/**
 * FREE direct UPI payments (no gateway, no fees).
 *
 *   tenant pays the owner's UPI ID in any UPI app
 *     -> tenant reports it ("I've paid", optional 12-digit UPI reference)   status REPORTED
 *     -> owner checks their bank/UPI app and confirms (or rejects)          status SUCCESS / FAILED
 *
 * A report never changes the invoice. Only the owner's confirmation applies money to it,
 * through the same applyPaymentToInvoice path as "mark cash received".
 */
import type { Property, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { formatINR } from '../../lib/money.js';
import { env } from '../../config/env.js';
import { push } from '../../providers/message.js';
import { applyPaymentToInvoice } from './apply.js';

/** name@bank style UPI ID (VPA), e.g. ramesh.kumar@okaxis or 9876543210@ybl. */
export const UPI_ID_RE = /^[a-z0-9][a-z0-9._-]{1,255}@[a-z][a-z0-9]{1,63}$/;
/** UPI transaction reference (UTR / RRN) shown in every UPI app: 12 digits. */
export const UPI_REF_RE = /^\d{12}$/;
export const MAX_OPEN_REPORTS_PER_INVOICE = 3;
/** Extra time a reservation is held while the owner checks a reported token payment. */
export const TOKEN_REPORT_HOLD_HOURS = 72;

export interface PayOptions {
  upi: { upiId: string; payeeName: string } | null;
  /** Online gateway (Razorpay, or the sandbox when the PG has no UPI ID set). */
  gateway: boolean;
}

export function payOptions(p: Pick<Property, 'upiId' | 'upiPayeeName' | 'name'>): PayOptions {
  const upi = p.upiId ? { upiId: p.upiId, payeeName: p.upiPayeeName || p.name } : null;
  // Razorpay is always offered when configured; the local sandbox only when the PG has no UPI ID; none = never.
  return { upi, gateway: env.PAYMENT_PROVIDER === 'razorpay' || (env.PAYMENT_PROVIDER === 'fake' && !upi) };
}

export async function reportUpiPayment(tenant: User, invoiceId: string, input: { amountPaise?: number; upiRef?: string }) {
  const inv = await prisma.invoice.findFirst({
    where: { id: invoiceId, OR: [{ tenancy: { tenantProfile: { userId: tenant.id } } }, { booking: { tenantUserId: tenant.id } }] },
    include: { property: true, booking: true, payments: { where: { status: 'REPORTED' } } },
  });
  if (!inv) throw notFound('Invoice');
  if (!inv.property.upiId) throw conflict('This PG does not take direct UPI payments yet. Ask your owner.');
  if (inv.status !== 'DUE' && inv.status !== 'PARTIAL') throw conflict(inv.status === 'PAID' ? 'This invoice is already paid' : 'This invoice cannot be paid');
  if (inv.payments.length >= MAX_OPEN_REPORTS_PER_INVOICE) throw conflict('You already reported payments that are waiting for the owner to confirm');

  const pending = inv.payments.reduce((a, p) => a + p.amountPaise, 0);
  const left = inv.totalPaise - inv.paidPaise - pending;
  if (left <= 0) throw conflict('Your payment for this invoice is already waiting for the owner to confirm');
  const amount = input.amountPaise ?? left;
  if (amount <= 0) throw badRequest('Amount must be more than zero');
  if (amount > left) throw badRequest(`That is more than the ${formatINR(left)} still to pay`);

  if (input.upiRef) {
    const dup = await prisma.payment.findFirst({
      where: { upiRef: input.upiRef, status: { in: ['REPORTED', 'SUCCESS'] }, invoice: { propertyId: inv.propertyId } },
    });
    if (dup) throw conflict('This UPI reference number was already used for another payment');
  }

  const payment = await prisma.$transaction(async (tx) => {
    const p = await tx.payment.create({
      data: { invoiceId: inv.id, amountPaise: amount, method: 'UPI_DIRECT', status: 'REPORTED', upiRef: input.upiRef, reportedById: tenant.id, provider: 'upi-direct' },
    });
    // Don't let a reservation lapse while the owner is checking the token payment.
    if (inv.kind === 'TOKEN' && inv.booking && inv.booking.status === 'RESERVED') {
      const until = new Date(Math.max(inv.booking.holdUntil.getTime(), Date.now() + TOKEN_REPORT_HOLD_HOURS * 3600e3));
      await tx.booking.update({ where: { id: inv.booking.id }, data: { holdUntil: until } });
    }
    await audit(tx, { actorId: tenant.id, action: 'PAYMENT_REPORTED', entityType: 'Invoice', entityId: inv.id, after: { paymentId: p.id, amountPaise: amount, upiRef: input.upiRef ?? null } });
    return p;
  });

  await push({
    userId: inv.property.ownerId,
    title: 'Payment to confirm',
    body: `${tenant.name} says they paid ${formatINR(amount)} by UPI${input.upiRef ? ` (ref ${input.upiRef})` : ''}. Check your UPI app, then confirm it in Rent → To confirm.`,
  });
  return payment;
}

async function ownedReported(owner: User, paymentId: string) {
  const p = await prisma.payment.findFirst({
    where: { id: paymentId, invoice: { property: { ownerId: owner.id } } },
    include: { invoice: { include: { booking: true, tenancy: { include: { tenantProfile: true } } } } },
  });
  if (!p) throw notFound('Payment');
  if (p.status !== 'REPORTED') throw conflict(p.status === 'SUCCESS' ? 'This payment is already confirmed' : 'This payment is no longer waiting for confirmation');
  return p;
}

const tenantOf = (p: Awaited<ReturnType<typeof ownedReported>>) => p.reportedById ?? p.invoice.tenancy?.tenantProfile.userId ?? p.invoice.booking?.tenantUserId;

export async function confirmUpiPayment(owner: User, paymentId: string, amountPaise?: number) {
  const p = await ownedReported(owner, paymentId);
  const amount = amountPaise ?? p.amountPaise;
  const result = await prisma.$transaction(async (tx) => {
    // Claim first so a double tap (or two devices) cannot apply the money twice.
    const claim = await tx.payment.updateMany({
      where: { id: p.id, status: 'REPORTED' },
      data: { status: 'SUCCESS', amountPaise: amount, recordedById: owner.id, receivedAt: new Date() },
    });
    if (claim.count !== 1) throw conflict('This payment is already confirmed');
    const { invoiceStatus } = await applyPaymentToInvoice(tx, p.invoiceId, amount, { actorId: owner.id, strict: true });
    await audit(tx, {
      actorId: owner.id,
      action: 'PAYMENT_CONFIRMED',
      entityType: 'Invoice',
      entityId: p.invoiceId,
      before: { reportedPaise: p.amountPaise },
      after: { paymentId: p.id, amountPaise: amount, method: 'UPI_DIRECT', upiRef: p.upiRef, invoiceStatus },
    });
    return { invoiceStatus };
  });
  const tenantId = tenantOf(p);
  if (tenantId) await push({ userId: tenantId, title: 'Payment confirmed', body: `Your owner confirmed ${formatINR(amount)}. The receipt is in the app.` });
  return { paymentId: p.id, amountPaise: amount, ...result };
}

export async function rejectUpiPayment(owner: User, paymentId: string, reason: string) {
  const p = await ownedReported(owner, paymentId);
  await prisma.$transaction(async (tx) => {
    const r = await tx.payment.updateMany({ where: { id: p.id, status: 'REPORTED' }, data: { status: 'FAILED', failureReason: reason, recordedById: owner.id } });
    if (r.count !== 1) throw conflict('This payment is no longer waiting for confirmation');
    // Give the tenant a little time to pay again before the reservation lapses.
    if (p.invoice.kind === 'TOKEN' && p.invoice.booking?.status === 'RESERVED') {
      const soon = new Date(Date.now() + 2 * 3600e3);
      if (p.invoice.booking.holdUntil > soon) await tx.booking.update({ where: { id: p.invoice.booking.id }, data: { holdUntil: soon } });
    }
    await audit(tx, { actorId: owner.id, action: 'PAYMENT_REPORT_REJECTED', entityType: 'Invoice', entityId: p.invoiceId, after: { paymentId: p.id, amountPaise: p.amountPaise, reason } });
  });
  const tenantId = tenantOf(p);
  if (tenantId) await push({ userId: tenantId, title: 'Payment not received', body: `Your owner could not find your UPI payment of ${formatINR(p.amountPaise)}: ${reason}` });
  return { paymentId: p.id, status: 'FAILED' };
}

/** Tenant withdraws a report made by mistake. */
export async function withdrawUpiReport(tenant: User, paymentId: string) {
  const r = await prisma.payment.updateMany({
    where: { id: paymentId, reportedById: tenant.id, status: 'REPORTED' },
    data: { status: 'FAILED', failureReason: 'Withdrawn by tenant' },
  });
  if (r.count !== 1) throw notFound('Pending payment');
  return { ok: true };
}
