import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, pageQuery, paged, paiseSchema, parse, phoneSchema } from '../../lib/http.js';
import { conflict, badRequest, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedProperty, managedPropertyIds, ownedBed, ownedProperty, ownedRoom } from '../access.js';
import { deriveBedStatuses } from '../beds/status.js';
import { listCityCodes } from '../verification/cities.js';

export const propertiesRouter = Router();

const bedLabel = (i: number) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '');
const newInviteCode = () => randomBytes(4).toString('hex').toUpperCase();

const propertyInput = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().min(5).max(400),
  city: z.string().trim().min(2).max(60),
  cityCode: z.string().trim().toLowerCase().max(40),
  rentDueDay: z.number().int().min(1).max(28).default(5),
  minNoticeDays: z.number().int().min(0).max(180).default(30),
  reservationHoldHours: z.number().int().min(1).max(24 * 14).default(24),
  tokenAmountPaise: paiseSchema.default(200000),
  depositMonths: z.number().int().min(0).max(12).default(1),
  verificationReminderDays: z.number().int().min(1).max(60).default(7),
  remindersEnabled: z.boolean().default(true),
});

// ---- Properties -----------------------------------------------------------------

propertiesRouter.get('/properties', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const user = me(req);
  const { page, pageSize } = parse(pageQuery, req.query);
  const ids = await managedPropertyIds(user);
  const where = { id: { in: ids } };
  const [items, total] = await Promise.all([
    prisma.property.findMany({
      where,
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { rooms: { where: { status: 'ACTIVE' } } } } },
    }),
    prisma.property.count({ where }),
  ]);
  res.json(paged(items, total, page, pageSize));
});

propertiesRouter.post('/properties', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const input = parse(propertyInput, req.body);
  if (!listCityCodes().includes(input.cityCode)) throw badRequest(`Unknown city code. Use one of: ${listCityCodes().join(', ')}`);
  const p = await prisma.property.create({ data: { ...input, ownerId: user.id, inviteCode: newInviteCode() } });
  res.status(201).json(p);
});

propertiesRouter.get('/properties/:id', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  res.json(await managedProperty(me(req), id));
});

propertiesRouter.patch('/properties/:id', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const before = await ownedProperty(user, id);
  const input = parse(propertyInput.partial().strict(), req.body);
  if (input.cityCode && !listCityCodes().includes(input.cityCode)) throw badRequest('Unknown city code');
  const after = await prisma.$transaction(async (tx) => {
    const p = await tx.property.update({ where: { id }, data: input });
    if (input.tokenAmountPaise !== undefined && input.tokenAmountPaise !== before.tokenAmountPaise) {
      await audit(tx, { actorId: user.id, action: 'TOKEN_AMOUNT_CHANGED', entityType: 'Property', entityId: id, before: { tokenAmountPaise: before.tokenAmountPaise }, after: { tokenAmountPaise: p.tokenAmountPaise } });
    }
    if (input.depositMonths !== undefined && input.depositMonths !== before.depositMonths) {
      await audit(tx, { actorId: user.id, action: 'DEFAULT_DEPOSIT_CHANGED', entityType: 'Property', entityId: id, before: { depositMonths: before.depositMonths }, after: { depositMonths: p.depositMonths } });
    }
    if (input.rentDueDay !== undefined && input.rentDueDay !== before.rentDueDay) {
      await audit(tx, { actorId: user.id, action: 'RENT_DUE_DAY_CHANGED', entityType: 'Property', entityId: id, before: { rentDueDay: before.rentDueDay }, after: { rentDueDay: p.rentDueDay } });
    }
    return p;
  });
  res.json(after);
});

propertiesRouter.post('/properties/:id/deactivate', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  await ownedProperty(user, id);
  const live = await prisma.tenancy.count({ where: { propertyId: id, status: { in: ['ACTIVE', 'NOTICE'] } } });
  if (live > 0) throw conflict('End all active tenancies before deactivating this property');
  res.json(await prisma.property.update({ where: { id }, data: { status: 'INACTIVE' } }));
});

propertiesRouter.post('/properties/:id/activate', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await ownedProperty(me(req), id);
  res.json(await prisma.property.update({ where: { id }, data: { status: 'ACTIVE' } }));
});

propertiesRouter.post('/properties/:id/invite-code/rotate', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await ownedProperty(me(req), id);
  res.json(await prisma.property.update({ where: { id }, data: { inviteCode: newInviteCode() } }));
});

// ---- Rooms & beds (with derived status) ---------------------------------------------

