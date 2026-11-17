/**
 * Invoice engine (DB side). Generation is idempotent: the unique key
 * (tenancyId, kind, periodStart) means re-running never creates duplicates.
 */
import { randomBytes } from 'node:crypto';
import type { InvoiceKind, Prisma } from '@prisma/client';
import { prisma, isUniqueViolation, type Db, type Tx } from '../../lib/prisma.js';
import { todayIST } from '../../lib/dates.js';
import { audit } from '../../lib/audit.js';
import { logger } from '../../lib/logger.js';
import { billableMonths, computeMonthlyInvoice } from './calc.js';

export function invoiceNumber(d: Date = new Date()) {
  const ym = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return `INV-${ym}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

export async function generateInvoicesForTenancy(db: Db, tenancyId: string, today = todayIST()) {
  const t = await db.tenancy.findUnique({
    where: { id: tenancyId },
    include: { property: true, charges: { where: { status: 'ACTIVE' } } },
  });
  if (!t || t.status === 'ENDED' || t.property.status !== 'ACTIVE') return 0;
  let created = 0;
  for (const month of billableMonths(t.billingFrom, today, t.endDate)) {
    const c = computeMonthlyInvoice(t, month, t.property.rentDueDay, t.charges);
    if (!c) continue;
    const exists = await db.invoice.findUnique({
      where: { tenancyId_kind_periodStart: { tenancyId: t.id, kind: 'RENT', periodStart: c.periodStart } },
      select: { id: true },
    });
    if (exists) continue;
    try {
      await db.invoice.create({
        data: {
          number: invoiceNumber(c.periodStart),
          propertyId: t.propertyId,
          tenancyId: t.id,
          kind: 'RENT',
          periodStart: c.periodStart,
          periodEnd: c.periodEnd,
          dueDate: c.dueDate,
          totalPaise: c.totalPaise,
          status: c.totalPaise === 0 ? 'PAID' : 'DUE',
          lines: { create: c.lines },
        },
      });
      created++;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err; // a concurrent run created it — fine
    }
  }
  return created;
}

/** Daily job: create invoices for every live tenancy in active properties. */
export async function runInvoiceGeneration(today = todayIST(), propertyIds?: string[]) {
  const tenancies = await prisma.tenancy.findMany({
    where: {
      status: { in: ['ACTIVE', 'NOTICE'] },
      property: { status: 'ACTIVE' },
      ...(propertyIds ? { propertyId: { in: propertyIds } } : {}),
    },
    select: { id: true },
  });
  let created = 0;
  for (const t of tenancies) {
    try {
      created += await generateInvoicesForTenancy(prisma, t.id, today);
    } catch (err) {
      logger.error('invoice_generation_failed', { tenancyId: t.id, error: String(err) });
    }
  }
  return { tenancies: tenancies.length, created };
}

/** One-off invoice (deposit, token, other). */
export async function createSimpleInvoice(
  db: Db,
  input: {
    propertyId: string;
    kind: InvoiceKind;
    tenancyId?: string;
    bookingId?: string;
    dueDate: Date;
    lines: { kind: Prisma.InvoiceLineCreateWithoutInvoiceInput['kind']; description: string; amountPaise: number }[];
  },
) {
  const total = input.lines.reduce((a, l) => a + l.amountPaise, 0);
  return db.invoice.create({
    data: {
      number: invoiceNumber(input.dueDate),
      propertyId: input.propertyId,
      tenancyId: input.tenancyId,
      bookingId: input.bookingId,
      kind: input.kind,
      dueDate: input.dueDate,
      totalPaise: total,
      lines: { create: input.lines },
    },
  });
}

/**
 * When a tenancy gets an end date: void unpaid rent invoices that start after it, and
 * prorate the invoice for the final month down (via an ADJUSTMENT line) if it was billed in full.
 */
export async function adjustInvoicesForEnd(tx: Tx, tenancyId: string, endDate: Date, actorId: string) {
  const t = await tx.tenancy.findUniqueOrThrow({
    where: { id: tenancyId },
    include: { property: true, charges: { where: { status: 'ACTIVE' } } },
  });
  const invoices = await tx.invoice.findMany({ where: { tenancyId, kind: 'RENT', status: { not: 'VOID' } } });
  for (const inv of invoices) {
    if (!inv.periodStart || !inv.periodEnd) continue;
    if (inv.periodStart.getTime() > endDate.getTime()) {
      if (inv.paidPaise === 0) {
        await tx.invoice.update({ where: { id: inv.id }, data: { status: 'VOID' } });
        await audit(tx, { actorId, action: 'INVOICE_VOIDED', entityType: 'Invoice', entityId: inv.id, before: { status: inv.status }, after: { status: 'VOID', reason: 'tenancy ended before period' } });
      }
      continue;
    }
    if (inv.periodEnd.getTime() > endDate.getTime()) {
      const c = computeMonthlyInvoice({ ...t, endDate }, inv.periodStart, t.property.rentDueDay, t.charges);
      if (!c) continue;
      const newTotal = Math.max(c.totalPaise, inv.paidPaise);
      const delta = newTotal - inv.totalPaise;
      if (delta === 0) continue;
      await tx.invoiceLine.create({
        data: { invoiceId: inv.id, kind: 'ADJUSTMENT', description: `Prorated for move-out on ${endDate.toISOString().slice(0, 10)}`, amountPaise: delta },
      });
      const status = newTotal <= inv.paidPaise ? 'PAID' : inv.paidPaise > 0 ? 'PARTIAL' : 'DUE';
      await tx.invoice.update({ where: { id: inv.id }, data: { totalPaise: newTotal, periodEnd: c.periodEnd, status } });
      await audit(tx, { actorId, action: 'INVOICE_PRORATED_FOR_END', entityType: 'Invoice', entityId: inv.id, before: { totalPaise: inv.totalPaise }, after: { totalPaise: newTotal } });
    }
  }
}
