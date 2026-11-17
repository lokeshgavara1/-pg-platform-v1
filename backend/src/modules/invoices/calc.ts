/**
 * Pure invoice maths (no database). Billing periods are calendar months.
 *
 * - A tenancy is billed from `billingFrom` (its join date, or the first of the month the
 *   owner added an existing tenant) to `endDate` (inclusive) if set.
 * - Partial first and last months are prorated by day: amount × days ÷ daysInMonth,
 *   rounded half-up to the paisa. Recurring extra charges are prorated the same way.
 * - Due date = the property's rent due day in that month, but never before the period
 *   starts and never after it ends.
 */
import { prorate } from '../../lib/money.js';
import { dateOnly, daysInMonth, daysInclusive, endOfMonth, maxDate, minDate, startOfMonth } from '../../lib/dates.js';

export interface BillableTenancy {
  billingFrom: Date;
  endDate: Date | null;
  rentPaise: number;
}

export interface ChargeInput {
  name: string;
  amountPaise: number;
}

export interface ComputedLine {
  kind: 'RENT' | 'EXTRA';
  description: string;
  amountPaise: number;
}

export interface ComputedInvoice {
  periodStart: Date;
  periodEnd: Date;
  dueDate: Date;
  lines: ComputedLine[];
  totalPaise: number;
  prorated: boolean;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (d: Date) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const dd = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

export function computeMonthlyInvoice(
  tenancy: BillableTenancy,
  anyDayInMonth: Date,
  rentDueDay: number,
  charges: ChargeInput[] = [],
): ComputedInvoice | null {
  const monthStart = startOfMonth(anyDayInMonth);
  const monthEnd = endOfMonth(anyDayInMonth);
  const periodStart = maxDate(monthStart, tenancy.billingFrom);
  const periodEnd = tenancy.endDate ? minDate(monthEnd, tenancy.endDate) : monthEnd;
  if (periodStart.getTime() > periodEnd.getTime()) return null;

  const dim = daysInMonth(monthStart.getUTCFullYear(), monthStart.getUTCMonth());
  const days = daysInclusive(periodStart, periodEnd);
  const prorated = days !== dim;

  const lines: ComputedLine[] = [];
  const rent = prorate(tenancy.rentPaise, days, dim);
  lines.push({
    kind: 'RENT',
    description: prorated
      ? `Rent ${monthLabel(monthStart)} (${dd(periodStart)}–${dd(periodEnd)}, ${days}/${dim} days)`
      : `Rent ${monthLabel(monthStart)}`,
    amountPaise: rent,
  });
  for (const c of charges) {
    const amt = prorate(c.amountPaise, days, dim);
    if (amt > 0) lines.push({ kind: 'EXTRA', description: prorated ? `${c.name} (${days}/${dim} days)` : c.name, amountPaise: amt });
  }

  const nominalDue = dateOnly(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), Math.min(rentDueDay, dim));
  const dueDate = maxDate(periodStart, minDate(nominalDue, periodEnd));
  return {
    periodStart,
    periodEnd,
    dueDate,
    lines,
    totalPaise: lines.reduce((a, l) => a + l.amountPaise, 0),
    prorated,
  };
}

/** First day of every month from billingFrom's month up to and including `upTo`'s month. */
export function billableMonths(billingFrom: Date, upTo: Date, endDate: Date | null): Date[] {
  const last = startOfMonth(endDate ? minDate(upTo, endDate) : upTo);
  const out: Date[] = [];
  for (let m = startOfMonth(billingFrom); m.getTime() <= last.getTime(); m = dateOnly(m.getUTCFullYear(), m.getUTCMonth() + 1, 1)) {
    out.push(m);
  }
  return out;
}

/** Invoice status from amounts. */
export function invoiceStatus(totalPaise: number, paidPaise: number): 'DUE' | 'PARTIAL' | 'PAID' {
  if (paidPaise <= 0) return totalPaise === 0 ? 'PAID' : 'DUE';
  return paidPaise >= totalPaise ? 'PAID' : 'PARTIAL';
}
