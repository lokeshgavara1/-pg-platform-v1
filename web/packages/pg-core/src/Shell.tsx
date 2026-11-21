import { useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import { useAsync } from './hooks';
import { formatDateTime } from './format';
import { BottomNav, Button, EmptyState, Modal, ToastHost, type NavItem } from './ui';
import { BrandLockup } from './brand';

interface NotificationRow {
  id: string;
  title: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export function NotificationBell() {
  const { client } = useAuth();
  const [open, setOpen] = useState(false);
  const state = useAsync(() => client.get<{ items: NotificationRow[]; unread: number }>('/api/notifications'), [open]);
  const unread = state.data?.unread ?? 0;
  return (
    <>
      <button className="icon-btn" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} onClick={() => setOpen(true)}>
        <span aria-hidden>🔔</span>
        {unread > 0 && <span className="dot">{unread > 9 ? '9+' : unread}</span>}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Notifications">
        {state.data && state.data.items.length === 0 && <EmptyState title="All caught up" glyph="✓" />}
        <ul className="list">
          {state.data?.items.map((n) => (
            <li key={n.id} style={{ padding: '10px 0', opacity: n.readAt ? 0.65 : 1 }}>
              <div className="row between">
                <b>{n.title}</b>
                <span className="faint">{formatDateTime(n.createdAt)}</span>
              </div>
              <div className="muted" style={{ fontSize: 14 }}>{n.body}</div>
            </li>
          ))}
        </ul>
        {unread > 0 && (
          <Button variant="secondary" block onClick={async () => { await client.post('/api/notifications/read-all'); state.reload(); }}>
            Mark all as read
          </Button>
        )}
      </Modal>
    </>
  );
}

/** appLabel shows as a small chip next to the PGPAL wordmark ("Owner", "Staff", "Admin"); omit it for tenants. */
export function AppShell({ nav, children, right, appLabel }: { nav: NavItem[]; children: ReactNode; right?: ReactNode; appLabel?: string }) {
  const { session, logout } = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <BrandLockup app={appLabel} size={28} />
        <div className="spacer" />
        {right}
        <NotificationBell />
        <button className="icon-btn" title={`Log out ${session?.user.name ?? ''}`} aria-label="Log out" onClick={() => { if (confirm('Log out?')) void logout(); }}>
          <span aria-hidden>⎋</span>
        </button>
      </header>
      <div className="body-row">
        <BottomNav items={nav} />
        <main className="main">{children}</main>
      </div>
      <ToastHost />
    </div>
  );
}
