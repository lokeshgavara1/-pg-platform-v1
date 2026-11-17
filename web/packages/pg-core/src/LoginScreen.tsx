import { useState, type FormEvent } from 'react';
import { ApiError } from './api';
import { useAuth } from './auth';
import { errorMessage } from './hooks';
import { Alert, Button, Field, Input } from './ui';

/**
 * Phone → OTP → (name, for first-time sign-up) login used by every app.
 * The app passed to AuthProvider decides which account types are accepted.
 */
export function LoginScreen({ title, tagline, allowSignup = true, devHint = true }: { title: string; tagline: string; allowSignup?: boolean; devHint?: boolean }) {
  const { client, login } = useAuth();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanPhone = phone.replace(/\D/g, '').slice(-10);

  async function sendOtp(e?: FormEvent) {
    e?.preventDefault();
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) return setError('Enter a valid 10-digit mobile number');
    setBusy(true);
    setError(null);
    try {
      await client.requestOtp(cleanPhone);
      setStep('otp');
      setCode('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) return setError('Enter the 6-digit OTP');
    if (needsName && name.trim().length < 2) return setError('Enter your full name');
    setBusy(true);
    setError(null);
    try {
      await login(cleanPhone, code, needsName ? name.trim() : undefined);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NAME_REQUIRED') {
        if (!allowSignup) setError('No account found for this number.');
        else {
          // The OTP is still valid; just ask for the name and submit again.
          setNeedsName(true);
          setError(null);
        }
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-card reveal">
        <div className="login-hero">
          <div className="brand"><span className="brand-mark">P</span> PG Platform</div>
          <h1>{title}</h1>
          <p className="tag">{tagline}</p>
        </div>
        <div className="card ledger">
          {step === 'phone' ? (
            <form className="stack" onSubmit={sendOtp}>
              <Field label="Mobile number" hint="We’ll send a 6-digit OTP by SMS">
                <div className="prefix">
                  <span className="sym">+91</span>
                  <Input style={{ paddingLeft: 48 }} inputMode="numeric" autoComplete="tel-national" maxLength={14} placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus aria-label="Mobile number" />
                </div>
              </Field>
              <Alert>{error}</Alert>
              <Button type="submit" block busy={busy}>Send OTP</Button>
            </form>
          ) : (
            <form className="stack" onSubmit={verify}>
              <p className="muted" style={{ margin: 0 }}>
                OTP sent to <b className="mono">+91 {cleanPhone}</b>{' '}
                <button type="button" className="btn ghost small" onClick={() => { setStep('phone'); setNeedsName(false); setError(null); }}>Change</button>
              </p>
              {needsName && (
                <>
                  <Alert tone="info">New here? Tell us your name to create your account.</Alert>
                  <Field label="Full name">
                    <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus aria-label="Full name" />
                  </Field>
                </>
              )}
              <Field label="OTP">
                <Input className="input otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus={!needsName} aria-label="OTP" />
              </Field>
              <Alert>{error}</Alert>
              <Button type="submit" block busy={busy}>{needsName ? 'Create account' : 'Verify & continue'}</Button>
              <Button type="button" variant="ghost" onClick={() => sendOtp()} disabled={busy}>Resend OTP</Button>
              {devHint && import.meta.env?.DEV && <p className="faint" style={{ margin: 0 }}>Development: the OTP is printed in the backend console.</p>}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
