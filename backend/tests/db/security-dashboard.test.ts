import { beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, makeUser, ownerWithProperty, resetDb, todayStr } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { runRentReminders, runVerificationReminders } from '../../src/jobs/reminders.js';
import { addDays, todayIST } from '../../src/lib/dates.js';

describe('cross-owner and cross-tenant isolation', () => {
  beforeEach(resetDb);

  it('owner A cannot read owner B’s properties, tenants, invoices, complaints, bookings or exports', async () => {
    const A = await ownerWithProperty();
    const B = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(B.owner, B.property.id, B.rooms[0].beds[0].id);
    const inv = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: tenancy.id } });
    const c = await api().post('/api/tenant/complaints').set(tenant.auth).send({ category: 'OTHER', description: 'Something broke' }).expect(201);
    const a = A.owner.auth;

    await api().get(`/api/owner/properties/${B.property.id}`).set(a).expect(404);
    await api().get(`/api/owner/tenancies/${tenancy.id}`).set(a).expect(404);
    await api().patch(`/api/owner/tenancies/${tenancy.id}`).set(a).send({ rentPaise: 1 }).expect(404);
    await api().post(`/api/owner/tenancies/${tenancy.id}/end`).set(a).send({ endDate: todayStr() }).expect(404);
    await api().get(`/api/owner/invoices/${inv.id}`).set(a).expect(404);
    await api().post(`/api/owner/invoices/${inv.id}/payments`).set(a).send({ amountPaise: 1, method: 'CASH' }).expect(404);
    await api().post(`/api/owner/invoices/${inv.id}/payment-link`).set(a).expect(404);
    await api().get(`/api/owner/complaints/${c.body.id}`).set(a).expect(404);
    await api().post('/api/owner/verification/export').set(a).send({ tenancyIds: [tenancy.id], format: 'csv' }).expect(404);
    await api().post(`/api/owner/tenancies/${tenancy.id}/agreement`).set(a).expect(404);

    // Lists are scoped, and filtering by another owner's propertyId returns nothing.
    for (const path of ['/api/owner/tenants', '/api/owner/invoices', '/api/owner/complaints']) {
      const r = await api().get(`${path}?propertyId=${B.property.id}`).set(a).expect(200);
      expect(r.body.total).toBe(0);
    }
    const dash = await api().get(`/api/owner/dashboard?propertyId=${B.property.id}`).set(a).expect(200);
    expect(dash.body.occupancy.totalBeds).toBe(0);
  });

  it('a tenant cannot read another tenant’s invoices, payments or stay', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const t1 = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const t2 = await addTenant(owner, property.id, rooms[0].beds[1].id);
    const inv2 = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: t2.tenancy.id } });
    await api().get(`/api/tenant/invoices/${inv2.id}`).set(t1.tenant.auth).expect(404);
    await api().post(`/api/tenant/invoices/${inv2.id}/pay-link`).set(t1.tenant.auth).expect(404);
    const mine = await api().get('/api/tenant/invoices').set(t1.tenant.auth).expect(200);
    expect(mine.body.items.every((i: { tenancyId: string }) => i.tenancyId === t1.tenancy.id)).toBe(true);
  });

  it('errors never leak internals', async () => {
    const owner = await makeUser('OWNER');
    const r = await api().post('/api/owner/properties').set(owner.auth).set('content-type', 'application/json').send('{bad json').expect(400);
    expect(r.body.error.code).toBe('BAD_REQUEST');
    const nf = await api().get('/api/does-not-exist').expect(404);
    expect(nf.body).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('SQL-ish input is treated as data', async () => {
    const { owner } = await ownerWithProperty();
    const r = await api().get(`/api/owner/tenants?search=${encodeURIComponent("' OR 1=1 --")}`).set(owner.auth).expect(200);
    expect(r.body.total).toBe(0);
  });

  it('admin can search, view audit, deactivate (audited); deactivated user is locked out', async () => {
    const admin = await makeUser('ADMIN');
    const { owner } = await ownerWithProperty();
    const s = await api().get(`/api/admin/users?phone=${owner.user.phone.slice(-6)}`).set(admin.auth).expect(200);
    expect(s.body.items[0].id).toBe(owner.user.id);
    await api().post(`/api/admin/users/${owner.user.id}/deactivate`).set(admin.auth).send({ reason: 'Fraud report' }).expect(200);
    await api().get('/api/owner/properties').set(owner.auth).expect(401);
    const audit = await api().get(`/api/admin/users/${owner.user.id}/audit`).set(admin.auth).expect(200);
    expect(audit.body.items.map((x: { action: string }) => x.action)).toContain('USER_DEACTIVATED');
    await api().get('/api/admin/webhooks').set(admin.auth).expect(200);
    await api().get('/api/admin/payments/failed').set(admin.auth).expect(200);
  });
});

