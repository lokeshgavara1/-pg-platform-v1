import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, parse } from '../../lib/http.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';

/**
 * Pilot-support admin API. Read-only except deactivate/activate, which writes an audit row.
 * Admins cannot open tenant KYC files (see files/service.ts).
 */
export const adminRouter = Router();

adminRouter.get('/users', async (req, res) => {
  const { phone } = parse(z.object({ phone: z.string().trim().max(20).optional() }), req.query);
  const digits = (phone ?? '').replace(/\D/g, '');
  const users = await prisma.user.findMany({
    where: digits.length >= 3 ? { phone: { contains: digits } } : {},
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { id: true, name: true, phone: true, role: true, status: true, createdAt: true },
  });
  res.json({ items: users });
});

adminRouter.get('/users/:id', async (req, res) => {
  const { id } = parse(idParam, req.params);
  const u = await prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      phone: true,
      role: true,
      status: true,
      createdAt: true,
      ownedProperties: { select: { id: true, name: true, city: true, status: true } },
      tenantProfile: {
        select: {
          id: true,
          kycStatus: true,
          tenancies: { select: { id: true, status: true, startDate: true, endDate: true, property: { select: { name: true } } } },
        },
      },
    },
  });
  if (!u) throw notFound('User');
  res.json(u);
});

/** Audit trail for a user: actions they took, and changes to their profile/tenancies. */
adminRouter.get('/users/:id/audit', async (req, res) => {
  const { id } = parse(idParam, req.params);
  const profile = await prisma.tenantProfile.findUnique({ where: { userId: id }, include: { tenancies: { select: { id: true } } } });
  const entityIds = [id, ...(profile ? [profile.id, ...profile.tenancies.map((t) => t.id)] : [])];
  const rows = await prisma.auditLog.findMany({
    where: { OR: [{ actorId: id }, { entityId: { in: entityIds } }] },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { actor: { select: { name: true, role: true } } },
  });
  res.json({ items: rows });
});

adminRouter.post('/users/:id/deactivate', async (req, res) => {
  const admin = req.user!;
  const { id } = parse(idParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('User');
  if (u.id === admin.id) throw conflict('You cannot deactivate yourself');
  if (u.status === 'DEACTIVATED') throw conflict('Already deactivated');
  const updated = await prisma.$transaction(async (tx) => {
    const x = await tx.user.update({ where: { id }, data: { status: 'DEACTIVATED' } });
    await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(tx, { actorId: admin.id, action: 'USER_DEACTIVATED', entityType: 'User', entityId: id, before: { status: u.status }, after: { status: 'DEACTIVATED', reason } });
    return x;
  });
  res.json({ id: updated.id, status: updated.status });
});

adminRouter.post('/users/:id/activate', async (req, res) => {
  const admin = req.user!;
  const { id } = parse(idParam, req.params);
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) throw notFound('User');
  if (u.status === 'ACTIVE') throw conflict('Already active');
  const updated = await prisma.$transaction(async (tx) => {
    const x = await tx.user.update({ where: { id }, data: { status: 'ACTIVE' } });
    await audit(tx, { actorId: admin.id, action: 'USER_ACTIVATED', entityType: 'User', entityId: id, before: { status: u.status }, after: { status: 'ACTIVE' } });
    return x;
  });
  res.json({ id: updated.id, status: updated.status });
});

adminRouter.get('/payments/failed', async (_req, res) => {
  const rows = await prisma.payment.findMany({
    where: { status: 'FAILED' },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, amountPaise: true, provider: true, failureReason: true, createdAt: true, invoice: { select: { number: true, property: { select: { name: true } } } } },
  });
  res.json({ items: rows });
});

adminRouter.get('/webhooks', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['FAILED', 'REJECTED', 'IGNORED', 'PROCESSED', 'PROBLEMS']).default('PROBLEMS') }), req.query);
  const rows = await prisma.webhookEvent.findMany({
    where: status === 'PROBLEMS' ? { status: { in: ['FAILED', 'REJECTED'] } } : { status },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: { id: true, provider: true, eventId: true, type: true, signatureOk: true, status: true, error: true, createdAt: true },
  });
  res.json({ items: rows });
});
