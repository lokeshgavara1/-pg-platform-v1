import { Router } from 'express';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { parse, phoneSchema } from '../../lib/http.js';
import { AppError, forbidden, tooMany } from '../../lib/errors.js';
import { clientIp, limiters } from '../../lib/rateLimit.js';
import { checkOtp, consumeOtp, requestOtp } from './otp.js';
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken, signAccessToken, ACCESS_TTL_SECONDS } from './tokens.js';
import { authenticate, me } from './middleware.js';

export const authRouter = Router();

/** Which roles may sign in to which app. Enforced here AND in each app. */
const APP_ROLES: Record<'owner' | 'tenant' | 'admin', Role[]> = {
  owner: ['OWNER', 'STAFF'],
  tenant: ['TENANT'],
  admin: ['ADMIN'],
};

const APP_REFUSAL: Record<'owner' | 'tenant' | 'admin', string> = {
  owner: 'This number is registered as a tenant. Please use the tenant app.',
  tenant: 'This number is registered as an owner or staff account. Please use the owner app.',
  admin: 'This account is not an admin.',
};

export function publicUser(u: { id: string; name: string; role: Role; phone: string }) {
  return { id: u.id, name: u.name, role: u.role, phone: u.phone };
}

authRouter.post('/request-otp', async (req, res) => {
  const { phone } = parse(z.object({ phone: phoneSchema }), req.body);
  const result = await requestOtp(phone, clientIp(req));
  res.json({ ok: true, ...result });
});

authRouter.post('/verify-otp', async (req, res) => {
  if (!limiters.verifyPerIp.hit(clientIp(req))) throw tooMany();
  const body = parse(
    z.object({
      phone: phoneSchema,
      code: z.string().regex(/^\d{6}$/, 'OTP is 6 digits'),
      app: z.enum(['owner', 'tenant', 'admin']),
      name: z.string().trim().min(2).max(80).optional(),
    }),
    req.body,
  );
  // Check the code first; it is consumed only once we are about to sign the user in,
  // so a new user asked for their name can reuse the same OTP.
  const otpId = await checkOtp(body.phone, body.code);

  let user = await prisma.user.findUnique({ where: { phone: body.phone } });
  if (!user) {
    // Self sign-up is allowed only for owners (owner app) and tenants (tenant app).
    if (body.app === 'admin') {
      await consumeOtp(otpId);
      throw forbidden(APP_REFUSAL.admin);
    }
    const name = body.name;
    if (!name) throw new AppError(400, 'NAME_REQUIRED', 'Enter your name to create an account');
    await consumeOtp(otpId);
    user = await prisma.user.create({
      data: { phone: body.phone, name, role: body.app === 'owner' ? 'OWNER' : 'TENANT' },
    });
  } else {
    await consumeOtp(otpId);
  }
  if (user.status !== 'ACTIVE') throw forbidden('This account has been deactivated. Contact support.');
  if (!APP_ROLES[body.app].includes(user.role)) throw forbidden(APP_REFUSAL[body.app]);

  res.json({
    user: publicUser(user),
    accessToken: signAccessToken(user.id, user.role),
    accessTokenExpiresIn: ACCESS_TTL_SECONDS,
    refreshToken: await issueRefreshToken(user.id),
  });
});

authRouter.post('/refresh', async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
  const r = await rotateRefreshToken(refreshToken);
  res.json({
    user: publicUser(r.user),
    accessToken: r.accessToken,
    accessTokenExpiresIn: ACCESS_TTL_SECONDS,
    refreshToken: r.refreshToken,
  });
});

authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = parse(z.object({ refreshToken: z.string().min(20).max(200) }), req.body);
  await revokeRefreshToken(refreshToken);
  res.json({ ok: true });
});

authRouter.get('/me', authenticate, async (req, res) => {
  res.json({ user: publicUser(me(req)) });
});
