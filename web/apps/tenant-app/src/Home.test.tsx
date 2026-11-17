import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiClient, AuthProvider, memoryTokenStore } from 'pg-core';
import { HomePage } from './pages/Home';

afterEach(cleanup);

const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

function renderHome(home: unknown) {
  const store = memoryTokenStore();
  store.save({ user: { id: 'u', name: 'Priya Sharma', role: 'TENANT', phone: '+919876543210' }, accessToken: 'a', refreshToken: 'r' });
  const client = new ApiClient('', store, ((url: string) => (url.endsWith('/home') ? json(home) : json({ items: [] }))) as unknown as typeof fetch);
  render(
    <AuthProvider app="tenant" client={client}>
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const base = { user: { id: 'u', name: 'Priya Sharma', phone: '+919876543210' }, kycStatus: 'NOT_SUBMITTED', agreement: null, booking: null, unreadNotifications: 0 };

describe('tenant home', () => {
  it('invites a tenant with no stay to enter a code', async () => {
    renderHome({ ...base, stay: null, dues: { outstandingPaise: 0, overduePaise: 0, nextDueDate: null } });
    expect(await screen.findByText('Enter invite code')).toBeTruthy();
  });

  it('shows dues and a pay button for a living tenant', async () => {
    renderHome({
      ...base,
      stay: { tenancyId: 't', status: 'ACTIVE', propertyName: 'Sunrise PG', propertyAddress: 'x', room: '101', bed: 'A', startDate: '2026-01-01', endDate: null, rentPaise: 850000, depositPaise: 1700000, depositHeldPaise: 1700000, rentDueDay: 5, minNoticeDays: 30 },
      dues: { outstandingPaise: 850000, overduePaise: 850000, nextDueDate: '2026-11-05' },
    });
    expect(await screen.findByText('Overdue — please pay')).toBeTruthy();
    expect(screen.getAllByText('₹8,500').length).toBeGreaterThan(0);
    expect(screen.getByText('Pay by UPI')).toBeTruthy();
    expect(screen.getByText('Upload your ID')).toBeTruthy();
  });
});
