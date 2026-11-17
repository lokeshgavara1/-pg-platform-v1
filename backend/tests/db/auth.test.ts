import { beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { api, makeUser, resetDb } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { ConsoleSmsProvider } from '../../src/providers/sms.js';

const PHONE = '9876500001';
const E164 = '+919876500001';

async function requestCode(phone = PHONE) {
  await api().post('/api/auth/request-otp').send({ phone }).expect(200);
  return ConsoleSmsProvider.lastCodes.get(phone.startsWith('+') ? phone : `+91${phone}`)!;
}

describe('phone OTP login', () => {
  beforeEach(resetDb);

  it('signs up a new owner and returns tokens', async () => {
    const code = await requestCode();
    const r = await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'owner', name: 'New Owner' }).expect(200);
    expect(r.body.user).toMatchObject({ phone: E164, role: 'OWNER', name: 'New Owner' });
    expect(r.body.accessToken).toBeTruthy();
    expect(r.body.refreshToken).toBeTruthy();
    await api().get('/api/auth/me').set('Authorization', `Bearer ${r.body.accessToken}`).expect(200);
  });

  it('stores only a hash of the OTP', async () => {
    const code = await requestCode();
    const row = await prisma.otpRequest.findFirstOrThrow({ where: { phone: E164 } });
    expect(row.codeHash).not.toContain(code);
    expect(row.codeHash).toHaveLength(64);
  });

  it('asks for a name when the number is new', async () => {
    const code = await requestCode();
    const r = await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'tenant' }).expect(400);
    expect(r.body.error.code).toBe('NAME_REQUIRED');
    // The same code still works once the name is supplied.
    const ok = await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'tenant', name: 'New Tenant' }).expect(200);
    expect(ok.body.user.role).toBe('TENANT');
  });

  it('rejects a wrong OTP and locks after 5 wrong attempts', async () => {
    const code = await requestCode();
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const r = await api().post('/api/auth/verify-otp').send({ phone: PHONE, code: wrong, app: 'owner', name: 'X Y' }).expect(400);
      expect(r.body.error.message).toBe('Incorrect OTP');
    }
    // Even the right code no longer works once attempts are exhausted.
    await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'owner', name: 'X Y' }).expect(429);
  });

  it('rejects an expired OTP', async () => {
    const code = await requestCode();
    await prisma.otpRequest.updateMany({ where: { phone: E164 }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r = await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'owner', name: 'X Y' }).expect(400);
    expect(r.body.error.message).toMatch(/expired/i);
  });

  it('an OTP works only once', async () => {
    const code = await requestCode();
    await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'owner', name: 'Owner A' }).expect(200);
    await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'owner' }).expect(400);
  });

  it('rate-limits OTP requests per phone', async () => {
    for (let i = 0; i < 3; i++) await api().post('/api/auth/request-otp').send({ phone: PHONE }).expect(200);
    const r = await api().post('/api/auth/request-otp').send({ phone: PHONE }).expect(429);
    expect(r.body.error.code).toBe('RATE_LIMITED');
    // A different phone is still allowed.
    await api().post('/api/auth/request-otp').send({ phone: '9876500002' }).expect(200);
  });

  it('rate-limits OTP requests per IP', async () => {
    for (let i = 0; i < 20; i++) await api().post('/api/auth/request-otp').send({ phone: `98765${String(10000 + i)}` }).expect(200);
    await api().post('/api/auth/request-otp').send({ phone: '9876599999' }).expect(429);
  });

  it('validates phone numbers with the standard error shape', async () => {
    const r = await api().post('/api/auth/request-otp').send({ phone: '12345' }).expect(400);
    expect(r.body).toMatchObject({ error: { code: 'BAD_REQUEST', message: 'Invalid input' } });
    expect(Array.isArray(r.body.error.details)).toBe(true);
  });

  it('owner app refuses tenant accounts and tenant app refuses owner accounts', async () => {
    const tenant = await makeUser('TENANT');
    let code = await requestCode(tenant.user.phone);
    let r = await api().post('/api/auth/verify-otp').send({ phone: tenant.user.phone, code, app: 'owner' }).expect(403);
    expect(r.body.error.message).toMatch(/tenant app/);

    const owner = await makeUser('OWNER');
    code = await requestCode(owner.user.phone);
    r = await api().post('/api/auth/verify-otp').send({ phone: owner.user.phone, code, app: 'tenant' }).expect(403);
    expect(r.body.error.message).toMatch(/owner app/);
  });

  it('staff may use the owner app; nobody can self-register as admin', async () => {
    const staff = await makeUser('STAFF');
    const code = await requestCode(staff.user.phone);
    await api().post('/api/auth/verify-otp').send({ phone: staff.user.phone, code, app: 'owner' }).expect(200);
    const c2 = await requestCode('9876500003');
    await api().post('/api/auth/verify-otp').send({ phone: '9876500003', code: c2, app: 'admin', name: 'Hacker' }).expect(403);
  });

  it('deactivated users cannot log in', async () => {
    const u = await makeUser('OWNER');
    await prisma.user.update({ where: { id: u.user.id }, data: { status: 'DEACTIVATED' } });
    const code = await requestCode(u.user.phone);
    await api().post('/api/auth/verify-otp').send({ phone: u.user.phone, code, app: 'owner' }).expect(403);
    await api().get('/api/auth/me').set(u.auth).expect(401);
  });
});

