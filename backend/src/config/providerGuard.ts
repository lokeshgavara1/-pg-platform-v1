/**
 * Production safety: development-only providers can never run with NODE_ENV=production.
 *   SMS_PROVIDER=console   prints OTPs to the server log instead of sending an SMS
 *   PAYMENT_PROVIDER=fake  sandbox checkout page that lets anyone "pay" an invoice
 *   ESIGN_PROVIDER=dev     OTP "signature" that is not legally valid
 * Production uses: Google sign-in (free) with SMS_PROVIDER=none, direct UPI + cash with
 * PAYMENT_PROVIDER=none (or razorpay with keys), and paper signing with ESIGN_PROVIDER=none.
 */
export interface ProviderSettings {
  NODE_ENV: string;
  SMS_PROVIDER: string;
  PAYMENT_PROVIDER: string;
  ESIGN_PROVIDER?: string;
  FIREBASE_PROJECT_ID?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
}

/**
 * LOCAL DEVELOPMENT ONLY: return the OTP in the API response so the login screen can show it
 * (no real SMS is sent locally). Never in production or tests, and never with a real SMS provider.
 */
export function shouldExposeDevOtp(s: Pick<ProviderSettings, 'NODE_ENV' | 'SMS_PROVIDER'>): boolean {
  return s.NODE_ENV === 'development' && s.SMS_PROVIDER === 'console';
}

/** What the apps should offer, derived from the server configuration (served at GET /api/auth/config). */
export function features(s: ProviderSettings) {
  return {
    otpLogin: s.SMS_PROVIDER !== 'none',
    googleLogin: Boolean(s.FIREBASE_PROJECT_ID),
    esign: (s.ESIGN_PROVIDER ?? 'dev') !== 'none',
    onlineGateway: s.PAYMENT_PROVIDER !== 'none',
  };
}

export function providerProblems(s: ProviderSettings): string[] {
  const problems: string[] = [];
  if (s.PAYMENT_PROVIDER === 'razorpay' && (!s.RAZORPAY_KEY_ID || !s.RAZORPAY_KEY_SECRET || !s.RAZORPAY_WEBHOOK_SECRET)) {
    problems.push('PAYMENT_PROVIDER=razorpay needs RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET');
  }
  const f = features(s);
  if (!f.otpLogin && !f.googleLogin) problems.push('No way to log in: set FIREBASE_PROJECT_ID (Google sign-in) or an SMS provider');
  if (s.NODE_ENV !== 'production') return problems;
  if (s.SMS_PROVIDER === 'console') problems.push('SMS_PROVIDER=console prints OTPs to the log; use SMS_PROVIDER=none (Google sign-in) or a real SMS provider');
  if (s.PAYMENT_PROVIDER === 'fake') problems.push('PAYMENT_PROVIDER=fake lets anyone mark invoices paid; use PAYMENT_PROVIDER=none (direct UPI) or razorpay');
  if ((s.ESIGN_PROVIDER ?? 'dev') === 'dev') problems.push('ESIGN_PROVIDER=dev is not a legally valid signature; use ESIGN_PROVIDER=none (paper signing)');
  return problems;
}
