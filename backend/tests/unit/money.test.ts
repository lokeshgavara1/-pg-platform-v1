import { describe, expect, it } from 'vitest';
import { divRoundHalfUp, formatINR, prorate, rupeesToPaise, sumPaise } from '../../src/lib/money.js';

describe('money (integer paise only)', () => {
  it('divRoundHalfUp rounds half up with integers only', () => {
    expect(divRoundHalfUp(10, 4)).toBe(3); // 2.5 -> 3
    expect(divRoundHalfUp(9, 4)).toBe(2); // 2.25 -> 2
    expect(divRoundHalfUp(11, 4)).toBe(3); // 2.75 -> 3
    expect(divRoundHalfUp(0, 7)).toBe(0);
    expect(() => divRoundHalfUp(1, 0)).toThrow();
    expect(() => divRoundHalfUp(1.5, 2)).toThrow();
  });

  it('prorate gives the full amount for a full month and rounds partial months to the paisa', () => {
    expect(prorate(850000, 30, 30)).toBe(850000);
    expect(prorate(850000, 15, 30)).toBe(425000);
    // 10000 * 1 / 3 = 3333.33 -> 3333
    expect(prorate(10000, 1, 3)).toBe(3333);
    // 10000 * 2 / 3 = 6666.67 -> 6667
    expect(prorate(10000, 2, 3)).toBe(6667);
    // ₹8,500 for 17 of 31 days = 466129.03 paise -> 466129
    expect(prorate(850000, 17, 31)).toBe(466129);
    expect(prorate(850000, 0, 31)).toBe(0);
    expect(() => prorate(850000, 32, 31)).toThrow();
    expect(() => prorate(8500.5, 1, 31)).toThrow();
  });

  it('prorated pieces never exceed the monthly amount', () => {
    for (let dim = 28; dim <= 31; dim++) {
      for (let d = 1; d < dim; d++) {
        const a = prorate(999999, d, dim);
        const b = prorate(999999, dim - d, dim);
        expect(Math.abs(a + b - 999999)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('parses rupee strings without floats', () => {
    expect(rupeesToPaise('8500')).toBe(850000);
    expect(rupeesToPaise('8500.5')).toBe(850050);
    expect(rupeesToPaise('0.07')).toBe(7);
    expect(rupeesToPaise('0.30')).toBe(30);
    expect(() => rupeesToPaise('1.234')).toThrow();
    expect(() => rupeesToPaise('-5')).toThrow();
  });

  it('formats Indian grouping', () => {
    expect(formatINR(850000)).toBe('₹8,500');
    expect(formatINR(12345678900)).toBe('₹12,34,56,789');
    expect(formatINR(1050)).toBe('₹10.50');
    expect(formatINR(-500)).toBe('-₹5');
  });

  it('sumPaise rejects non-integers', () => {
    expect(sumPaise([100, 200])).toBe(300);
    expect(() => sumPaise([100, 0.5])).toThrow();
  });
});
