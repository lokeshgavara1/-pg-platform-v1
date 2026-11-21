import { beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, nextPhone, ownerWithProperty, resetDb, todayStr } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';

describe('tenants and tenancies', () => {
  beforeEach(resetDb);

  it('adding a tenant creates user, profile, tenancy, deposit ledger and invoice', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id, { depositPaise: 2000000, depositCollectedPaise: 1500000 });
    expect(tenant.user.role).toBe('TENANT');
    const ledger = await prisma.depositLedger.findMany({ where: { tenancyId: tenancy.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ type: 'COLLECTED', amountPaise: 1500000 });
    const invoices = await prisma.invoice.findMany({ where: { tenancyId: tenancy.id } });
    expect(invoices.map((i) => i.kind).sort()).toEqual(['DEPOSIT', 'RENT']);
    expect(invoices.find((i) => i.kind === 'DEPOSIT')!.totalPaise).toBe(500000);
    const audit = await prisma.auditLog.findMany({ where: { OR: [{ entityId: tenancy.id }, { action: 'DEPOSIT_LEDGER_ADDED' }] } });
    expect(audit.map((a) => a.action).sort()).toEqual(['DEPOSIT_LEDGER_ADDED', 'TENANCY_CREATED']);
  });

  it('prevents double-booking a bed through the API', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    await addTenant(owner, property.id, rooms[0].beds[0].id);
    const r = await api()
      .post('/api/owner/tenants')
      .set(owner.auth)
      .send({ propertyId: property.id, bedId: rooms[0].beds[0].id, name: 'Second', phone: nextPhone(), joinDate: todayStr(), rentPaise: 100000, depositPaise: 0 })
      .expect(409);
    expect(r.body.error.code).toBe('CONFLICT');
  });

  it('prevents double-booking a bed with a database constraint', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const other = await prisma.user.create({ data: { phone: nextPhone(), name: 'Other', role: 'TENANT' } });
    const profile = await prisma.tenantProfile.create({ data: { userId: other.id } });
    const t = await prisma.tenancy.findUniqueOrThrow({ where: { id: tenancy.id } });
    await expect(
      prisma.tenancy.create({
        data: { propertyId: property.id, bedId: t.bedId, tenantProfileId: profile.id, startDate: t.startDate, billingFrom: t.billingFrom, rentPaise: 1, depositPaise: 0 },
      }),
    ).rejects.toThrow(/tenancy_one_live_per_bed|Unique constraint/);
  });

  it('concurrent adds for one bed: exactly one succeeds', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const bedId = rooms[0].beds[0].id;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        api().post('/api/owner/tenants').set(owner.auth).send({ propertyId: property.id, bedId, name: 'Racer', phone: nextPhone(), joinDate: todayStr(), rentPaise: 100000, depositPaise: 0 }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it('refuses to add an owner’s phone as a tenant', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    await api()
      .post('/api/owner/tenants')
      .set(owner.auth)
      .send({ propertyId: property.id, bedId: rooms[0].beds[0].id, name: 'Me', phone: owner.user.phone, joinDate: todayStr(), rentPaise: 1, depositPaise: 0 })
      .expect(409);
  });

  it('rent and deposit changes write audit rows with actor', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    await api().patch(`/api/owner/tenancies/${tenancy.id}`).set(owner.auth).send({ rentPaise: 1100000, depositPaise: 2500000 }).expect(200);
    const logs = await prisma.auditLog.findMany({ where: { entityId: tenancy.id, action: { in: ['RENT_CHANGED', 'DEPOSIT_AMOUNT_CHANGED'] } } });
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.actorId === owner.user.id)).toBe(true);
    expect(logs.find((l) => l.action === 'RENT_CHANGED')!.before).toEqual({ rentPaise: 1000000 });
  });

  it('moves a tenant to a vacant bed but not to an occupied one', async () => {
    const { owner, property, rooms } = await ownerWithProperty({ rooms: [{ name: '1', sharingType: 3, rentPaise: 100000 }] });
    const [b1, b2, b3] = rooms[0].beds;
    const a = await addTenant(owner, property.id, b1.id);
    await addTenant(owner, property.id, b2.id);
    await api().post(`/api/owner/tenancies/${a.tenancy.id}/move-bed`).set(owner.auth).send({ bedId: b2.id }).expect(409);
    await api().post(`/api/owner/tenancies/${a.tenancy.id}/move-bed`).set(owner.auth).send({ bedId: b3.id }).expect(200);
    const t = await prisma.tenancy.findUniqueOrThrow({ where: { id: a.tenancy.id } });
    expect(t.bedId).toBe(b3.id);
    expect(await prisma.bedMove.count({ where: { tenancyId: a.tenancy.id } })).toBe(1);
  });

  it('ending a tenancy frees the bed and keeps the record', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    await api().post(`/api/owner/tenancies/${tenancy.id}/end`).set(owner.auth).send({ endDate: todayStr() }).expect(200);
    const t = await prisma.tenancy.findUniqueOrThrow({ where: { id: tenancy.id } });
    expect(t.status).toBe('ENDED');
    // Bed is free again — a new tenant can take it.
    await addTenant(owner, property.id, rooms[0].beds[0].id);
  });

  it('lists tenants with search and filters', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    await addTenant(owner, property.id, rooms[0].beds[0].id, { name: 'Priya Sharma' });
    await addTenant(owner, property.id, rooms[0].beds[1].id, { name: 'Rahul Verma' });
    const r = await api().get('/api/owner/tenants?search=priya').set(owner.auth).expect(200);
    expect(r.body.items.map((x: { tenantProfile: { user: { name: string } } }) => x.tenantProfile.user.name)).toEqual(['Priya Sharma']);
    const all = await api().get('/api/owner/tenants?filter=active').set(owner.auth).expect(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items[0].outstandingPaise).toBeGreaterThan(0);
    const notice = await api().get('/api/owner/tenants?filter=notice').set(owner.auth).expect(200);
    expect(notice.body.total).toBe(0);
  });
});
