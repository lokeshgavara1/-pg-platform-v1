import { useState, type FormEvent, type ReactNode } from 'react';
import { ApiError } from './api';
import { useAuth } from './auth';
import { errorMessage } from './hooks';
import { googleIdToken, googleSignInAvailable } from './google';
import { Alert, Button, Field, Input, Spinner } from './ui';
import { useServerConfig } from './serverConfig';
import { BRAND_NAME, BRAND_TAGLINE, BrandLockup, LogoMark } from './brand';

/**
 * Shown only when the backend runs in local development mode, where no real SMS is sent.
 * The backend never includes the code on staging or production.
 */
export function DevOtpBox({ code, onUse }: { code: string; onUse: () => void }) {
  return (
    <div className="alert warn" role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <span>
        <b>Development mode</b> — no SMS is sent. Your code is{' '}
        <b className="mono" style={{ fontSize: 18, letterSpacing: '.15em' }} data-testid="dev-otp">{code}</b>
      </span>
      <button type="button" className="btn small secondary" onClick={onUse}>Use code</button>
    </div>
  );
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function GoogleButton({ onClick, busy, children = 'Continue with Google' }: { onClick: () => void; busy?: boolean; children?: ReactNode }) {
  return (
    <Button type="button" variant="secondary" block busy={busy} onClick={onClick} style={{ background: '#fff', color: '#1f1f1f', borderColor: '#dadce0' }}>
      {!busy && <GoogleLogo />} {children}
    </Button>
  );
}

const APP_CHIP = { owner: 'Owner', tenant: undefined, admin: 'Admin' } as const;

/** Login layout: green brand panel (logo, promise, tagline) beside — or above, on phones — the sign-in card. */
function LoginFrame({ title, tagline, children }: { title: string; tagline: string; children: ReactNode }) {
  const { app } = useAuth();
  return (
    <div className="login-wrap">
      <section className="login-brand" aria-label={BRAND_NAME}>
        <BrandLockup app={APP_CHIP[app]} size={36} />
        <div className="reveal" style={{ position: 'relative' }}>
          <h1>{title}</h1>
          <p className="tag">{tagline}</p>
        </div>
        <span className="tagline-foot">{BRAND_TAGLINE}</span>
        <LogoMark size={420} className="watermark" title="" />
      </section>
      <main className="login-pane">
        <div className="login-card reveal">
          <div className="card">{children}</div>
        </div>
      </main>
    </div>
  );
}

/** One-time step after a first Google sign-in: we need a name and a mobile number. */
function ProfileStep({ idToken, suggestedName, email, linkToken, onCancel }: { idToken: string; suggestedName: string; email: string | null; linkToken?: string; onCancel: () => void }) {
  const { loginWithGoogle } = useAuth();
  const [name, setName] = useState(suggestedName);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cleanPhone = phone.replace(/\D/g, '').slice(-10);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim().length < 2) return setError('Enter your full name');
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) return setError('Enter a valid 10-digit mobile number');
    setBusy(true);
    setError(null);
    try {
      await loginWithGoogle(idToken, { name: name.trim(), phone: cleanPhone, linkToken });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="stack" onSubmit={submit}>
      <Alert tone="info">Almost done{email ? <> — signed in as <b>{email}</b></> : null}. Tell us your name and mobile number to create your account.</Alert>
      <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" aria-label="Full name" /></Field>
      <Field label="Mobile number" hint="Your PG owner uses this to contact you.">
        <div className="prefix">
          <span className="sym">+91</span>
          <Input style={{ paddingLeft: 48 }} inputMode="numeric" autoComplete="tel-national" maxLength={14} placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} autoFocus aria-label="Mobile number" />
        </div>
      </Field>
      <Alert>{error}</Alert>
      <Button type="submit" block busy={busy}>Create account</Button>
      <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

