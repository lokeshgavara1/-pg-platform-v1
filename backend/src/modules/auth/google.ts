/**
 * Free sign-in with Google (Firebase Auth, Spark plan) — no SMS cost.
 *
 * Rules that prevent account takeover:
 * - A Google account is tied to at most one user, and a user to at most one Google account.
 * - A NEW Google sign-up may not claim a mobile number that already has an account. Existing
 *   accounts connect Google either by signing in another way first (OTP) and linking, or by
 *   opening a one-time login link their PG owner sent them.
 * - Phone numbers typed in at Google sign-up are stored as not verified.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { parse, phoneSchema } from '../../lib/http.js';
import { AppError, conflict, forbidden, tooMany, unauthorized } from '../../lib/errors.js';
import { clientIp, limiters } from '../../lib/rateLimit.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { googleVerifier, type GoogleIdentity } from '../../providers/googleAuth.js';
import { authenticate, me } from './middleware.js';
import { APP_REFUSAL, assertAppAccess, sessionResponse } from './routes.js';

export const LOGIN_LINK_TTL_DAYS = 7;

const hashLinkToken = (t: string) => createHash('sha256').update(env.OTP_HASH_SECRET).update(`login-link:${t}`).digest('hex');

async function verifyGoogle(idToken: string): Promise<GoogleIdentity> {
  const verifier = googleVerifier();
  if (!verifier) throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not set up on this server');
  let id: GoogleIdentity;
  try {
    id = await verifier(idToken);
  } catch {
    throw unauthorized('Google sign-in failed. Please try again.');
  }
  if (id.provider !== 'google.com') throw unauthorized('Please sign in with Google');
  return id;
}

const PHONE_TAKEN = () =>
  new AppError(409, 'PHONE_TAKEN', 'This mobile number already has an account. Ask your PG owner for a login link, or log in with OTP and connect Google from your profile.');

export const googleAuthRouter = Router();

googleAuthRouter.post('/google', async (req, res) => {
  if (!limiters.verifyPerIp.hit(clientIp(req))) throw tooMany();
  const body = parse(
    z.object({
      idToken: z.string().min(20).max(5000),
      app: z.enum(['owner', 'tenant', 'admin']),
      name: z.string().trim().min(2).max(80).optional(),
      phone: phoneSchema.optional(),
      linkToken: z.string().min(20).max(100).optional(),
    }),
    req.body,
  );
  const google = await verifyGoogle(body.idToken);

  let user: User | null;
  if (body.linkToken) {
    user = await useLoginLink(body.linkToken, google);
  } else {
    user = await prisma.user.findUnique({ where: { firebaseUid: google.uid } });
    if (!user) {
      if (body.app === 'admin') throw forbidden(APP_REFUSAL.admin);
      if (!body.name || !body.phone) {
        throw new AppError(400, 'PROFILE_REQUIRED', 'Tell us your name and mobile number to finish creating your account', {
          suggestedName: google.name,
          email: google.email,
        });
      }
      if (await prisma.user.findUnique({ where: { phone: body.phone } })) throw PHONE_TAKEN();
      try {
        user = await prisma.user.create({
          data: {
            phone: body.phone,
            name: body.name,
            role: body.app === 'owner' ? 'OWNER' : 'TENANT',
            phoneVerified: false,
            firebaseUid: google.uid,
            email: google.email,
          },
        });
      } catch {
        // A concurrent sign-up took the number or the Google account.
        throw PHONE_TAKEN();
      }
      await audit(prisma, { actorId: user.id, action: 'SIGNED_UP_WITH_GOOGLE', entityType: 'User', entityId: user.id, after: { role: user.role, phoneVerified: false } });
    } else if (google.email && google.email !== user.email) {
      user = await prisma.user.update({ where: { id: user.id }, data: { email: google.email } });
    }
  }
  assertAppAccess(user, body.app);
  res.json(await sessionResponse(user));
});

/** A signed-in user (e.g. via OTP) connects their Google account for future logins. */
googleAuthRouter.post('/google/link', authenticate, async (req, res) => {
  const user = me(req);
  const { idToken } = parse(z.object({ idToken: z.string().min(20).max(5000) }), req.body);
  const google = await verifyGoogle(idToken);
  await connectGoogle(user, google);
  res.json({ ok: true, email: google.email });
});

async function connectGoogle(user: User, google: GoogleIdentity) {
  if (user.firebaseUid === google.uid) return user;
  if (user.firebaseUid) throw conflict('This account is already connected to a different Google account');
  const other = await prisma.user.findUnique({ where: { firebaseUid: google.uid } });
  if (other) throw conflict('This Google account is already connected to another PGPAL account');
  return prisma.$transaction(async (tx) => {
    const u = await tx.user.update({ where: { id: user.id }, data: { firebaseUid: google.uid, email: google.email ?? user.email } });
    await audit(tx, { actorId: user.id, action: 'GOOGLE_CONNECTED', entityType: 'User', entityId: user.id, after: { email: google.email } });
    return u;
  });
}

async function useLoginLink(token: string, google: GoogleIdentity): Promise<User> {
  const link = await prisma.loginLink.findUnique({ where: { tokenHash: hashLinkToken(token) }, include: { user: true } });
  if (!link || link.usedAt || link.expiresAt < new Date()) {
    throw new AppError(400, 'LINK_INVALID', 'This login link has expired or was already used. Ask your PG owner for a new one.');
  }
  const user = await connectGoogle(link.user, google);
  // Single use: only one request can mark it used.
  const r = await prisma.loginLink.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } });
  if (r.count !== 1) throw new AppError(400, 'LINK_INVALID', 'This login link was already used. Ask your PG owner for a new one.');
  return user;
}

/** The app a user signs in to, by role. */
export function appUrlForRole(role: User['role']) {
  const url = role === 'TENANT' ? env.TENANT_APP_URL : role === 'ADMIN' ? env.ADMIN_APP_URL : env.OWNER_APP_URL;
  return url.replace(/\/$/, '');
}

/**
 * Create a one-time login link (7 days, single use) that opens the right app for the user's role;
 * older unused links for them stop working. createdById is null when made from the server CLI.
 */
export async function createLoginLink(userId: string, createdById: string | null) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const token = randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + LOGIN_LINK_TTL_DAYS * 86400000);
  await prisma.$transaction(async (tx) => {
    await tx.loginLink.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    await tx.loginLink.create({ data: { userId, tokenHash: hashLinkToken(token), expiresAt, createdById: createdById ?? 'cli' } });
    await audit(tx, { actorId: createdById, action: 'LOGIN_LINK_CREATED', entityType: 'User', entityId: userId, after: { expiresAt: expiresAt.toISOString() } });
  });
  return { url: `${appUrlForRole(user.role)}/link/${token}`, expiresAt: expiresAt.toISOString() };
}
