import { describe, expect, it } from 'vitest';
import { billableMonths, computeMonthlyInvoice, invoiceStatus } from '../../src/modules/invoices/calc.js';
import { parseDateOnly as d, toDateString as s } from '../../src/lib/dates.js';

const tenancy = (from: string, rent = 850000, end: string | null = null) => ({ billingFrom: d(from), endDate: end ? d(end) : null, rentPaise: rent });

describe('computeMonthlyInvoice', () => {
  it('bills a full month at the full rent with due date on the due day', () => {
    const c = computeMonthlyInvoice(tenancy('2026-01-01'), d('2026-11-01'), 5)!;
    expect(s(c.periodStart)).toBe('2026-11-01');
    expect(s(c.periodEnd)).toBe('2026-11-30');
    expect(s(c.dueDate)).toBe('2026-11-05');
    expect(c.totalPaise).toBe(850000);
    expect(c.prorated).toBe(false);
  });

  it('prorates a partial first month and moves the due date to the join date if later', () => {
    // Joins 15 Nov (30-day month): 16 days -> 850000*16/30 = 453333.33 -> 453333
    const c = computeMonthlyInvoice(tenancy('2026-11-15'), d('2026-11-01'), 5)!;
    expect(s(c.periodStart)).toBe('2026-11-15');
    expect(c.totalPaise).toBe(453333);
    expect(c.prorated).toBe(true);
    expect(s(c.dueDate)).toBe('2026-11-15');
  });

  it('keeps the due day when the join date is before it', () => {
    const c = computeMonthlyInvoice(tenancy('2026-11-02'), d('2026-11-20'), 5)!;
    expect(s(c.dueDate)).toBe('2026-11-05');
    expect(c.totalPaise).toBe(prorateCheck(850000, 29, 30));
  });

  it('prorates a partial last month', () => {
    // Leaves 10 Dec (31-day month): 10 days -> 850000*10/31 = 274193.55 -> 274194
    const c = computeMonthlyInvoice(tenancy('2026-01-01', 850000, '2026-12-10'), d('2026-12-01'), 5)!;
    expect(s(c.periodEnd)).toBe('2026-12-10');
    expect(c.totalPaise).toBe(274194);
    expect(s(c.dueDate)).toBe('2026-12-05');
  });

  it('clamps the due date to the end of a short final period', () => {
    const c = computeMonthlyInvoice(tenancy('2026-01-01', 850000, '2026-12-03'), d('2026-12-01'), 5)!;
    expect(s(c.dueDate)).toBe('2026-12-03');
  });

  it('handles start and end in the same month', () => {
    const c = computeMonthlyInvoice(tenancy('2026-11-10', 900000, '2026-11-19'), d('2026-11-01'), 5)!;
    expect(c.totalPaise).toBe(300000); // 10/30 of 9000
  });

  it('handles February in a leap year', () => {
    const c = computeMonthlyInvoice(tenancy('2028-02-15', 870000), d('2028-02-01'), 5)!;
    // 15 of 29 days: 870000*15/29 = 450000
    expect(c.totalPaise).toBe(450000);
  });

  it('prorates recurring extra charges the same way and adds them as lines', () => {
    const c = computeMonthlyInvoice(tenancy('2026-11-16', 900000), d('2026-11-01'), 5, [{ name: 'Food', amountPaise: 300000 }])!;
    expect(c.lines).toHaveLength(2);
    expect(c.lines[0].amountPaise).toBe(450000);
    expect(c.lines[1]).toMatchObject({ kind: 'EXTRA', amountPaise: 150000 });
    expect(c.totalPaise).toBe(600000);
  });

  it('returns null when the tenancy does not overlap the month', () => {
    expect(computeMonthlyInvoice(tenancy('2026-12-01'), d('2026-11-01'), 5)).toBeNull();
    expect(computeMonthlyInvoice(tenancy('2026-01-01', 1, '2026-10-31'), d('2026-11-01'), 5)).toBeNull();
  });

  it('uses only integers for every amount', () => {
    for (let day = 1; day <= 31; day++) {
      const c = computeMonthlyInvoice(tenancy(`2026-10-${String(day).padStart(2, '0')}`, 777777), d('2026-10-01'), 5, [{ name: 'x', amountPaise: 33333 }])!;
      for (const l of c.lines) expect(Number.isInteger(l.amountPaise)).toBe(true);
    }
  });
});

describe('billableMonths', () => {
  it('lists each month from billing start to today', () => {
    expect(billableMonths(d('2026-09-20'), d('2026-11-17'), null).map(s)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
  });
  it('stops at the end date', () => {
    expect(billableMonths(d('2026-09-20'), d('2026-12-17'), d('2026-10-05')).map(s)).toEqual(['2026-09-01', '2026-10-01']);
  });
  it('is empty for a future start', () => {
    expect(billableMonths(d('2026-12-01'), d('2026-11-17'), null)).toEqual([]);
  });
});

describe('invoiceStatus', () => {
  it('derives status from amounts', () => {
    expect(invoiceStatus(1000, 0)).toBe('DUE');
    expect(invoiceStatus(1000, 1)).toBe('PARTIAL');
    expect(invoiceStatus(1000, 1000)).toBe('PAID');
    expect(invoiceStatus(0, 0)).toBe('PAID');
  });
});

function prorateCheck(m: number, days: number, dim: number) {
  return Math.floor((m * days * 2 + dim) / (2 * dim));
}
