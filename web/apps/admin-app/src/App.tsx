import { useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import {
  Alert, AppShell, Async, AuthProvider, Button, Card, ConnectGoogleCard, createClient, EmptyState, Field, formatDate, formatDateTime, Input, LoginLinkScreen, LoginScreen, linkTokenFromUrl, Money, PageHead, StatusBadge, Tabs, TextArea, Modal, toast, useAction, useApi, useAsync, useAuth, type NavItem,
} from 'pg-core';

/** Pilot-support admin site. Read-only, except deactivate/activate (audited). Cannot open tenant documents. */
const client = createClient('admin');

const NAV: NavItem[] = [
  { to: '/', label: 'Users', icon: '☺', end: true },
  { to: '/payments', label: 'Failed payments', icon: '₹' },
  { to: '/webhooks', label: 'Webhooks', icon: '⇄' },
];

interface UserRow { id: string; name: string; phone: string; role: string; status: string; createdAt: string }

function UsersPage() {
  const api = useApi();
  const [phone, setPhone] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(phone.replace(/\D/g, '')), 300);
    return () => clearTimeout(t);
  }, [phone]);
  const state = useAsync(() => api.get<{ items: UserRow[] }>(`/api/admin/users${q.length >= 3 ? `?phone=${q}` : ''}`), [q]);
  return (
    <>
      <PageHead eyebrow="Admin" title="Users" sub="Search by phone number (at least 3 digits)." />
      <div style={{ marginBottom: 12 }}><ConnectGoogleCard /></div>
      <Input type="search" inputMode="numeric" placeholder="98765…" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Search by phone" />
      <Card style={{ marginTop: 12 }}>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="No users found" /> : null)}>
          {(d) => (
            <div className="table-wrap">
              <table className="ledger-table">
                <thead><tr><th>Name</th><th>Phone</th><th>Role</th><th>Status</th><th>Joined</th></tr></thead>
                <tbody>
                  {d.items.map((u) => (
                    <tr key={u.id}>
                      <td><Link to={`/users/${u.id}`}>{u.name}</Link></td>
                      <td className="mono">{u.phone}</td>
                      <td>{u.role}</td>
                      <td><StatusBadge status={u.status} /></td>
                      <td className="mono">{formatDate(u.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Async>
      </Card>
    </>
  );
}

interface UserDetail extends UserRow {
  ownedProperties: { id: string; name: string; city: string; status: string }[];
  tenantProfile: { id: string; kycStatus: string; tenancies: { id: string; status: string; startDate: string; endDate: string | null; property: { name: string } }[] } | null;
}
interface AuditRow { id: string; action: string; entityType: string; entityId: string; before: unknown; after: unknown; createdAt: string; actor: { name: string; role: string } | null }

function UserPage() {
  const { id } = useParams();
  const api = useApi();
  const user = useAsync(() => api.get<UserDetail>(`/api/admin/users/${id}`), [id]);
  const audit = useAsync(() => api.get<{ items: AuditRow[] }>(`/api/admin/users/${id}/audit`), [id]);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const toggle = useAction(async (u: UserDetail) => {
    if (u.status === 'ACTIVE') await api.post(`/api/admin/users/${u.id}/deactivate`, { reason });
    else await api.post(`/api/admin/users/${u.id}/activate`);
    toast(u.status === 'ACTIVE' ? 'User deactivated and signed out' : 'User re-activated');
    setConfirming(false);
    setReason('');
    user.reload();
    audit.reload();
  });
  return (
    <Async state={user}>
      {(u) => (
        <>
          <PageHead eyebrow={u.role} title={u.name} sub={<span className="mono">{u.phone}</span>} actions={<><StatusBadge status={u.status} /><Button variant={u.status === 'ACTIVE' ? 'danger' : 'secondary'} small onClick={() => (u.status === 'ACTIVE' ? setConfirming(true) : void toggle.run(u))}>{u.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}</Button></>} />
          <Alert>{toggle.error}</Alert>
          <div className="grid cols-3">
            {u.ownedProperties.length > 0 && (
              <Card ledger>
                <h3>Properties</h3>
                <ul className="list">{u.ownedProperties.map((p) => <li key={p.id} className="row between" style={{ padding: '6px 0' }}><span>{p.name} <span className="faint">{p.city}</span></span><StatusBadge status={p.status} /></li>)}</ul>
              </Card>
            )}
            {u.tenantProfile && (
              <Card ledger>
                <div className="card-head"><h3>Stays</h3><StatusBadge status={u.tenantProfile.kycStatus} label={`KYC ${u.tenantProfile.kycStatus.toLowerCase().replace('_', ' ')}`} /></div>
                <ul className="list">{u.tenantProfile.tenancies.map((t) => <li key={t.id} className="row between" style={{ padding: '6px 0' }}><span>{t.property.name} <span className="faint">{formatDate(t.startDate)} – {formatDate(t.endDate)}</span></span><StatusBadge status={t.status} /></li>)}</ul>
              </Card>
            )}
          </div>
          <Card style={{ marginTop: 12 }}>
            <h3 style={{ marginBottom: 8 }}>Audit log</h3>
            <Async state={audit} empty={(d) => (d.items.length === 0 ? <EmptyState title="No audit entries" /> : null)}>
              {(d) => (
                <div className="table-wrap">
                  <table className="ledger-table">
                    <thead><tr><th>When</th><th>Action</th><th>By</th><th>Change</th></tr></thead>
                    <tbody>
                      {d.items.map((a) => (
                        <tr key={a.id}>
                          <td className="mono" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.createdAt)}</td>
                          <td><b>{a.action}</b><div className="faint">{a.entityType}</div></td>
                          <td>{a.actor ? `${a.actor.name} (${a.actor.role.toLowerCase()})` : 'system'}</td>
                          <td className="mono" style={{ fontSize: 12, maxWidth: 360, wordBreak: 'break-word' }}>{a.before ? `${JSON.stringify(a.before)} → ` : ''}{JSON.stringify(a.after)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Async>
          </Card>
          <Modal open={confirming} onClose={() => setConfirming(false)} title={`Deactivate ${u.name}?`}>
            <div className="stack">
              <p className="muted" style={{ margin: 0 }}>They are signed out everywhere and cannot log in. Their records are kept. This is written to the audit log.</p>
              <Field label="Reason"><TextArea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
              <Button variant="danger" block disabled={reason.trim().length < 3} busy={toggle.busy} onClick={() => void toggle.run(u)}>Deactivate</Button>
            </div>
          </Modal>
        </>
      )}
    </Async>
  );
}

function FailedPaymentsPage() {
  const api = useApi();
  const state = useAsync(() => api.get<{ items: { id: string; amountPaise: number; provider: string; failureReason: string; createdAt: string; invoice: { number: string; property: { name: string } } }[] }>('/api/admin/payments/failed'), []);
  return (
    <>
      <PageHead eyebrow="Admin" title="Failed payments" />
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="No failed payments" glyph="✓" /> : null)}>
          {(d) => (
            <div className="table-wrap">
              <table className="ledger-table">
                <thead><tr><th>When</th><th>PG / invoice</th><th>Reason</th><th className="num">Amount</th></tr></thead>
                <tbody>{d.items.map((p) => <tr key={p.id}><td className="mono">{formatDateTime(p.createdAt)}</td><td>{p.invoice.property.name}<div className="faint mono">{p.invoice.number}</div></td><td>{p.failureReason} <span className="faint">({p.provider})</span></td><td className="num"><Money paise={p.amountPaise} /></td></tr>)}</tbody>
              </table>
            </div>
          )}
        </Async>
      </Card>
    </>
  );
}

function WebhooksPage() {
  const api = useApi();
  const [status, setStatus] = useState<'PROBLEMS' | 'PROCESSED' | 'IGNORED'>('PROBLEMS');
  const state = useAsync(() => api.get<{ items: { id: string; provider: string; eventId: string; type: string; signatureOk: boolean; status: string; error: string | null; createdAt: string }[] }>(`/api/admin/webhooks?status=${status}`), [status]);
  return (
    <>
      <PageHead eyebrow="Admin" title="Payment webhooks" />
      <Tabs value={status} onChange={setStatus} options={[{ value: 'PROBLEMS', label: 'Failed / rejected' }, { value: 'PROCESSED', label: 'Processed' }, { value: 'IGNORED', label: 'Ignored' }]} />
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="Nothing here" glyph="✓" /> : null)}>
          {(d) => (
            <div className="table-wrap">
              <table className="ledger-table">
                <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Error</th></tr></thead>
                <tbody>{d.items.map((w) => <tr key={w.id}><td className="mono">{formatDateTime(w.createdAt)}</td><td>{w.provider} · {w.type}<div className="faint mono">{w.eventId}</div></td><td><StatusBadge status={w.status} />{!w.signatureOk && <div className="danger-text faint">bad signature</div>}</td><td>{w.error}</td></tr>)}</tbody>
              </table>
            </div>
          )}
        </Async>
      </Card>
    </>
  );
}

function Authed() {
  const { session } = useAuth();
  if (!session) {
    // First sign-in: one-time link printed by `npm run admin:create` on the server.
    const linkToken = linkTokenFromUrl();
    if (linkToken) return <LoginLinkScreen linkToken={linkToken} />;
    return <LoginScreen title="Pilot support" tagline="Admin access only." allowSignup={false} />;
  }
  return (
    <BrowserRouter>
      <AppShell appLabel="Admin" nav={NAV}>
        <Routes>
          <Route path="/" element={<UsersPage />} />
          <Route path="/users/:id" element={<UserPage />} />
          <Route path="/payments" element={<FailedPaymentsPage />} />
          <Route path="/webhooks" element={<WebhooksPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </BrowserRouter>
  );
}

export function App() {
  return (
    <AuthProvider app="admin" client={client}>
      <Authed />
    </AuthProvider>
  );
}
