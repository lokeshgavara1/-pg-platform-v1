import { beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, makeUser, ownerWithProperty, resetDb, uploadFile } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { addDays, todayIST, toDateString } from '../../src/lib/dates.js';

describe('complaints visibility and updates', () => {
  beforeEach(resetDb);

  async function setup() {
    const { owner, property, rooms } = await ownerWithProperty({ rooms: [{ name: '1', sharingType: 2, rentPaise: 100000 }] });
    const a = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const b = await addTenant(owner, property.id, rooms[0].beds[1].id);
    const s = await api().post(`/api/owner/properties/${property.id}/staff`).set(owner.auth).send({ phone: '9822222222', name: 'Staff One' }).expect(201);
    const staff = { auth: { Authorization: `Bearer ${signAccessToken(s.body.userId, 'STAFF')}` }, id: s.body.userId as string };
    const photo = await uploadFile(a.tenant, 'COMPLAINT_PHOTO');
    const c = await api().post('/api/tenant/complaints').set(a.tenant.auth).send({ category: 'PLUMBING', description: 'Tap is leaking badly', photoFileIds: [photo] }).expect(201);
    return { owner, property, a, b, staff, complaint: c.body, photo };
  }

  it('tenant sees only their own complaints', async () => {
    const { a, b, complaint } = await setup();
    expect((await api().get('/api/tenant/complaints').set(a.tenant.auth).expect(200)).body.items).toHaveLength(1);
    expect((await api().get('/api/tenant/complaints').set(b.tenant.auth).expect(200)).body.items).toHaveLength(0);
    await api().get(`/api/tenant/complaints/${complaint.id}`).set(b.tenant.auth).expect(404);
  });

  it('allows at most 3 photos', async () => {
    const { a } = await setup();
    const ids = await Promise.all([1, 2, 3, 4].map(() => uploadFile(a.tenant, 'COMPLAINT_PHOTO')));
    await api().post('/api/tenant/complaints').set(a.tenant.auth).send({ category: 'WIFI', description: 'No internet at all', photoFileIds: ids }).expect(400);
  });

  it('another owner cannot see or update; staff only after assignment', async () => {
    const { owner, staff, complaint, photo } = await setup();
    const other = await makeUser('OWNER');
    await api().get(`/api/owner/complaints/${complaint.id}`).set(other.auth).expect(404);
    await api().post(`/api/owner/complaints/${complaint.id}/updates`).set(other.auth).send({ message: 'hi there' }).expect(404);
    await api().get(`/api/owner/complaints/${complaint.id}`).set(staff.auth).expect(404);
    await api().get(`/api/files/${photo}/view-url`).set(staff.auth).expect(404);

    await api().post(`/api/owner/complaints/${complaint.id}/assign`).set(owner.auth).send({ staffUserId: staff.id }).expect(200);
    await api().get(`/api/owner/complaints/${complaint.id}`).set(staff.auth).expect(200);
    await api().get(`/api/files/${photo}/view-url`).set(staff.auth).expect(200);
    await api().post(`/api/owner/complaints/${complaint.id}/updates`).set(staff.auth).send({ message: 'Plumber is coming', status: 'IN_PROGRESS' }).expect(200);
    // Staff cannot close or reassign.
    await api().post(`/api/owner/complaints/${complaint.id}/close`).set(staff.auth).send({ note: 'done' }).expect(403);
    await api().post(`/api/owner/complaints/${complaint.id}/assign`).set(staff.auth).send({ staffUserId: null }).expect(403);
  });

  it('every status change notifies the tenant; closing needs a note', async () => {
    const { owner, a, complaint } = await setup();
    await api().post(`/api/owner/complaints/${complaint.id}/updates`).set(owner.auth).send({ message: 'Looking into it', status: 'IN_PROGRESS' }).expect(200);
    await api().post(`/api/owner/complaints/${complaint.id}/close`).set(owner.auth).send({}).expect(400);
    const closed = await api().post(`/api/owner/complaints/${complaint.id}/close`).set(owner.auth).send({ note: 'Tap replaced' }).expect(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', closingNote: 'Tap replaced' });
    const n = await prisma.notification.findMany({ where: { userId: a.tenant.user.id } });
    expect(n.filter((x) => /complaint/i.test(x.title + x.body)).length).toBeGreaterThanOrEqual(2);
    await api().post(`/api/owner/complaints/${complaint.id}/updates`).set(owner.auth).send({ message: 'again' }).expect(409);
  });

  it('notices reach the right tenants', async () => {
    const { owner, property, a } = await setup();
    await api().post('/api/owner/notices').set(owner.auth).send({ propertyId: property.id, title: 'Diwali party', body: 'Terrace at 7 pm' }).expect(201);
    const r = await api().get('/api/tenant/notices').set(a.tenant.auth).expect(200);
    expect(r.body.items[0].title).toBe('Diwali party');
    const outsider = await makeUser('TENANT');
    expect((await api().get('/api/tenant/notices').set(outsider.auth).expect(200)).body.items).toHaveLength(0);
  });
});

describe('move-out notice and deposit settlement', () => {
  beforeEach(resetDb);

  async function setup(minNoticeDays = 15) {
    const { owner, property, rooms } = await ownerWithProperty({ property: { minNoticeDays } });
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id, { joinDate: '2024-01-01', depositPaise: 2000000, depositCollectedPaise: 2000000 });
    return { owner, property, rooms, tenancy, tenant };
  }

  it('respects the minimum notice days', async () => {
    const { tenant } = await setup(15);
    await api().post('/api/tenant/move-out').set(tenant.auth).send({ moveOutDate: toDateString(addDays(todayIST(), 10)) }).expect(400);
    await api().post('/api/tenant/move-out').set(tenant.auth).send({ moveOutDate: toDateString(addDays(todayIST(), 15)) }).expect(201);
  });

  it('full flow: notice → accept → inspection → settlement → dispute → revise → accept → complete', async () => {
    const { owner, tenant, tenancy, rooms, property } = await setup(0);
    const date = toDateString(addDays(todayIST(), 3));
    await api().post('/api/tenant/move-out').set(tenant.auth).send({ moveOutDate: date }).expect(201);
    const mo = await prisma.moveOut.findUniqueOrThrow({ where: { tenancyId: tenancy.id } });

    await api().post(`/api/owner/move-outs/${mo.id}/settlement`).set(owner.auth).send({ deductions: [] }).expect(409); // not accepted yet
    await api().post(`/api/owner/move-outs/${mo.id}/accept`).set(owner.auth).send({}).expect(200);
    expect((await prisma.tenancy.findUniqueOrThrow({ where: { id: tenancy.id } })).status).toBe('NOTICE');

    await api()
      .post(`/api/owner/move-outs/${mo.id}/inspection`)
      .set(owner.auth)
      .send({ checklist: [{ item: 'Walls', ok: false, note: 'Marks' }, { item: 'Keys returned', ok: true }] })
      .expect(200);

    const photo = await uploadFile(owner, 'DEDUCTION_PHOTO');
    const s1 = await api()
      .post(`/api/owner/move-outs/${mo.id}/settlement`)
      .set(owner.auth)
      .send({ deductions: [{ reason: 'Wall repaint', amountPaise: 300000, photoFileId: photo }, { reason: 'Lost key', amountPaise: 50000 }] })
      .expect(200);
    expect(s1.body).toMatchObject({ status: 'SETTLEMENT_PROPOSED', depositHeldPaise: 2000000, deductionsPaise: 350000, refundPaise: 1650000 });
    // Tenant can view the deduction photo on their own settlement.
    await api().get(`/api/files/${photo}/view-url`).set(tenant.auth).expect(200);

    await api().post('/api/tenant/move-out/dispute').set(tenant.auth).send({ comment: 'Walls were already marked when I moved in' }).expect(200);
    await api().post(`/api/owner/move-outs/${mo.id}/complete`).set(owner.auth).expect(409);
    const s2 = await api().post(`/api/owner/move-outs/${mo.id}/settlement`).set(owner.auth).send({ deductions: [{ reason: 'Lost key', amountPaise: 50000 }] }).expect(200);
    expect(s2.body.refundPaise).toBe(1950000);
    expect(await prisma.settlementDeduction.count({ where: { moveOutId: mo.id, status: 'ACTIVE' } })).toBe(1);

    await api().post('/api/tenant/move-out/accept').set(tenant.auth).expect(200);
    await api().post(`/api/owner/move-outs/${mo.id}/complete`).set(owner.auth).expect(200);

    const ledger = await prisma.depositLedger.findMany({ where: { tenancyId: tenancy.id }, orderBy: { createdAt: 'asc' } });
    expect(ledger.map((l) => [l.type, l.amountPaise])).toEqual([
      ['COLLECTED', 2000000],
      ['DEDUCTION', 50000],
      ['REFUND', 1950000],
    ]);
    expect((await prisma.tenancy.findUniqueOrThrow({ where: { id: tenancy.id } })).status).toBe('ENDED');
    // Bed released (derived): a new tenant can move in.
    await addTenant(owner, property.id, rooms[0].beds[0].id);
    const actions = (await prisma.auditLog.findMany({ where: { entityId: mo.id } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['MOVE_OUT_REQUESTED', 'MOVE_OUT_ACCEPTED', 'INSPECTION_RECORDED', 'SETTLEMENT_PROPOSED', 'SETTLEMENT_DISPUTED', 'SETTLEMENT_ACCEPTED', 'MOVE_OUT_COMPLETED']));
  });

  it('refuses completion if the deposit changed after the proposal', async () => {
    const { owner, tenant, tenancy } = await setup(0);
    await api().post('/api/tenant/move-out').set(tenant.auth).send({ moveOutDate: toDateString(addDays(todayIST(), 1)) }).expect(201);
    const mo = await prisma.moveOut.findUniqueOrThrow({ where: { tenancyId: tenancy.id } });
    await api().post(`/api/owner/move-outs/${mo.id}/accept`).set(owner.auth).send({}).expect(200);
    await api().post(`/api/owner/move-outs/${mo.id}/settlement`).set(owner.auth).send({ deductions: [] }).expect(200);
    await api().post('/api/tenant/move-out/accept').set(tenant.auth).expect(200);
    await api().post(`/api/owner/tenancies/${tenancy.id}/deposit`).set(owner.auth).send({ amountPaise: 1000, reason: 'late top-up' }).expect(201);
    await api().post(`/api/owner/move-outs/${mo.id}/complete`).set(owner.auth).expect(409);
  });

  it('other owners and tenants cannot touch the settlement', async () => {
    const { owner, tenant, tenancy } = await setup(0);
    await api().post('/api/tenant/move-out').set(tenant.auth).send({ moveOutDate: toDateString(addDays(todayIST(), 1)) }).expect(201);
    const mo = await prisma.moveOut.findUniqueOrThrow({ where: { tenancyId: tenancy.id } });
    const other = await makeUser('OWNER');
    await api().post(`/api/owner/move-outs/${mo.id}/accept`).set(other.auth).send({}).expect(404);
    await api().get(`/api/owner/move-outs/${mo.id}`).set(other.auth).expect(404);
    const otherTenant = await makeUser('TENANT');
    await api().post('/api/tenant/move-out/accept').set(otherTenant.auth).expect(404);
    await api().get(`/api/owner/move-outs/${mo.id}`).set(owner.auth).expect(200);
  });
});
