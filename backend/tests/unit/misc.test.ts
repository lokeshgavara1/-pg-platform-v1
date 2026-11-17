import { describe, expect, it } from 'vitest';
import { computeSettlement } from '../../src/modules/moveout/calc.js';
import { isQuietHoursIST, todayIST, toDateString } from '../../src/lib/dates.js';
import { RateLimiter } from '../../src/lib/rateLimit.js';
import { signFileToken, verifyFileToken } from '../../src/providers/storage.js';
import { redact } from '../../src/lib/logger.js';
import { reminderText } from '../../src/jobs/reminders.js';
import { sniffMatches } from '../../src/modules/files/service.js';
import { PNG_BYTES, JPEG_BYTES } from '../helpers.js';

describe('deposit settlement maths', () => {
  it('refund = deposit − deductions', () => {
    expect(computeSettlement(2000000, [{ reason: 'Paint', amountPaise: 150000 }, { reason: 'Key', amountPaise: 50000 }])).toEqual({
      depositHeldPaise: 2000000,
      deductionsPaise: 200000,
      refundPaise: 1800000,
      balanceDuePaise: 0,
    });
  });
  it('no deductions refunds everything', () => {
    expect(computeSettlement(1700000, []).refundPaise).toBe(1700000);
  });
  it('deductions above the deposit become a balance due, never a negative refund', () => {
    const s = computeSettlement(100000, [{ reason: 'Damage', amountPaise: 250000 }]);
    expect(s.refundPaise).toBe(0);
    expect(s.balanceDuePaise).toBe(150000);
  });
  it('rejects bad deductions', () => {
    expect(() => computeSettlement(1000, [{ reason: 'x', amountPaise: 0 }])).toThrow();
    expect(() => computeSettlement(1000, [{ reason: 'x', amountPaise: 1.5 }])).toThrow();
    expect(() => computeSettlement(1000, [{ reason: ' ', amountPaise: 10 }])).toThrow();
    expect(() => computeSettlement(-1, [])).toThrow();
  });
});

describe('India time helpers', () => {
  it('quiet hours are 9 pm to 8 am IST', () => {
    // 15:29 UTC = 20:59 IST (allowed), 15:30 UTC = 21:00 IST (quiet)
    expect(isQuietHoursIST(new Date('2026-11-17T15:29:00Z'))).toBe(false);
    expect(isQuietHoursIST(new Date('2026-11-17T15:30:00Z'))).toBe(true);
    // 02:29 UTC = 07:59 IST (quiet), 02:30 UTC = 08:00 IST (allowed)
    expect(isQuietHoursIST(new Date('2026-11-17T02:29:00Z'))).toBe(true);
    expect(isQuietHoursIST(new Date('2026-11-17T02:30:00Z'))).toBe(false);
  });
  it('today in IST rolls over at IST midnight', () => {
    expect(toDateString(todayIST(new Date('2026-11-17T18:29:00Z')))).toBe('2026-11-17');
    expect(toDateString(todayIST(new Date('2026-11-17T18:30:00Z')))).toBe('2026-11-18');
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window, then blocks, then resets', () => {
    let t = 0;
    const l = new RateLimiter(3, 1000, () => t);
    expect([l.hit('a'), l.hit('a'), l.hit('a'), l.hit('a')]).toEqual([true, true, true, false]);
    expect(l.hit('b')).toBe(true);
    t = 1000;
    expect(l.hit('a')).toBe(true);
  });
});

describe('signed file tokens', () => {
  it('verifies a valid token and rejects expired or tampered ones', () => {
    const future = Math.floor(Date.now() / 1000) + 60;
    const tok = signFileToken({ f: 'file1', a: 'get', u: 'u1', e: future });
    expect(verifyFileToken(tok)?.f).toBe('file1');
    expect(verifyFileToken(tok, (future + 1) * 1000)).toBeNull();
    const [body, sig] = tok.split('.');
    const forged = Buffer.from(JSON.stringify({ f: 'file2', a: 'get', u: 'u1', e: future })).toString('base64url');
    expect(verifyFileToken(`${forged}.${sig}`)).toBeNull();
    expect(verifyFileToken(`${body}.x${sig.slice(1)}`)).toBeNull();
    expect(verifyFileToken('garbage')).toBeNull();
  });
});

describe('log redaction', () => {
  it('masks phones, OTPs and tokens', () => {
    const r = redact({ phone: '+919876543210', note: 'call 9876543210 now', otp: '123456', nested: { refreshToken: 'abc' } }) as Record<string, unknown>;
    expect(r.phone).toBe('[redacted]');
    expect(r.otp).toBe('[redacted]');
    expect(r.note).toBe('call [redacted] now');
    expect((r.nested as Record<string, unknown>).refreshToken).toBe('[redacted]');
  });
});

describe('reminder text and file sniffing', () => {
  it('builds the three reminder messages', () => {
    const due = new Date(Date.UTC(2026, 10, 5));
    expect(reminderText(-3, 850000, due, 'Sunrise').title).toBe('Rent due soon');
    expect(reminderText(0, 850000, due, 'Sunrise').body).toContain('₹8,500');
    expect(reminderText(3, 850000, due, 'Sunrise').title).toBe('Rent overdue');
  });
  it('checks magic bytes', () => {
    expect(sniffMatches('image/png', PNG_BYTES)).toBe(true);
    expect(sniffMatches('image/jpeg', JPEG_BYTES)).toBe(true);
    expect(sniffMatches('image/png', JPEG_BYTES)).toBe(false);
    expect(sniffMatches('application/pdf', Buffer.from('%PDF-1.7'))).toBe(true);
    expect(sniffMatches('application/pdf', Buffer.from('<html>'))).toBe(false);
  });
});