propertiesRouter.get('/properties/:id/rooms', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await managedProperty(me(req), id);
  const { includeInactive } = parse(z.object({ includeInactive: z.enum(['true', 'false']).optional() }), req.query);
  const rooms = await prisma.room.findMany({
    where: { propertyId: id, ...(includeInactive === 'true' ? {} : { status: 'ACTIVE' }) },
    orderBy: [{ floor: 'asc' }, { name: 'asc' }],
    include: { beds: { orderBy: { label: 'asc' }, ...(includeInactive === 'true' ? {} : { where: { status: 'ACTIVE' } }) } },
  });
  const statuses = await deriveBedStatuses(
    prisma,
    rooms.flatMap((r) => r.beds.map((b) => ({ id: b.id, status: b.status, roomStatus: r.status }))),
  );
  res.json({
    items: rooms.map((r) => ({
      ...r,
      beds: r.beds.map((b) => ({ ...b, occupancy: statuses.get(b.id) })),
    })),
  });
});

propertiesRouter.get('/properties/:id/occupancy', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await managedProperty(me(req), id);
  res.json(await occupancySummary([id]));
});

export async function occupancySummary(propertyIds: string[]) {
  const beds = await prisma.bed.findMany({
    where: { room: { propertyId: { in: propertyIds } } },
    select: { id: true, status: true, room: { select: { status: true } } },
  });
  const statuses = await deriveBedStatuses(prisma, beds.map((b) => ({ id: b.id, status: b.status, roomStatus: b.room.status })));
  const counts = { VACANT: 0, RESERVED: 0, OCCUPIED: 0, INACTIVE: 0 };
  for (const s of statuses.values()) counts[s.status]++;
  const usable = counts.VACANT + counts.RESERVED + counts.OCCUPIED;
  return {
    totalBeds: usable,
    occupied: counts.OCCUPIED,
    reserved: counts.RESERVED,
    vacant: counts.VACANT,
    inactive: counts.INACTIVE,
    // Integer basis points avoid float drift; UI shows one decimal.
    occupancyBps: usable === 0 ? 0 : Math.round((counts.OCCUPIED * 10000) / usable),
  };
}

const roomInput = z.object({
  name: z.string().trim().min(1).max(40),
  floor: z.number().int().min(-2).max(100).default(0),
  sharingType: z.number().int().min(1).max(20),
  rentPaise: paiseSchema.refine((v) => v > 0, 'Rent must be more than zero'),
});

propertiesRouter.post('/properties/:id/rooms', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  await ownedProperty(user, id);
  const input = parse(roomInput, req.body);
  const exists = await prisma.room.findUnique({ where: { propertyId_name: { propertyId: id, name: input.name } } });
  if (exists) throw conflict('A room with this name already exists');
  const room = await prisma.room.create({
    data: {
      ...input,
      propertyId: id,
      beds: { create: Array.from({ length: input.sharingType }, (_, i) => ({ label: bedLabel(i) })) },
    },
    include: { beds: true },
  });
  res.status(201).json(room);
});

propertiesRouter.patch('/rooms/:id', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const before = await ownedRoom(user, id);
  const input = parse(roomInput.partial().strict(), req.body);
  const room = await prisma.$transaction(async (tx) => {
    if (input.sharingType !== undefined && input.sharingType !== before.sharingType) {
      const beds = await tx.bed.findMany({ where: { roomId: id }, orderBy: { createdAt: 'asc' } });
      const activeCount = beds.filter((b) => b.status === 'ACTIVE').length;
      if (input.sharingType < activeCount) {
        throw conflict('To reduce sharing, deactivate specific vacant beds first');
      }
      const existingLabels = new Set(beds.map((b) => b.label));
      let i = 0;
      for (let added = activeCount; added < input.sharingType; ) {
        const label = bedLabel(i++);
        if (existingLabels.has(label)) {
          const inactive = beds.find((b) => b.label === label && b.status === 'INACTIVE');
          if (inactive) {
            await tx.bed.update({ where: { id: inactive.id }, data: { status: 'ACTIVE' } });
            added++;
          }
          continue;
        }
        await tx.bed.create({ data: { roomId: id, label } });
        added++;
      }
    }
    const r = await tx.room.update({ where: { id }, data: input, include: { beds: true } });
    if (input.rentPaise !== undefined && input.rentPaise !== before.rentPaise) {
      await audit(tx, { actorId: user.id, action: 'ROOM_RENT_CHANGED', entityType: 'Room', entityId: id, before: { rentPaise: before.rentPaise }, after: { rentPaise: r.rentPaise } });
    }
    return r;
  });
  res.json(room);
});

