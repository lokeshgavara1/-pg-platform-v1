import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, paiseSchema, parse, phoneSchema } from '../../lib/http.js';
import { conflict, notFound } from '../../lib/errors.js';
import { payOptions, reportUpiPayment, UPI_REF_RE, withdrawUpiReport } from '../payments/upi.js';
import { todayIST } from '../../lib/dates.js';
import { me } from '../auth/middleware.js';
import { ensureTenantProfile, tenantContext } from '../access.js';
import { createPaymentLink, receiptPdf } from '../payments/service.js';
import { depositHeld } from '../tenancies/service.js';

/** Tenant-only routes about the tenant's own stay. Mounted behind requireRole('TENANT'). */
export const tenantRouter = Router();

tenantRouter.get('/home', async (req, res) => {
  const user = me(req);
  const { profile, tenancy } = await tenantContext(user);
  const today = todayIST();
  let dues = { outstandingPaise: 0, overduePaise: 0, nextDueDate: null as Date | null };
  let agreement = null;
  let held = 0;
  if (tenancy) {
    const open = await prisma.invoice.findMany({ where: { tenancyId: tenancy.id, status: { in: ['DUE', 'PARTIAL'] } }, orderBy: { dueDate: 'asc' } });
    dues = {
      outstandingPaise: open.reduce((a, i) => a + i.totalPaise - i.paidPaise, 0),
      overduePaise: open.filter((i) => i.dueDate < today).reduce((a, i) => a + i.totalPaise - i.paidPaise, 0),
      nextDueDate: open[0]?.dueDate ?? null,
    };
    agreement = await prisma.agreement.findFirst({ where: { tenancyId: tenancy.id, status: { in: ['DRAFT', 'SIGNED'] } }, orderBy: { createdAt: 'desc' }, select: { id: true, status: true, signedAt: true, esignDevOnly: true } });
    held = await prisma.$transaction((tx) => depositHeld(tx, tenancy.id));
  }
  const booking = await prisma.booking.findFirst({
    where: { tenantUserId: user.id, status: { in: ['RESERVED', 'PAID'] } },
    include: { property: { select: { name: true } }, bed: { select: { label: true, room: { select: { name: true } } } } },
  });
  const unread = await prisma.notification.count({ where: { userId: user.id, readAt: null } });
  res.json({
    user: { id: user.id, name: user.name, phone: user.phone },
    kycStatus: profile?.kycStatus ?? 'NOT_SUBMITTED',
    stay: tenancy
      ? {
          tenancyId: tenancy.id,
          status: tenancy.status,
          propertyName: tenancy.property.name,
          propertyAddress: tenancy.property.address,
          room: tenancy.bed.room.name,
          bed: tenancy.bed.label,
          startDate: tenancy.startDate,
          endDate: tenancy.endDate,
          rentPaise: tenancy.rentPaise,
          depositPaise: tenancy.depositPaise,
          depositHeldPaise: held,
          rentDueDay: tenancy.property.rentDueDay,
          minNoticeDays: tenancy.property.minNoticeDays,
        }
      : null,
    dues,
    agreement,
    booking,
    unreadNotifications: unread,
  });
});

tenantRouter.get('/profile', async (req, res) => {
  const p = await ensureTenantProfile(me(req).id);
  res.json({
    guardianName: p.guardianName,
    guardianPhone: p.guardianPhone,
    fatherName: p.fatherName,
    permanentAddress: p.permanentAddress,
    occupation: p.occupation,
    workplace: p.workplace,
  });
});

tenantRouter.patch('/profile', async (req, res) => {
  const user = me(req);
  const input = parse(
    z
      .object({
        name: z.string().trim().min(2).max(80),
        guardianName: z.string().trim().max(80),
        guardianPhone: phoneSchema,
        fatherName: z.string().trim().max(80),
        permanentAddress: z.string().trim().max(400),
        occupation: z.string().trim().max(80),
        workplace: z.string().trim().max(120),
      })
      .partial()
      .strict(),
    req.body,
  );
  const { name, ...profile } = input;
  const p = await ensureTenantProfile(user.id);
  if (name) await prisma.user.update({ where: { id: user.id }, data: { name } });
  const updated = await prisma.tenantProfile.update({ where: { id: p.id }, data: profile });
  res.json({ ok: true, profile: { ...profile, id: updated.id } });
});

