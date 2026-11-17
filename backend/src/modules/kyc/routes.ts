import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, parse } from '../../lib/http.js';
import { conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { me, requireRole } from '../auth/middleware.js';
import { ensureTenantProfile, managedPropertyIds } from '../access.js';
import { assertOwnUploadedFiles, ownerCanSeeTenant } from '../files/service.js';
import { kyc } from '../../providers/kyc.js';
import { push } from '../../providers/message.js';

const ID_TYPES = ['AADHAAR', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID', 'PAN'] as const;

// ---- Tenant ----------------------------------------------------------------------------

export const tenantKycRouter = Router();

tenantKycRouter.get('/kyc', async (req, res) => {
  const p = await ensureTenantProfile(me(req).id);
  res.json({
    kycStatus: p.kycStatus,
    kycRejectReason: p.kycRejectReason,
    idType: p.idType,
    idLast4: p.idLast4,
    kycIdFileId: p.kycIdFileId,
    kycPhotoFileId: p.kycPhotoFileId,
    kycSubmittedAt: p.kycSubmittedAt,
  });
});

tenantKycRouter.post('/kyc/submit', async (req, res) => {
  const user = me(req);
  const input = parse(
    z.object({
      idType: z.enum(ID_TYPES),
      // Only the last 4 characters are ever accepted or stored.
      idLast4: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{4}$/, 'Enter only the last 4 characters of the ID').optional(),
      idFileId: z.string(),
      photoFileId: z.string(),
    }),
    req.body,
  );
  const profile = await ensureTenantProfile(user.id);
  if (profile.kycStatus === 'APPROVED') throw conflict('Your KYC is already approved');
  if (profile.kycStatus === 'PENDING') throw conflict('Your KYC is already under review');
  await assertOwnUploadedFiles(user.id, [input.idFileId], 'KYC_ID');
  await assertOwnUploadedFiles(user.id, [input.photoFileId], 'KYC_PHOTO');

  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.tenantProfile.update({
      where: { id: profile.id },
      data: {
        idType: input.idType,
        idLast4: input.idLast4 ?? null,
        kycIdFileId: input.idFileId,
        kycPhotoFileId: input.photoFileId,
        kycStatus: 'PENDING',
        kycRejectReason: null,
        kycSubmittedAt: new Date(),
      },
    });
    await audit(tx, { actorId: user.id, action: 'KYC_SUBMITTED', entityType: 'TenantProfile', entityId: p.id, before: { kycStatus: profile.kycStatus }, after: { kycStatus: 'PENDING', idType: input.idType } });
    return p;
  });

  const check = await kyc().check({ tenantProfileId: updated.id, idType: input.idType, idFileId: input.idFileId, photoFileId: input.photoFileId });
  if (check.outcome !== 'MANUAL_REVIEW') {
    await prisma.$transaction(async (tx) => {
      const status = check.outcome === 'VERIFIED' ? 'APPROVED' : 'REJECTED';
      await tx.tenantProfile.update({ where: { id: updated.id }, data: { kycStatus: status, kycRejectReason: check.reason, kycReviewedAt: new Date() } });
      await audit(tx, { actorId: null, action: `KYC_${status}`, entityType: 'TenantProfile', entityId: updated.id, before: { kycStatus: 'PENDING' }, after: { kycStatus: status, by: kyc().name } });
    });
  }
  // Tell the owner(s) of the tenant's current stay or booking.
  const owners = await prisma.property.findMany({
    where: { OR: [{ tenancies: { some: { tenantProfileId: updated.id, status: { in: ['ACTIVE', 'NOTICE'] } } } }, { bookings: { some: { tenantUserId: user.id, status: { in: ['RESERVED', 'PAID'] } } } }] },
    select: { ownerId: true },
  });
  for (const o of new Set(owners.map((x) => x.ownerId))) {
    await push({ userId: o, title: 'KYC to review', body: `${user.name} submitted ID documents for review.` });
  }
  res.json({ kycStatus: check.outcome === 'VERIFIED' ? 'APPROVED' : check.outcome === 'FAILED' ? 'REJECTED' : 'PENDING' });
});

// ---- Owner -----------------------------------------------------------------------------

export const ownerKycRouter = Router();

ownerKycRouter.get('/kyc', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { status } = parse(z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'NOT_SUBMITTED']).default('PENDING') }), req.query);
  const ids = await managedPropertyIds(user);
  const rows = await prisma.tenantProfile.findMany({
    where: {
      kycStatus: status,
      OR: [
        { tenancies: { some: { propertyId: { in: ids }, status: { in: ['ACTIVE', 'NOTICE'] } } } },
        { user: { bookings: { some: { propertyId: { in: ids }, status: { in: ['RESERVED', 'PAID'] } } } } },
      ],
    },
    orderBy: { kycSubmittedAt: 'asc' },
    take: 100,
    select: {
      id: true,
      kycStatus: true,
      kycRejectReason: true,
      idType: true,
      idLast4: true,
      kycIdFileId: true,
      kycPhotoFileId: true,
      kycSubmittedAt: true,
      user: { select: { id: true, name: true, phone: true } },
    },
  });
  res.json({ items: rows });
});

async function reviewable(ownerId: string, profileId: string) {
  const p = await prisma.tenantProfile.findUnique({ where: { id: profileId } });
  if (!p || !(await ownerCanSeeTenant(ownerId, p.userId))) throw notFound('Tenant');
  return p;
}

ownerKycRouter.post('/kyc/:id/approve', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const p = await reviewable(user.id, id);
  if (p.kycStatus !== 'PENDING') throw conflict('Only pending KYC can be approved');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.tenantProfile.update({ where: { id }, data: { kycStatus: 'APPROVED', kycRejectReason: null, kycReviewedAt: new Date(), kycReviewedById: user.id } });
    await audit(tx, { actorId: user.id, action: 'KYC_APPROVED', entityType: 'TenantProfile', entityId: id, before: { kycStatus: p.kycStatus }, after: { kycStatus: 'APPROVED' } });
    return u;
  });
  await push({ userId: p.userId, title: 'KYC approved', body: 'Your ID documents were approved.' });
  res.json({ id: updated.id, kycStatus: updated.kycStatus });
});

ownerKycRouter.post('/kyc/:id/reject', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }), req.body);
  const p = await reviewable(user.id, id);
  if (p.kycStatus !== 'PENDING') throw conflict('Only pending KYC can be rejected');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.tenantProfile.update({ where: { id }, data: { kycStatus: 'REJECTED', kycRejectReason: reason, kycReviewedAt: new Date(), kycReviewedById: user.id } });
    await audit(tx, { actorId: user.id, action: 'KYC_REJECTED', entityType: 'TenantProfile', entityId: id, before: { kycStatus: p.kycStatus }, after: { kycStatus: 'REJECTED', reason } });
    return u;
  });
  await push({ userId: p.userId, title: 'KYC needs attention', body: `Your ID documents were not accepted: ${reason}` });
  res.json({ id: updated.id, kycStatus: updated.kycStatus });
});
