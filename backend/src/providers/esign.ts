import { randomInt } from 'node:crypto';
import { sms } from './sms.js';

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

let provider: EsignProvider = new DevOtpEsignProvider();
export const esign = () => provider;
export function setEsignProvider(p: EsignProvider) {
  provider = p;
}