async function myInvoiceWhere(userId: string) {
  return {
    OR: [{ tenancy: { tenantProfile: { userId } } }, { booking: { tenantUserId: userId } }],
  };
}

tenantRouter.get('/invoices', async (req, res) => {
  const user = me(req);
  const { status } = parse(z.object({ status: z.enum(['UNPAID', 'ALL']).default('ALL') }), req.query);
  const rows = await prisma.invoice.findMany({
    where: { ...(await myInvoiceWhere(user.id)), ...(status === 'UNPAID' ? { status: { in: ['DUE', 'PARTIAL'] } } : { status: { not: 'VOID' } }) },
    orderBy: { dueDate: 'desc' },
    take: 100,
    include: {
      lines: true,
      property: { select: { name: true, upiId: true, upiPayeeName: true } },
      payments: { where: { status: 'REPORTED' }, select: { id: true, amountPaise: true, upiRef: true, createdAt: true } },
    },
  });
  res.json({ items: rows.map(({ property, payments, ...inv }) => ({ ...inv, property: { name: property.name }, payOptions: payOptions(property), pendingReports: payments })) });
});

tenantRouter.get('/invoices/:id', async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const inv = await prisma.invoice.findFirst({
    where: { id, ...(await myInvoiceWhere(user.id)) },
    include: { lines: true, payments: { where: { status: { in: ['SUCCESS', 'REPORTED'] } } }, property: { select: { name: true, upiId: true, upiPayeeName: true } } },
  });
  if (!inv) throw notFound('Invoice');
  const { property, ...rest } = inv;
  res.json({ ...rest, property: { name: property.name }, payOptions: payOptions(property) });
});

tenantRouter.post('/invoices/:id/pay-link', async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const inv = await prisma.invoice.findFirst({ where: { id, ...(await myInvoiceWhere(user.id)) }, include: { property: true } });
  if (!inv) throw notFound('Invoice');
  if (!payOptions(inv.property).gateway) throw conflict('Pay this PG directly by UPI instead');
  res.status(201).json(await createPaymentLink(id, { customerPhone: user.phone }));
});

/** "I've paid": the tenant paid the owner's UPI ID directly. The owner must confirm it. */
tenantRouter.post('/invoices/:id/upi-report', async (req, res) => {
  const { id } = parse(idParam, req.params);
  const input = parse(
    z.object({
      amountPaise: paiseSchema.refine((v) => v > 0, 'Amount must be more than zero').optional(),
      upiRef: z
        .string()
        .transform((s) => s.replace(/\s/g, ''))
        .pipe(z.string().regex(UPI_REF_RE, 'The UPI reference number has 12 digits'))
        .optional(),
    }),
    req.body ?? {},
  );
  const p = await reportUpiPayment(me(req), id, input);
  res.status(201).json({ id: p.id, status: p.status, amountPaise: p.amountPaise, upiRef: p.upiRef });
});

tenantRouter.post('/payments/:id/withdraw', async (req, res) => {
  const { id } = parse(idParam, req.params);
  res.json(await withdrawUpiReport(me(req), id));
});

tenantRouter.get('/payments', async (req, res) => {
  const user = me(req);
  const rows = await prisma.payment.findMany({
    where: { status: 'SUCCESS', invoice: await myInvoiceWhere(user.id) },
    orderBy: { receivedAt: 'desc' },
    take: 100,
    select: { id: true, amountPaise: true, method: true, receivedAt: true, invoice: { select: { number: true, kind: true, periodStart: true, property: { select: { name: true } } } } },
  });
  res.json({ items: rows });
});

tenantRouter.get('/payments/:id/receipt.pdf', async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const p = await prisma.payment.findFirst({ where: { id, status: 'SUCCESS', invoice: await myInvoiceWhere(user.id) } });
  if (!p) throw notFound('Payment');
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="receipt-${id.slice(-8)}.pdf"`);
  res.send(await receiptPdf(id));
});
