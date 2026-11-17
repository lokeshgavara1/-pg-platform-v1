/**
 * The ONLY code path that moves an invoice towards PAID. Called from
 * (a) verified gateway webhooks and (b) an owner marking cash/UPI received.
 */
import { Prisma } from '@prisma/client';
import type { Tx } from '../../lib/prisma.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { invoiceStatus } from '../invoices/calc.js';

export async function lockInvoice(tx: Tx, invoiceId: string) {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`);
  return tx.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { booking: true } });
}

/**
 * Apply `amountPaise` to the invoice. Returns the amount actually applied
 * (capped at the outstanding balance).
 */
export async function applyPaymentToInvoice(
  tx: Tx,
  invoiceId: string,
  amountPaise: number,
  ctx: { actorId: string | null; strict: boolean },
): Promise<{ applied: number; invoiceStatus: string }> {
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0) throw badRequest('Amount must be a positive number of paise');
  const inv = await lockInvoice(tx, invoiceId);
  if (inv.status === 'VOID') {
    if (ctx.strict) throw conflict('This invoice is void');
    return { applied: 0, invoiceStatus: 'VOID' };
  }
  const outstanding = inv.totalPaise - inv.paidPaise;
  if (outstanding <= 0) {
    if (ctx.strict) throw conflict('This invoice is already paid');
    return { applied: 0, invoiceStatus: inv.status };
  }
  if (ctx.strict && amountPaise > outstanding) throw badRequest(`Amount is more than the outstanding ${outstanding} paise`);
  const applied = Math.min(amountPaise, outstanding);
  const paid = inv.paidPaise + applied;
  const status = invoiceStatus(inv.totalPaise, paid);
  await tx.invoice.update({ where: { id: inv.id }, data: { paidPaise: paid, status } });

  // Side effects by invoice kind.
  if (inv.kind === 'TOKEN' && status === 'PAID' && inv.booking && inv.booking.status === 'RESERVED') {
    await tx.booking.update({ where: { id: inv.booking.id }, data: { status: 'PAID' } });
  }
  if (inv.kind === 'DEPOSIT' && inv.tenancyId) {
    await tx.depositLedger.create({
      data: {
        tenancyId: inv.tenancyId,
        type: 'COLLECTED',
        amountPaise: applied,
        reason: `Deposit payment on invoice ${inv.number}`,
        createdById: ctx.actorId ?? 'system',
      },
    });
  }
  return { applied, invoiceStatus: status };
}