describe('dashboard', () => {
  beforeEach(resetDb);

  it('aggregates occupancy, collections, overdue and pending work', async () => {
    const { owner, property, rooms } = await ownerWithProperty({ rooms: [{ name: '1', sharingType: 4, rentPaise: 1000000 }] });
    const t1 = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01' });
    await addTenant(owner, property.id, rooms[0].beds[1].id, { joinDate: '2024-01-01' });
    const inv1 = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: t1.tenancy.id, kind: 'RENT' } });
    await api().post(`/api/owner/invoices/${inv1.id}/payments`).set(owner.auth).send({ amountPaise: 1000000, method: 'CASH' }).expect(201);
    // Make the other tenant's invoice overdue.
    await prisma.invoice.updateMany({ where: { status: 'DUE', kind: 'RENT' }, data: { dueDate: addDays(todayIST(), -2) } });

    const d = await api().get('/api/owner/dashboard').set(owner.auth).expect(200);
    expect(d.body.occupancy).toMatchObject({ totalBeds: 4, occupied: 2, vacant: 2, occupancyBps: 5000 });
    expect(d.body.month.collectedPaise).toBe(1000000);
    expect(d.body.overdue).toHaveLength(1);
    expect(d.body.overdue[0].overduePaise).toBe(1000000);
    expect(d.body.pending.verification).toBe(2);
    expect(d.body.openComplaints).toBe(0);
  });
});

describe('reminder scheduler', () => {
  beforeEach(resetDb);

  it('sends −3/0/+3 day reminders once each, never in quiet hours, and respects the owner switch', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01' });
    const inv = await prisma.invoice.findFirstOrThrow({ where: { tenancyId: tenancy.id, kind: 'RENT' } });
    const noonIST = new Date(Date.UTC(todayIST().getUTCFullYear(), todayIST().getUTCMonth(), todayIST().getUTCDate(), 6, 30)); // 12:00 IST
    const tonight = new Date(noonIST.getTime() + 10 * 3600e3); // 22:00 IST

    await prisma.invoice.update({ where: { id: inv.id }, data: { dueDate: addDays(todayIST(), 3) } });
    expect((await runRentReminders(tonight)).sent).toBe(0);
    expect((await runRentReminders(noonIST)).sent).toBe(1);
    expect((await runRentReminders(noonIST)).sent).toBe(0); // no duplicates

    await prisma.invoice.update({ where: { id: inv.id }, data: { dueDate: todayIST() } });
    expect((await runRentReminders(noonIST)).sent).toBe(1);
    await prisma.invoice.update({ where: { id: inv.id }, data: { dueDate: addDays(todayIST(), -3) } });
    expect((await runRentReminders(noonIST)).sent).toBe(1);
    await prisma.invoice.update({ where: { id: inv.id }, data: { dueDate: addDays(todayIST(), -1) } });
    expect((await runRentReminders(noonIST)).sent).toBe(0);

    const notes = await prisma.notification.findMany({ where: { userId: tenant.user.id } });
    expect(notes.map((n) => n.title).sort()).toEqual(['Rent due soon', 'Rent due today', 'Rent overdue']);

    // Owner switches reminders off.
    await api().patch(`/api/owner/properties/${property.id}`).set(owner.auth).send({ remindersEnabled: false }).expect(200);
    await prisma.reminderLog.deleteMany({});
    expect((await runRentReminders(noonIST)).sent).toBe(0);
  });

  it('reminds the owner about pending police verification', async () => {
    const { owner, property, rooms } = await ownerWithProperty({ property: { verificationReminderDays: 3 } });
    await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01' });
    const noonIST = new Date(Date.UTC(todayIST().getUTCFullYear(), todayIST().getUTCMonth(), todayIST().getUTCDate(), 6, 30));
    expect((await runVerificationReminders(noonIST)).sent).toBe(1);
    expect((await runVerificationReminders(noonIST)).sent).toBe(0);
  });
});

describe('verification export', () => {
  beforeEach(resetDb);

  it('exports CSV with only the last 4 ID digits and tracks status', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id, { name: '=HYPERLINK("x")' });
    await prisma.tenantProfile.update({ where: { userId: tenant.user.id }, data: { idType: 'AADHAAR', idLast4: '9012' } });
    const r = await api().post('/api/owner/verification/export').set(owner.auth).send({ tenancyIds: [tenancy.id], format: 'csv' }).expect(200);
    expect(r.text).toContain('XXXX9012');
    expect(r.text).toContain(`"'=HYPERLINK(""x"")"`); // formula injection neutralised
    const pdf = await api().post('/api/owner/verification/export').set(owner.auth).send({ tenancyIds: [tenancy.id], format: 'pdf' }).expect(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    const rec = await prisma.verificationRecord.findUniqueOrThrow({ where: { tenancyId: tenancy.id } });
    await api().patch(`/api/owner/verification/${rec.id}`).set(owner.auth).send({ status: 'SUBMITTED', reference: 'KOR/123' }).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'VERIFICATION_STATUS_CHANGED' } })).toBe(1);
  });
});
