import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiClient, AuthProvider, memoryTokenStore } from 'pg-core';
import { DuesPage } from './pages/Dues';

afterEach(cleanup);

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

const invoice = (extra: Record<string, unknown> = {}) => ({
  id: 'inv1',
  number: 'INV-202611-AAAA',
  kind: 'RENT',
  periodStart: '2026-11-01',
  dueDate: '2099-11-05',
  totalPaise: 850000,
  paidPaise: 0,
  status: 'DUE',
  lines: [{ id: 'l1', description: 'Rent Nov 2026', amountPaise: 850000 }],
  property: { name: 'Sunrise PG' },
  payOptions: { upi: { upiId: 'ramesh@okaxis', payeeName: 'Ramesh Kumar' }, gateway: false },
  pendingReports: [],
  ...extra,
});

function renderDues(items: unknown[], onReport?: (body: unknown) => void, phoneUA = true) {
  Object.defineProperty(window.navigator, 'userAgent', { value: phoneUA ? 'Mozilla/5.0 (Linux; Android 14) Mobile' : 'Mozilla/5.0 (Windows NT 10.0)', configurable: true });
  const store = memoryTokenStore();
  store.save({ user: { id: 'u', name: 'Priya', role: 'TENANT', phone: '+919876543210' }, accessToken: 'a', refreshToken: 'r' });
  const fetchImpl = ((url: string, init?: RequestInit) => {
    if (url.includes('/upi-report')) {
      onReport?.(JSON.parse(String(init?.body)));
      return json({ id: 'p1', status: 'REPORTED' }, 201);
    }
    if (url.includes('/api/tenant/invoices')) return json({ items });
    return json({ items: [] });
  }) as unknown as typeof fetch;
  render(
    <AuthProvider app="tenant" client={new ApiClient('', store, fetchImpl)}>
      <MemoryRouter>
        <DuesPage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('tenant Pay screen with direct UPI', () => {
  it('on a phone, opens the UPI app with the owner UPI ID and the exact amount', async () => {
    renderDues([invoice()]);
    const link = (await screen.findByTestId('upi-pay-link')) as HTMLAnchorElement;
    expect(link.textContent).toContain('₹8,500');
    expect(link.getAttribute('href')).toMatch(/^upi:\/\/pay\?pa=ramesh@okaxis&pn=Ramesh%20Kumar&am=8500\.00&cu=INR&tn=/);
  });

  it('on a laptop, shows the UPI ID to pay instead of an app link', async () => {
    renderDues([invoice()], undefined, false);
    expect(await screen.findByText(/Open this page on your phone/)).toBeTruthy();
    expect(screen.queryByTestId('upi-pay-link')).toBeNull();
  });

  it('"I\'ve paid" sends the amount and UPI reference to the owner', async () => {
    let sent: unknown;
    renderDues([invoice()], (b) => (sent = b));
    fireEvent.click(await screen.findByText('I’ve paid'));
    fireEvent.change(screen.getByPlaceholderText('4123 4567 8901'), { target: { value: '4123 4567 8901' } });
    fireEvent.click(screen.getByText('Send to owner'));
    await waitFor(() => expect(sent).toEqual({ amountPaise: 850000, upiRef: '412345678901' }));
  });

  it('rejects a reference that is not 12 digits before sending', async () => {
    let sent: unknown;
    renderDues([invoice()], (b) => (sent = b));
    fireEvent.click(await screen.findByText('I’ve paid'));
    fireEvent.change(screen.getByPlaceholderText('4123 4567 8901'), { target: { value: '12345' } });
    fireEvent.click(screen.getByText('Send to owner'));
    expect(await screen.findByText('The UPI reference number has 12 digits')).toBeTruthy();
    expect(sent).toBeUndefined();
  });

  it('a fully reported invoice waits for the owner and offers no second payment', async () => {
    renderDues([invoice({ pendingReports: [{ id: 'p1', amountPaise: 850000, upiRef: '412345678901', createdAt: '2026-11-18T05:00:00Z' }] })]);
    expect(await screen.findByText(/waiting for your owner to confirm/)).toBeTruthy();
    expect(screen.getByText('Waiting for owner')).toBeTruthy();
    expect(screen.queryByTestId('upi-pay-link')).toBeNull();
    expect(screen.queryByText('I’ve paid')).toBeNull();
  });
});
