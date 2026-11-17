import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Async, Button, Card, Field, formatDate, formatDateTime, Input, maskPhone, Modal, Money, MoneyInput, openFile, PageHead, Select, StatusBadge, toast, todayIST, useAction, useApi, useAsync } from 'pg-core';
import { InvoiceModal } from '../components/InvoiceModal';
import type { Invoice, Room } from '../types';

interface Detail {
  id: string;
  status: 'ACTIVE' | 'NOTICE' | 'ENDED';
  startDate: string;
  endDate: string | null;
  rentPaise: number;
  depositPaise: number;
  propertyId: string;
  property: { name: string };
  bed: { id: string; label: string; room: { name: string } };
  tenant: { profileId: string; name: string; phone: string; guardianName: string | null; guardianPhone: string | null; fatherName: string | null; permanentAddress: string | null; occupation: string | null; workplace: string | null; kycStatus: string; kycRejectReason: string | null; idType: string | null; idLast4: string | null; kycIdFileId: string | null; kycPhotoFileId: string | null };
  invoices: Invoice[];
  depositLedger: { id: string; type: string; amountPaise: number; reason: string; createdAt: string }[];
  depositHeldPaise: number;
  charges: { id: string; name: string; amountPaise: number; status: string }[];
  agreements: { id: string; status: string; pdfFileId: string; signedPdfFileId: string | null; signedAt: string | null; esignDevOnly: boolean; createdAt: string }[];
  verification: { id: string; status: string; reference: string | null } | null;
  moveOut: { id: string; status: string; requestedMoveOutDate: string } | null;
}

