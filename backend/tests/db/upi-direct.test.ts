import { beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, makeUser, ownerWithProperty, resetDb, todayStr } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { expireStaleReservations } from '../../src/modules/beds/status.js';

async function setup(upiId: string | null = 'ramesh.kumar@okaxis') {
  const { owner, property, rooms } = await ownerWithProperty();
  if (upiId) await api().patch(`/api/owner/properties/${property.id}`).set(owner.auth).send({ upiId, upiPayeeName: 'Ramesh Kumar' }).expect(200);
  const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01', rentPaise: 850000 });
  const inv = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: tenancy.id, kind: 'RENT' } });
  return { owner, property, rooms, tenancy, tenant, inv };
}

const report = (auth: Record<string, string>, invoiceId: string, body: Record<string, unknown> = {}) =>
  api().post(`/api/tenant/invoices/${invoiceId}/upi-report`).set(auth).send(body);

describe('owner UPI settings', () => {
  beforeEach(resetDb);

  it('validates and normalises the UPI ID, and audits every change', async () => {
    const { owner, property } = await ownerWithProperty();
    await api().patch(`/api/owner/properties/${property.id}`).set(owner.auth).send({ upiId: 'not a upi id' }).expect(400);
    await api().patch(`/api/owner/properties/${property.id}`).set(owner.auth).send({ upiId: 'name@' }).expect(400);
    const r = await api().patch(`/api/owner/properties/${property.id}`).set(owner.auth).send({ upiId: ' Ramesh.Kumar@OKAXIS ', upiPayeeName: 'Ramesh Kumar' }).expect(200);
    expect(r.body.upiId).toBe('ramesh.kumar@okaxis');
    await api().patch(`/api/owner/properties/${property.id}`).set(owner.auth).send({ upiId: '9876543210@ybl' }).expect(200);
    const logs = await prisma.auditLog.findMany({ where: { entityId: property.id, action: 'UPI_ID_CHANGED' }, orderBy: { createdAt: 'asc' } });
    expect(logs).toHaveLength(2);
    expect(logs[1].before).toMatchObject({ upiId: 'ramesh.kumar@okaxis' });
    expect(logs[1].actorId).toBe(owner.user.id);
  });

  it('another owner cannot change it', async () => {
    const { property } = await ownerWithProperty();
    const other = await makeUser('OWNER');
    await api().patch(`/api/owner/properties/${property.id}`).set(other.auth).send({ upiId: 'thief@okaxis' }).expect(404);
  });
});

describe('tenant reports a direct UPI payment', () => {
  beforeEach(resetDb);

  it('shows the owner UPI details and hides the gateway', async () => {
    const { tenant } = await setup();
    const r = await api().get('/api/tenant/invoices?status=UNPAID').set(tenant.auth).expect(200);
    expect(r.body.items[0].payOptions).toEqual({ upi: { upiId: 'ramesh.kumar@okaxis', payeeName: 'Ramesh Kumar' }, gateway: false });
    await api().post(`/api/tenant/invoices/${r.body.items[0].id}/pay-link`).set(tenant.auth).expect(409);
  });

  it('a report does NOT change the invoice; the owner is notified', async () => {
    const { tenant, owner, inv } = await setup();
    const r = await report(tenant.auth, inv.id, { upiRef: '4123 4567 8901' }).expect(201);
    expect(r.body).toMatchObject({ status: 'REPORTED', amountPaise: 850000, upiRef: '412345678901' });
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after).toMatchObject({ status: 'DUE', paidPaise: 0 });
    const note = await prisma.notification.findFirst({ where: { userId: owner.user.id, title: 'Payment to confirm' } });
    expect(note?.body).toContain('412345678901');
  });

  it('validates amounts and reference numbers', async () => {
    const { tenant, inv } = await setup();
    await report(tenant.auth, inv.id, { upiRef: '12345' }).expect(400);
    await report(tenant.auth, inv.id, { amountPaise: 850001 }).expect(400);
    await report(tenant.auth, inv.id, { amountPaise: 100.5 }).expect(400);
    await report(tenant.auth, inv.id, { amountPaise: 500000 }).expect(201);
    // Only the remaining ₹3,500 can still be reported.
    await report(tenant.auth, inv.id, { amountPaise: 400000 }).expect(400);
    await report(tenant.auth, inv.id).expect(201);
    await report(tenant.auth, inv.id).expect(409); // nothing left to report
  });

  it('the same UPI reference cannot be used twice', async () => {
    const { owner, property, rooms, tenant, inv } = await setup();
    await report(tenant.auth, inv.id, { upiRef: '999988887777' }).expect(201);
    const b = await addTenant(owner, property.id, rooms[0].beds[1].id, { joinDate: '2024-01-01' });
    const inv2 = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: b.tenancy.id, kind: 'RENT' } });
    const r = await report(b.tenant.auth, inv2.id, { upiRef: '999988887777' }).expect(409);
    expect(r.body.error.message).toMatch(/already used/);
  });

  it('cannot report on someone else’s invoice, a paid invoice, or a PG without a UPI ID', async () => {
    const { tenant, inv, owner } = await setup();
    const stranger = await makeUser('TENANT');
    await report(stranger.auth, inv.id).expect(404);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 850000, method: 'CASH' }).expect(201);
    await report(tenant.auth, inv.id).expect(409);

    await resetDb();
    const noUpi = await setup(null);
    await report(noUpi.tenant.auth, noUpi.inv.id).expect(409);
  });

  it('a tenant can withdraw their own pending report, nobody else can', async () => {
    const { tenant, inv } = await setup();
    const r = await report(tenant.auth, inv.id).expect(201);
    const other = await makeUser('TENANT');
    await api().post(`/api/tenant/payments/${r.body.id}/withdraw`).set(other.auth).expect(404);
    await api().post(`/api/tenant/payments/${r.body.id}/withdraw`).set(tenant.auth).expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('FAILED');
  });
});

