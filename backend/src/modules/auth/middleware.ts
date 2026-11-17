import type { NextFunction, Request, Response } from 'express';
import type { Role, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { forbidden, unauthorized } from '../../lib/errors.js';
import { verifyAccessToken } from './tokens.js';

export type AuthedRequest = Request & { user: User; id?: string };

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    const claims = verifyAccessToken(header.slice(7));
    const user = await prisma.user.findUnique({ where: { id: claims.sub } });
    if (!user || user.status !== 'ACTIVE') return next(unauthorized('Account is not active'));
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

/** Narrow helper for handlers mounted behind `authenticate`. */
export function me(req: Request): User {
  if (!req.user) throw unauthorized();
  return req.user;
}
