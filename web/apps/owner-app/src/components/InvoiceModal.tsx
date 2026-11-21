import { useState } from 'react';
import { Alert, Async, Button, Field, formatDate, formatINR, Input, Modal, Money, MoneyInput, openBlob, Select, StatusBadge, Tabs, toast, todayIST, useAction, useApi, useAsync } from 'pg-core';
import type { Invoice } from '../types';

/** Free: send the tenant the UPI ID and exact amount on WhatsApp. */
function ShareUpi({ inv, upi, outstanding }: { inv: Invoice; upi: { upiId: string; payeeName: string }; outstanding: number }) {
  const name = inv.tenancy?.tenantProfile.user.name ?? inv.booking?.tenantUser.name ?? '';
  const phone = (inv.tenancy?.tenantProfile.user.phone ?? inv.booking?.tenantUser.phone ?? '').replace(/\D/g, '');
  const what = inv.kind === 'RENT' ? `rent for ${formatDate(inv.periodStart).slice(2)}` : inv.kind === 'TOKEN' ? 'the booking token' : inv.kind === 'DEPOSIT' ? 'the security deposit' : 'your invoice';
  const message = `Hi ${name.split(' ')[0]}, please pay ${formatINR(outstanding)} for ${what} (${inv.property?.name ?? ''}) by UPI to ${upi.upiId} (${upi.payeeName}). After paying, open the PG app → Pay → "I've paid" so I can confirm it. Thank you!`;
  return (
    <div className="stack">
      <p className="muted" style={{ margin: 0 }}>Tenants pay your UPI ID directly from their PG app — free, no fees. You can also remind them on WhatsApp.</p>
      <dl className="kv">
        <dt>UPI ID</dt><dd className="mono">{upi.upiId}</dd>
        <dt>Amount</dt><dd><Money paise={outstanding} /></dd>
      </dl>
      <div className="row">
        {phone && <a className="btn accent" href={`https://wa.me/${phone}?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>}
        <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(message); toast('Message copied'); }}>Copy message</Button>
      </div>
    </div>
  );
}

/** Invoice detail: lines, payments + receipts, record cash/UPI, share a payment link, adjust or void. */
export function InvoiceModal({ invoiceId, onClose, onChanged }: { invoiceId: string; onClose: () => void; onChanged: () => void }) {
  const client = useApi();
  const state = useAsync(() => client.get<Invoice>(`/api/owner/invoices/${invoiceId}`), [invoiceId]);
  const [tab, setTab] = useState<'pay' | 'link' | 'adjust'>('pay');
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState<'CASH' | 'UPI_DIRECT'>('CASH');
  const [note, setNote] = useState('');
  const [receivedOn, setReceivedOn] = useState(todayIST());
  const [lineDesc, setLineDesc] = useState('');
  const [lineAmt, setLineAmt] = useState<number | null>(null);
  const [discount, setDiscount] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const refresh = () => { state.reload(); onChanged(); };

  const record = useAction(async (outstanding: number) => {
    const amt = amount ?? outstanding;
    if (!amt) throw new Error('Enter the amount received');
    await client.post(`/api/owner/invoices/${invoiceId}/payments`, { amountPaise: amt, method, note: note || undefined, receivedOn });
    toast('Payment recorded');
    setAmount(null);
    setNote('');
    refresh();
  });
  const makeLink = useAction(async () => {
    const r = await client.post<{ url: string }>(`/api/owner/invoices/${invoiceId}/payment-link`);
    setLink(r.url);
  });
  const addLine = useAction(async () => {
    if (!lineDesc.trim() || !lineAmt) throw new Error('Enter a description and amount');
    await client.post(`/api/owner/invoices/${invoiceId}/lines`, { description: lineDesc.trim(), amountPaise: discount ? -lineAmt : lineAmt });
    toast(discount ? 'Discount added' : 'Charge added');
    setLineDesc('');
    setLineAmt(null);
    refresh();
  });
  const voidIt = useAction(async () => {
    const reason = prompt('Why are you voiding this invoice?');
    if (!reason) return;
    await client.post(`/api/owner/invoices/${invoiceId}/void`, { reason });
    toast('Invoice voided');
    refresh();
  });

  return (
    <Modal open onClose={onClose} title="Invoice">
      <Async state={state}>
        {(inv) => {
          const outstanding = inv.totalPaise - inv.paidPaise;
          const open = inv.status === 'DUE' || inv.status === 'PARTIAL';
          const whatsapp = link ? `https://wa.me/${(inv.tenancy?.tenantProfile.user.phone ?? '').replace(/\D/g, '')}?text=${encodeURIComponent(`Hi ${inv.tenancy?.tenantProfile.user.name ?? ''}, please pay your ${inv.property?.name ?? ''} invoice ${inv.number} here: ${link}`)}` : null;
          return (
            <div className="stack">
              <div className="row between">
                <div>
                  <div className="mono faint">{inv.number}</div>
                  <b>{inv.tenancy?.tenantProfile.user.name ?? inv.booking?.tenantUser.name}</b>
                  {inv.tenancy && <span className="faint"> · Room {inv.tenancy.bed.room.name}-{inv.tenancy.bed.label}</span>}
                </div>
                <StatusBadge status={inv.status} />
              </div>
              <div className="table-wrap">
                <table className="ledger-table">
                  <tbody>
                    {inv.lines?.map((l) => (
                      <tr key={l.id}>
                        <td>{l.description}</td>
                        <td className="num">{l.amountPaise < 0 ? <span className="ok-text"><Money paise={l.amountPaise} /></span> : <Money paise={l.amountPaise} />}</td>
                      </tr>
                    ))}
                    <tr><td><b>Total</b> <span className="faint">· due {formatDate(inv.dueDate)}</span></td><td className="num"><b><Money paise={inv.totalPaise} /></b></td></tr>
                    <tr><td>Paid</td><td className="num"><Money paise={inv.paidPaise} /></td></tr>
                    <tr><td><b>Balance</b></td><td className="num"><b className={outstanding > 0 ? 'danger-text' : ''}><Money paise={outstanding} /></b></td></tr>
                  </tbody>
                </table>
              </div>

              {inv.payments && inv.payments.filter((p) => p.status === 'SUCCESS').length > 0 && (
                <div>
                  <h3 style={{ marginBottom: 6 }}>Payments</h3>
                  <ul className="list">
                    {inv.payments.filter((p) => p.status === 'SUCCESS').map((p) => (
                      <li key={p.id} className="row between" style={{ padding: '8px 0' }}>
                        <span>
                          <Money paise={p.amountPaise} /> <span className="faint">· {p.method === 'GATEWAY' ? 'Online' : p.method === 'UPI_DIRECT' ? 'UPI' : 'Cash'} · {formatDate(p.receivedAt)}</span>
                          {p.note && <div className="faint">{p.note}</div>}
                        </span>
                        <Button small variant="secondary" onClick={() => void openBlob(client, 'GET', `/api/owner/payments/${p.id}/receipt.pdf`)}>Receipt</Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {inv.payments && inv.payments.some((p) => p.status === 'REPORTED') && (
                <Alert tone="warn">
                  The tenant says they paid {inv.payments.filter((p) => p.status === 'REPORTED').map((p) => `₹${(p.amountPaise / 100).toLocaleString('en-IN')}${p.upiRef ? ` (ref ${p.upiRef})` : ''}`).join(', ')} by UPI.{' '}
                  Check your UPI app, then confirm it under <b>Rent → To confirm</b>.
                </Alert>
              )}

              {open && (
                <>
                  <Tabs value={tab} onChange={setTab} options={[{ value: 'pay', label: 'Mark received' }, { value: 'link', label: inv.payOptions?.gateway === false ? 'Share UPI details' : 'Payment link' }, { value: 'adjust', label: 'Add charge / discount' }]} />
                  {tab === 'pay' && (
                    <form className="stack" onSubmit={(e) => { e.preventDefault(); void record.run(outstanding); }}>
                      <div className="grid cols-2">
                        <Field label="Amount received"><MoneyInput value={amount ?? outstanding} onChange={setAmount} /></Field>
                        <Field label="How">
                          <Select value={method} onChange={(e) => setMethod(e.target.value as 'CASH' | 'UPI_DIRECT')}>
                            <option value="CASH">Cash</option>
                            <option value="UPI_DIRECT">UPI to my account</option>
                          </Select>
                        </Field>
                        <Field label="Received on"><Input type="date" value={receivedOn} max={todayIST()} onChange={(e) => setReceivedOn(e.target.value)} /></Field>
                        <Field label="Note (optional)"><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="UTR / reference" /></Field>
                      </div>
                      <Alert>{record.error}</Alert>
                      <Button type="submit" block busy={record.busy}>Record payment</Button>
                    </form>
                  )}
                  {tab === 'link' && inv.payOptions?.upi && !inv.payOptions.gateway && (
                    <ShareUpi inv={inv} upi={inv.payOptions.upi} outstanding={outstanding} />
                  )}
                  {tab === 'link' && (!inv.payOptions?.upi || inv.payOptions.gateway) && (
                    <div className="stack">
                      <p className="muted" style={{ margin: 0 }}>A link the tenant can open in any browser and pay by UPI. The invoice updates automatically when the gateway confirms.</p>
                      {link ? (
                        <>
                          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
                          <div className="row">
                            <Button variant="secondary" onClick={() => { void navigator.clipboard?.writeText(link); toast('Link copied'); }}>Copy</Button>
                            {whatsapp && <a className="btn accent" href={whatsapp} target="_blank" rel="noreferrer">Send on WhatsApp</a>}
                          </div>
                        </>
                      ) : (
                        <Button busy={makeLink.busy} onClick={() => void makeLink.run()}>Create link for <Money paise={outstanding} /></Button>
                      )}
                      <Alert>{makeLink.error}</Alert>
                    </div>
                  )}
                  {tab === 'adjust' && (
                    <form className="stack" onSubmit={(e) => { e.preventDefault(); void addLine.run(); }}>
                      <label className="check"><input type="checkbox" checked={discount} onChange={(e) => setDiscount(e.target.checked)} /> This is a discount</label>
                      <Field label="Description"><Input value={lineDesc} onChange={(e) => setLineDesc(e.target.value)} placeholder={discount ? 'Festival discount' : 'Electricity (Nov)'} /></Field>
                      <Field label="Amount"><MoneyInput value={lineAmt} onChange={setLineAmt} /></Field>
                      <Alert>{addLine.error}</Alert>
                      <Button type="submit" block variant="secondary" busy={addLine.busy}>Add to invoice</Button>
                    </form>
                  )}
                  {inv.paidPaise === 0 && <Button variant="ghost" busy={voidIt.busy} onClick={() => void voidIt.run()}>Void this invoice</Button>}
                  <Alert>{voidIt.error}</Alert>
                </>
              )}
            </div>
          );
        }}
      </Async>
    </Modal>
  );
}
