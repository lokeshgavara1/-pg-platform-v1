import { useState } from 'react';
import {
  Alert, Async, Button, Card, EmptyState, Field, formatDate, formatDateTime, formatINR, Input, isPhone, Modal, Money, MoneyInput, openBlob, PageHead, StatusBadge, Tabs, toast, upiPayUri, useAction, useApi, useAsync,
} from 'pg-core';
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
  const [reporting, setReporting] = useState<{ inv: Invoice; left: number } | null>(null);
  const unpaid = useAsync(() => client.get<{ items: Invoice[] }>('/api/tenant/invoices?status=UNPAID'), [tab]);
  const receipts = useAsync(() => client.get<{ items: Receipt[] }>('/api/tenant/payments'), [tab]);
  const pay = useAction(async (inv: Invoice) => {
    // Online gateway (only when the PG has no UPI ID). Open the window first so mobile browsers don't block it.
    const win = window.open('', '_blank');
    const r = await client.post<{ url: string }>(`/api/tenant/invoices/${inv.id}/pay-link`);
    if (win) win.location.href = r.url;
    else window.location.href = r.url;
  });
  const withdraw = useAction(async (paymentId: string) => {
    if (!confirm('Withdraw this payment report?')) return;
    await client.post(`/api/tenant/payments/${paymentId}/withdraw`);
    unpaid.reload();
  });
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHead title="Pay" sub="Pay your PG directly by UPI — no fees. Your owner confirms it, and the receipt appears here." />
      <Tabs value={tab} onChange={setTab} options={[{ value: 'due', label: 'To pay' }, { value: 'receipts', label: 'Receipts' }]} />
      <Alert>{pay.error || withdraw.error}</Alert>
      {tab === 'due' ? (
        <Async state={unpaid} empty={(d) => (d.items.length === 0 ? <Card><EmptyState title="Nothing to pay" glyph="✓">You’re all paid up.</EmptyState></Card> : null)}>
          {(d) => (
            <div className="stack reveal">
              {d.items.map((inv) => {
                const due = inv.totalPaise - inv.paidPaise;
                const pending = inv.pendingReports.reduce((a, p) => a + p.amountPaise, 0);
                const left = due - pending;
                const late = inv.dueDate.slice(0, 10) < today;
                return (
                  <Card key={inv.id} ledger>
                    <div className="row between">
                      <div>
                        <b>{invoiceTitle(inv)}</b>
                        <div className="faint">{inv.property.name} · due {formatDate(inv.dueDate)}</div>
                      </div>
                      <StatusBadge status={pending > 0 && left <= 0 ? 'PENDING' : late ? 'OVERDUE' : inv.status} label={pending > 0 && left <= 0 ? 'Waiting for owner' : undefined} />
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

                    {inv.pendingReports.map((p) => (
                      <div key={p.id} className="alert warn" style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <span>
                          You reported <b>{formatINR(p.amountPaise)}</b>{p.upiRef ? <> (ref <span className="mono">{p.upiRef}</span>)</> : null} on {formatDateTime(p.createdAt)} — waiting for your owner to confirm.
                        </span>
                        <button className="btn ghost small" onClick={() => void withdraw.run(p.id)}>Withdraw</button>
                      </div>
                    ))}

                    {left > 0 && inv.payOptions.upi && (
                      <UpiPay inv={inv} upi={inv.payOptions.upi} amount={left} onPaid={() => setReporting({ inv, left })} />
                    )}
                    {left > 0 && !inv.payOptions.upi && inv.payOptions.gateway && (
                      <Button block variant="accent" style={{ marginTop: 12 }} busy={pay.busy} onClick={() => void pay.run(inv)}>
                        Pay <Money paise={left} /> online
                      </Button>
                    )}
                    {left > 0 && !inv.payOptions.upi && !inv.payOptions.gateway && (
                      <p className="faint" style={{ marginTop: 10 }}>Your PG hasn’t set up online payment yet. Pay your owner directly; they’ll record it.</p>
                    )}
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
      {reporting && <ReportModal inv={reporting.inv} left={reporting.left} onClose={() => setReporting(null)} onDone={unpaid.reload} />}
    </>
  );
}

/** Pay the owner's UPI ID directly. On a phone the UPI app opens with everything filled in. */
function UpiPay({ inv, upi, amount, onPaid }: { inv: Invoice; upi: { upiId: string; payeeName: string }; amount: number; onPaid: () => void }) {
  const phone = isPhone();
  const uri = upiPayUri(upi, amount, `${invoiceTitle(inv)} ${inv.number}`);
  const copy = () => {
    void navigator.clipboard?.writeText(upi.upiId);
    toast('UPI ID copied');
  };
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      {phone ? (
        <a className="btn accent block" href={uri} data-testid="upi-pay-link">
          Pay {formatINR(amount)} with UPI app
        </a>
      ) : (
        <Alert tone="info">
          Open this page on your phone to pay with one tap, or pay <b>{formatINR(amount)}</b> to UPI ID <b className="mono">{upi.upiId}</b> ({upi.payeeName}) from any UPI app.
        </Alert>
      )}
      <div className="row between">
        <span className="faint">
          To <span className="mono">{upi.upiId}</span> · {upi.payeeName}
        </span>
        <button className="btn ghost small" onClick={copy}>Copy UPI ID</button>
      </div>
      <Button block variant="secondary" onClick={onPaid}>I’ve paid</Button>
    </div>
  );
}

function ReportModal({ inv, left, onClose, onDone }: { inv: Invoice; left: number; onClose: () => void; onDone: () => void }) {
  const client = useApi();
  const [amount, setAmount] = useState<number | null>(left);
  const [ref, setRef] = useState('');
  const save = useAction(async () => {
    const upiRef = ref.replace(/\s/g, '');
    if (upiRef && !/^\d{12}$/.test(upiRef)) throw new Error('The UPI reference number has 12 digits');
    if (!amount) throw new Error('Enter the amount you paid');
    await client.post(`/api/tenant/invoices/${inv.id}/upi-report`, { amountPaise: amount, upiRef: upiRef || undefined });
    toast('Sent to your owner to confirm');
    onDone();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="I’ve paid by UPI">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <Field label="Amount paid"><MoneyInput value={amount} onChange={setAmount} /></Field>
        <Field label="UPI reference number (recommended)" hint="12 digits. In your UPI app, open the payment and look for “UPI Ref No.”, “UTR” or “Transaction ID”. It helps your owner find it fast.">
          <Input className="input mono" inputMode="numeric" maxLength={14} value={ref} onChange={(e) => setRef(e.target.value.replace(/[^\d\s]/g, ''))} placeholder="4123 4567 8901" />
        </Field>
        <Alert tone="info">Your owner checks their account and confirms. Until then the invoice still shows as due.</Alert>
        <Alert>{save.error}</Alert>
        <Button type="submit" block busy={save.busy}>Send to owner</Button>
      </form>
    </Modal>
  );
}
