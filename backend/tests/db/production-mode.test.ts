/**
 * Behaviour with the production provider settings (SMS_PROVIDER=none, PAYMENT_PROVIDER=none,
 * ESIGN_PROVIDER=none). The env object is switched for each test and restored afterwards.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, makeUser, ownerWithProperty, resetDb } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { env } from '../../src/config/env.js';
import { setPaymentProvider } from '../../src/providers/payment.js';
import { setGoogleTokenVerifier } from '../../src/providers/googleAuth.js';
import { buildFakeWebhook } from '../../src/modules/payments/service.js';
import { NoGatewayProvider } from '../../src/providers/payment.js';

const original = { SMS_PROVIDER: env.SMS_PROVIDER, PAYMENT_PROVIDER: env.PAYMENT_PROVIDER, ESIGN_PROVIDER: env.ESIGN_PROVIDER, FIREBASE_PROJECT_ID: env.FIREBASE_PROJECT_ID };

function productionMode() {
  Object.assign(env, { SMS_PROVIDER: 'none', PAYMENT_PROVIDER: 'none', ESIGN_PROVIDER: 'none', FIREBASE_PROJECT_ID: 'pg-platform-e8a57' });
  setPaymentProvider(new NoGatewayProvider());
}

beforeAll(() =>
  setGoogleTokenVerifier(async (token) => {
    const m = /^gtok-([a-z0-9]+)-padding-padding$/.exec(token);
    if (!m) throw new Error('bad token');
    return { uid: m[1], email: `${m[1]}@gmail.com`, name: m[1], provider: 'google.com' };
  }),
);

afterEach(() => {
  Object.assign(env, original);
  setPaymentProvider(null);
});

describe('production mode', () => {
  beforeEach(async () => {
    await resetDb();
    productionMode();
  });

  it('tells the apps what is available', async () => {
    const r = await api().get('/api/auth/config').expect(200);
    expect(r.body).toEqual({ otpLogin: false, googleLogin: true, esign: false, onlineGateway: false });
  });

  it('mobile OTP login is switched off', async () => {
    const r = await api().post('/api/auth/request-otp').send({ phone: '9876500001' }).expect(503);
    expect(r.body.error.code).toBe('OTP_DISABLED');
    await api().post('/api/auth/verify-otp').send({ phone: '9876500001', code: '123456', app: 'owner' }).expect(503);
  });

  it('the sandbox webhook and checkout page are unreachable', async () => {
    const { raw, signature } = buildFakeWebhook('plink_fake_0123456789abcdef', 'success', 100);
    await api().post('/webhooks/payments/fake').set('content-type', 'application/json').set('x-fake-signature', signature).send(raw.toString('utf8')).expect(404);
    await api().get('/fake-gateway/pay/plink_fake_0123456789abcdef').expect(404);
  });

  it('no online payment option is offered, even for a PG without a UPI ID', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenant, tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const inv = (await api().get('/api/tenant/invoices?status=UNPAID').set(tenant.auth).expect(200)).body.items[0];
    expect(inv.payOptions).toEqual({ upi: null, gateway: false });
    await api().post(`/api/tenant/invoices/${inv.id}/pay-link`).set(tenant.auth).expect(409);
    const rent = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: tenancy.id, kind: 'RENT' } });
    await api().post(`/api/owner/invoices/${rent.id}/payment-link`).set(owner.auth).expect(409);
    // Cash still works.
    await api().post(`/api/owner/invoices/${rent.id}/payments`).set(owner.auth).send({ amountPaise: 1000, method: 'CASH' }).expect(201);
  });

  it('agreements are signed on paper: tenant OTP signing is refused, the owner marks it signed', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenant, tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const a = await api().post(`/api/owner/tenancies/${tenancy.id}/agreement`).set(owner.auth).expect(201);
    expect(a.body).toMatchObject({ esignProvider: 'paper', esignDevOnly: false });
    await api().post(`/api/tenant/agreement/${a.body.id}/request-otp`).set(tenant.auth).expect(409);

    const other = await makeUser('OWNER');
    await api().post(`/api/owner/agreements/${a.body.id}/mark-signed`).set(other.auth).expect(404);
    await api().post(`/api/owner/agreements/${a.body.id}/mark-signed`).set(tenant.auth).expect(403);
    const s = await api().post(`/api/owner/agreements/${a.body.id}/mark-signed`).set(owner.auth).expect(200);
    expect(s.body).toMatchObject({ status: 'SIGNED', esignProvider: 'paper', esignDevOnly: false });
    await api().post(`/api/owner/agreements/${a.body.id}/mark-signed`).set(owner.auth).expect(409);
    expect(await prisma.auditLog.count({ where: { entityId: a.body.id, action: 'AGREEMENT_SIGNED_ON_PAPER' } })).toBe(1);
  });

  it('staff sign in through a one-time link from their owner, then with Google', async () => {
    const { owner, property } = await ownerWithProperty();
    const s = await api().post(`/api/owner/properties/${property.id}/staff`).set(owner.auth).send({ phone: '9833333333', name: 'Caretaker' }).expect(201);
    const other = await makeUser('OWNER');
    await api().post(`/api/owner/properties/${property.id}/staff/${s.body.userId}/login-link`).set(other.auth).expect(404);
    const link = await api().post(`/api/owner/properties/${property.id}/staff/${s.body.userId}/login-link`).set(owner.auth).expect(201);
    expect(link.body.url).toMatch(/^http:\/\/localhost:5173\/link\//); // the owner app, not the tenant app
    const token = new URL(link.body.url).pathname.split('/').pop();
    const r = await api().post('/api/auth/google').send({ idToken: 'gtok-caretaker-padding-padding', app: 'owner', linkToken: token }).expect(200);
    expect(r.body.user).toMatchObject({ role: 'STAFF', googleConnected: true });
  });
});

describe('local development mode (unchanged)', () => {
  beforeEach(resetDb);
  it('still offers OTP, the sandbox gateway and OTP signing on a developer machine', async () => {
    const r = await api().get('/api/auth/config').expect(200);
    expect(r.body).toMatchObject({ otpLogin: true, esign: true, onlineGateway: true });
    await api().post('/api/auth/request-otp').send({ phone: '9876500002' }).expect(200);
  });
});
