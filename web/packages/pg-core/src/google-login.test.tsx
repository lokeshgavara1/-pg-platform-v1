import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

// Fake Google popup: always returns a token.
vi.mock('./google', () => ({ googleSignInAvailable: true, googleIdToken: vi.fn(async () => 'firebase-id-token-xyz') }));

import { ApiClient, memoryTokenStore } from './api';
import { AuthProvider, useAuth } from './auth';
import { LoginLinkScreen, LoginScreen } from './LoginScreen';
import { resetServerConfigCache } from './serverConfig';

afterEach(cleanup);

const json = (status: number, body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status }));

function Who() {
  const { session } = useAuth();
  return <div>{session ? `Hello ${session.user.name}` : 'logged out'}</div>;
}

function setup(handler: (body: Record<string, unknown>) => Promise<Response>, ui: 'login' | 'link' = 'login') {
  const calls: Record<string, unknown>[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    if (url.endsWith('/api/auth/google')) {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return handler(body);
    }
    return json(404, {});
  }) as unknown as typeof fetch;
  render(
    <AuthProvider app="tenant" client={new ApiClient('', memoryTokenStore(), fetchImpl)}>
      {ui === 'login' ? <LoginScreen title="T" tagline="t" devHint={false} /> : <LoginLinkScreen linkToken="link-token-aaaaaaaaaaaaaaaa" />}
      <Who />
    </AuthProvider>,
  );
  return calls;
}

const session = (name: string) => json(200, { user: { id: 'u', name, role: 'TENANT', phone: '+919876543210' }, accessToken: 'a', refreshToken: 'r' });

describe('Continue with Google', () => {
  it('existing account: one tap and you are in', async () => {
    setup(() => session('Priya'));
    fireEvent.click(await screen.findByText('Continue with Google'));
    await waitFor(() => expect(screen.getByText('Hello Priya')).toBeTruthy());
  });

  it('new account: asks name and mobile once, then signs in', async () => {
    const calls = setup((b) =>
      b.phone ? session(String(b.name)) : json(400, { error: { code: 'PROFILE_REQUIRED', message: 'x', details: { suggestedName: 'Ravi Kumar', email: 'ravi@gmail.com' } } }),
    );
    fireEvent.click(await screen.findByText('Continue with Google'));
    expect(await screen.findByText(/ravi@gmail.com/)).toBeTruthy();
    expect((screen.getByLabelText('Full name') as HTMLInputElement).value).toBe('Ravi Kumar');
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '98765 43210' } });
    fireEvent.click(screen.getByText('Create account'));
    await waitFor(() => expect(screen.getByText('Hello Ravi Kumar')).toBeTruthy());
    expect(calls[1]).toMatchObject({ idToken: 'firebase-id-token-xyz', app: 'tenant', name: 'Ravi Kumar', phone: '9876543210' });
  });

  it('shows the server message when the mobile number already has an account', async () => {
    setup((b) =>
      b.phone
        ? json(409, { error: { code: 'PHONE_TAKEN', message: 'This mobile number already has an account. Ask your PG owner for a login link.' } })
        : json(400, { error: { code: 'PROFILE_REQUIRED', message: 'x', details: {} } }),
    );
    fireEvent.click(await screen.findByText('Continue with Google'));
    await screen.findByLabelText('Mobile number');
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'Mallory' } });
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9876543210' } });
    fireEvent.click(screen.getByText('Create account'));
    expect(await screen.findByText(/Ask your PG owner for a login link/)).toBeTruthy();
    expect(screen.getByText('logged out')).toBeTruthy();
  });

  it('login link screen sends the link token with the Google sign-in', async () => {
    const calls = setup(() => session('Priya'), 'link');
    fireEvent.click(await screen.findByText('Continue with Google'));
    await waitFor(() => expect(screen.getByText('Hello Priya')).toBeTruthy());
    expect(calls[0]).toMatchObject({ linkToken: 'link-token-aaaaaaaaaaaaaaaa', app: 'tenant' });
  });
});

describe('production login screen', () => {
  function renderWithConfig(app: 'tenant' | 'owner', config: Record<string, boolean>) {
    const fetchImpl = ((url: string) => (url.endsWith('/api/auth/config') ? json(200, config) : json(404, {}))) as unknown as typeof fetch;
    render(
      <AuthProvider app={app} client={new ApiClient('', memoryTokenStore(), fetchImpl)}>
        <LoginScreen title="T" tagline="t" devHint={false} />
      </AuthProvider>,
    );
  }

  it('shows only Google when the server has no SMS (production)', async () => {
    resetServerConfigCache();
    renderWithConfig('tenant', { otpLogin: false, googleLogin: true, esign: false, onlineGateway: false });
    expect(await screen.findByText('Continue with Google')).toBeTruthy();
    expect(screen.queryByLabelText('Mobile number')).toBeNull();
    expect(screen.queryByText('or use mobile OTP')).toBeNull();
  });

  it('tells staff to ask their owner for a login link', async () => {
    resetServerConfigCache();
    renderWithConfig('owner', { otpLogin: false, googleLogin: true, esign: false, onlineGateway: false });
    expect(await screen.findByText(/ask your PG owner for a login link/)).toBeTruthy();
  });
});
