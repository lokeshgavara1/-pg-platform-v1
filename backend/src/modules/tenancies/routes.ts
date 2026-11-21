import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { dateString, idParam, pageQuery, paged, paiseSchema, parse, phoneSchema } from '../../lib/http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { parseDateOnly, todayIST } from '../../lib/dates.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds, ownedProperty, ownedTenancy } from '../access.js';
import { assertBedFree, lockBed } from '../beds/status.js';
import { adjustInvoicesForEnd, generateInvoicesForTenancy } from '../invoices/engine.js';
import { createTenancy, depositHeld } from './service.js';
import { createLoginLink } from '../auth/google.js';

export const tenanciesRouter = Router();

const tenantListQuery = pageQuery.extend({
  propertyId: z.string().optional(),
  filter: z.enum(['active', 'dues', 'notice', 'ended', 'all']).default('active'),
  search: z.string().trim().max(60).optional(),
});

tenanciesRouter.get('/tenants', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const user = me(req);
  const q = parse(tenantListQuery, req.query);
  const ids = await managedPropertyIds(user);
  const propertyIds = q.propertyId ? ids.filter((i) => i === q.propertyId) : ids;
  const today = todayIST();
  const where: Prisma.TenancyWhereInput = { propertyId: { in: propertyIds } };
  if (q.filter === 'active') where.status = { in: ['ACTIVE', 'NOTICE'] };
  if (q.filter === 'notice') where.status = 'NOTICE';
  if (q.filter === 'ended') where.status = 'ENDED';
  if (q.filter === 'dues') {
    where.invoices = { some: { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lte: today } } };
  }
  if (q.search) {
    const digits = q.search.replace(/\D/g, '');
    where.tenantProfile = {
      user: {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
        ],
      },
    };
  }
  const [rows, total] = await Promise.all([
    prisma.tenancy.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        property: { select: { id: true, name: true } },
        bed: { select: { id: true, label: true, room: { select: { id: true, name: true } } } },
        tenantProfile: { select: { id: true, kycStatus: true, user: { select: { id: true, name: true, phone: true } } } },
      },
    }),
    prisma.tenancy.count({ where }),
  ]);
  // Outstanding dues per tenancy in one grouped query (no N+1).
  const dues = await prisma.invoice.groupBy({
    by: ['tenancyId'],
    where: { tenancyId: { in: rows.map((r) => r.id) }, status: { in: ['DUE', 'PARTIAL'] } },
    _sum: { totalPaise: true, paidPaise: true },
  });
  const overdue = await prisma.invoice.groupBy({
    by: ['tenancyId'],
    where: { tenancyId: { in: rows.map((r) => r.id) }, status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: today } },
    _sum: { totalPaise: true, paidPaise: true },
  });
  const out = (arr: typeof dues, id: string) => {
    const d = arr.find((x) => x.tenancyId === id);
    return d ? (d._sum.totalPaise ?? 0) - (d._sum.paidPaise ?? 0) : 0;
  };
  res.json(
    paged(
      rows.map((r) => ({ ...r, outstandingPaise: out(dues, r.id), overduePaise: out(overdue, r.id) })),
      total,
      q.page,
      q.pageSize,
    ),
  );
});

const addTenantInput = z.object({
  propertyId: z.string(),
  bedId: z.string(),
  name: z.string().trim().min(2).max(80),
  phone: phoneSchema,
  guardianName: z.string().trim().max(80).optional(),
  guardianPhone: phoneSchema.optional(),
  joinDate: dateString,
  rentPaise: paiseSchema.refine((v) => v > 0, 'Rent must be more than zero'),
  depositPaise: paiseSchema,
  depositCollectedPaise: paiseSchema.default(0),
  charges: z.array(z.object({ name: z.string().trim().min(1).max(40), amountPaise: paiseSchema })).max(10).default([]),
});

