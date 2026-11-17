import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Async, Button, Card, EmptyState, Initials, Input, maskPhone, Money, PageHead, StatusBadge, Tabs, useApi, useAsync, type Paged } from 'pg-core';
import { useProperty } from '../property';
import type { TenancyRow } from '../types';

type Filter = 'active' | 'dues' | 'notice' | 'ended';

export function TenantsPage() {
  const client = useApi();
  const nav = useNavigate();
  const { current } = useProperty();
  const [filter, setFilter] = useState<Filter>('active');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const state = useAsync(
    () => client.get<Paged<TenancyRow>>(`/api/owner/tenants?propertyId=${current!.id}&filter=${filter}&page=${page}&pageSize=25${q ? `&search=${encodeURIComponent(q)}` : ''}`),
    [current?.id, filter, q, page],
  );

  return (
    <>
      <PageHead eyebrow={current?.name} title="Tenants" actions={<Button onClick={() => nav('/tenants/new')}>+ Add tenant</Button>} />
      <div className="stack">
        <Input type="search" placeholder="Search by name or phone" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search tenants" />
        <Tabs value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[{ value: 'active', label: 'Living here' }, { value: 'dues', label: 'With dues' }, { value: 'notice', label: 'On notice' }, { value: 'ended', label: 'Moved out' }]} />
      </div>
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title={q ? 'No match' : 'No tenants here'} glyph="☺">{filter === 'active' && !q ? 'Add the people already living in your PG to start tracking rent.' : null}</EmptyState> : null)}>
          {(d) => (
            <>
              <ul className="list">
                {d.items.map((t) => (
                  <li key={t.id}>
                    <Link className="list-item" to={`/tenancies/${t.id}`}>
                      <Initials name={t.tenantProfile.user.name} />
                      <div className="grow">
                        <div className="title">{t.tenantProfile.user.name}</div>
                        <div className="meta">
                          Room {t.bed.room.name}-{t.bed.label} · <span className="mono">{maskPhone(t.tenantProfile.user.phone)}</span>
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        {t.overduePaise > 0 ? <Money paise={t.overduePaise} className="danger-text" /> : t.outstandingPaise > 0 ? <Money paise={t.outstandingPaise} /> : <span className="faint">Paid up</span>}
                        <div>{t.status !== 'ACTIVE' ? <StatusBadge status={t.status} /> : t.tenantProfile.kycStatus !== 'APPROVED' ? <span className="faint">KYC {t.tenantProfile.kycStatus.toLowerCase().replace('_', ' ')}</span> : null}</div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
              {d.totalPages > 1 && (
                <div className="row between" style={{ marginTop: 10 }}>
                  <Button variant="secondary" small disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Prev</Button>
                  <span className="faint">Page {d.page} of {d.totalPages}</span>
                  <Button variant="secondary" small disabled={page >= d.totalPages} onClick={() => setPage(page + 1)}>Next ›</Button>
                </div>
              )}
            </>
          )}
        </Async>
      </Card>
    </>
  );
}
