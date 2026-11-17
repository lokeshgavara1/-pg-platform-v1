import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { dateString, idParam, parse } from '../../lib/http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { addDays, parseDateOnly, todayIST } from '../../lib/dates.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds, ownedProperty } from '../access.js';
import { assertBedFree, deriveBedStatuses, lockBed } from '../beds/status.js';
import { createSimpleInvoice, generateInvoicesForTenancy } from '../invoices/engine.js';
import { createPaymentLink } from '../payments/service.js';
import { createTenancy } from '../tenancies/service.js';
import { push } from '../../providers/message.js';

// ---- Tenant side ---------------------------------------------------------------------

export const tenantBookingsRouter = Router();

/** Open a PG through the owner's invite code: shows vacant beds and prices. */
tenantBookingsRouter.get('/pg/:code', async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{6,12}$/, 'Invalid code') }), req.params);
  const p = await prisma.property.findUnique({
    where: { inviteCode: code },
    include: { rooms: { where: { status: 'ACTIVE' }, orderBy: [{ floor: 'asc' }, { name: 'asc' }], include: { beds: { where: { status: 'ACTIVE' }, orderBy: { label: 'asc' } } } } },
  });
  if (!p || p.status !== 'ACTIVE') throw notFound('PG');
  const statuses = await deriveBedStatuses(prisma, p.rooms.flatMap((r) => r.beds.map((b) => ({ id: b.id, status: b.status, roomStatus: r.status }))));
  res.json({
    id: p.id,
    name: p.name,
    address: p.address,
    city: p.city,
    tokenAmountPaise: p.tokenAmountPaise,
    depositMonths: p.depositMonths,
    reservationHoldHours: p.reservationHoldHours,
    minNoticeDays: p.minNoticeDays,
    rooms: p.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      floor: r.floor,
      sharingType: r.sharingType,
      rentPaise: r.rentPaise,
      depositPaise: r.rentPaise * p.depositMonths,
      // Tenants only learn whether a bed is free — never who is in it.
      beds: r.beds.map((b) => ({ id: b.id, label: b.label, available: statuses.get(b.id)?.status === 'VACANT' })),
    })),
  });
});

tenantBookingsRouter.post('/bookings', async (req, res) => {
  const user = me(req);
  const input = parse(z.object({ bedId: z.string(), moveInDate: dateString }), req.body);
  const moveIn = parseDateOnly(input.moveInDate);
  const today = todayIST();
  if (moveIn < today) throw badRequest('Move-in date cannot be in the past');
  if (moveIn > addDays(today, 90)) throw badRequest('Move-in date must be within 90 days');

  const bed = await prisma.bed.findUnique({ where: { id: input.bedId }, include: { room: { include: { property: true } } } });
  if (!bed || bed.room.property.status !== 'ACTIVE') throw notFound('Bed');
  const property = bed.room.property;

  const existing = await prisma.booking.findFirst({
    where: { tenantUserId: user.id, OR: [{ status: 'PAID' }, { status: 'RESERVED', holdUntil: { gt: new Date() } }] },
  });
  if (existing) throw conflict('You already have a reservation. Cancel it before booking another bed.');
  const profile = await prisma.tenantProfile.findUnique({ where: { userId: user.id } });
  if (profile) {
    const live = await prisma.tenancy.findFirst({ where: { tenantProfileId: profile.id, status: { in: ['ACTIVE', 'NOTICE'] } } });
    if (live) throw conflict('You already have an active stay');
  }

  const { booking, invoice } = await prisma.$transaction(async (tx) => {
    await lockBed(tx, bed.id);
    await assertBedFree(tx, bed.id);
    const b = await tx.booking.create({
      data: {
        propertyId: property.id,
        bedId: bed.id,
        tenantUserId: user.id,
        status: 'RESERVED',
        holdUntil: new Date(Date.now() + property.reservationHoldHours * 3600 * 1000),
        moveInDate: moveIn,
        rentPaise: bed.room.rentPaise,
        depositPaise: bed.room.rentPaise * property.depositMonths,
        tokenAmountPaise: property.tokenAmountPaise,
      },
    });
    const inv =
      property.tokenAmountPaise > 0
        ? await createSimpleInvoice(tx, {
            propertyId: property.id,
            kind: 'TOKEN',
            bookingId: b.id,
            dueDate: today,
            lines: [{ kind: 'TOKEN', description: `Token amount to reserve bed ${bed.room.name}-${bed.label}`, amountPaise: property.tokenAmountPaise }],
          })
        : null;
    // A zero token means the reservation is effectively paid immediately.
    const finalB = inv ? b : await tx.booking.update({ where: { id: b.id }, data: { status: 'PAID' } });
    return { booking: finalB, invoice: inv };
  });

  const pay = invoice ? await createPaymentLink(invoice.id, { customerPhone: user.phone }) : null;
  await push({ userId: property.ownerId, title: 'New reservation', body: `${user.name} reserved bed ${bed.room.name}-${bed.label} at ${property.name}.` });
  res.status(201).json({ booking, invoice, payment: pay });
});

tenantBookingsRouter.get('/bookings', async (req, res) => {
  const user = me(req);
  const rows = await prisma.booking.findMany({
    where: { tenantUserId: user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      property: { select: { name: true, address: true } },
      bed: { select: { label: true, room: { select: { name: true } } } },
      invoices: { where: { kind: 'TOKEN' }, select: { id: true, totalPaise: true, paidPaise: true, status: true } },
    },
  });
  res.json({ items: rows });
});

