import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, makeUser, ownerWithProperty, resetDb } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { setGoogleTokenVerifier } from '../../src/providers/googleAuth.js';

/** Fake Google: a token "gtok-<uid>[-<provider>]" means that Google account signed in. */
beforeAll(() =>
  setGoogleTokenVerifier(async (token) => {
    const m = /^gtok-([a-z0-9]+)(?:-(\w+))?-padding-padding$/.exec(token);
    if (!m) throw new Error('bad token');
    return { uid: m[1], email: `${m[1]}@gmail.com`, name: `Google ${m[1]}`, provider: m[2] ?? 'google.com' };
  }),
);
afterAll(() => setGoogleTokenVerifier(null));

const tok = (uid: string, provider?: string) => `gtok-${uid}${provider ? `-${provider}` : ''}-padding-padding`;
const google = (body: Record<string, unknown>) => api().post('/api/auth/google').send(body);

describe('sign in with Google', () => {
  beforeEach(resetDb);

  it('new owner: asks for name and phone, then creates an owner with an unverified phone', async () => {
    const r1 = await google({ idToken: tok('alice'), app: 'owner' }).expect(400);
    expect(r1.body.error.code).toBe('PROFILE_REQUIRED');
    expect(r1.body.error.details).toMatchObject({ suggestedName: 'Google alice', email: 'alice@gmail.com' });

    const r2 = await google({ idToken: tok('alice'), app: 'owner', name: 'Alice Owner', phone: '9811100001' }).expect(200);
    expect(r2.body.user).toMatchObject({ role: 'OWNER', phone: '+919811100001', email: 'alice@gmail.com', phoneVerified: false, googleConnected: true });
    expect(r2.body.accessToken).toBeTruthy();
    // Works as a normal session.
    await api().get('/api/owner/properties').set('Authorization', `Bearer ${r2.body.accessToken}`).expect(200);

    // Next time: straight in, no questions.
    const r3 = await google({ idToken: tok('alice'), app: 'owner' }).expect(200);
    expect(r3.body.user.id).toBe(r2.body.user.id);
  });

  it('new tenant signs up from the tenant app', async () => {
    const r = await google({ idToken: tok('bob'), app: 'tenant', name: 'Bob Tenant', phone: '9811100002' }).expect(200);
    expect(r.body.user.role).toBe('TENANT');
  });

  it('cannot claim a phone number that already has an account (no takeover)', async () => {
    const victim = await makeUser('TENANT', 'Victim');
    const digits = victim.user.phone.slice(3);
    const r = await google({ idToken: tok('mallory'), app: 'tenant', name: 'Mallory', phone: digits }).expect(409);
    expect(r.body.error.code).toBe('PHONE_TAKEN');
    const v = await prisma.user.findUniqueOrThrow({ where: { id: victim.user.id } });
    expect(v.firebaseUid).toBeNull();
  });

  it('keeps the app rules: tenant Google account refused by the owner app, and vice versa', async () => {
    await google({ idToken: tok('carol'), app: 'tenant', name: 'Carol', phone: '9811100003' }).expect(200);
    const r = await google({ idToken: tok('carol'), app: 'owner' }).expect(403);
    expect(r.body.error.message).toMatch(/tenant app/);
  });

  it('nobody can become an admin through Google sign-up', async () => {
    await google({ idToken: tok('eve'), app: 'admin', name: 'Eve', phone: '9811100004' }).expect(403);
    expect(await prisma.user.count({ where: { role: 'ADMIN' } })).toBe(0);
  });

  it('deactivated accounts are refused', async () => {
    const r = await google({ idToken: tok('dan'), app: 'owner', name: 'Dan', phone: '9811100005' }).expect(200);
    await prisma.user.update({ where: { id: r.body.user.id }, data: { status: 'DEACTIVATED' } });
    await google({ idToken: tok('dan'), app: 'owner' }).expect(403);
  });

  it('rejects invalid tokens and non-Google providers', async () => {
    await google({ idToken: 'not-a-valid-google-token-xx', app: 'owner' }).expect(401);
    await google({ idToken: tok('frank', 'password'), app: 'owner', name: 'Frank', phone: '9811100006' }).expect(401);
  });

  it('is switched off cleanly when the server has no Firebase project configured', async () => {
    setGoogleTokenVerifier(null);
    try {
      const r = await google({ idToken: tok('gina'), app: 'owner' });
      // The test environment has no FIREBASE_PROJECT_ID, so the endpoint reports "not set up".
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('GOOGLE_NOT_CONFIGURED');
    } finally {
      setGoogleTokenVerifier(async (token) => ({ uid: token.split('-')[1], email: null, name: null, provider: 'google.com' }));
    }
  });
});

