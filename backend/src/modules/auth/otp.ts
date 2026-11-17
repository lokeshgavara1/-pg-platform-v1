import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { badRequest, tooMany } from '../../lib/errors.js';
import { limiters } from '../../lib/rateLimit.js';
import { sms } from '../../providers/sms.js';

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;

export function hashOtp(phone: string, code: string): string {
  return createHmac('sha256', env.OTP_HASH_SECRET).update(`${phone}:${code}`).digest('hex');
}

export async function requestOtp(phone: string, ip: string) {
  if (!limiters.otpPerIp.hit(ip)) throw tooMany();
  if (!limiters.otpPerPhone.hit(phone)) throw tooMany('Too many OTP requests for this number. Try again in a few minutes.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  // Invalidate older unused codes for this phone.
  await prisma.otpRequest.updateMany({ where: { phone, consumedAt: null }, data: { consumedAt: new Date() } });
  await prisma.otpRequest.create({
    data: { phone, codeHash: hashOtp(phone, code), expiresAt: new Date(Date.now() + OTP_TTL_MS), ip },
  });
  await sms().sendOtp(phone, code);
  return { expiresInSeconds: OTP_TTL_MS / 1000 };
}

/** Throws on invalid/expired/used code; consumes the code on success. */
export async function verifyOtp(phone: string, code: string, now = new Date()) {
  const id = await checkOtp(phone, code, now);
  await consumeOtp(id, now);
}

/** Atomic consume: only one concurrent verify can win. */
export async function consumeOtp(id: string, now = new Date()) {
  const res = await prisma.otpRequest.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: now } });
  if (res.count !== 1) throw badRequest('Request a new OTP first');
}

/** Check a code without consuming it (wrong guesses still count as attempts). Returns the OTP row id. */
export async function checkOtp(phone: string, code: string, now = new Date()): Promise<string> {
  const otp = await prisma.otpRequest.findFirst({
    where: { phone, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!otp) throw badRequest('Request a new OTP first');
  if (otp.expiresAt < now) throw badRequest('OTP expired. Request a new one.');
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw tooMany('Too many wrong attempts. Request a new OTP.');

  const expected = Buffer.from(otp.codeHash, 'hex');
  const given = Buffer.from(hashOtp(phone, code), 'hex');
  if (!timingSafeEqual(expected, given)) {
    await prisma.otpRequest.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    throw badRequest('Incorrect OTP');
  }
  return otp.id;
}
