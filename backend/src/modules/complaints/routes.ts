import { Router } from 'express';
import { z } from 'zod';
import type { ComplaintStatus, Prisma, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { idParam, pageQuery, paged, parse } from '../../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds, requireCurrentTenancy } from '../access.js';
import { assertOwnUploadedFiles } from '../files/service.js';
import { push } from '../../providers/message.js';

export const COMPLAINT_CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'CLEANING', 'FOOD', 'WIFI', 'FURNITURE', 'SECURITY', 'NOISE', 'OTHER'] as const;

const detailInclude = {
  property: { select: { id: true, name: true, ownerId: true } },
  tenancy: { select: { id: true, bed: { select: { label: true, room: { select: { name: true } } } } } },
  raisedBy: { select: { id: true, name: true } },
  assignedTo: { select: { id: true, name: true } },
  updates: { orderBy: { createdAt: 'asc' } },
  photos: { select: { id: true, mimeType: true } },
} satisfies Prisma.ComplaintInclude;

async function statusPush(c: { id: string; raisedById: string; category: string }, status: ComplaintStatus, message?: string) {
  await push({
    userId: c.raisedById,
    title: `Complaint ${status.replace('_', ' ').toLowerCase()}`,
    body: `${c.category.toLowerCase()} complaint: ${message ?? `status is now ${status.replace('_', ' ').toLowerCase()}`}`,
  });
}

// ---- Tenant ----------------------------------------------------------------------------

export const tenantComplaintsRouter = Router();

tenantComplaintsRouter.get('/complaints', async (req, res) => {
  const user = me(req);
  const rows = await prisma.complaint.findMany({ where: { raisedById: user.id }, orderBy: { createdAt: 'desc' }, include: detailInclude });
  res.json({ items: rows });
});

tenantComplaintsRouter.get('/complaints/:id', async (req, res) => {
  const { id } = parse(idParam, req.params);
  const c = await prisma.complaint.findFirst({ where: { id, raisedById: me(req).id }, include: detailInclude });
  if (!c) throw notFound('Complaint');
  res.json(c);
});

tenantComplaintsRouter.post('/complaints', async (req, res) => {
  const user = me(req);
  const input = parse(
    z.object({
      category: z.enum(COMPLAINT_CATEGORIES),
      description: z.string().trim().min(5).max(2000),
      photoFileIds: z.array(z.string()).max(3, 'Up to 3 photos').default([]),
    }),
    req.body,
  );
  const { tenancy } = await requireCurrentTenancy(user);
  await assertOwnUploadedFiles(user.id, input.photoFileIds, 'COMPLAINT_PHOTO');
  const already = await prisma.fileObject.count({ where: { id: { in: input.photoFileIds }, complaintId: { not: null } } });
  if (already) throw badRequest('A photo is already attached to another complaint');
  const c = await prisma.complaint.create({
    data: {
      propertyId: tenancy.propertyId,
      tenancyId: tenancy.id,
      raisedById: user.id,
      category: input.category,
      description: input.description,
      photos: { connect: input.photoFileIds.map((id) => ({ id })) },
    },
    include: detailInclude,
  });
  await push({ userId: tenancy.property.ownerId, title: 'New complaint', body: `${user.name} (room ${tenancy.bed.room.name}) raised a ${input.category.toLowerCase()} complaint.` });
  res.status(201).json(c);
});

// ---- Owner & staff -----------------------------------------------------------------------

export const ownerComplaintsRouter = Router();

/** Owners see complaints in their properties; staff see only complaints assigned to them. */
async function complaintScope(user: User): Promise<Prisma.ComplaintWhereInput> {
  if (user.role === 'OWNER') return { propertyId: { in: await managedPropertyIds(user) } };
  if (user.role === 'STAFF') return { assignedToId: user.id, propertyId: { in: await managedPropertyIds(user) } };
  throw forbidden();
}

async function scopedComplaint(user: User, id: string) {
  const c = await prisma.complaint.findFirst({ where: { id, ...(await complaintScope(user)) }, include: detailInclude });
  if (!c) throw notFound('Complaint');
  return c;
}

ownerComplaintsRouter.get('/complaints', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const user = me(req);
  const q = parse(pageQuery.extend({ propertyId: z.string().optional(), status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'ACTIVE']).optional() }), req.query);
  const where: Prisma.ComplaintWhereInput = { ...(await complaintScope(user)) };
  if (q.propertyId) where.AND = [{ propertyId: q.propertyId }];
  if (q.status === 'ACTIVE') where.status = { in: ['OPEN', 'IN_PROGRESS'] };
  else if (q.status) where.status = q.status;
  const [items, total] = await Promise.all([
    prisma.complaint.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: detailInclude }),
    prisma.complaint.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

ownerComplaintsRouter.get('/complaints/:id', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  res.json(await scopedComplaint(me(req), id));
});

ownerComplaintsRouter.post('/complaints/:id/assign', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { staffUserId } = parse(z.object({ staffUserId: z.string().nullable() }), req.body);
  const c = await scopedComplaint(user, id);
  if (c.status === 'CLOSED') throw conflict('This complaint is closed');
  let staffName = 'nobody';
  if (staffUserId) {
    const s = await prisma.propertyStaff.findFirst({ where: { userId: staffUserId, propertyId: c.propertyId, status: 'ACTIVE' }, include: { user: true } });
    if (!s) throw badRequest('That person is not active staff at this property');
    staffName = s.user.name;
  }
  const updated = await prisma.$transaction(async (tx) => {
    await tx.complaintUpdate.create({ data: { complaintId: id, authorId: user.id, message: `Assigned to ${staffName}` } });
    return tx.complaint.update({ where: { id }, data: { assignedToId: staffUserId }, include: detailInclude });
  });
  if (staffUserId) await push({ userId: staffUserId, title: 'Complaint assigned to you', body: `${c.category.toLowerCase()} — room ${c.tenancy.bed.room.name}` });
  res.json(updated);
});

ownerComplaintsRouter.post('/complaints/:id/updates', requireRole('OWNER', 'STAFF'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const input = parse(z.object({ message: z.string().trim().min(2).max(1000), status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional() }), req.body);
  const c = await scopedComplaint(user, id);
  if (c.status === 'CLOSED') throw conflict('This complaint is closed');
  const changed = input.status && input.status !== c.status ? input.status : undefined;
  const updated = await prisma.$transaction(async (tx) => {
    await tx.complaintUpdate.create({ data: { complaintId: id, authorId: user.id, message: input.message, fromStatus: changed ? c.status : undefined, toStatus: changed } });
    return tx.complaint.update({ where: { id }, data: changed ? { status: changed } : { updatedAt: new Date() }, include: detailInclude });
  });
  await statusPush(c, changed ?? c.status, input.message);
  res.json(updated);
});

ownerComplaintsRouter.post('/complaints/:id/close', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { note } = parse(z.object({ note: z.string().trim().min(2).max(1000) }), req.body);
  const c = await scopedComplaint(user, id);
  if (c.status === 'CLOSED') throw conflict('Already closed');
  const updated = await prisma.$transaction(async (tx) => {
    await tx.complaintUpdate.create({ data: { complaintId: id, authorId: user.id, message: note, fromStatus: c.status, toStatus: 'CLOSED' } });
    return tx.complaint.update({ where: { id }, data: { status: 'CLOSED', closingNote: note }, include: detailInclude });
  });
  await statusPush(c, 'CLOSED', note);
  res.json(updated);
});