/** Google sign-in with the one-time profile step for new accounts. */
function useGoogleLogin(allowSignup: boolean, linkToken?: string) {
  const { loginWithGoogle } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ idToken: string; suggestedName: string; email: string | null } | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    try {
      const idToken = await googleIdToken();
      if (!idToken) return; // closed the popup
      try {
        await loginWithGoogle(idToken, { linkToken });
      } catch (err) {
        if (err instanceof ApiError && err.code === 'PROFILE_REQUIRED') {
          if (!allowSignup) return setError('No account is connected to this Google account.');
          const d = (err.details ?? {}) as { suggestedName?: string | null; email?: string | null };
          setProfile({ idToken, suggestedName: d.suggestedName ?? '', email: d.email ?? null });
        } else throw err;
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return { start, busy, error, profile, cancel: () => setProfile(null) };
}

/** Mobile number → OTP (→ name, for first-time sign-up). */
function OtpLogin({ allowSignup, devHint }: { allowSignup: boolean; devHint: boolean }) {
  const { client, login } = useAuth();
  const [step, setStep] = useState<'phone' | 'otp'>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [needsName, setNeedsName] = useState(false);
  const [devOtp, setDevOtp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cleanPhone = phone.replace(/\D/g, '').slice(-10);

  async function sendOtp(e?: FormEvent) {
    e?.preventDefault();
    if (!/^[6-9]\d{9}$/.test(cleanPhone)) return setError('Enter a valid 10-digit mobile number');
    setBusy(true);
    setError(null);
    try {
      const r = await client.requestOtp(cleanPhone);
      setDevOtp(r.devOtp ?? null);
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

  if (step === 'phone') {
    return (
      <form className="stack" onSubmit={sendOtp}>
        <Field label="Mobile number" hint="We’ll send a 6-digit OTP by SMS">
          <div className="prefix">
            <span className="sym">+91</span>
            <Input style={{ paddingLeft: 48 }} inputMode="numeric" autoComplete="tel-national" maxLength={14} placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Mobile number" />
          </div>
        </Field>
        <Alert>{error}</Alert>
        <Button type="submit" block busy={busy}>Send OTP</Button>
      </form>
    );
  }
  return (
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
      {devOtp ? (
        <DevOtpBox code={devOtp} onUse={() => setCode(devOtp)} />
      ) : (
        devHint && import.meta.env?.DEV && <p className="faint" style={{ margin: 0 }}>Development: the OTP is printed in the backend console.</p>
      )}
    </form>
  );
}

/**
 * Login used by every app: "Continue with Google" (free) first, mobile OTP as the alternative.
 * The app passed to AuthProvider decides which account types are accepted.
 */
export function LoginScreen({ title, tagline, allowSignup = true, devHint = true, google = googleSignInAvailable }: { title: string; tagline: string; allowSignup?: boolean; devHint?: boolean; google?: boolean }) {
  const { client, app } = useAuth();
  const g = useGoogleLogin(allowSignup);
  // Show only the sign-in methods this server offers (production: Google only).
  const cfg = useServerConfig(client);
  const showGoogle = google && (cfg?.googleLogin ?? false);
  const showOtp = cfg?.otpLogin ?? false;
  return (
    <LoginFrame title={title} tagline={tagline}>
      {!cfg ? (
        <Spinner label="Getting ready…" />
      ) : g.profile ? (
        <ProfileStep {...g.profile} onCancel={g.cancel} />
      ) : (
        <div className="stack">
          {showGoogle && (
            <>
              <GoogleButton onClick={() => void g.start()} busy={g.busy} />
              <Alert>{g.error}</Alert>
            </>
          )}
          {showGoogle && showOtp && <div className="or-divider" aria-hidden>or use mobile OTP</div>}
          {showOtp && <OtpLogin allowSignup={allowSignup} devHint={devHint} />}
          {!showOtp && app !== 'tenant' && (
            <p className="faint" style={{ margin: 0, textAlign: 'center' }}>
              {app === 'admin' ? 'Admins get their first sign-in link from the server.' : 'Staff: ask your PG owner for a login link.'}
            </p>
          )}
          {!showGoogle && !showOtp && <Alert>Sign-in is not available right now. Please try again later.</Alert>}
        </div>
      )}
    </LoginFrame>
  );
}

/** The token in a one-time login link URL (/link/<token>), if the page was opened from one. */
export function linkTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  return /^\/link\/([\w-]{20,100})\/?$/.exec(window.location.pathname)?.[1] ?? null;
}

const LINK_TEXT = {
  tenant: ['Your PG sent you a login link', 'Sign in with your Google account to connect it to your stay. Next time just tap “Continue with Google”.'],
  owner: ['You’ve been invited to PGPAL', 'Sign in with your Google account to connect it. Next time just tap “Continue with Google”.'],
  admin: ['Admin sign-in link', 'Sign in with your Google account to connect it to the admin account.'],
} as const;

/** One-time login link: from the PG owner (tenants, staff) or the server CLI (admins). */
export function LoginLinkScreen({ linkToken }: { linkToken: string }) {
  const { app } = useAuth();
  const g = useGoogleLogin(true, linkToken);
  const [title, tagline] = LINK_TEXT[app];
  return (
    <LoginFrame title={title} tagline={tagline}>
      {g.profile ? (
        <ProfileStep {...g.profile} linkToken={linkToken} onCancel={g.cancel} />
      ) : (
        <div className="stack">
          <GoogleButton onClick={() => void g.start()} busy={g.busy} />
          <Alert>{g.error}</Alert>
        </div>
      )}
    </LoginFrame>
  );
}

/** For signed-in users: connect Google so future logins need no OTP. */
export function ConnectGoogleCard() {
  const { client, session } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  if (!googleSignInAvailable || !session) return null;
  const connected = done || session.user.googleConnected;
  return (
    <div className="card ledger stack">
      <div className="row between">
        <h3>Google sign-in</h3>
        <span className={`badge ${connected ? 'ok' : ''}`}>{connected ? 'Connected' : 'Not connected'}</span>
      </div>
      {connected ? (
        <p className="muted" style={{ margin: 0 }}>You can log in with “Continue with Google” — no OTP needed{session.user.email ? ` (${session.user.email})` : ''}.</p>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>Connect your Google account to log in with one tap, free, without waiting for an OTP.</p>
          <GoogleButton
            busy={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const t = await googleIdToken();
                if (t) {
                  await client.connectGoogle(t);
                  setDone(true);
                }
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Connect Google account
          </GoogleButton>
          <Alert>{error}</Alert>
        </>
      )}
    </div>
  );
}
