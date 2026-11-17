import { Router } from 'express';
import { z } from 'zod';
import type { MoveOutStatus, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { dateString, idParam, paiseSchema, parse } from '../../lib/http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { addDays, parseDateOnly, todayIST, toDateString } from '../../lib/dates.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds, requireCurrentTenancy } from '../access.js';
import { assertOwnUploadedFiles } from '../files/service.js';
import { adjustInvoicesForEnd } from '../invoices/engine.js';
import { depositHeld } from '../tenancies/service.js';
import { computeSettlement } from './calc.js';
import { push } from '../../providers/message.js';

const moveOutInclude = {
  deductions: { where: { status: 'ACTIVE' as const }, orderBy: { createdAt: 'asc' as const } },
  tenancy: {
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      depositPaise: true,
      propertyId: true,
      property: { select: { name: true, ownerId: true, minNoticeDays: true } },
      bed: { select: { label: true, room: { select: { name: true } } } },
      tenantProfile: { select: { userId: true, user: { select: { name: true, phone: true } } } },
    },
  },
};

async function outstandingDues(tenancyId: string) {
  const r = await prisma.invoice.aggregate({ where: { tenancyId, status: { in: ['DUE', 'PARTIAL'] } }, _sum: { totalPaise: true, paidPaise: true } });
  return (r._sum.totalPaise ?? 0) - (r._sum.paidPaise ?? 0);
}

// ---- Tenant ----------------------------------------------------------------------------

export const tenantMoveOutRouter = Router();

tenantMoveOutRouter.get('/move-out', async (req, res) => {
  const user = me(req);
  const profile = await prisma.tenantProfile.findUnique({ where: { userId: user.id } });
  if (!profile) return res.json({ moveOut: null });
  const m = await prisma.moveOut.findFirst({ where: { tenancy: { tenantProfileId: profile.id } }, orderBy: { createdAt: 'desc' }, include: moveOutInclude });
  res.json({ moveOut: m });
});

tenantMoveOutRouter.post('/move-out', async (req, res) => {
  const user = me(req);
  const { moveOutDate } = parse(z.object({ moveOutDate: dateString }), req.body);
  const { tenancy } = await requireCurrentTenancy(user);
  if (tenancy.status !== 'ACTIVE') throw conflict('A move-out is already in progress');
  const date = parseDateOnly(moveOutDate);
  const earliest = addDays(todayIST(), tenancy.property.minNoticeDays);
  if (date < earliest) throw badRequest(`This PG needs ${tenancy.property.minNoticeDays} days' notice. The earliest move-out date is ${toDateString(earliest)}.`);
  const existing = await prisma.moveOut.findUnique({ where: { tenancyId: tenancy.id } });
  if (existing && existing.status !== 'REJECTED') throw conflict('A move-out request already exists');
  const m = existing
    ? await prisma.moveOut.update({ where: { id: existing.id }, data: { status: 'REQUESTED', requestedMoveOutDate: date, noticeGivenAt: new Date(), ownerNote: null } })
    : await prisma.moveOut.create({ data: { tenancyId: tenancy.id, requestedMoveOutDate: date } });
  await audit(prisma, { actorId: user.id, action: 'MOVE_OUT_REQUESTED', entityType: 'MoveOut', entityId: m.id, after: { moveOutDate } });
  await push({ userId: tenancy.property.ownerId, title: 'Move-out notice', body: `${user.name} (room ${tenancy.bed.room.name}) gave notice to move out on ${moveOutDate}.` });
  res.status(201).json(m);
});

async function tenantMoveOut(user: User, expected: MoveOutStatus) {
  const profile = await prisma.tenantProfile.findUnique({ where: { userId: user.id } });
  const m = profile ? await prisma.moveOut.findFirst({ where: { tenancy: { tenantProfileId: profile.id } }, orderBy: { createdAt: 'desc' }, include: moveOutInclude }) : null;
  if (!m) throw notFound('Move-out');
  if (m.status !== expected) throw conflict(`Move-out is ${m.status.toLowerCase().replace('_', ' ')}`);
  return m;
}

tenantMoveOutRouter.post('/move-out/accept', async (req, res) => {
  const user = me(req);
  const m = await tenantMoveOut(user, 'SETTLEMENT_PROPOSED');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.moveOut.update({ where: { id: m.id }, data: { status: 'TENANT_ACCEPTED', tenantComment: null } });
    await audit(tx, { actorId: user.id, action: 'SETTLEMENT_ACCEPTED', entityType: 'MoveOut', entityId: m.id, after: { refundPaise: m.refundPaise } });
    return u;
  });
  await push({ userId: m.tenancy.property.ownerId, title: 'Settlement accepted', body: `${user.name} accepted the deposit settlement.` });
  res.json(updated);
});

