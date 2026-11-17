import { beforeEach, describe, expect, it } from 'vitest';
import { api, makeUser, ownerWithProperty, resetDb, todayStr } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { buildFakeWebhook } from '../../src/modules/payments/service.js';
import { expireStaleReservations } from '../../src/modules/beds/status.js';

async function payToken(paymentId: string) {
  const p = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  const { raw, signature } = buildFakeWebhook(p.gatewayLinkId!, 'success', p.amountPaise);
  await api().post('/webhooks/payments/fake').set('content-type', 'application/json').set('x-fake-signature', signature).send(raw.toString('utf8')).expect(200);
}

describe('booking and token payment', () => {
  beforeEach(resetDb);

  it('tenant opens a PG by invite code and sees only availability, not occupants', async () => {
    const { property } = await ownerWithProperty({ property: { depositMonths: 2, tokenAmountPaise: 300000 } });
    const tenant = await makeUser('TENANT');
    const r = await api().get(`/api/tenant/pg/${property.inviteCode}`).set(tenant.auth).expect(200);
    expect(r.body.tokenAmountPaise).toBe(300000);
    expect(r.body.rooms[0].depositPaise).toBe(2000000);
    expect(r.body.rooms[0].beds[0]).toEqual({ id: expect.any(String), label: 'A', available: true });
    await api().get('/api/tenant/pg/NOPE0000').set(tenant.auth).expect(404);
  });

  it('two tenants racing for one bed: exactly one reservation wins', async () => {
    const { rooms } = await ownerWithProperty();
    const bedId = rooms[0].beds[0].id;
    const tenants = await Promise.all(Array.from({ length: 6 }, () => makeUser('TENANT')));
    const results = await Promise.all(tenants.map((t) => api().post('/api/tenant/bookings').set(t.auth).send({ bedId, moveInDate: todayStr() })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await prisma.booking.count({ where: { bedId, status: { in: ['RESERVED', 'PAID'] } } })).toBe(1);
  });

  it('the database refuses a second live booking on a bed', async () => {
    const { rooms, property } = await ownerWithProperty();
    const [a, b] = await Promise.all([makeUser('TENANT'), makeUser('TENANT')]);
    const base = { propertyId: property.id, bedId: rooms[0].beds[0].id, holdUntil: new Date(Date.now() + 3600e3), moveInDate: new Date(), rentPaise: 1, depositPaise: 1, tokenAmountPaise: 1 };
    await prisma.booking.create({ data: { ...base, tenantUserId: a.user.id } });
    await expect(prisma.booking.create({ data: { ...base, tenantUserId: b.user.id } })).rejects.toThrow();
  });

  it('a reservation expires if unpaid and the bed becomes free', async () => {
    const { rooms } = await ownerWithProperty();
    const bedId = rooms[0].beds[0].id;
    const [a, b] = await Promise.all([makeUser('TENANT'), makeUser('TENANT')]);
    const r = await api().post('/api/tenant/bookings').set(a.auth).send({ bedId, moveInDate: todayStr() }).expect(201);
    expect(r.body.payment.url).toContain('/fake-gateway/pay/');
    await prisma.booking.update({ where: { id: r.body.booking.id }, data: { holdUntil: new Date(Date.now() - 1000) } });
    expect(await expireStaleReservations(prisma)).toBe(1);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id } })).status).toBe('EXPIRED');
    expect((await prisma.invoice.findFirstOrThrow({ where: { bookingId: r.body.booking.id } })).status).toBe('VOID');
    await api().post('/api/tenant/bookings').set(b.auth).send({ bedId, moveInDate: todayStr() }).expect(201);
  });

  it('token paid by webhook → owner confirms → tenancy with token counted towards deposit', async () => {
    const { owner, rooms, property } = await ownerWithProperty({ property: { depositMonths: 2, tokenAmountPaise: 500000 } });
    const tenant = await makeUser('TENANT');
    const r = await api().post('/api/tenant/bookings').set(tenant.auth).send({ bedId: rooms[0].beds[0].id, moveInDate: todayStr() }).expect(201);
    // Owner cannot confirm before the token is paid.
    await api().post(`/api/owner/bookings/${r.body.booking.id}/confirm`).set(owner.auth).expect(409);
    await payToken(r.body.payment.paymentId);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id } })).status).toBe('PAID');
    // Paid bookings no longer expire.
    await prisma.booking.update({ where: { id: r.body.booking.id }, data: { holdUntil: new Date(Date.now() - 1000) } });
    expect(await expireStaleReservations(prisma)).toBe(0);
    const list = await api().get(`/api/owner/bookings?propertyId=${property.id}`).set(owner.auth).expect(200);
    expect(list.body.items).toHaveLength(1);

    const t = await api().post(`/api/owner/bookings/${r.body.booking.id}/confirm`).set(owner.auth).expect(200);
    const ledger = await prisma.depositLedger.findMany({ where: { tenancyId: t.body.id } });
    expect(ledger).toEqual([expect.objectContaining({ type: 'COLLECTED', amountPaise: 500000 })]);
    const dep = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: t.body.id, kind: 'DEPOSIT' } });
    expect(dep.totalPaise).toBe(2000000 - 500000);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: r.body.booking.id } })).status).toBe('CONVERTED');
    const home = await api().get('/api/tenant/home').set(tenant.auth).expect(200);
    expect(home.body.stay.room).toBe('101');
  });

  it('owner can cancel a paid booking; a refund is flagged', async () => {
    const { owner, rooms } = await ownerWithProperty();
    const tenant = await makeUser('TENANT');
    const r = await api().post('/api/tenant/bookings').set(tenant.auth).send({ bedId: rooms[0].beds[0].id, moveInDate: todayStr() }).expect(201);
    await payToken(r.body.payment.paymentId);
    const c = await api().post(`/api/owner/bookings/${r.body.booking.id}/cancel`).set(owner.auth).send({ reason: 'Room under repair' }).expect(200);
    expect(c.body).toMatchObject({ status: 'CANCELLED', refundDue: true });
  });

  it('another owner cannot confirm or cancel the booking', async () => {
    const { rooms } = await ownerWithProperty();
    const other = await makeUser('OWNER');
    const tenant = await makeUser('TENANT');
    const r = await api().post('/api/tenant/bookings').set(tenant.auth).send({ bedId: rooms[0].beds[0].id, moveInDate: todayStr() }).expect(201);
    await api().post(`/api/owner/bookings/${r.body.booking.id}/confirm`).set(other.auth).expect(404);
    await api().post(`/api/owner/bookings/${r.body.booking.id}/cancel`).set(other.auth).send({ reason: 'xxxx' }).expect(404);
  });

  it('a tenant can hold only one reservation', async () => {
    const { rooms } = await ownerWithProperty();
    const tenant = await makeUser('TENANT');
    await api().post('/api/tenant/bookings').set(tenant.auth).send({ bedId: rooms[0].beds[0].id, moveInDate: todayStr() }).expect(201);
    await api().post('/api/tenant/bookings').set(tenant.auth).send({ bedId: rooms[0].beds[1].id, moveInDate: todayStr() }).expect(409);
  });
});
