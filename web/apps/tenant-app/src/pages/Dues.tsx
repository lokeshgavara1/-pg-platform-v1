import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, formatDate, Money, openBlob, PageHead, StatusBadge, Tabs, useAction, useApi, useAsync } from 'pg-core';
import type { Invoice } from '../types';

interface Receipt {
  id: string;
  amountPaise: number;
  method: string;
  receivedAt: string;
  invoice: { number: string; kind: string; periodStart: string | null; property: { name: string } };
}

const invoiceTitle = (i: { kind: string; periodStart: string | null }) =>
  i.kind === 'RENT' ? `Rent · ${formatDate(i.periodStart).slice(2)}` : i.kind === 'TOKEN' ? 'Booking token' : i.kind === 'DEPOSIT' ? 'Security deposit' : 'Charge';

export function DuesPage() {
  const client = useApi();
  const [tab, setTab] = useState<'due' | 'receipts'>('due');
  const unpaid = useAsync(() => client.get<{ items: Invoice[] }>('/api/tenant/invoices?status=UNPAID'), [tab]);
  const receipts = useAsync(() => client.get<{ items: Receipt[] }>('/api/tenant/payments'), [tab]);
  const pay = useAction(async (inv: Invoice) => {
    // Open the window first so mobile browsers don't block the pop-up.
    const win = window.open('', '_blank');
    const r = await client.post<{ url: string }>(`/api/tenant/invoices/${inv.id}/pay-link`);
    if (win) win.location.href = r.url;
    else window.location.href = r.url;
  });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHead title="Pay" sub="Pay securely by UPI. Your invoice is marked paid as soon as the payment is confirmed." />
      <Tabs value={tab} onChange={setTab} options={[{ value: 'due', label: 'To pay' }, { value: 'receipts', label: 'Receipts' }]} />
      <Alert>{pay.error}</Alert>
      {tab === 'due' ? (
        <Async state={unpaid} empty={(d) => (d.items.length === 0 ? <Card><EmptyState title="Nothing to pay" glyph="✓">You’re all paid up.</EmptyState></Card> : null)}>
          {(d) => (
            <div className="stack reveal">
              {d.items.map((inv) => {
                const due = inv.totalPaise - inv.paidPaise;
                const late = inv.dueDate.slice(0, 10) < today;
                return (
                  <Card key={inv.id} ledger>
                    <div className="row between">
                      <div>
                        <b>{invoiceTitle(inv)}</b>
                        <div className="faint">{inv.property.name} · due {formatDate(inv.dueDate)}</div>
                      </div>
                      <StatusBadge status={late ? 'OVERDUE' : inv.status} />
                    </div>
                    <div className="table-wrap" style={{ marginTop: 8 }}>
                      <table className="ledger-table">
                        <tbody>
                          {inv.lines.map((l) => (
                            <tr key={l.id}><td>{l.description}</td><td className="num"><Money paise={l.amountPaise} /></td></tr>
                          ))}
                          {inv.paidPaise > 0 && <tr><td>Already paid</td><td className="num">−<Money paise={inv.paidPaise} /></td></tr>}
                        </tbody>
                      </table>
                    </div>
                    <Button block variant="accent" style={{ marginTop: 12 }} busy={pay.busy} onClick={() => void pay.run(inv)}>
                      Pay <Money paise={due} /> by UPI
                    </Button>
                  </Card>
                );
              })}
              <p className="faint" style={{ textAlign: 'center' }}>Paid in cash? Your owner will record it and the receipt appears here.</p>
            </div>
          )}
        </Async>
      ) : (
        <Card>
          <Async state={receipts} empty={(d) => (d.items.length === 0 ? <EmptyState title="No payments yet" glyph="₹" /> : null)}>
            {(d) => (
              <ul className="list">
                {d.items.map((p) => (
                  <li key={p.id} className="row between" style={{ padding: '10px 0' }}>
                    <div>
                      <b>{invoiceTitle(p.invoice)}</b>
                      <div className="faint">{formatDate(p.receivedAt)} · {p.method === 'GATEWAY' ? 'UPI / online' : p.method === 'UPI_DIRECT' ? 'UPI to owner' : 'Cash'}</div>
                    </div>
                    <div className="row">
                      <Money paise={p.amountPaise} />
                      <Button small variant="secondary" onClick={() => void openBlob(client, 'GET', `/api/tenant/payments/${p.id}/receipt.pdf`)}>Receipt</Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Async>
        </Card>
      )}
    </>
  );
}