describe('connecting Google to an existing account', () => {
  beforeEach(async () => {
    await resetDb();
    setGoogleTokenVerifier(async (token) => {
      const m = /^gtok-([a-z0-9]+)(?:-(\w+))?-padding-padding$/.exec(token);
      if (!m) throw new Error('bad token');
      return { uid: m[1], email: `${m[1]}@gmail.com`, name: `Google ${m[1]}`, provider: m[2] ?? 'google.com' };
    });
  });

  it('an OTP-logged-in owner links Google, then can sign in with it', async () => {
    const owner = await makeUser('OWNER', 'Ramesh');
    await api().post('/api/auth/google/link').set(owner.auth).send({ idToken: tok('ramesh') }).expect(200);
    const r = await google({ idToken: tok('ramesh'), app: 'owner' }).expect(200);
    expect(r.body.user).toMatchObject({ id: owner.user.id, phoneVerified: true });
    expect(await prisma.auditLog.count({ where: { entityId: owner.user.id, action: 'GOOGLE_CONNECTED' } })).toBe(1);
  });

  it('a Google account can be connected to only one user', async () => {
    const a = await makeUser('OWNER');
    const b = await makeUser('OWNER');
    await api().post('/api/auth/google/link').set(a.auth).send({ idToken: tok('shared') }).expect(200);
    await api().post('/api/auth/google/link').set(b.auth).send({ idToken: tok('shared') }).expect(409);
    await api().post('/api/auth/google/link').set(a.auth).send({ idToken: tok('another') }).expect(409);
  });
});

describe('owner sends a tenant a one-time login link', () => {
  beforeEach(async () => {
    await resetDb();
    setGoogleTokenVerifier(async (token) => {
      const m = /^gtok-([a-z0-9]+)(?:-(\w+))?-padding-padding$/.exec(token);
      if (!m) throw new Error('bad token');
      return { uid: m[1], email: `${m[1]}@gmail.com`, name: `Google ${m[1]}`, provider: m[2] ?? 'google.com' };
    });
  });

  async function setup() {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const link = await api().post(`/api/owner/tenancies/${tenancy.id}/login-link`).set(owner.auth).expect(201);
    const token = new URL(link.body.url).pathname.split('/').pop()!;
    return { owner, tenancy, tenant, link: link.body, token };
  }

  it('creates a tenant-app link; only a hash is stored', async () => {
    const { link, token } = await setup();
    expect(link.url).toMatch(/^http:\/\/localhost:5174\/link\//);
    const rows = await prisma.loginLink.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toContain(token);
  });

  it('the tenant opens it, signs in with Google, and lands in their own account', async () => {
    const { tenant, token } = await setup();
    const r = await google({ idToken: tok('priya'), app: 'tenant', linkToken: token }).expect(200);
    expect(r.body.user).toMatchObject({ id: tenant.user.id, phoneVerified: true, googleConnected: true });
    // From now on, plain Google sign-in works.
    const again = await google({ idToken: tok('priya'), app: 'tenant' }).expect(200);
    expect(again.body.user.id).toBe(tenant.user.id);
  });

  it('a link works once, and a newer link replaces older ones', async () => {
    const { owner, tenancy, token } = await setup();
    const newer = await api().post(`/api/owner/tenancies/${tenancy.id}/login-link`).set(owner.auth).expect(201);
    const r = await google({ idToken: tok('priya'), app: 'tenant', linkToken: token }).expect(400);
    expect(r.body.error.code).toBe('LINK_INVALID');
    const newToken = new URL(newer.body.url).pathname.split('/').pop()!;
    await google({ idToken: tok('priya'), app: 'tenant', linkToken: newToken }).expect(200);
    await google({ idToken: tok('other'), app: 'tenant', linkToken: newToken }).expect(400);
  });

  it('expired links are refused', async () => {
    const { token } = await setup();
    await prisma.loginLink.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await google({ idToken: tok('priya'), app: 'tenant', linkToken: token }).expect(400);
  });

  it('a Google account already used by someone else cannot be attached through a link', async () => {
    const { token } = await setup();
    await google({ idToken: tok('taken'), app: 'tenant', name: 'Someone', phone: '9811100009' }).expect(200);
    await google({ idToken: tok('taken'), app: 'tenant', linkToken: token }).expect(409);
  });

  it('another owner and tenants cannot create links for this tenancy', async () => {
    const { tenancy, tenant } = await setup();
    const other = await makeUser('OWNER');
    await api().post(`/api/owner/tenancies/${tenancy.id}/login-link`).set(other.auth).expect(404);
    await api().post(`/api/owner/tenancies/${tenancy.id}/login-link`).set(tenant.auth).expect(403);
  });
});