tenantMoveOutRouter.post('/move-out/dispute', async (req, res) => {
  const user = me(req);
  const { comment } = parse(z.object({ comment: z.string().trim().min(5).max(1000) }), req.body);
  const m = await tenantMoveOut(user, 'SETTLEMENT_PROPOSED');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.moveOut.update({ where: { id: m.id }, data: { status: 'DISPUTED', tenantComment: comment } });
    await audit(tx, { actorId: user.id, action: 'SETTLEMENT_DISPUTED', entityType: 'MoveOut', entityId: m.id, after: { comment } });
    return u;
  });
  await push({ userId: m.tenancy.property.ownerId, title: 'Settlement disputed', body: `${user.name}: ${comment.slice(0, 150)}` });
  res.json(updated);
});

// ---- Owner -----------------------------------------------------------------------------

export const ownerMoveOutRouter = Router();

async function ownedMoveOut(user: User, id: string) {
  const m = await prisma.moveOut.findFirst({ where: { id, tenancy: { property: { ownerId: user.id } } }, include: moveOutInclude });
  if (!m) throw notFound('Move-out');
  return m;
}

ownerMoveOutRouter.get('/move-outs', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { propertyId, status } = parse(z.object({ propertyId: z.string().optional(), status: z.enum(['OPEN', 'ALL']).default('OPEN') }), req.query);
  const ids = await managedPropertyIds(user);
  const rows = await prisma.moveOut.findMany({
    where: {
      tenancy: { propertyId: { in: propertyId ? ids.filter((i) => i === propertyId) : ids } },
      ...(status === 'OPEN' ? { status: { notIn: ['COMPLETED', 'REJECTED'] } } : {}),
    },
    orderBy: { requestedMoveOutDate: 'asc' },
    include: moveOutInclude,
  });
  res.json({ items: rows });
});

ownerMoveOutRouter.get('/move-outs/:id', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  const m = await ownedMoveOut(me(req), id);
  const held = await prisma.$transaction((tx) => depositHeld(tx, m.tenancyId));
  res.json({ ...m, currentDepositHeldPaise: held, outstandingDuesPaise: await outstandingDues(m.tenancyId) });
});

ownerMoveOutRouter.post('/move-outs/:id/accept', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { note } = parse(z.object({ note: z.string().trim().max(500).optional() }), req.body ?? {});
  const m = await ownedMoveOut(user, id);
  if (m.status !== 'REQUESTED') throw conflict('Only new requests can be accepted');
  const updated = await prisma.$transaction(async (tx) => {
    await adjustInvoicesForEnd(tx, m.tenancyId, m.requestedMoveOutDate, user.id);
    await tx.tenancy.update({ where: { id: m.tenancyId }, data: { status: 'NOTICE', endDate: m.requestedMoveOutDate } });
    const u = await tx.moveOut.update({ where: { id }, data: { status: 'ACCEPTED', ownerNote: note } });
    await audit(tx, { actorId: user.id, action: 'MOVE_OUT_ACCEPTED', entityType: 'MoveOut', entityId: id, after: { endDate: toDateString(m.requestedMoveOutDate) } });
    return u;
  });
  await push({ userId: m.tenancy.tenantProfile.userId, title: 'Move-out accepted', body: `Your move-out on ${toDateString(m.requestedMoveOutDate)} is confirmed.` });
  res.json(updated);
});

ownerMoveOutRouter.post('/move-outs/:id/reject', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { note } = parse(z.object({ note: z.string().trim().min(3).max(500) }), req.body);
  const m = await ownedMoveOut(user, id);
  if (m.status !== 'REQUESTED') throw conflict('Only new requests can be rejected');
  const updated = await prisma.moveOut.update({ where: { id }, data: { status: 'REJECTED', ownerNote: note } });
  await audit(prisma, { actorId: user.id, action: 'MOVE_OUT_REJECTED', entityType: 'MoveOut', entityId: id, after: { note } });
  await push({ userId: m.tenancy.tenantProfile.userId, title: 'Move-out request declined', body: note });
  res.json(updated);
});

ownerMoveOutRouter.post('/move-outs/:id/inspection', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { checklist } = parse(
    z.object({ checklist: z.array(z.object({ item: z.string().trim().min(1).max(80), ok: z.boolean(), note: z.string().trim().max(300).optional() })).min(1).max(40) }),
    req.body,
  );
  const m = await ownedMoveOut(user, id);
  if (!['ACCEPTED', 'SETTLEMENT_PROPOSED', 'DISPUTED'].includes(m.status)) throw conflict('Inspection can be recorded after accepting the move-out');
  const updated = await prisma.moveOut.update({ where: { id }, data: { checklist } });
  await audit(prisma, { actorId: user.id, action: 'INSPECTION_RECORDED', entityType: 'MoveOut', entityId: id, after: { items: checklist.length, issues: checklist.filter((c) => !c.ok).length } });
  res.json(updated);
});

