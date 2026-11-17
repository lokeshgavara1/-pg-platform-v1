import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { dateString, idParam, pageQuery, paged, paiseSchema, parse } from '../../lib/http.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { parseDateOnly, todayIST } from '../../lib/dates.js';
import { me, requireRole } from '../auth/middleware.js';
import { managedPropertyIds, ownedInvoice } from '../access.js';
import { runInvoiceGeneration } from './engine.js';
import { applyPaymentToInvoice } from '../payments/apply.js';
import { createPaymentLink, receiptPdf } from '../payments/service.js';
import { invoiceStatus } from './calc.js';

export const invoicesRouter = Router();

const listQuery = pageQuery.extend({
  propertyId: z.string().optional(),
  tenancyId: z.string().optional(),
  status: z.enum(['DUE', 'PARTIAL', 'PAID', 'VOID', 'OVERDUE', 'UNPAID']).optional(),
  kind: z.enum(['RENT', 'DEPOSIT', 'TOKEN', 'OTHER']).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

invoicesRouter.get('/invoices', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const q = parse(listQuery, req.query);
  const ids = await managedPropertyIds(user);
  const where: Prisma.InvoiceWhereInput = { propertyId: { in: q.propertyId ? ids.filter((i) => i === q.propertyId) : ids } };
  if (q.tenancyId) where.tenancyId = q.tenancyId;
  if (q.kind) where.kind = q.kind;
  if (q.status === 'OVERDUE') Object.assign(where, { status: { in: ['DUE', 'PARTIAL'] }, dueDate: { lt: todayIST() } });
  else if (q.status === 'UNPAID') where.status = { in: ['DUE', 'PARTIAL'] };
  else if (q.status) where.status = q.status;
  if (q.month) {
    const [y, m] = q.month.split('-').map(Number);
    where.dueDate = { gte: new Date(Date.UTC(y, m - 1, 1)), lt: new Date(Date.UTC(y, m, 1)) };
  }
  const [items, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ dueDate: 'desc' }, { createdAt: 'desc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: {
        property: { select: { name: true } },
        tenancy: { select: { id: true, tenantProfile: { select: { user: { select: { name: true } } } }, bed: { select: { label: true, room: { select: { name: true } } } } } },
        booking: { select: { id: true, tenantUser: { select: { name: true } } } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);
  res.json(paged(items, total, q.page, q.pageSize));
});

invoicesRouter.get('/invoices/:id', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await ownedInvoice(me(req), id);
  res.json(
    await prisma.invoice.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { createdAt: 'asc' } },
        payments: { orderBy: { createdAt: 'desc' } },
        property: { select: { name: true } },
        tenancy: { select: { id: true, tenantProfile: { select: { user: { select: { name: true, phone: true } } } }, bed: { select: { label: true, room: { select: { name: true } } } } } },
      },
    }),
  );
});

/** Owner marks money received in cash or by direct UPI. */
invoicesRouter.post('/invoices/:id/payments', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  await ownedInvoice(user, id);
  const input = parse(
    z.object({
      amountPaise: paiseSchema.refine((v) => v > 0, 'Amount must be more than zero'),
      method: z.enum(['CASH', 'UPI_DIRECT']),
      note: z.string().trim().max(300).optional(),
      receivedOn: dateString.optional(),
    }),
    req.body,
  );
  const payment = await prisma.$transaction(async (tx) => {
    const { invoiceStatus: status } = await applyPaymentToInvoice(tx, id, input.amountPaise, { actorId: user.id, strict: true });
    const p = await tx.payment.create({
      data: {
        invoiceId: id,
        amountPaise: input.amountPaise,
        method: input.method,
        status: 'SUCCESS',
        note: input.note,
        recordedById: user.id,
        receivedAt: input.receivedOn ? parseDateOnly(input.receivedOn) : new Date(),
      },
    });
    await audit(tx, { actorId: user.id, action: 'PAYMENT_RECORDED', entityType: 'Invoice', entityId: id, after: { paymentId: p.id, amountPaise: p.amountPaise, method: p.method, invoiceStatus: status } });
    return p;
  });
  res.status(201).json(payment);
});

/** Add an extra charge or a discount (negative) to an unpaid invoice. */
invoicesRouter.post('/invoices/:id/lines', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const inv = await ownedInvoice(user, id);
  if (inv.status === 'VOID' || inv.status === 'PAID') throw conflict('Only unpaid invoices can be changed');
  const input = parse(
    z.object({ description: z.string().trim().min(2).max(120), amountPaise: z.number().int().min(-10_000_000_00).max(10_000_000_00).refine((v) => v !== 0) }),
    req.body,
  );
  const newTotal = inv.totalPaise + input.amountPaise;
  if (newTotal < inv.paidPaise) throw badRequest('Discount is larger than the unpaid balance');
  const updated = await prisma.$transaction(async (tx) => {
    await tx.invoiceLine.create({ data: { invoiceId: id, kind: input.amountPaise > 0 ? 'EXTRA' : 'ADJUSTMENT', description: input.description, amountPaise: input.amountPaise } });
    const u = await tx.invoice.update({ where: { id }, data: { totalPaise: newTotal, status: invoiceStatus(newTotal, inv.paidPaise) } });
    await audit(tx, { actorId: user.id, action: 'INVOICE_ADJUSTED', entityType: 'Invoice', entityId: id, before: { totalPaise: inv.totalPaise }, after: { totalPaise: newTotal, line: input } });
    return u;
  });
  res.json(updated);
});

invoicesRouter.post('/invoices/:id/void', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const inv = await ownedInvoice(user, id);
  const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(200) }), req.body);
  if (inv.paidPaise > 0) throw conflict('Invoices with payments cannot be voided');
  if (inv.status === 'VOID') throw conflict('Already void');
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.invoice.update({ where: { id }, data: { status: 'VOID' } });
    await audit(tx, { actorId: user.id, action: 'INVOICE_VOIDED', entityType: 'Invoice', entityId: id, before: { status: inv.status }, after: { status: 'VOID', reason } });
    return u;
  });
  res.json(updated);
});

/** Payment link the owner can share on WhatsApp/SMS; works in any browser. */
invoicesRouter.post('/invoices/:id/payment-link', requireRole('OWNER'), async (req, res) => {
  const { id } = parse(idParam, req.params);
  await ownedInvoice(me(req), id);
  res.status(201).json(await createPaymentLink(id));
});

invoicesRouter.get('/payments/:id/receipt.pdf', requireRole('OWNER'), async (req, res) => {
  const user = me(req);
  const { id } = parse(idParam, req.params);
  const p = await prisma.payment.findFirst({ where: { id, status: 'SUCCESS', invoice: { property: { ownerId: user.id } } } });
  if (!p) throw notFound('Payment');
  const pdf = await receiptPdf(id);
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `inline; filename="receipt-${id.slice(-8)}.pdf"`);
  res.send(pdf);
});

/** Manually run invoice generation for the owner's properties (the daily job does this too). */
invoicesRouter.post('/invoices/generate', requireRole('OWNER'), async (req, res) => {
  const ids = await managedPropertyIds(me(req));
  res.json(await runInvoiceGeneration(todayIST(), ids));
});
