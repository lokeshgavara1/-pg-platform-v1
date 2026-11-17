import type { NextFunction, Request, Response } from 'express';
import { tooMany } from './errors.js';

/**
 * Small in-memory fixed-window rate limiter (single-instance deployment; no Redis).
 * If the backend is ever scaled to several instances, move this to Postgres or Redis.
 */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    public readonly limit: number,
    public readonly windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Returns true if allowed (and counts the hit). */
  hit(key: string): boolean {
    const t = this.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      this.gc(t);
      return true;
    }
    if (cur.count >= this.limit) return false;
    cur.count++;
    return true;
  }

  reset() {
    this.hits.clear();
  }

  private gc(t: number) {
    if (this.hits.size < 10_000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function rateLimitMiddleware(limiter: RateLimiter, keyFn: (req: Request) => string = clientIp) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!limiter.hit(keyFn(req))) return next(tooMany());
    next();
  };
}

export const limiters = {
  otpPerPhone: new RateLimiter(3, 10 * 60 * 1000), // 3 OTP requests / 10 min / phone
  otpPerIp: new RateLimiter(20, 60 * 60 * 1000), // 20 OTP requests / hour / IP
  verifyPerIp: new RateLimiter(30, 10 * 60 * 1000),
  publicPerIp: new RateLimiter(300, 60 * 1000), // general public routes
  webhookPerIp: new RateLimiter(600, 60 * 1000),
};

export function resetAllLimiters() {
  Object.values(limiters).forEach((l) => l.reset());
}