async function bedIsLive(bedId: string) {
  const [t, b] = await Promise.all([
    prisma.tenancy.count({ where: { bedId, status: { in: ['ACTIVE', 'NOTICE'] } } }),
    prisma.booking.count({ where: { bedId, OR: [{ status: 'PAID' }, { status: 'RESERVED', holdUntil: { gt: new Date() } }] } }),
  ]);
  return t + b > 0;
}

propertiesRouter.post('/rooms/:id/deactivate', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  const room = await ownedRoom(me(req), id);
  const beds = await prisma.bed.findMany({ where: { roomId: room.id } });
  for (const b of beds) if (await bedIsLive(b.id)) throw conflict('This room has occupied or reserved beds');
  res.json(await prisma.room.update({ where: { id }, data: { status: 'INACTIVE' } }));
});

propertiesRouter.post('/rooms/:id/activate', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await ownedRoom(me(req), id);
  res.json(await prisma.room.update({ where: { id }, data: { status: 'ACTIVE' } }));
});

propertiesRouter.post('/rooms/:id/beds', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  const room = await ownedRoom(me(req), id);
  const { label } = parse(z.object({ label: z.string().trim().min(1).max(10).optional() }), req.body ?? {});
  const beds = await prisma.bed.findMany({ where: { roomId: id } });
  const taken = new Set(beds.map((b) => b.label));
  let finalLabel = label;
  if (!finalLabel) {
    let i = 0;
    while (taken.has(bedLabel(i))) i++;
    finalLabel = bedLabel(i);
  } else if (taken.has(finalLabel)) throw conflict('A bed with this label already exists in the room');
  const bed = await prisma.$transaction(async (tx) => {
    const b = await tx.bed.create({ data: { roomId: id, label: finalLabel! } });
    await tx.room.update({ where: { id }, data: { sharingType: room.sharingType + 1 } });
    return b;
  });
  res.status(201).json(bed);
});

propertiesRouter.patch('/beds/:id', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await ownedBed(me(req), id);
  const input = parse(z.object({ label: z.string().trim().min(1).max(10) }).strict(), req.body);
  res.json(await prisma.bed.update({ where: { id }, data: input }));
});

propertiesRouter.post('/beds/:id/deactivate', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  const bed = await ownedBed(me(req), id);
  if (await bedIsLive(id)) throw conflict('This bed is occupied or reserved');
  const updated = await prisma.$transaction(async (tx) => {
    const b = await tx.bed.update({ where: { id }, data: { status: 'INACTIVE' } });
    if (bed.status === 'ACTIVE') await tx.room.update({ where: { id: bed.roomId }, data: { sharingType: { decrement: 1 } } });
    return b;
  });
  res.json(updated);
});

propertiesRouter.post('/beds/:id/activate', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  const bed = await ownedBed(me(req), id);
  const updated = await prisma.$transaction(async (tx) => {
    const b = await tx.bed.update({ where: { id }, data: { status: 'ACTIVE' } });
    if (bed.status === 'INACTIVE') await tx.room.update({ where: { id: bed.roomId }, data: { sharingType: { increment: 1 } } });
    return b;
  });
  res.json(updated);
});

// ---- Staff ----------------------------------------------------------------------------

propertiesRouter.get('/properties/:id/staff', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await ownedProperty(me(req), id);
  const rows = await prisma.propertyStaff.findMany({
    where: { propertyId: id },
    include: { user: { select: { id: true, name: true, phone: true, status: true } } },
  });
  res.json({ items: rows });
});

propertiesRouter.post('/properties/:id/staff', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  await ownedProperty(user, id);
  const input = parse(z.object({ phone: phoneSchema, name: z.string().trim().min(2).max(80) }), req.body);
  let staff = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (staff && staff.role !== 'STAFF') throw conflict('This phone number already belongs to a non-staff account');
  if (!staff) staff = await prisma.user.create({ data: { phone: input.phone, name: input.name, role: 'STAFF' } });
  const row = await prisma.propertyStaff.upsert({
    where: { propertyId_userId: { propertyId: id, userId: staff.id } },
    create: { propertyId: id, userId: staff.id },
    update: { status: 'ACTIVE' },
  });
  res.status(201).json(row);
});

propertiesRouter.post('/properties/:id/staff/:userId/deactivate', requireRole('OWNER'), async (req, res) => {
  const { id, userId } = parse(z.object({ id: z.string(), userId: z.string() }), req.params);
  await ownedProperty(me(req), id);
  const r = await prisma.propertyStaff.updateMany({ where: { propertyId: id, userId }, data: { status: 'INACTIVE' } });
  if (r.count === 0) throw notFound('Staff member');
  res.json({ ok: true });
});
