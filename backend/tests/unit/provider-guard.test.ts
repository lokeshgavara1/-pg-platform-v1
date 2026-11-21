import { describe, expect, it } from 'vitest';
import { features, providerProblems, shouldExposeDevOtp } from '../../src/config/providerGuard.js';

describe('showing the OTP on screen', () => {
  it('only in local development with the console SMS provider', () => {
    expect(shouldExposeDevOtp({ NODE_ENV: 'development', SMS_PROVIDER: 'console' })).toBe(true);
  });
  it('never in production', () => {
    expect(shouldExposeDevOtp({ NODE_ENV: 'production', SMS_PROVIDER: 'console' })).toBe(false);
  });
  it('never in tests or without the console provider', () => {
    expect(shouldExposeDevOtp({ NODE_ENV: 'test', SMS_PROVIDER: 'console' })).toBe(false);
    expect(shouldExposeDevOtp({ NODE_ENV: 'development', SMS_PROVIDER: 'none' })).toBe(false);
  });
});

const PROD_OK = { NODE_ENV: 'production', SMS_PROVIDER: 'none', PAYMENT_PROVIDER: 'none', ESIGN_PROVIDER: 'none', FIREBASE_PROJECT_ID: 'pg-platform-e8a57' };

describe('production safety', () => {
  it('accepts the production setup: Google sign-in, direct UPI, paper signing', () => {
    expect(providerProblems(PROD_OK)).toEqual([]);
  });

  it('refuses every development-only provider in production, with no override', () => {
    expect(providerProblems({ ...PROD_OK, SMS_PROVIDER: 'console' })[0]).toMatch(/SMS_PROVIDER=console/);
    expect(providerProblems({ ...PROD_OK, PAYMENT_PROVIDER: 'fake' })[0]).toMatch(/PAYMENT_PROVIDER=fake/);
    expect(providerProblems({ ...PROD_OK, ESIGN_PROVIDER: 'dev' })[0]).toMatch(/ESIGN_PROVIDER=dev/);
    // Leaving ESIGN_PROVIDER out means the dev default, which is refused too.
    const { ESIGN_PROVIDER: _drop, ...noEsign } = PROD_OK;
    expect(providerProblems(noEsign)[0]).toMatch(/ESIGN_PROVIDER=dev/);
    // The old staging escape hatch is gone: an extra flag changes nothing.
    expect(providerProblems({ ...PROD_OK, SMS_PROVIDER: 'console', ALLOW_DEV_PROVIDERS: true } as typeof PROD_OK)).toHaveLength(1);
  });

  it('refuses a server where nobody could log in', () => {
    expect(providerProblems({ ...PROD_OK, FIREBASE_PROJECT_ID: '' })[0]).toMatch(/No way to log in/);
  });

  it('allows the dev providers for local development', () => {
    expect(providerProblems({ NODE_ENV: 'development', SMS_PROVIDER: 'console', PAYMENT_PROVIDER: 'fake', ESIGN_PROVIDER: 'dev' })).toEqual([]);
  });

  it('requires all Razorpay keys whenever Razorpay is selected', () => {
    const r = { ...PROD_OK, PAYMENT_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'rzp_test_x', RAZORPAY_KEY_SECRET: '' };
    expect(providerProblems(r)[0]).toMatch(/RAZORPAY_WEBHOOK_SECRET/);
    expect(providerProblems({ ...r, RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' })).toEqual([]);
  });
});

describe('features offered to the apps', () => {
  it('production: Google only, no online gateway, paper signing', () => {
    expect(features(PROD_OK)).toEqual({ otpLogin: false, googleLogin: true, esign: false, onlineGateway: false });
  });
  it('local development: everything on', () => {
    expect(features({ NODE_ENV: 'development', SMS_PROVIDER: 'console', PAYMENT_PROVIDER: 'fake', FIREBASE_PROJECT_ID: 'p' })).toEqual({ otpLogin: true, googleLogin: true, esign: true, onlineGateway: true });
  });
});
