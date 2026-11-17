/**
 * Deposit settlement maths (pure).
 *   refund      = max(0, depositHeld − totalDeductions)
 *   balanceDue  = max(0, totalDeductions − depositHeld)   (tenant owes the owner)
 */
export interface Deduction {
  reason: string;
  amountPaise: number;
}

export function computeSettlement(depositHeldPaise: number, deductions: Deduction[]) {
  if (!Number.isSafeInteger(depositHeldPaise) || depositHeldPaise < 0) throw new Error('Deposit held must be a non-negative integer');
  let total = 0;
  for (const d of deductions) {
    if (!Number.isSafeInteger(d.amountPaise) || d.amountPaise <= 0) throw new Error('Each deduction must be a positive integer number of paise');
    if (!d.reason.trim()) throw new Error('Each deduction needs a reason');
    total += d.amountPaise;
  }
  return {
    depositHeldPaise,
    deductionsPaise: total,
    refundPaise: Math.max(0, depositHeldPaise - total),
    balanceDuePaise: Math.max(0, total - depositHeldPaise),
  };
}
