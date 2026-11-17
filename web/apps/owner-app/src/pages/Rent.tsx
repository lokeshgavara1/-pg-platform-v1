import { useState } from 'react';
import { Async, Button, Card, EmptyState, formatDate, Money, PageHead, StatusBadge, Tabs, toast, useAction, useApi, useAsync, type Paged } from 'pg-core';
import { useProperty } from '../property';
import { InvoiceModal } from '../components/InvoiceModal';
import type { Invoice } from '../types';

type Filter = 'UNPAID' | 'OVERDUE' | 'PAID' | 'ALL';

export function RentPage() {
  const client = useApi();
  const { current } = useProperty();
  const [filter, setFilter] = useState<Filter>('UNPAID');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const state = useAsync(
    () => client.get<Paged<Invoice>>(`/api/owner/invoices?propertyId=${current!.id}&page=${page}&pageSize=30${filter === 'ALL' ? '' : `&status=${filter}`}`),
    [current?.id, filter, page],
  );
  const gen = useAction(async () => {
    const r = await client.post<{ created: number }>('/api/owner/invoices/generate');
    toast(r.created ? `${r.created} new invoice(s) created` : 'All invoices are already up to date');
    state.reload();
  });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHead
        eyebrow={current?.name}
        title="Rent"
        sub="Invoices are created automatically each month. Tap one to record cash or share a payment link."
        actions={<Button variant="secondary" busy={gen.busy} onClick={() => void gen.run()}>Run billing now</Button>}
      />
      <Tabs value={filter} onChange={(v) => { setFilter(v); setPage(1); }} options={[{ value: 'UNPAID', label: 'Unpaid' }, { value: 'OVERDUE', label: 'Overdue' }, { value: 'PAID', label: 'Paid' }, { value: 'ALL', label: 'All' }]} />
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="Nothing here" glyph="₹">{filter === 'UNPAID' ? 'Everyone is paid up.' : null}</EmptyState> : null)}>
          {(d) => (
            <>
              <ul className="list">
                {d.items.map((inv) => {
                  const who = inv.tenancy?.tenantProfile.user.name ?? inv.booking?.tenantUser.name ?? '—';
                  const late = (inv.status === 'DUE' || inv.status === 'PARTIAL') && inv.dueDate.slice(0, 10) < today;
                  return (
                    <li key={inv.id}>
                      <button className="list-item" onClick={() => setOpen(inv.id)}>
                        <div className="grow">
                          <div className="title">{who}</div>
                          <div className="meta">
                            {inv.kind === 'RENT' ? `Rent ${formatDate(inv.periodStart).slice(2)}` : inv.kind.toLowerCase()}
                            {inv.tenancy ? ` · ${inv.tenancy.bed.room.name}-${inv.tenancy.bed.label}` : ''} · due {formatDate(inv.dueDate)}
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <Money paise={inv.totalPaise - inv.paidPaise > 0 ? inv.totalPaise - inv.paidPaise : inv.totalPaise} className={late ? 'danger-text' : ''} />
                          <div><StatusBadge status={late ? 'OVERDUE' : inv.status} /></div>
                        </div>
                      </button>
                    </li>
                  );
                })}
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
      {open && <InvoiceModal invoiceId={open} onClose={() => setOpen(null)} onChanged={state.reload} />}
    </>
  );
}
