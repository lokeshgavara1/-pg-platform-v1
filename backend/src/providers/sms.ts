import { env, isTest } from '../config/env.js';

/** SMS provider interface. Plug a real provider (MSG91, Twilio, ...) in later. */
export interface SmsProvider {
  sendOtp(phone: string, code: string): Promise<void>;
  send(phone: string, text: string): Promise<void>;
}

/**
 * DEV ONLY: prints the OTP to the server console so you can log in locally.
 * This is the one place an OTP is ever written out, and only in development.
 */
export class ConsoleSmsProvider implements SmsProvider {
  /** Tests read the last code from here instead of the console. */
  static lastCodes = new Map<string, string>();

  async sendOtp(phone: string, code: string) {
    ConsoleSmsProvider.lastCodes.set(phone, code);
    if (!isTest) console.log(`\n[DEV SMS] OTP for ${phone}: ${code}  (valid 5 minutes)\n`);
  }

  async send(phone: string, text: string) {
    if (!isTest) console.log(`[DEV SMS] to ${phone.slice(0, 3)}******${phone.slice(-2)}: ${text}`);
  }
}

let provider: SmsProvider | null = null;
export function sms(): SmsProvider {
  if (!provider) {
    switch (env.SMS_PROVIDER) {
      case 'console':
      default:
        provider = new ConsoleSmsProvider();
    }
  }
  return provider;
}
export function setSmsProvider(p: SmsProvider) {
  provider = p;
}