tenantBookingsRouter.post('/bookings/:id/pay-link', async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const b = await prisma.booking.findFirst({ where: { id, tenantUserId: user.id }, include: { invoices: { where: { kind: 'TOKEN' } } } });
  if (!b) throw notFound('Booking');
  if (b.status !== 'RESERVED' || b.holdUntil < new Date()) throw conflict('This reservation can no longer be paid');
  const inv = b.invoices[0];
  if (!inv) throw conflict('No token is due for this booking');
  res.status(201).json(await createPaymentLink(inv.id, { customerPhone: user.phone }));
});

tenantBookingsRouter.post('/bookings/:id/cancel', async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const b = await prisma.booking.findFirst({ where: { id, tenantUserId: user.id } });
  if (!b) throw notFound('Booking');
  if (b.status !== 'RESERVED') throw conflict('Only unpaid reservations can be cancelled here; contact the owner');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.booking.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: 'Cancelled by tenant' } });
    await tx.invoice.updateMany({ where: { bookingId: id, kind: 'TOKEN', paidPaise: 0 }, data: { status: 'VOID' } });
    return u;
  });
  res.json(updated);
});

// ---- Owner side ----------------------------------------------------------------------

export const ownerBookingsRouter = Router();

ownerBookingsRouter.get('/bookings', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const q = parse(z.object({ propertyId: z.string().optional(), status: z.enum(['RESERVED', 'PAID', 'CONVERTED', 'CANCELLED', 'EXPIRED', 'LIVE']).default('LIVE') }), req.query);
  const ids = await managedPropertyIds(user);
  const rows = await prisma.booking.findMany({
    where: {
      propertyId: { in: q.propertyId ? ids.filter((i) => i === q.propertyId) : ids },
      status: q.status === 'LIVE' ? { in: ['RESERVED', 'PAID'] } : q.status,
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      property: { select: { name: true } },
      bed: { select: { label: true, room: { select: { name: true } } } },
      tenantUser: { select: { name: true, phone: true } },
      invoices: { where: { kind: 'TOKEN' }, select: { totalPaise: true, paidPaise: true, status: true } },
    },
  });
  res.json({ items: rows });
});

async function ownedBooking(userId: string, id: string) {
  const b = await prisma.booking.findFirst({ where: { id, property: { ownerId: userId } }, include: { property: true, tenantUser: true } });
  if (!b) throw notFound('Booking');
  return b;
}

ownerBookingsRouter.post('/bookings/:id/confirm', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const b = await ownedBooking(user.id, id);
  await ownedProperty(user, b.propertyId);
  if (b.status !== 'PAID') throw conflict(b.status === 'RESERVED' ? 'The token has not been paid yet' : `Booking is ${b.status.toLowerCase()}`);
  const tenancy = await prisma.$transaction(async (tx) => {
    const tokenPaid = b.tokenAmountPaise;
    const tokenTowardsDeposit = Math.min(tokenPaid, b.depositPaise);
    const t = await createTenancy(tx, {
      actorId: user.id,
      propertyId: b.propertyId,
      bedId: b.bedId,
      tenantUserId: b.tenantUserId,
      startDate: b.moveInDate,
      rentPaise: b.rentPaise,
      depositPaise: b.depositPaise,
      depositCollectedPaise: tokenTowardsDeposit,
      cityCode: b.property.cityCode,
      ignoreBookingId: b.id,
    });
    await tx.booking.update({ where: { id: b.id }, data: { status: 'CONVERTED', tenancyId: t.id } });
    await audit(tx, { actorId: user.id, action: 'BOOKING_CONFIRMED', entityType: 'Booking', entityId: b.id, after: { tenancyId: t.id, tokenTowardsDepositPaise: tokenTowardsDeposit } });
    await generateInvoicesForTenancy(tx, t.id);
    return t;
  });
  await push({ userId: b.tenantUserId, title: 'Booking confirmed', body: `Your bed at ${b.property.name} is confirmed. Complete your KYC in the app.` });
  res.json(tenancy);
});

ownerBookingsRouter.post('/bookings/:id/cancel', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
  const b = await ownedBooking(user.id, id);
  if (b.status !== 'RESERVED' && b.status !== 'PAID') throw conflict(`Booking is already ${b.status.toLowerCase()}`);
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.booking.update({ where: { id }, data: { status: 'CANCELLED', cancelReason: reason, refundDue: b.status === 'PAID' } });
    await tx.invoice.updateMany({ where: { bookingId: id, kind: 'TOKEN', paidPaise: 0 }, data: { status: 'VOID' } });
    await audit(tx, { actorId: user.id, action: 'BOOKING_CANCELLED', entityType: 'Booking', entityId: id, before: { status: b.status }, after: { status: 'CANCELLED', reason, refundDue: b.status === 'PAID' } });
    return u;
  });
  await push({ userId: b.tenantUserId, title: 'Reservation cancelled', body: `The owner cancelled your reservation at ${b.property.name}: ${reason}` });
  res.json(updated);
});

ownerBookingsRouter.post('/bookings/:id/refund-done', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const b = await ownedBooking(user.id, id);
  if (!b.refundDue) throw conflict('No refund is due for this booking');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.booking.update({ where: { id }, data: { refundDue: false } });
    await audit(tx, { actorId: user.id, action: 'TOKEN_REFUNDED', entityType: 'Booking', entityId: id, after: { amountPaise: b.tokenAmountPaise } });
    return u;
  });
  res.json(updated);
});