tenanciesRouter.post('/tenants', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const input = parse(addTenantInput, req.body);
  const property = await ownedProperty(user, input.propertyId);
  if (input.depositCollectedPaise > input.depositPaise) throw badRequest('Collected deposit cannot exceed the deposit amount');
  const bed = await prisma.bed.findFirst({ where: { id: input.bedId, room: { propertyId: property.id } } });
  if (!bed) throw notFound('Bed');

  const tenancy = await prisma.$transaction(async (tx) => {
    let tenantUser = await tx.user.findUnique({ where: { phone: input.phone } });
    if (tenantUser && tenantUser.role !== 'TENANT') throw conflict('This phone number belongs to an owner or staff account');
    if (!tenantUser) tenantUser = await tx.user.create({ data: { phone: input.phone, name: input.name, role: 'TENANT' } });
    const t = await createTenancy(tx, {
      actorId: user.id,
      propertyId: property.id,
      bedId: bed.id,
      tenantUserId: tenantUser.id,
      startDate: parseDateOnly(input.joinDate),
      rentPaise: input.rentPaise,
      depositPaise: input.depositPaise,
      depositCollectedPaise: input.depositCollectedPaise,
      charges: input.charges,
    });
    if (input.guardianName || input.guardianPhone) {
      await tx.tenantProfile.update({
        where: { id: t.tenantProfileId },
        data: { guardianName: input.guardianName, guardianPhone: input.guardianPhone },
      });
    }
    await generateInvoicesForTenancy(tx, t.id);
    return t;
  });
  res.status(201).json(tenancy);
});

tenanciesRouter.get('/tenancies/:id', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  const t = await ownedTenancy(me(req), id);
  const [invoices, ledger, charges, agreements, moveOut, held, bedMoves] = await Promise.all([
    prisma.invoice.findMany({ where: { tenancyId: id }, orderBy: { dueDate: 'desc' }, include: { lines: true, payments: { where: { status: 'SUCCESS' } } } }),
    prisma.depositLedger.findMany({ where: { tenancyId: id }, orderBy: { createdAt: 'asc' } }),
    prisma.recurringCharge.findMany({ where: { tenancyId: id }, orderBy: { createdAt: 'asc' } }),
    prisma.agreement.findMany({ where: { tenancyId: id }, orderBy: { createdAt: 'desc' } }),
    prisma.moveOut.findUnique({ where: { tenancyId: id }, include: { deductions: { where: { status: 'ACTIVE' } } } }),
    prisma.$transaction((tx) => depositHeld(tx, id)),
    prisma.bedMove.findMany({ where: { tenancyId: id }, orderBy: { movedAt: 'desc' } }),
  ]);
  const { tenantProfile, ...rest } = t;
  res.json({
    ...rest,
    tenant: {
      profileId: tenantProfile.id,
      userId: tenantProfile.user.id,
      name: tenantProfile.user.name,
      phone: tenantProfile.user.phone,
      guardianName: tenantProfile.guardianName,
      guardianPhone: tenantProfile.guardianPhone,
      fatherName: tenantProfile.fatherName,
      permanentAddress: tenantProfile.permanentAddress,
      occupation: tenantProfile.occupation,
      workplace: tenantProfile.workplace,
      kycStatus: tenantProfile.kycStatus,
      kycRejectReason: tenantProfile.kycRejectReason,
      idType: tenantProfile.idType,
      idLast4: tenantProfile.idLast4,
      kycIdFileId: tenantProfile.kycIdFileId,
      kycPhotoFileId: tenantProfile.kycPhotoFileId,
    },
    invoices,
    depositLedger: ledger,
    depositHeldPaise: held,
    charges,
    agreements,
    moveOut,
    bedMoves,
  });
});

tenanciesRouter.patch('/tenancies/:id', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const before = await ownedTenancy(user, id);
  if (before.status === 'ENDED') throw conflict('This tenancy has ended');
  const input = parse(z.object({ rentPaise: paiseSchema.refine((v) => v > 0).optional(), depositPaise: paiseSchema.optional() }).strict(), req.body);
  const after = await prisma.$transaction(async (tx) => {
    const t = await tx.tenancy.update({ where: { id }, data: input });
    if (input.rentPaise !== undefined && input.rentPaise !== before.rentPaise) {
      await audit(tx, { actorId: user.id, action: 'RENT_CHANGED', entityType: 'Tenancy', entityId: id, before: { rentPaise: before.rentPaise }, after: { rentPaise: t.rentPaise } });
    }
    if (input.depositPaise !== undefined && input.depositPaise !== before.depositPaise) {
      await audit(tx, { actorId: user.id, action: 'DEPOSIT_AMOUNT_CHANGED', entityType: 'Tenancy', entityId: id, before: { depositPaise: before.depositPaise }, after: { depositPaise: t.depositPaise } });
    }
    return t;
  });
  res.json(after);
});

