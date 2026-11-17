import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, parse } from '../../lib/http.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds, ownedProperty, tenantContext } from '../access.js';
import { push } from '../../providers/message.js';

export const ownerNoticesRouter = Router();

ownerNoticesRouter.get('/notices', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const user = me(req);
  const { propertyId } = parse(z.object({ propertyId: z.string().optional() }), req.query);
  const ids = await managedPropertyIds(user);
  const rows = await prisma.notice.findMany({
    where: { propertyId: { in: propertyId ? ids.filter((i) => i === propertyId) : ids }, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { property: { select: { name: true } }, room: { select: { name: true } } },
  });
  res.json({ items: rows });
});

ownerNoticesRouter.post('/notices', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const input = parse(
    z.object({
      propertyId: z.string(),
      roomId: z.string().optional(),
      title: z.string().trim().min(3).max(120),
      body: z.string().trim().min(3).max(4000),
    }),
    req.body,
  );
  await ownedProperty(user, input.propertyId);
  if (input.roomId) {
    const room = await prisma.room.findFirst({ where: { id: input.roomId, propertyId: input.propertyId } });
    if (!room) throw badRequest('Room does not belong to this property');
  }
  const notice = await prisma.notice.create({ data: { ...input, authorId: user.id } });
  // Push to the tenants the notice is addressed to.
  const recipients = await prisma.tenancy.findMany({
    where: { propertyId: input.propertyId, status: { in: ['ACTIVE', 'NOTICE'] }, ...(input.roomId ? { bed: { roomId: input.roomId } } : {}) },
    select: { tenantProfile: { select: { userId: true } } },
  });
  for (const r of recipients) await push({ userId: r.tenantProfile.userId, title: `Notice: ${input.title}`, body: input.body.slice(0, 200) });
  res.status(201).json(notice);
});

ownerNoticesRouter.post('/notices/:id/archive', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const n = await prisma.notice.findFirst({ where: { id, property: { ownerId: user.id } } });
  if (!n) throw notFound('Notice');
  res.json(await prisma.notice.update({ where: { id }, data: { status: 'INACTIVE' } }));
});

export const tenantNoticesRouter = Router();

tenantNoticesRouter.get('/notices', async (req, res) => {
  const { tenancy } = await tenantContext(me(req));
  if (!tenancy) return res.json({ items: [] });
  const rows = await prisma.notice.findMany({
    where: { propertyId: tenancy.propertyId, status: 'ACTIVE', OR: [{ roomId: null }, { roomId: tenancy.bed.roomId }] },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { room: { select: { name: true } } },
  });
  res.json({ items: rows });
});
