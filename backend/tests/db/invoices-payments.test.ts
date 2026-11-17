import { beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, makeUser, ownerWithProperty, resetDb } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { generateInvoicesForTenancy, runInvoiceGeneration } from '../../src/modules/invoices/engine.js';
import { buildFakeWebhook } from '../../src/modules/payments/service.js';
import { addDays, parseDateOnly, startOfMonth, todayIST } from '../../src/lib/dates.js';

async function rentInvoice(tenancyId: string) {
  return prisma.invoice.findFirstOrThrow({ where: { tenancyId, kind: 'RENT' }, orderBy: { periodStart: 'asc' } });
}

function sendWebhook(raw: Buffer, signature: string) {
  return api().post('/webhooks/payments/fake').set('content-type', 'application/json').set('x-fake-signature', signature).send(raw.toString('utf8'));
}

describe('invoice engine', () => {
  beforeEach(resetDb);

  it('generation is idempotent', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const before = await prisma.invoice.count({ where: { tenancyId: tenancy.id, kind: 'RENT' } });
    expect(before).toBe(1);
    await runInvoiceGeneration();
    await runInvoiceGeneration();
    expect(await generateInvoicesForTenancy(prisma, tenancy.id)).toBe(0);
    expect(await prisma.invoice.count({ where: { tenancyId: tenancy.id, kind: 'RENT' } })).toBe(1);
  });

  it('concurrent generation runs never create duplicates', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const nextMonth = addDays(startOfMonth(addDays(startOfMonth(todayIST()), 40)), 0);
    await Promise.all(Array.from({ length: 5 }, () => generateInvoicesForTenancy(prisma, tenancy.id, nextMonth)));
    expect(await prisma.invoice.count({ where: { tenancyId: tenancy.id, kind: 'RENT' } })).toBe(2);
  });

  it('prorates the first month for a mid-month join', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const t = todayIST();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id, { rentPaise: 900000 });
    const inv = await rentInvoice(tenancy.id);
    const dim = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    const days = dim - t.getUTCDate() + 1;
    expect(inv.totalPaise).toBe(Math.floor((900000 * days * 2 + dim) / (2 * dim)));
  });

  it('existing tenants joined long ago are billed from this month only', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-15' });
    const invs = await prisma.invoice.findMany({ where: { tenancyId: tenancy.id, kind: 'RENT' } });
    expect(invs).toHaveLength(1);
    expect(invs[0].periodStart!.getTime()).toBe(startOfMonth(todayIST()).getTime());
    expect(invs[0].totalPaise).toBe(1000000);
  });

  it('includes recurring extra charges', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01', charges: [{ name: 'Food', amountPaise: 300000 }] });
    const inv = await rentInvoice(tenancy.id);
    expect(inv.totalPaise).toBe(1300000);
  });
});

describe('owner-recorded payments', () => {
  beforeEach(resetDb);

  it('cash partial then full payment moves DUE → PARTIAL → PAID with audit rows', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01' });
    const inv = await rentInvoice(tenancy.id);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 400000, method: 'CASH' }).expect(201);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PARTIAL');
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 600001, method: 'UPI_DIRECT' }).expect(400);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 600000, method: 'UPI_DIRECT', note: 'GPay' }).expect(201);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after).toMatchObject({ status: 'PAID', paidPaise: 1000000 });
    expect(await prisma.auditLog.count({ where: { entityId: inv.id, action: 'PAYMENT_RECORDED' } })).toBe(2);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 1, method: 'CASH' }).expect(409);
  });

  it('rejects float amounts', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const inv = await rentInvoice(tenancy.id);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 100.5, method: 'CASH' }).expect(400);
  });

  it('paying a deposit invoice writes the deposit ledger', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id, { depositPaise: 2000000, depositCollectedPaise: 0 });
    const dep = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: tenancy.id, kind: 'DEPOSIT' } });
    await api().post(`/api/owner/invoices/${dep.id}/payments`).set(owner.auth).send({ amountPaise: 2000000, method: 'CASH' }).expect(201);
    const ledger = await prisma.depositLedger.findMany({ where: { tenancyId: tenancy.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'COLLECTED', amountPaise: 2000000 });
  });

  it('adds extra lines and discounts with audit; voids only unpaid invoices', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01' });
    const inv = await rentInvoice(tenancy.id);
    await api().post(`/api/owner/invoices/${inv.id}/lines`).set(owner.auth).send({ description: 'Electricity', amountPaise: 45000 }).expect(200);
    await api().post(`/api/owner/invoices/${inv.id}/lines`).set(owner.auth).send({ description: 'Festival discount', amountPaise: -5000 }).expect(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).totalPaise).toBe(1040000);
    expect(await prisma.auditLog.count({ where: { entityId: inv.id, action: 'INVOICE_ADJUSTED' } })).toBe(2);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 100, method: 'CASH' }).expect(201);
    await api().post(`/api/owner/invoices/${inv.id}/void`).set(owner.auth).send({ reason: 'mistake' }).expect(409);
  });

  it('receipt PDF is generated for the owner and the tenant only', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const inv = await rentInvoice(tenancy.id);
    const p = await api().post(`/api/owner/invoices/${inv.id}/payments`).set(owner.auth).send({ amountPaise: 1000, method: 'CASH' }).expect(201);
    const r = await api().get(`/api/owner/payments/${p.body.id}/receipt.pdf`).set(owner.auth).expect(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(r.body).subarray(0, 5).toString()).toBe('%PDF-');
    await api().get(`/api/tenant/payments/${p.body.id}/receipt.pdf`).set(tenant.auth).expect(200);
    const stranger = await makeUser('TENANT');
    await api().get(`/api/tenant/payments/${p.body.id}/receipt.pdf`).set(stranger.auth).expect(404);
    const otherOwner = await makeUser('OWNER');
    await api().get(`/api/owner/payments/${p.body.id}/receipt.pdf`).set(otherOwner.auth).expect(404);
  });
});

