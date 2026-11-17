/**
 * Money helpers. All money is integer paise (1 rupee = 100 paise). No floats.
 */

export function assertPaise(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer number of paise`);
  return value;
}

/**
 * Round-half-up integer division for non-negative integers: round(numerator / denominator).
 * Uses only integer arithmetic so there is no floating-point error.
 */
export function divRoundHalfUp(numerator: number, denominator: number): number {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new Error('divRoundHalfUp needs integers');
  }
  if (denominator <= 0) throw new Error('denominator must be positive');
  if (numerator < 0) throw new Error('numerator must be non-negative');
  const q = Math.floor(numerator / denominator);
  const r = numerator - q * denominator;
  return r * 2 >= denominator ? q + 1 : q;
}

/** Prorate a monthly amount for `days` out of `daysInMonth`, rounded half-up to the paisa. */
export function prorate(monthlyPaise: number, days: number, daysInMonth: number): number {
  assertPaise(monthlyPaise, 'monthly amount');
  if (days < 0 || days > daysInMonth) throw new Error('days out of range');
  if (days === daysInMonth) return monthlyPaise;
  return divRoundHalfUp(monthlyPaise * days, daysInMonth);
}

export function rupeesToPaise(rupees: string | number): number {
  const s = String(rupees).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error('Invalid rupee amount');
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

export function formatINR(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  // Indian digit grouping: 12,34,567
  const s = String(rupees);
  const last3 = s.slice(-3);
  const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest ? `${rest},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}${p ? '.' + String(p).padStart(2, '0') : ''}`;
}

export function sumPaise(values: number[]): number {
  return values.reduce((a, b) => assertPaise(a + b), 0);
}
