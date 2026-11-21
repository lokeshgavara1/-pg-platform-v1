import { Link } from 'react-router-dom';
import { Async, Card, EmptyState, formatDate, formatINR, Initials, Money, PageHead, pct, Stat, StatusBadge, useApi, useAsync, useAuth } from 'pg-core';
import { useProperty } from '../property';

interface Dashboard {
  occupancy: { totalBeds: number; occupied: number; reserved: number; vacant: number; occupancyBps: number };
  month: { from: string; to: string; duePaise: number; collectedPaise: number; outstandingPaise: number };
  overdue: { tenancyId: string; tenantName: string; propertyName: string; room: string; bed: string; overduePaise: number; oldestDueDate: string }[];
  endingSoon: { id: string; status: string; endDate: string | null; property: { name: string }; bed: { label: string; room: { name: string } }; tenantProfile: { user: { name: string } } }[];
  openComplaints: number;
  pending: { kyc: number; bookings: number; moveOuts: number; paymentsToConfirm?: number };
}

export function DashboardPage() {
  const client = useApi();
  const { session } = useAuth();
  const { current } = useProperty();
  const state = useAsync(() => client.get<Dashboard>(`/api/owner/dashboard${current ? `?propertyId=${current.id}` : ''}`), [current?.id]);
  const first = session?.user.name.split(' ')[0];
  const monthName = new Date().toLocaleString('en-IN', { month: 'long', timeZone: 'Asia/Kolkata' });

  return (
    <>
      <PageHead eyebrow={current?.name} title={`Namaste, ${first}`} sub={`Here’s ${monthName} at a glance.`} />
      <Async state={state}>
        {(d) => {
          const collectedPct = d.month.duePaise ? Math.round((d.month.collectedPaise * 100) / d.month.duePaise) : 0;
          const todo = [
            { n: d.pending.paymentsToConfirm ?? 0, label: 'UPI payments to confirm', to: '/rent?tab=confirm' },
            { n: d.pending.bookings, label: 'bookings to confirm', to: '/bookings' },
            { n: d.pending.kyc, label: 'KYC to review', to: '/kyc' },
            { n: d.openComplaints, label: 'open complaints', to: '/complaints' },
            { n: d.pending.moveOuts, label: 'move-outs to handle', to: '/move-outs' },
          ].filter((t) => t.n > 0);
          return (
            <div className="stack reveal">
              <div className="grid cols-2">
                <Stat hero label={`Collected · ${monthName}`} value={formatINR(d.month.collectedPaise)} sub={`of ${formatINR(d.month.duePaise)} due · ${collectedPct}%`} meter={collectedPct} />
                <Stat label="Occupancy" value={pct(d.occupancy.occupancyBps)} sub={`${d.occupancy.occupied} of ${d.occupancy.totalBeds} beds · ${d.occupancy.vacant} vacant · ${d.occupancy.reserved} reserved`} meter={d.occupancy.occupancyBps / 100} />
                <Stat label="Still to collect" value={formatINR(d.month.outstandingPaise)} sub="this month’s invoices" />
                <Stat label="Overdue tenants" value={d.overdue.length} sub={d.overdue.length ? formatINR(d.overdue.reduce((a, o) => a + o.overduePaise, 0)) + ' late' : 'Nobody is late'} />
              </div>

              {todo.length > 0 && (
                <Card ledger>
                  <div className="card-head"><h3>Needs your attention</h3></div>
                  <ul className="list">
                    {todo.map((t) => (
                      <li key={t.to}>
                        <Link className="list-item" to={t.to}>
                          <span className="money" style={{ fontSize: 22, minWidth: 32, color: 'var(--accent)' }}>{t.n}</span>
                          <span className="grow">{t.label}</span>
                          <span aria-hidden>›</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card ledger>
                <div className="card-head">
                  <h3>Overdue rent</h3>
                  <Link to="/rent" className="faint">All invoices ›</Link>
                </div>
                {d.overdue.length === 0 ? (
                  <EmptyState title="No overdue rent" glyph="✓">Everyone has paid what was due.</EmptyState>
                ) : (
                  <ul className="list">
                    {d.overdue.map((o) => (
                      <li key={o.tenancyId}>
                        <Link className="list-item" to={`/tenancies/${o.tenancyId}`}>
                          <Initials name={o.tenantName} />
                          <div className="grow">
                            <div className="title">{o.tenantName}</div>
                            <div className="meta">Room {o.room}-{o.bed} · due since {formatDate(o.oldestDueDate)}</div>
                          </div>
                          <Money paise={o.overduePaise} className="danger-text" />
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              {d.endingSoon.length > 0 && (
                <Card ledger>
                  <div className="card-head"><h3>Moving out soon</h3></div>
                  <ul className="list">
                    {d.endingSoon.map((t) => (
                      <li key={t.id}>
                        <Link className="list-item" to={`/tenancies/${t.id}`}>
                          <Initials name={t.tenantProfile.user.name} />
                          <div className="grow">
                            <div className="title">{t.tenantProfile.user.name}</div>
                            <div className="meta">Room {t.bed.room.name}-{t.bed.label} · leaves {formatDate(t.endDate)}</div>
                          </div>
                          <StatusBadge status={t.status} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          );
        }}
      </Async>
    </>
  );
}
