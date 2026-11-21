import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiClient, memoryTokenStore } from './api';
import { AuthProvider, useAuth } from './auth';
import { formatINR, parseRupees, formatDate, upiPayUri } from './format';
import { LoginScreen } from './LoginScreen';

afterEach(cleanup);

describe('money formatting', () => {
  it('formats paise with Indian grouping', () => {
    expect(formatINR(850000)).toBe('₹8,500');
    expect(formatINR(12345678950)).toBe('₹12,34,56,789.50');
    expect(formatINR(-2500)).toBe('−₹25');
  });
  it('parses typed rupees into integer paise', () => {
    expect(parseRupees('8,500')).toBe(850000);
    expect(parseRupees('₹ 99.5')).toBe(9950);
    expect(parseRupees('1.234')).toBeNull();
    expect(parseRupees('abc')).toBeNull();
  });
  it('builds a UPI payment link with the exact amount in rupees and paise', () => {
    expect(upiPayUri({ upiId: 'ramesh.kumar@okaxis', payeeName: 'Ramesh Kumar' }, 850050, 'Rent Nov 2026 INV-1')).toBe(
      'upi://pay?pa=ramesh.kumar@okaxis&pn=Ramesh%20Kumar&am=8500.50&cu=INR&tn=Rent%20Nov%202026%20INV-1',
    );
    expect(upiPayUri({ upiId: 'x@ybl', payeeName: 'X' }, 7, 'n')).toContain('am=0.07');
  });

  it('formats date-only values without timezone drift', () => {
    expect(formatDate('2026-11-05T00:00:00.000Z')).toBe('5 Nov 2026');
  });
});

function json(status: number, body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

describe('ApiClient', () => {
  it('refreshes once on 401 and retries', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${url}`);
      if (url.endsWith('/api/x') && (init?.headers as Record<string, string>).authorization === 'Bearer old') return json(401, { error: { code: 'UNAUTHORIZED', message: 'expired' } });
      if (url.endsWith('/api/auth/refresh')) return json(200, { user: { id: '1', name: 'A', role: 'OWNER', phone: '+91' }, accessToken: 'new', refreshToken: 'r2' });
      return json(200, { ok: true });
    }) as unknown as typeof fetch;
    const store = memoryTokenStore();
    store.save({ user: { id: '1', name: 'A', role: 'OWNER', phone: '+91' }, accessToken: 'old', refreshToken: 'r1' });
    const c = new ApiClient('', store, fetchImpl);
    await expect(c.get('/api/x')).resolves.toEqual({ ok: true });
    expect(calls).toEqual(['GET /api/x', 'POST /api/auth/refresh', 'GET /api/x']);
    expect(store.load()?.refreshToken).toBe('r2');
  });

  it('raises typed errors with the backend message', async () => {
    const c = new ApiClient('', memoryTokenStore(), (() => json(409, { error: { code: 'CONFLICT', message: 'Bed taken' } })) as unknown as typeof fetch);
    await expect(c.post('/api/y')).rejects.toMatchObject({ status: 409, code: 'CONFLICT', message: 'Bed taken' });
  });
});

function Who() {
  const { session } = useAuth();
  return <div>{session ? `Hello ${session.user.name}` : 'logged out'}</div>;
}

function renderLogin(app: 'owner' | 'tenant', role: string) {
  const fetchImpl = ((url: string) => {
    if (url.endsWith('/request-otp')) return json(200, { ok: true, expiresInSeconds: 300 });
    if (url.endsWith('/verify-otp')) return json(200, { user: { id: 'u', name: 'Ravi', role, phone: '+919876543210' }, accessToken: 'a', refreshToken: 'r' });
    return json(404, {});
  }) as unknown as typeof fetch;
  const client = new ApiClient('', memoryTokenStore(), fetchImpl);
  render(
    <AuthProvider app={app} client={client}>
      <LoginScreen title="Owner" tagline="t" devHint={false} />
      <Who />
    </AuthProvider>,
  );
}

async function doLogin() {
  fireEvent.change(await screen.findByLabelText('Mobile number'), { target: { value: '9876543210' } });
  fireEvent.click(screen.getByText('Send OTP'));
  await screen.findByLabelText('OTP');
  fireEvent.change(screen.getByLabelText('OTP'), { target: { value: '123456' } });
  fireEvent.click(screen.getByText('Verify & continue'));
}

describe('LoginScreen development code box', () => {
  async function renderWith(devOtp?: string) {
    const fetchImpl = ((url: string) => (url.endsWith('/request-otp') ? json(200, { ok: true, expiresInSeconds: 300, ...(devOtp ? { devOtp } : {}) }) : json(404, {}))) as unknown as typeof fetch;
    render(
      <AuthProvider app="owner" client={new ApiClient('', memoryTokenStore(), fetchImpl)}>
        <LoginScreen title="Owner" tagline="t" devHint={false} />
      </AuthProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Mobile number'), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByText('Send OTP'));
  }

  it('shows the code and fills it with one tap when the backend sends it (local dev)', async () => {
    await renderWith('482913');
    expect((await screen.findByTestId('dev-otp')).textContent).toBe('482913');
    fireEvent.click(screen.getByText('Use code'));
    expect((screen.getByLabelText('OTP') as HTMLInputElement).value).toBe('482913');
  });

  it('shows nothing when the backend does not send a code (staging/production)', async () => {
    await renderWith();
    await screen.findByLabelText('OTP');
    expect(screen.queryByTestId('dev-otp')).toBeNull();
  });
});

describe('LoginScreen', () => {
  it('validates the phone number before sending', async () => {
    renderLogin('owner', 'OWNER');
    fireEvent.change(await screen.findByLabelText('Mobile number'), { target: { value: '12345' } });
    fireEvent.click(screen.getByText('Send OTP'));
    expect(await screen.findByText('Enter a valid 10-digit mobile number')).toBeTruthy();
  });

  it('logs an owner into the owner app', async () => {
    renderLogin('owner', 'OWNER');
    await doLogin();
    await waitFor(() => expect(screen.getByText('Hello Ravi')).toBeTruthy());
  });

  it('owner app refuses a tenant account with a clear message', async () => {
    renderLogin('owner', 'TENANT');
    await doLogin();
    expect(await screen.findByText(/registered as a tenant/)).toBeTruthy();
    expect(screen.getByText('logged out')).toBeTruthy();
  });

  it('tenant app refuses an owner account', async () => {
    renderLogin('tenant', 'OWNER');
    await doLogin();
    expect(await screen.findByText(/Please use the owner app/)).toBeTruthy();
  });
});