describe('tokens and roles', () => {
  beforeEach(resetDb);

  it('rotates refresh tokens and detects reuse', async () => {
    const code = await requestCode();
    const login = await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'owner', name: 'Owner' }).expect(200);
    const r1 = await api().post('/api/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    // Reusing the old token fails and revokes the new one too.
    await api().post('/api/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await api().post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('logout revokes the refresh token', async () => {
    const code = await requestCode();
    const login = await api().post('/api/auth/verify-otp').send({ phone: PHONE, code, app: 'owner', name: 'Owner' }).expect(200);
    await api().post('/api/auth/logout').send({ refreshToken: login.body.refreshToken }).expect(200);
    await api().post('/api/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
  });

  it('rejects missing, forged and expired access tokens', async () => {
    const u = await makeUser('OWNER');
    await api().get('/api/owner/properties').expect(401);
    const forged = jwt.sign({ role: 'OWNER' }, 'not-the-secret-not-the-secret-not-the-secret', { subject: u.user.id, issuer: 'pg-platform' });
    await api().get('/api/owner/properties').set('Authorization', `Bearer ${forged}`).expect(401);
    const expired = jwt.sign({ role: 'OWNER' }, process.env.JWT_ACCESS_SECRET!, { subject: u.user.id, issuer: 'pg-platform', expiresIn: -10 });
    await api().get('/api/owner/properties').set('Authorization', `Bearer ${expired}`).expect(401);
    const noneAlg = jwt.sign({ role: 'OWNER', sub: u.user.id, iss: 'pg-platform' }, '', { algorithm: 'none' });
    await api().get('/api/owner/properties').set('Authorization', `Bearer ${noneAlg}`).expect(401);
  });

  it('a tenant token is rejected on owner routes and an owner token on tenant/admin routes', async () => {
    const tenant = await makeUser('TENANT');
    const owner = await makeUser('OWNER');
    await api().get('/api/owner/properties').set(tenant.auth).expect(403);
    await api().get('/api/owner/dashboard').set(tenant.auth).expect(403);
    await api().get('/api/tenant/home').set(owner.auth).expect(403);
    await api().get('/api/admin/users').set(owner.auth).expect(403);
  });

  it('role in a token cannot be escalated: the DB role is used', async () => {
    const tenant = await makeUser('TENANT');
    // A token claiming OWNER for a tenant user (e.g. stale after a role change) is still checked against the DB.
    const { signAccessToken } = await import('../../src/modules/auth/tokens.js');
    const t = signAccessToken(tenant.user.id, 'OWNER');
    await api().get('/api/owner/properties').set('Authorization', `Bearer ${t}`).expect(403);
  });
});