tenanciesRouter.post('/tenancies/:id/move-bed', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const t = await ownedTenancy(user, id);
  if (t.status === 'ENDED') throw conflict('This tenancy has ended');
  const { bedId } = parse(z.object({ bedId: z.string() }), req.body);
  if (bedId === t.bedId) throw badRequest('Tenant is already on this bed');
  const target = await prisma.bed.findFirst({ where: { id: bedId, room: { propertyId: t.propertyId } } });
  if (!target) throw notFound('Bed');
  const updated = await prisma.$transaction(async (tx) => {
    // Lock both beds in a stable order to avoid deadlocks.
    for (const b of [t.bedId, bedId].sort()) await lockBed(tx, b);
    await assertBedFree(tx, bedId);
    const u = await tx.tenancy.update({ where: { id }, data: { bedId } });
    await tx.bedMove.create({ data: { tenancyId: id, fromBedId: t.bedId, toBedId: bedId, actorId: user.id } });
    await audit(tx, { actorId: user.id, action: 'BED_MOVED', entityType: 'Tenancy', entityId: id, before: { bedId: t.bedId }, after: { bedId } });
    return u;
  });
  res.json(updated);
});

tenanciesRouter.post('/tenancies/:id/end', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const t = await ownedTenancy(user, id);
  if (t.status === 'ENDED') throw conflict('This tenancy has already ended');
  const { endDate } = parse(z.object({ endDate: dateString }), req.body);
  const end = parseDateOnly(endDate);
  if (end < t.startDate) throw badRequest('End date is before the start date');
  const updated = await prisma.$transaction(async (tx) => {
    await adjustInvoicesForEnd(tx, id, end, user.id);
    const u = await tx.tenancy.update({ where: { id }, data: { status: 'ENDED', endDate: end } });
    await tx.moveOut.updateMany({ where: { tenancyId: id, status: { notIn: ['COMPLETED', 'REJECTED'] } }, data: { status: 'COMPLETED' } });
    await audit(tx, { actorId: user.id, action: 'TENANCY_ENDED', entityType: 'Tenancy', entityId: id, before: { status: t.status }, after: { status: 'ENDED', endDate } });
    return u;
  });
  res.json(updated);
});

tenanciesRouter.post('/tenancies/:id/charges', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const t = await ownedTenancy(user, id);
  if (t.status === 'ENDED') throw conflict('This tenancy has ended');
  const input = parse(z.object({ name: z.string().trim().min(1).max(40), amountPaise: paiseSchema.refine((v) => v > 0) }), req.body);
  const charge = await prisma.$transaction(async (tx) => {
    const c = await tx.recurringCharge.create({ data: { ...input, tenancyId: id } });
    await audit(tx, { actorId: user.id, action: 'RECURRING_CHARGE_ADDED', entityType: 'Tenancy', entityId: id, after: { name: c.name, amountPaise: c.amountPaise } });
    return c;
  });
  res.status(201).json(charge);
});

tenanciesRouter.post('/charges/:id/deactivate', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const c = await prisma.recurringCharge.findFirst({ where: { id, tenancy: { property: { ownerId: user.id } } } });
  if (!c) throw notFound('Charge');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.recurringCharge.update({ where: { id }, data: { status: 'INACTIVE' } });
    await audit(tx, { actorId: user.id, action: 'RECURRING_CHARGE_REMOVED', entityType: 'Tenancy', entityId: c.tenancyId, before: { name: c.name, amountPaise: c.amountPaise } });
    return u;
  });
  res.json(updated);
});

/** Record deposit money received outside an invoice (e.g. paid in cash before the app). */
/** One-time link the owner sends the tenant (e.g. on WhatsApp) to sign in with Google for free. */
tenanciesRouter.post('/tenancies/:id/login-link', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const t = await ownedTenancy(user, id);
  if (t.status === 'ENDED') throw conflict('This tenancy has ended');
  if (t.tenantProfile.user.status !== 'ACTIVE') throw conflict('This tenant account is deactivated');
  res.status(201).json({
    ...(await createLoginLink(t.tenantProfile.userId, user.id)),
    tenantName: t.tenantProfile.user.name,
    tenantPhone: t.tenantProfile.user.phone,
    alreadyConnected: !!t.tenantProfile.user.firebaseUid,
  });
});

tenanciesRouter.post('/tenancies/:id/deposit', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  await ownedTenancy(user, id);
  const input = parse(z.object({ amountPaise: paiseSchema.refine((v) => v > 0), reason: z.string().trim().min(2).max(200) }), req.body);
  const entry = await prisma.$transaction(async (tx) => {
    const e = await tx.depositLedger.create({ data: { tenancyId: id, type: 'COLLECTED', amountPaise: input.amountPaise, reason: input.reason, createdById: user.id } });
    await audit(tx, { actorId: user.id, action: 'DEPOSIT_LEDGER_ADDED', entityType: 'DepositLedger', entityId: e.id, after: { type: 'COLLECTED', amountPaise: e.amountPaise, tenancyId: id } });
    return e;
  });
  res.status(201).json(entry);
});