describe('owner confirms or rejects', () => {
  beforeEach(resetDb);

  it('confirm applies the money once, writes an audit row, and issues a receipt', async () => {
    const { tenant, owner, inv, property } = await setup();
    const r = await report(tenant.auth, inv.id, { upiRef: '111122223333' }).expect(201);
    const list = await api().get(`/api/owner/payments/reported?propertyId=${property.id}`).set(owner.auth).expect(200);
    expect(list.body.items).toHaveLength(1);
    const dash = await api().get('/api/owner/dashboard').set(owner.auth).expect(200);
    expect(dash.body.pending.paymentsToConfirm).toBe(1);

    const results = await Promise.all([1, 2, 3].map(() => api().post(`/api/owner/payments/${r.body.id}/confirm`).set(owner.auth).send({})));
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after).toMatchObject({ status: 'PAID', paidPaise: 850000 });
    expect(await prisma.auditLog.count({ where: { entityId: inv.id, action: 'PAYMENT_CONFIRMED' } })).toBe(1);
    const pdf = await api().get(`/api/tenant/payments/${r.body.id}/receipt.pdf`).set(tenant.auth).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(await prisma.notification.count({ where: { userId: tenant.user.id, title: 'Payment confirmed' } })).toBe(1);
  });

  it('the owner can confirm a smaller amount actually received (partial)', async () => {
    const { tenant, owner, inv } = await setup();
    const r = await report(tenant.auth, inv.id).expect(201);
    await api().post(`/api/owner/payments/${r.body.id}/confirm`).set(owner.auth).send({ amountPaise: 300000 }).expect(200);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ status: 'PARTIAL', paidPaise: 300000 });
  });

  it('reject needs a reason, leaves the invoice due and tells the tenant', async () => {
    const { tenant, owner, inv } = await setup();
    const r = await report(tenant.auth, inv.id).expect(201);
    await api().post(`/api/owner/payments/${r.body.id}/reject`).set(owner.auth).send({}).expect(400);
    await api().post(`/api/owner/payments/${r.body.id}/reject`).set(owner.auth).send({ reason: 'Not in my account' }).expect(200);
    expect(await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).toMatchObject({ status: 'DUE', paidPaise: 0 });
    await api().post(`/api/owner/payments/${r.body.id}/confirm`).set(owner.auth).send({}).expect(409);
    const n = await prisma.notification.findFirst({ where: { userId: tenant.user.id, title: 'Payment not received' } });
    expect(n?.body).toContain('Not in my account');
    // The tenant can report again after a rejection.
    await report(tenant.auth, inv.id).expect(201);
  });

  it('only the owning owner can confirm or reject; tenants cannot confirm their own report', async () => {
    const { tenant, inv } = await setup();
    const r = await report(tenant.auth, inv.id).expect(201);
    const other = await makeUser('OWNER');
    await api().post(`/api/owner/payments/${r.body.id}/confirm`).set(other.auth).send({}).expect(404);
    await api().post(`/api/owner/payments/${r.body.id}/reject`).set(other.auth).send({ reason: 'nope' }).expect(404);
    await api().post(`/api/owner/payments/${r.body.id}/confirm`).set(tenant.auth).send({}).expect(403);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('DUE');
  });

  it('confirm fails cleanly if the owner already recorded the money in cash', async () => {
    const { tenant, owner, inv } = await setup();
    const r = await report(tenant.auth, inv.id).expect(201);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 850000, method: 'CASH' }).expect(201);
    await api().post(`/api/owner/payments/${r.body.id}/confirm`).set(owner.auth).send({}).expect(409);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).paidPaise).toBe(850000);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: r.body.id } })).status).toBe('REPORTED');
  });
});

describe('booking token paid by direct UPI', () => {
  beforeEach(resetDb);

  it('no gateway link; report keeps the bed held; confirm marks the booking paid', async () => {
    const { owner, property, rooms } = await ownerWithProperty({ property: { tokenAmountPaise: 200000 } });
    await api().patch(`/api/owner/properties/${property.id}`).set(owner.auth).send({ upiId: 'ramesh@okaxis' }).expect(200);
    const tenant = await makeUser('TENANT');
    const b = await api().post('/api/tenant/bookings').set(tenant.auth).send({ bedId: rooms[0].beds[0].id, moveInDate: todayStr() }).expect(201);
    expect(b.body.payment).toBeNull();
    expect(b.body.payOptions.upi.upiId).toBe('ramesh@okaxis');

    const r = await report(tenant.auth, b.body.invoice.id, { upiRef: '555566667777' }).expect(201);
    // Hold was extended, and even past it the booking does not expire while the report is pending.
    const held = await prisma.booking.findUniqueOrThrow({ where: { id: b.body.booking.id } });
    expect(held.holdUntil.getTime()).toBeGreaterThan(Date.now() + 70 * 3600e3);
    await prisma.booking.update({ where: { id: held.id }, data: { holdUntil: new Date(Date.now() - 1000) } });
    expect(await expireStaleReservations(prisma)).toBe(0);

    await api().post(`/api/owner/payments/${r.body.id}/confirm`).set(owner.auth).send({}).expect(200);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: held.id } })).status).toBe('PAID');
    await api().post(`/api/owner/bookings/${held.id}/confirm`).set(owner.auth).expect(200);
  });
});