export function TenantDetailPage() {
  const { id } = useParams();
  const client = useApi();
  const state = useAsync(() => client.get<Detail>(`/api/owner/tenancies/${id}`), [id]);
  const [invoice, setInvoice] = useState<string | null>(null);
  const [modal, setModal] = useState<null | 'rent' | 'move' | 'end' | 'charge' | 'deposit'>(null);

  const agreement = useAction(async () => {
    await client.post(`/api/owner/tenancies/${id}/agreement`);
    toast('Agreement created and sent to the tenant to sign');
    state.reload();
  });
  const kyc = useAction(async (action: 'approve' | 'reject', profileId: string) => {
    if (action === 'reject') {
      const reason = prompt('Reason for rejecting (the tenant will see this)');
      if (!reason) return;
      await client.post(`/api/owner/kyc/${profileId}/reject`, { reason });
    } else await client.post(`/api/owner/kyc/${profileId}/approve`);
    toast(`KYC ${action === 'approve' ? 'approved' : 'rejected'}`);
    state.reload();
  });
  const removeCharge = useAction(async (chargeId: string) => {
    if (!confirm('Stop this monthly charge from next invoice?')) return;
    await client.post(`/api/owner/charges/${chargeId}/deactivate`);
    state.reload();
  });

  return (
    <Async state={state}>
      {(t) => {
        const live = t.status !== 'ENDED';
        const latestAgreement = t.agreements.find((a) => a.status !== 'VOID');
        return (
          <>
            <PageHead
              eyebrow={`${t.property.name} · Room ${t.bed.room.name}-${t.bed.label}`}
              title={t.tenant.name}
              sub={<><span className="mono">{maskPhone(t.tenant.phone)}</span> · since {formatDate(t.startDate)} {t.endDate && `· until ${formatDate(t.endDate)}`}</>}
              actions={<StatusBadge status={t.status} />}
            />
            <div className="grid cols-3 reveal">
              <Card ledger>
                <div className="card-head"><h3>Rent & deposit</h3>{live && <Button small variant="ghost" onClick={() => setModal('rent')}>Edit</Button>}</div>
                <dl className="kv">
                  <dt>Monthly rent</dt><dd><Money paise={t.rentPaise} /></dd>
                  {t.charges.filter((c) => c.status === 'ACTIVE').map((c) => (
                    <Fragment key={c.id}><dt>{c.name} <button className="btn ghost small" onClick={() => void removeCharge.run(c.id)} aria-label={`Remove ${c.name}`}>✕</button></dt><dd><Money paise={c.amountPaise} /></dd></Fragment>
                  ))}
                  <dt>Deposit agreed</dt><dd><Money paise={t.depositPaise} /></dd>
                  <dt>Deposit held</dt><dd><Money paise={t.depositHeldPaise} /></dd>
                </dl>
                {live && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <Button small variant="secondary" onClick={() => setModal('charge')}>+ Monthly charge</Button>
                    <Button small variant="secondary" onClick={() => setModal('deposit')}>+ Deposit received</Button>
                  </div>
                )}
              </Card>

              <Card ledger>
                <div className="card-head"><h3>KYC</h3><StatusBadge status={t.tenant.kycStatus} /></div>
                {t.tenant.idType && <p className="muted" style={{ margin: '0 0 8px' }}>{t.tenant.idType.replace('_', ' ')}{t.tenant.idLast4 ? ` ending ${t.tenant.idLast4}` : ''}</p>}
                {t.tenant.kycRejectReason && <Alert tone="warn">Rejected: {t.tenant.kycRejectReason}</Alert>}
                <div className="row">
                  {t.tenant.kycIdFileId && <Button small variant="secondary" onClick={() => void openFile(client, t.tenant.kycIdFileId!)}>View ID</Button>}
                  {t.tenant.kycPhotoFileId && <Button small variant="secondary" onClick={() => void openFile(client, t.tenant.kycPhotoFileId!)}>View photo</Button>}
                </div>
                {t.tenant.kycStatus === 'PENDING' && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <Button small busy={kyc.busy} onClick={() => void kyc.run('approve', t.tenant.profileId)}>Approve</Button>
                    <Button small variant="danger" busy={kyc.busy} onClick={() => void kyc.run('reject', t.tenant.profileId)}>Reject</Button>
                  </div>
                )}
                {t.tenant.kycStatus === 'NOT_SUBMITTED' && <p className="faint">The tenant uploads ID from the tenant app.</p>}
                <Alert>{kyc.error}</Alert>
                <hr className="divider" />
                <dl className="kv">
                  <dt>Guardian</dt><dd>{[t.tenant.guardianName, t.tenant.guardianPhone && maskPhone(t.tenant.guardianPhone)].filter(Boolean).join(' · ') || '—'}</dd>
                  <dt>Occupation</dt><dd>{[t.tenant.occupation, t.tenant.workplace].filter(Boolean).join(', ') || '—'}</dd>
                  <dt>Police verification</dt><dd>{t.verification ? <Link to="/verification"><StatusBadge status={t.verification.status} /></Link> : '—'}</dd>
                </dl>
              </Card>

              <Card ledger>
                <div className="card-head"><h3>Agreement</h3>{latestAgreement && <StatusBadge status={latestAgreement.status} />}</div>
                {latestAgreement ? (
                  <div className="stack">
                    {latestAgreement.esignDevOnly && latestAgreement.status === 'SIGNED' && <span className="dev-stamp">Test signature · not legally valid</span>}
                    <div className="row">
                      <Button small variant="secondary" onClick={() => void openFile(client, latestAgreement.signedPdfFileId ?? latestAgreement.pdfFileId)}>Open PDF</Button>
                      {latestAgreement.signedAt && <span className="faint">Signed {formatDateTime(latestAgreement.signedAt)}</span>}
                    </div>
                  </div>
                ) : (
                  <p className="muted" style={{ marginTop: 0 }}>No agreement yet.</p>
                )}
                {live && (!latestAgreement || latestAgreement.status === 'DRAFT') && (
                  <Button small style={{ marginTop: 10 }} busy={agreement.busy} onClick={() => void agreement.run()}>{latestAgreement ? 'Regenerate draft' : 'Create agreement'}</Button>
                )}
                <Alert>{agreement.error}</Alert>
                {t.moveOut && (
                  <>
                    <hr className="divider" />
                    <Link to={`/move-outs/${t.moveOut.id}`} className="row between">
                      <span>Move-out {formatDate(t.moveOut.requestedMoveOutDate)}</span>
                      <StatusBadge status={t.moveOut.status} />
                    </Link>
                  </>
                )}
              </Card>
            </div>

            <Card style={{ marginTop: 12 }}>
              <div className="card-head"><h3>Invoices</h3></div>
              <ul className="list">
                {t.invoices.filter((i) => i.status !== 'VOID').map((inv) => (
                  <li key={inv.id}>
                    <button className="list-item" onClick={() => setInvoice(inv.id)}>
                      <div className="grow">
                        <div className="title">{inv.kind === 'RENT' ? `Rent · ${formatDate(inv.periodStart).slice(2)}` : `${inv.kind.toLowerCase()} invoice`}</div>
                        <div className="meta">Due {formatDate(inv.dueDate)}</div>
                      </div>
                      <Money paise={inv.totalPaise} />
                      <StatusBadge status={inv.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </Card>

            {t.depositLedger.length > 0 && (
              <Card style={{ marginTop: 12 }}>
                <div className="card-head"><h3>Deposit ledger</h3></div>
                <div className="table-wrap">
                  <table className="ledger-table">
                    <thead><tr><th>Date</th><th>Entry</th><th className="num">Amount</th></tr></thead>
                    <tbody>
                      {t.depositLedger.map((l) => (
                        <tr key={l.id}>
                          <td className="mono">{formatDate(l.createdAt)}</td>
                          <td>{l.reason} <span className="faint">({l.type.toLowerCase()})</span></td>
                          <td className="num">{l.type === 'COLLECTED' ? '+' : '−'}<Money paise={l.amountPaise} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}

            {live && (
              <div className="row" style={{ marginTop: 16 }}>
                <Button variant="secondary" onClick={() => setModal('move')}>Move to another bed</Button>
                <Button variant="danger" onClick={() => setModal('end')}>End tenancy</Button>
              </div>
            )}

            {invoice && <InvoiceModal invoiceId={invoice} onClose={() => setInvoice(null)} onChanged={state.reload} />}
            {modal === 'rent' && <RentModal t={t} onClose={() => setModal(null)} onSaved={state.reload} />}
            {modal === 'move' && <MoveBedModal t={t} onClose={() => setModal(null)} onSaved={state.reload} />}
            {modal === 'end' && <EndModal t={t} onClose={() => setModal(null)} onSaved={state.reload} />}
            {modal === 'charge' && <ChargeModal t={t} onClose={() => setModal(null)} onSaved={state.reload} />}
            {modal === 'deposit' && <DepositModal t={t} onClose={() => setModal(null)} onSaved={state.reload} />}
          </>
        );
      }}
    </Async>
  );
}

function RentModal({ t, onClose, onSaved }: { t: Detail; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [rent, setRent] = useState<number | null>(t.rentPaise);
  const [deposit, setDeposit] = useState<number | null>(t.depositPaise);
  const save = useAction(async () => {
    await client.patch(`/api/owner/tenancies/${t.id}`, { rentPaise: rent ?? undefined, depositPaise: deposit ?? undefined });
    toast('Saved. New rent applies from the next invoice.');
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Rent & deposit">
      <div className="stack">
        <Field label="Monthly rent" hint="Changes apply to invoices created from now on. Every change is recorded in the audit log."><MoneyInput value={rent} onChange={setRent} /></Field>
        <Field label="Deposit agreed"><MoneyInput value={deposit} onChange={setDeposit} /></Field>
        <Alert>{save.error}</Alert>
        <Button block busy={save.busy} onClick={() => void save.run()}>Save</Button>
      </div>
    </Modal>
  );
}

function MoveBedModal({ t, onClose, onSaved }: { t: Detail; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const rooms = useAsync(() => client.get<{ items: Room[] }>(`/api/owner/properties/${t.propertyId}/rooms`), []);
  const [bedId, setBedId] = useState('');
  const save = useAction(async () => {
    await client.post(`/api/owner/tenancies/${t.id}/move-bed`, { bedId });
    toast('Moved');
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Move to another bed">
      <Async state={rooms}>
        {(d) => (
          <div className="stack">
            <Select value={bedId} onChange={(e) => setBedId(e.target.value)}>
              <option value="">Choose a vacant bed…</option>
              {d.items.flatMap((r) => r.beds.filter((b) => b.occupancy?.status === 'VACANT').map((b) => <option key={b.id} value={b.id}>Room {r.name} · bed {b.label}</option>))}
            </Select>
            <Alert>{save.error}</Alert>
            <Button block disabled={!bedId} busy={save.busy} onClick={() => void save.run()}>Move</Button>
          </div>
        )}
      </Async>
    </Modal>
  );
}

function EndModal({ t, onClose, onSaved }: { t: Detail; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [date, setDate] = useState(todayIST());
  const save = useAction(async () => {
    await client.post(`/api/owner/tenancies/${t.id}/end`, { endDate: date });
    toast('Tenancy ended — the bed is free');
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="End tenancy">
      <div className="stack">
        <Alert tone="warn">Use this for a move-out handled outside the app. For a normal move-out with deposit settlement, use the tenant’s move-out request instead.</Alert>
        <Field label="Last day" hint="The final month’s rent is prorated to this date; later unpaid invoices are voided."><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Alert>{save.error}</Alert>
        <Button block variant="danger" busy={save.busy} onClick={() => void save.run()}>End tenancy</Button>
      </div>
    </Modal>
  );
}

function ChargeModal({ t, onClose, onSaved }: { t: Detail; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [name, setName] = useState('Food');
  const [amt, setAmt] = useState<number | null>(null);
  const save = useAction(async () => {
    if (!amt) throw new Error('Enter an amount');
    await client.post(`/api/owner/tenancies/${t.id}/charges`, { name, amountPaise: amt });
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Monthly charge">
      <div className="stack">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Amount per month"><MoneyInput value={amt} onChange={setAmt} /></Field>
        <Alert>{save.error}</Alert>
        <Button block busy={save.busy} onClick={() => void save.run()}>Add</Button>
      </div>
    </Modal>
  );
}

function DepositModal({ t, onClose, onSaved }: { t: Detail; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [amt, setAmt] = useState<number | null>(null);
  const [reason, setReason] = useState('Deposit received in cash');
  const save = useAction(async () => {
    if (!amt) throw new Error('Enter an amount');
    await client.post(`/api/owner/tenancies/${t.id}/deposit`, { amountPaise: amt, reason });
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Deposit received">
      <div className="stack">
        <Field label="Amount"><MoneyInput value={amt} onChange={setAmt} /></Field>
        <Field label="Note"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Alert>{save.error}</Alert>
        <Button block busy={save.busy} onClick={() => void save.run()}>Record</Button>
      </div>
    </Modal>
  );
}
