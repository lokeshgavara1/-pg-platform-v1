import type { Tx } from '../../lib/prisma.js';
import { audit } from '../../lib/audit.js';
import { addDays, startOfMonth, todayIST, maxDate } from '../../lib/dates.js';
import { assertBedFree, lockBed } from '../beds/status.js';
import { ensureTenantProfile } from '../access.js';
import { createSimpleInvoice } from '../invoices/engine.js';
import { conflict } from '../../lib/errors.js';

/**
 * Create a tenancy on a bed. Locks the bed row so concurrent requests cannot
 * double-book it; the partial unique index is a second line of defence.
 */
export async function createTenancy(
  tx: Tx,
  input: {
    actorId: string;
    propertyId: string;
    bedId: string;
    tenantUserId: string;
    startDate: Date;
    rentPaise: number;
    depositPaise: number;
    /** Deposit already received outside the app (cash/UPI) — written to the ledger now. */
    depositCollectedPaise: number;
    cityCode: string;
    ignoreBookingId?: string;
    charges?: { name: string; amountPaise: number }[];
  },
) {
  await lockBed(tx, input.bedId);
  await assertBedFree(tx, input.bedId, { ignoreBookingId: input.ignoreBookingId });

  const profile = await ensureTenantProfile(input.tenantUserId, tx);
  const live = await tx.tenancy.findFirst({ where: { tenantProfileId: profile.id, status: { in: ['ACTIVE', 'NOTICE'] } } });
  if (live) throw conflict('This tenant already has an active stay');

  // Existing tenants entered after the fact are billed from the current month, not years back.
  const billingFrom = maxDate(input.startDate, startOfMonth(todayIST()));

  const tenancy = await tx.tenancy.create({
    data: {
      propertyId: input.propertyId,
      bedId: input.bedId,
      tenantProfileId: profile.id,
      startDate: input.startDate,
      billingFrom,
      rentPaise: input.rentPaise,
      depositPaise: input.depositPaise,
      charges: input.charges?.length ? { create: input.charges } : undefined,
    },
  });
  await audit(tx, {
    actorId: input.actorId,
    action: 'TENANCY_CREATED',
    entityType: 'Tenancy',
    entityId: tenancy.id,
    after: { rentPaise: input.rentPaise, depositPaise: input.depositPaise, bedId: input.bedId, startDate: input.startDate.toISOString().slice(0, 10) },
  });

  if (input.depositCollectedPaise > 0) {
    const entry = await tx.depositLedger.create({
      data: { tenancyId: tenancy.id, type: 'COLLECTED', amountPaise: input.depositCollectedPaise, reason: 'Deposit received at move-in', createdById: input.actorId },
    });
    await audit(tx, { actorId: input.actorId, action: 'DEPOSIT_LEDGER_ADDED', entityType: 'DepositLedger', entityId: entry.id, after: { type: 'COLLECTED', amountPaise: entry.amountPaise, tenancyId: tenancy.id } });
  }
  const remaining = input.depositPaise - input.depositCollectedPaise;
  if (remaining > 0) {
    await createSimpleInvoice(tx, {
      propertyId: input.propertyId,
      kind: 'DEPOSIT',
      tenancyId: tenancy.id,
      dueDate: maxDate(input.startDate, todayIST()),
      lines: [{ kind: 'DEPOSIT', description: 'Security deposit', amountPaise: remaining }],
    });
  }
  await tx.verificationRecord.create({ data: { tenancyId: tenancy.id, cityCode: input.cityCode } });
  return tenancy;
}

/** Sum of the deposit ledger: collected − deductions − refunds. */
export async function depositHeld(tx: Tx, tenancyId: string) {
  const rows = await tx.depositLedger.groupBy({ by: ['type'], where: { tenancyId }, _sum: { amountPaise: true } });
  const sum = (t: string) => rows.find((r) => r.type === t)?._sum.amountPaise ?? 0;
  return sum('COLLECTED') - sum('DEDUCTION') - sum('REFUND');
}

export const defaultMoveOutDate = (minNoticeDays: number) => addDays(todayIST(), minNoticeDays);