describe('gateway webhooks', () => {
  beforeEach(resetDb);

  async function setup() {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01' });
    const inv = await rentInvoice(tenancy.id);
    const link = await api().post(`/api/tenant/invoices/${inv.id}/pay-link`).set(tenant.auth).expect(201);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: link.body.paymentId } });
    return { inv, payment, tenant, link };
  }

  it('a verified webhook marks the invoice paid; replaying it changes nothing', async () => {
    const { inv, payment } = await setup();
    const { raw, signature } = buildFakeWebhook(payment.gatewayLinkId!, 'success', payment.amountPaise, 'evt_1');
    await sendWebhook(raw, signature).expect(200);
    let after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after).toMatchObject({ status: 'PAID', paidPaise: 1000000 });
    const replay = await sendWebhook(raw, signature).expect(200);
    expect(replay.body.duplicate).toBe(true);
    after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.paidPaise).toBe(1000000);
    expect(await prisma.payment.count({ where: { invoiceId: inv.id, status: 'SUCCESS' } })).toBe(1);
  });

  it('a second, different success event for the same link is ignored', async () => {
    const { inv, payment } = await setup();
    const a = buildFakeWebhook(payment.gatewayLinkId!, 'success', payment.amountPaise, 'evt_a');
    const b = buildFakeWebhook(payment.gatewayLinkId!, 'success', payment.amountPaise, 'evt_b');
    await Promise.all([sendWebhook(a.raw, a.signature), sendWebhook(b.raw, b.signature)]);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).paidPaise).toBe(1000000);
  });

  it('rejects bad signatures and records them', async () => {
    const { inv, payment } = await setup();
    const { raw } = buildFakeWebhook(payment.gatewayLinkId!, 'success', payment.amountPaise);
    await sendWebhook(raw, 'deadbeef').expect(400);
    await api().post('/webhooks/payments/fake').set('content-type', 'application/json').send(raw.toString('utf8')).expect(400);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('DUE');
    expect(await prisma.webhookEvent.count({ where: { status: 'REJECTED' } })).toBe(2);
  });

  it('a tampered body fails verification', async () => {
    const { payment } = await setup();
    const { raw, signature } = buildFakeWebhook(payment.gatewayLinkId!, 'success', 100);
    const tampered = Buffer.from(raw.toString().replace('"amountPaise":100', '"amountPaise":1000000'));
    await sendWebhook(tampered, signature).expect(400);
  });

  it('handles partial payments', async () => {
    const { inv, payment, tenant } = await setup();
    const { raw, signature } = buildFakeWebhook(payment.gatewayLinkId!, 'success', 400000);
    await sendWebhook(raw, signature).expect(200);
    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after).toMatchObject({ status: 'PARTIAL', paidPaise: 400000 });
    // A new link is for the remaining balance only.
    const link2 = await api().post(`/api/tenant/invoices/${inv.id}/pay-link`).set(tenant.auth).expect(201);
    expect(link2.body.amountPaise).toBe(600000);
  });

  it('a failed payment leaves the invoice due', async () => {
    const { inv, payment } = await setup();
    const { raw, signature } = buildFakeWebhook(payment.gatewayLinkId!, 'fail', payment.amountPaise);
    await sendWebhook(raw, signature).expect(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('DUE');
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe('FAILED');
  });

  it('there is no client-side way to mark an invoice paid', async () => {
    const { inv, tenant } = await setup();
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(tenant.auth).send({ amountPaise: 1000000, method: 'CASH' }).expect(403);
    await api().post(`/api/tenant/invoices/${inv.id}/paid`).set(tenant.auth).send({}).expect(404);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('DUE');
  });

  it('the sandbox checkout page pays through the signed webhook path', async () => {
    const { inv, link } = await setup();
    const path = new URL(link.body.url).pathname;
    const page = await api().get(path).expect(200);
    expect(page.text).toContain('SANDBOX');
    await api().post(`${path}/complete`).type('form').send({ outcome: 'success' }).expect(200);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('PAID');
    expect(await prisma.webhookEvent.count({ where: { status: 'PROCESSED' } })).toBe(1);
  });
});

describe('ending a tenancy adjusts invoices', () => {
  beforeEach(resetDb);
  it('prorates the final month and voids later unpaid invoices', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01', rentPaise: 930000 });
    const next = startOfMonth(addDays(startOfMonth(todayIST()), 40));
    await generateInvoicesForTenancy(prisma, tenancy.id, next);
    const thisMonth = startOfMonth(todayIST());
    const end = addDays(thisMonth, 9); // 10th of this month
    await api().post(`/api/owner/tenancies/${tenancy.id}/end`).set(owner.auth).send({ endDate: end.toISOString().slice(0, 10) }).expect(200);
    const invs = await prisma.invoice.findMany({ where: { tenancyId: tenancy.id, kind: 'RENT' }, orderBy: { periodStart: 'asc' } });
    const dim = new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() + 1, 0)).getUTCDate();
    expect(invs[0].totalPaise).toBe(Math.floor((930000 * 10 * 2 + dim) / (2 * dim)));
    expect(invs[0].periodEnd!.getTime()).toBe(parseDateOnly(end.toISOString().slice(0, 10)).getTime());
    expect(invs[1].status).toBe('VOID');
  });
});
