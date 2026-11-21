import { beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, makeUser, ownerWithProperty, resetDb } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';

describe('properties, rooms and beds', () => {
  beforeEach(resetDb);

  it('creating a room creates one bed per sharing slot', async () => {
    const { rooms } = await ownerWithProperty({ rooms: [{ name: '101', sharingType: 3, rentPaise: 800000 }] });
    expect(rooms[0].beds.map((b) => b.label)).toEqual(['A', 'B', 'C']);
  });

  it('rejects a missing city and invalid rent', async () => {
    const owner = await makeUser('OWNER');
    await api().post('/api/owner/properties').set(owner.auth).send({ name: 'X PG', address: 'Somewhere 12' }).expect(400);
    const { owner: o2, property } = await ownerWithProperty();
    await api().post(`/api/owner/properties/${property.id}/rooms`).set(o2.auth).send({ name: '9', sharingType: 1, rentPaise: 1000.5 }).expect(400);
    await api().post(`/api/owner/properties/${property.id}/rooms`).set(o2.auth).send({ name: '9', sharingType: 1, rentPaise: 0 }).expect(400);
  });

  it('lists only the caller’s properties, paginated', async () => {
    const a = await ownerWithProperty();
    await ownerWithProperty();
    const r = await api().get('/api/owner/properties?page=1&pageSize=10').set(a.owner.auth).expect(200);
    expect(r.body.total).toBe(1);
    expect(r.body.items[0].id).toBe(a.property.id);
  });

  it('another owner and a tenant are refused', async () => {
    const a = await ownerWithProperty();
    const b = await makeUser('OWNER');
    const tenant = await makeUser('TENANT');
    await api().get(`/api/owner/properties/${a.property.id}`).set(b.auth).expect(404);
    await api().patch(`/api/owner/properties/${a.property.id}`).set(b.auth).send({ name: 'Hijacked' }).expect(404);
    await api().get(`/api/owner/properties/${a.property.id}/rooms`).set(b.auth).expect(404);
    await api().post(`/api/owner/properties/${a.property.id}/rooms`).set(b.auth).send({ name: 'X', sharingType: 1, rentPaise: 100 }).expect(404);
    await api().patch(`/api/owner/rooms/${a.rooms[0].id}`).set(b.auth).send({ rentPaise: 1 }).expect(404);
    await api().post(`/api/owner/beds/${a.rooms[0].beds[0].id}/deactivate`).set(b.auth).expect(404);
    await api().get(`/api/owner/properties/${a.property.id}`).set(tenant.auth).expect(403);
  });

  it('rejects unknown fields (no mass assignment)', async () => {
    const a = await ownerWithProperty();
    const other = await makeUser('OWNER');
    await api().patch(`/api/owner/properties/${a.property.id}`).set(a.owner.auth).send({ ownerId: other.user.id }).expect(400);
    const p = await prisma.property.findUniqueOrThrow({ where: { id: a.property.id } });
    expect(p.ownerId).toBe(a.owner.user.id);
  });

  it('derives bed status and occupancy from tenancies', async () => {
    const { owner, property, rooms } = await ownerWithProperty({ rooms: [{ name: '101', sharingType: 3, rentPaise: 900000 }] });
    await addTenant(owner, property.id, rooms[0].beds[0].id);
    const r = await api().get(`/api/owner/properties/${property.id}/rooms`).set(owner.auth).expect(200);
    const statuses = r.body.items[0].beds.map((b: { occupancy: { status: string } }) => b.occupancy.status);
    expect(statuses).toEqual(['OCCUPIED', 'VACANT', 'VACANT']);
    const occ = await api().get(`/api/owner/properties/${property.id}/occupancy`).set(owner.auth).expect(200);
    expect(occ.body).toMatchObject({ totalBeds: 3, occupied: 1, vacant: 2, reserved: 0, occupancyBps: 3333 });
    // No stored copy of bed status exists on the Bed row.
    const bed = await prisma.bed.findUniqueOrThrow({ where: { id: rooms[0].beds[0].id } });
    expect(Object.keys(bed)).not.toContain('occupancy');
  });

  it('cannot deactivate an occupied bed or a room with occupants; can deactivate a vacant one', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    await addTenant(owner, property.id, rooms[0].beds[0].id);
    await api().post(`/api/owner/beds/${rooms[0].beds[0].id}/deactivate`).set(owner.auth).expect(409);
    await api().post(`/api/owner/rooms/${rooms[0].id}/deactivate`).set(owner.auth).expect(409);
    await api().post(`/api/owner/beds/${rooms[0].beds[1].id}/deactivate`).set(owner.auth).expect(200);
    const occ = await api().get(`/api/owner/properties/${property.id}/occupancy`).set(owner.auth).expect(200);
    expect(occ.body).toMatchObject({ totalBeds: 1, inactive: 1 });
  });

  it('room rent change writes an audit row', async () => {
    const { owner, rooms } = await ownerWithProperty();
    await api().patch(`/api/owner/rooms/${rooms[0].id}`).set(owner.auth).send({ rentPaise: 1200000 }).expect(200);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { entityId: rooms[0].id, action: 'ROOM_RENT_CHANGED' } });
    expect(log.actorId).toBe(owner.user.id);
    expect(log.after).toEqual({ rentPaise: 1200000 });
  });

  it('increasing sharing adds beds', async () => {
    const { owner, rooms } = await ownerWithProperty({ rooms: [{ name: '1', sharingType: 1, rentPaise: 100000 }] });
    const r = await api().patch(`/api/owner/rooms/${rooms[0].id}`).set(owner.auth).send({ sharingType: 3 }).expect(200);
    expect(r.body.beds).toHaveLength(3);
  });

  it('staff see assigned properties but cannot change setup', async () => {
    const { owner, property } = await ownerWithProperty();
    const res = await api().post(`/api/owner/properties/${property.id}/staff`).set(owner.auth).send({ phone: '9811111111', name: 'Caretaker' }).expect(201);
    const staffUser = await prisma.user.findUniqueOrThrow({ where: { id: res.body.userId } });
    const { signAccessToken } = await import('../../src/modules/auth/tokens.js');
    const staffAuth = { Authorization: `Bearer ${signAccessToken(staffUser.id, 'STAFF')}` };
    const list = await api().get('/api/owner/properties').set(staffAuth).expect(200);
    expect(list.body.total).toBe(1);
    await api().patch(`/api/owner/properties/${property.id}`).set(staffAuth).send({ name: 'Nope' }).expect(403);
    await api().post('/api/owner/tenants').set(staffAuth).send({}).expect(403);
    await api().get('/api/owner/invoices').set(staffAuth).expect(403);
  });
});
