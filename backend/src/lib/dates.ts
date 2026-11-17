/**
 * Calendar-date helpers. Business dates (join date, due date, periods) are calendar
 * dates in India time and are stored as Postgres DATE, which Prisma returns as a
 * JS Date at 00:00 UTC. We represent them as "date-only" Date objects at UTC midnight.
 */

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Today's calendar date in India (as a UTC-midnight Date). */
export function todayIST(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/** Hour of day (0-23) in India time. */
export function hourIST(now: Date = new Date()): number {
  return new Date(now.getTime() + IST_OFFSET_MS).getUTCHours();
}

/** Reminders must not go out between 9 pm and 8 am India time. */
export function isQuietHoursIST(now: Date = new Date()): boolean {
  const h = hourIST(now);
  return h >= 21 || h < 8;
}

export function dateOnly(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d));
}

/** Parse "YYYY-MM-DD" into a UTC-midnight Date. */
export function parseDateOnly(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid date: ${s}`);
  const d = dateOnly(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getUTCMonth() !== Number(m[2]) - 1) throw new Error(`Invalid date: ${s}`);
  return d;
}

export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export function startOfMonth(d: Date): Date {
  return dateOnly(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

export function endOfMonth(d: Date): Date {
  return dateOnly(d.getUTCFullYear(), d.getUTCMonth(), daysInMonth(d.getUTCFullYear(), d.getUTCMonth()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

export function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const target = dateOnly(y, m, 1);
  const dim = daysInMonth(target.getUTCFullYear(), target.getUTCMonth());
  return dateOnly(target.getUTCFullYear(), target.getUTCMonth(), Math.min(d.getUTCDate(), dim));
}

/** Inclusive day count between two date-only values. */
export function daysInclusive(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
}

export function diffDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
