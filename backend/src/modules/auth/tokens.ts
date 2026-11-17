import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Role } from '@prisma/client';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { unauthorized } from '../../lib/errors.js';

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_DAYS = 30;

export interface AccessClaims {
  sub: string;
  role: Role;
}

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign({ role } satisfies Omit<AccessClaims, 'sub'>, env.JWT_ACCESS_SECRET, {
    subject: userId,
    expiresIn: ACCESS_TTL_SECONDS,
    algorithm: 'HS256',
    issuer: 'pg-platform',
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'pg-platform' });
    if (typeof p === 'string' || !p.sub) throw new Error('bad token');
    return { sub: p.sub, role: (p as { role: Role }).role };
  } catch {
    throw unauthorized('Invalid or expired token');
  }
}

const hashToken = (t: string) => createHash('sha256').update(env.JWT_REFRESH_SECRET).update(t).digest('hex');

export async function issueRefreshToken(userId: string): Promise<string> {
  const token = randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 86400000),
    },
  });
  return token;
}

/** Rotate: the old refresh token is revoked and a new pair is issued. */
export async function rotateRefreshToken(token: string) {
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
  if (!row || row.revokedAt || row.expiresAt < new Date() || row.user.status !== 'ACTIVE') {
    // Reuse of a revoked token suggests theft: revoke every token for that user.
    if (row?.revokedAt) await prisma.refreshToken.updateMany({ where: { userId: row.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    throw unauthorized('Session expired, please log in again');
  }
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });
  return {
    user: row.user,
    accessToken: signAccessToken(row.user.id, row.user.role),
    refreshToken: await issueRefreshToken(row.user.id),
  };
}

export async function revokeRefreshToken(token: string) {
  await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
}
