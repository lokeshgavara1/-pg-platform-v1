import { randomInt } from 'node:crypto';
import { sms } from './sms.js';
import { env } from '../config/env.js';

/**
 * E-sign provider interface. A real provider (Aadhaar e-sign via a licensed ASP,
 * Leegality, Digio, ...) returns a legally valid signature.
 */
export interface EsignProvider {
  readonly name: string;
  /** True when signatures from this provider are NOT legally valid. */
  readonly devOnly: boolean;
  startSigning(input: { agreementId: string; signerPhone: string }): Promise<{ otp: string }>;
}

/**
 * ⚠️ DEVELOPMENT / TESTING ONLY — NOT A LEGALLY VALID SIGNATURE.
 * The tenant confirms with an OTP sent through the SMS provider. The signed PDF is
 * stamped "TEST SIGNATURE — NOT LEGALLY VALID". Replace before real use.
 */
export class DevOtpEsignProvider implements EsignProvider {
  readonly name = 'dev-otp';
  readonly devOnly = true;
  async startSigning(input: { agreementId: string; signerPhone: string }) {
    const otp = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await sms().sendOtp(input.signerPhone, otp);
    return { otp };
  }
}

/**
 * ESIGN_PROVIDER=none (production): no electronic signature. The tenant reads the agreement PDF,
 * signs a printed copy, and the owner records it with "Mark as signed (paper)".
 */
export class PaperSigningProvider implements EsignProvider {
  readonly name = 'paper';
  readonly devOnly = false;
  async startSigning(): Promise<{ otp: string }> {
    throw new Error('Electronic signing is switched off; sign the printed agreement instead');
  }
}

let override: EsignProvider | null = null;
export const esign = (): EsignProvider => override ?? (env.ESIGN_PROVIDER === 'none' ? new PaperSigningProvider() : new DevOtpEsignProvider());
export function setEsignProvider(p: EsignProvider | null) {
  override = p;
}