ownerMoveOutRouter.post('/move-outs/:id/settlement', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { deductions } = parse(
    z.object({
      deductions: z
        .array(z.object({ reason: z.string().trim().min(2).max(200), amountPaise: paiseSchema.refine((v) => v > 0, 'Must be more than zero'), photoFileId: z.string().optional() }))
        .max(30),
    }),
    req.body,
  );
  const m = await ownedMoveOut(user, id);
  if (!['ACCEPTED', 'DISPUTED', 'SETTLEMENT_PROPOSED'].includes(m.status)) throw conflict('Settlement can be proposed after accepting the move-out');
  const photoIds = deductions.flatMap((d) => (d.photoFileId ? [d.photoFileId] : []));
  await assertOwnUploadedFiles(user.id, photoIds, 'DEDUCTION_PHOTO');
  const updated = await prisma.$transaction(async (tx) => {
    const held = await depositHeld(tx, m.tenancyId);
    const s = computeSettlement(held, deductions);
    await tx.settlementDeduction.updateMany({ where: { moveOutId: id, status: 'ACTIVE' }, data: { status: 'INACTIVE' } });
    if (deductions.length) await tx.settlementDeduction.createMany({ data: deductions.map((d) => ({ moveOutId: id, reason: d.reason, amountPaise: d.amountPaise, photoFileId: d.photoFileId })) });
    const u = await tx.moveOut.update({
      where: { id },
      data: { status: 'SETTLEMENT_PROPOSED', depositHeldPaise: s.depositHeldPaise, deductionsPaise: s.deductionsPaise, refundPaise: s.refundPaise, balanceDuePaise: s.balanceDuePaise },
      include: moveOutInclude,
    });
    await audit(tx, { actorId: user.id, action: 'SETTLEMENT_PROPOSED', entityType: 'MoveOut', entityId: id, before: m.status === 'DISPUTED' ? { refundPaise: m.refundPaise, tenantComment: m.tenantComment } : null, after: { ...s, deductions } });
    return u;
  });
  await push({ userId: m.tenancy.tenantProfile.userId, title: 'Deposit settlement ready', body: 'Review the deposit settlement in the app and accept or dispute it.' });
  res.json(updated);
});

ownerMoveOutRouter.post('/move-outs/:id/complete', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const m = await ownedMoveOut(user, id);
  if (m.status !== 'TENANT_ACCEPTED') throw conflict('The tenant must accept the settlement first');
  const updated = await prisma.$transaction(async (tx) => {
    const held = await depositHeld(tx, m.tenancyId);
    if (held !== m.depositHeldPaise) throw conflict('The deposit changed since the settlement was proposed. Propose it again.');
    const s = computeSettlement(held, m.deductions);
    for (const d of m.deductions) {
      const e = await tx.depositLedger.create({ data: { tenancyId: m.tenancyId, type: 'DEDUCTION', amountPaise: d.amountPaise, reason: d.reason, photoFileId: d.photoFileId, moveOutId: id, createdById: user.id } });
      await audit(tx, { actorId: user.id, action: 'DEPOSIT_LEDGER_ADDED', entityType: 'DepositLedger', entityId: e.id, after: { type: 'DEDUCTION', amountPaise: d.amountPaise, reason: d.reason } });
    }
    if (s.refundPaise > 0) {
      const e = await tx.depositLedger.create({ data: { tenancyId: m.tenancyId, type: 'REFUND', amountPaise: s.refundPaise, reason: 'Deposit refund at move-out', moveOutId: id, createdById: user.id } });
      await audit(tx, { actorId: user.id, action: 'DEPOSIT_LEDGER_ADDED', entityType: 'DepositLedger', entityId: e.id, after: { type: 'REFUND', amountPaise: s.refundPaise } });
    }
    // End the tenancy; the bed becomes vacant automatically (status is derived).
    await tx.tenancy.update({ where: { id: m.tenancyId }, data: { status: 'ENDED', endDate: m.tenancy.endDate ?? m.requestedMoveOutDate } });
    const u = await tx.moveOut.update({ where: { id }, data: { status: 'COMPLETED' } });
    await audit(tx, { actorId: user.id, action: 'MOVE_OUT_COMPLETED', entityType: 'MoveOut', entityId: id, after: s });
    return u;
  });
  await push({ userId: m.tenancy.tenantProfile.userId, title: 'Move-out complete', body: m.refundPaise ? 'Your deposit refund has been recorded by the owner.' : 'Your move-out is complete.' });
  res.json(updated);
});
