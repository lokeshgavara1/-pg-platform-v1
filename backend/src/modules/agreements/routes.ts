import { Router } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, parse } from '../../lib/http.js';
import { badRequest, conflict, notFound, tooMany } from '../../lib/errors.js';
import { limiters } from '../../lib/rateLimit.js';
import { audit } from '../../lib/audit.js';
import { env } from '../../config/env.js';
import { shouldExposeDevOtp } from '../../config/providerGuard.js';
import { me, requireRole } from '../auth/middleware.js';
import { ownedTenancy, requireCurrentTenancy } from '../access.js';
import { storeGeneratedFile } from '../files/service.js';
import { esign } from '../../providers/esign.js';
import { push } from '../../providers/message.js';
import { agreementPdf } from './service.js';

const otpHash = (agreementId: string, otp: string) => createHmac('sha256', env.OTP_HASH_SECRET).update(`esign:${agreementId}:${otp}`).digest('hex');

// ---- Owner -----------------------------------------------------------------------------

export const ownerAgreementsRouter = Router();

ownerAgreementsRouter.post('/tenancies/:id/agreement', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const t = await ownedTenancy(user, id);
  if (t.status === 'ENDED') throw conflict('This tenancy has ended');
  const pdf = await agreementPdf(id);
  const file = await storeGeneratedFile(user.id, 'AGREEMENT', 'application/pdf', pdf);
  const agreement = await prisma.$transaction(async (tx) => {
    // A new draft replaces any unsigned earlier draft.
    await tx.agreement.updateMany({ where: { tenancyId: id, status: 'DRAFT' }, data: { status: 'VOID' } });
    return tx.agreement.create({ data: { tenancyId: id, pdfFileId: file.id, esignProvider: esign().name, esignDevOnly: esign().devOnly } });
  });
  await push({
    userId: t.tenantProfile.userId,
    title: 'Agreement ready',
    body: esign().name === 'paper'
      ? `Your rental agreement for ${t.property.name} is ready. Read it in the app; your owner will give you a printed copy to sign.`
      : `Your rental agreement for ${t.property.name} is ready. Open the app to review and sign.`,
  });
  res.status(201).json(agreement);
});

/** The tenant signed a printed copy: the owner records it. */
ownerAgreementsRouter.post('/agreements/:id/mark-signed', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const a = await prisma.agreement.findFirst({ where: { id, tenancy: { property: { ownerId: user.id } } }, include: { tenancy: { include: { tenantProfile: true } } } });
  if (!a) throw notFound('Agreement');
  if (a.status !== 'DRAFT') throw conflict(a.status === 'SIGNED' ? 'This agreement is already signed' : 'This agreement was replaced by a newer one');
  const signed = await prisma.$transaction(async (tx) => {
    const r = await tx.agreement.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'SIGNED', signedAt: new Date(), esignProvider: 'paper', esignDevOnly: false, signOtpHash: null, signOtpExpiresAt: null },
    });
    if (r.count !== 1) throw conflict('This agreement is already signed');
    await audit(tx, { actorId: user.id, action: 'AGREEMENT_SIGNED_ON_PAPER', entityType: 'Agreement', entityId: id, after: { tenancyId: a.tenancyId } });
    return tx.agreement.findUniqueOrThrow({ where: { id } });
  });
  await push({ userId: a.tenancy.tenantProfile.userId, title: 'Agreement signed', body: 'Your owner recorded your signed rental agreement.' });
  res.json({ ...signed, signOtpHash: undefined });
});

// ---- Tenant ----------------------------------------------------------------------------

export const tenantAgreementsRouter = Router();

tenantAgreementsRouter.get('/agreement', async (req, res) => {
  const { tenancy } = await requireCurrentTenancy(me(req));
  const a = await prisma.agreement.findFirst({ where: { tenancyId: tenancy.id, status: { in: ['DRAFT', 'SIGNED'] } }, orderBy: { createdAt: 'desc' } });
  res.json({ agreement: a ? { ...a, signOtpHash: undefined } : null });
});

async function currentDraft(userId: string, agreementId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const { tenancy } = await requireCurrentTenancy(user);
  const a = await prisma.agreement.findFirst({ where: { id: agreementId, tenancyId: tenancy.id } });
  if (!a) throw notFound('Agreement');
  if (a.status !== 'DRAFT') throw conflict('This agreement is not awaiting signature');
  return { a, user, tenancy };
}

tenantAgreementsRouter.post('/agreement/:id/request-otp', async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { a, user } = await currentDraft(me(req).id, id);
  if (esign().name === 'paper') throw conflict('This PG signs agreements on paper. Ask your owner for a printed copy.');
  if (!limiters.otpPerPhone.hit(`esign:${user.phone}`)) throw tooMany();
  const { otp } = await esign().startSigning({ agreementId: a.id, signerPhone: user.phone });
  await prisma.agreement.update({ where: { id: a.id }, data: { signOtpHash: otpHash(a.id, otp), signOtpExpiresAt: new Date(Date.now() + 5 * 60 * 1000) } });
  res.json({ ok: true, devOnly: esign().devOnly, ...(shouldExposeDevOtp(env) ? { devOtp: otp } : {}) });
});

tenantAgreementsRouter.post('/agreement/:id/sign', async (req, res) => {
  const { id } = parse(idParam, req.params);
  const { otp } = parse(z.object({ otp: z.string().regex(/^\d{6}$/) }), req.body);
  const { a, user, tenancy } = await currentDraft(me(req).id, id);
  if (!a.signOtpHash || !a.signOtpExpiresAt || a.signOtpExpiresAt < new Date()) throw badRequest('Request a new OTP');
  const ok = timingSafeEqual(Buffer.from(a.signOtpHash, 'hex'), Buffer.from(otpHash(a.id, otp), 'hex'));
  if (!ok) {
    // One attempt per code: a wrong guess burns it, so the OTP cannot be brute-forced.
    await prisma.agreement.update({ where: { id: a.id }, data: { signOtpHash: null, signOtpExpiresAt: null } });
    throw badRequest('Incorrect OTP. Request a new one.');
  }
  const signedAt = new Date();
  const pdf = await agreementPdf(tenancy.id, { name: user.name, at: signedAt, provider: esign().name, devOnly: esign().devOnly });
  const file = await storeGeneratedFile(user.id, 'AGREEMENT', 'application/pdf', pdf);
  const signed = await prisma.$transaction(async (tx) => {
    const r = await tx.agreement.updateMany({
      where: { id: a.id, status: 'DRAFT' },
      data: { status: 'SIGNED', signedAt, signedPdfFileId: file.id, signOtpHash: null, signOtpExpiresAt: null, esignDevOnly: esign().devOnly },
    });
    if (r.count !== 1) throw conflict('Already signed');
    await audit(tx, { actorId: user.id, action: 'AGREEMENT_SIGNED', entityType: 'Agreement', entityId: a.id, after: { provider: esign().name, devOnly: esign().devOnly } });
    return tx.agreement.findUniqueOrThrow({ where: { id: a.id } });
  });
  await push({ userId: tenancy.property.ownerId, title: 'Agreement signed', body: `${user.name} signed the rental agreement.` });
  res.json({ ...signed, signOtpHash: undefined });
});
