import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Async, Button, Card, EmptyState, Field, formatDate, formatINR, Input, Money, MoneyInput, openFile, PageHead, StatusBadge, Tabs, toast, uploadFile, useAction, useApi, useAsync } from 'pg-core';
import { useProperty } from '../property';

interface MoveOut {
  id: string;
  tenancyId: string;
  status: string;
  requestedMoveOutDate: string;
  noticeGivenAt: string;
  ownerNote: string | null;
  checklist: { item: string; ok: boolean; note?: string }[] | null;
  depositHeldPaise: number | null;
  deductionsPaise: number | null;
  refundPaise: number | null;
  balanceDuePaise: number | null;
  tenantComment: string | null;
  deductions: { id: string; reason: string; amountPaise: number; photoFileId: string | null }[];
  tenancy: { id: string; status: string; bed: { label: string; room: { name: string } }; tenantProfile: { user: { name: string; phone: string } } };
  currentDepositHeldPaise?: number;
  outstandingDuesPaise?: number;
}

export function MoveOutsPage() {
  const client = useApi();
  const { current } = useProperty();
  const [status, setStatus] = useState<'OPEN' | 'ALL'>('OPEN');
  const state = useAsync(() => client.get<{ items: MoveOut[] }>(`/api/owner/move-outs?propertyId=${current!.id}&status=${status}`), [current?.id, status]);
  return (
    <>
      <PageHead eyebrow={current?.name} title="Move-outs" sub={`Tenants give notice from their app (minimum ${current?.minNoticeDays} days).`} />
      <Tabs value={status} onChange={setStatus} options={[{ value: 'OPEN', label: 'In progress' }, { value: 'ALL', label: 'All' }]} />
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="No move-outs" glyph="⇥" /> : null)}>
          {(d) => (
            <ul className="list">
              {d.items.map((m) => (
                <li key={m.id}>
                  <Link className="list-item" to={`/move-outs/${m.id}`}>
                    <div className="grow">
                      <div className="title">{m.tenancy.tenantProfile.user.name}</div>
                      <div className="meta">Room {m.tenancy.bed.room.name}-{m.tenancy.bed.label} · leaving {formatDate(m.requestedMoveOutDate)}</div>
                    </div>
                    <StatusBadge status={m.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
    </>
  );
}

const DEFAULT_CHECKLIST = ['Walls & paint', 'Bed & mattress', 'Cupboard & keys', 'Bathroom fittings', 'Electrical (fan, lights)', 'Room keys returned', 'ID card / access card returned'];

export function MoveOutDetailPage() {
  const { id } = useParams();
  const client = useApi();
  const state = useAsync(() => client.get<MoveOut>(`/api/owner/move-outs/${id}`), [id]);
  const act = useAction(async (path: string, body: unknown, msg: string) => {
    await client.post(`/api/owner/move-outs/${id}/${path}`, body);
    toast(msg);
    state.reload();
  });

  return (
    <Async state={state}>
      {(m) => (
        <>
          <PageHead
            eyebrow={`Room ${m.tenancy.bed.room.name}-${m.tenancy.bed.label}`}
            title={`${m.tenancy.tenantProfile.user.name} is moving out`}
            sub={`Leaving ${formatDate(m.requestedMoveOutDate)} · notice given ${formatDate(m.noticeGivenAt)}`}
            actions={<StatusBadge status={m.status} />}
          />
          <Alert>{act.error}</Alert>
          <div className="stack reveal">
            {m.status === 'REQUESTED' && (
              <Card ledger className="stack">
                <h3>Accept the notice?</h3>
                <p className="muted" style={{ margin: 0 }}>Accepting sets the last day. The final month’s rent is prorated to that date.</p>
                <div className="row">
                  <Button busy={act.busy} onClick={() => void act.run('accept', {}, 'Move-out accepted')}>Accept</Button>
                  <Button variant="secondary" busy={act.busy} onClick={() => { const note = prompt('Why are you declining?'); if (note) void act.run('reject', { note }, 'Declined'); }}>Decline</Button>
                </div>
              </Card>
            )}

            {['ACCEPTED', 'SETTLEMENT_PROPOSED', 'DISPUTED'].includes(m.status) && <Inspection m={m} onSave={(checklist) => act.run('inspection', { checklist }, 'Inspection saved')} />}

            {['ACCEPTED', 'SETTLEMENT_PROPOSED', 'DISPUTED'].includes(m.status) && <SettlementEditor m={m} onSave={(deductions) => act.run('settlement', { deductions }, 'Settlement sent to the tenant')} />}

            {m.refundPaise !== null && (
              <Card ledger>
                <div className="card-head"><h3>Settlement</h3><StatusBadge status={m.status} /></div>
                <div className="table-wrap">
                  <table className="ledger-table">
                    <tbody>
                      <tr><td>Deposit held</td><td className="num"><Money paise={m.depositHeldPaise} /></td></tr>
                      {m.deductions.map((d) => (
                        <tr key={d.id}>
                          <td>− {d.reason} {d.photoFileId && <button className="btn ghost small" onClick={() => void openFile(client, d.photoFileId!)}>photo</button>}</td>
                          <td className="num">−<Money paise={d.amountPaise} /></td>
                        </tr>
                      ))}
                      <tr><td><b>Refund to tenant</b></td><td className="num"><b><Money paise={m.refundPaise} /></b></td></tr>
                      {(m.balanceDuePaise ?? 0) > 0 && <tr><td className="danger-text">Tenant still owes</td><td className="num danger-text"><Money paise={m.balanceDuePaise} /></td></tr>}
                    </tbody>
                  </table>
                </div>
                {m.status === 'DISPUTED' && <Alert tone="warn">Tenant disputed: “{m.tenantComment}”. Revise the deductions above and send again.</Alert>}
                {m.status === 'TENANT_ACCEPTED' && (
                  <div className="stack" style={{ marginTop: 12 }}>
                    <Alert tone="ok">The tenant accepted. Pay the refund of {formatINR(m.refundPaise)}, then complete to write the ledger and free the bed.</Alert>
                    <Button busy={act.busy} onClick={() => { if (confirm(`Confirm you have refunded ${formatINR(m.refundPaise)}?`)) void act.run('complete', {}, 'Move-out completed — bed is free'); }}>Refund paid · complete move-out</Button>
                  </div>
                )}
              </Card>
            )}
            {m.status === 'COMPLETED' && <Alert tone="ok">Completed. The bed is vacant again.</Alert>}
          </div>
        </>
      )}
    </Async>
  );
}

function Inspection({ m, onSave }: { m: MoveOut; onSave: (c: { item: string; ok: boolean; note?: string }[]) => Promise<unknown> }) {
  const [items, setItems] = useState(() => m.checklist ?? DEFAULT_CHECKLIST.map((item) => ({ item, ok: true, note: '' })));
  const [busy, setBusy] = useState(false);
  return (
    <Card ledger className="stack">
      <h3>Inspection checklist</h3>
      {items.map((it, i) => (
        <div key={it.item} className="row" style={{ alignItems: 'flex-start' }}>
          <label className="check" style={{ flex: '1 1 180px' }}>
            <input type="checkbox" checked={it.ok} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, ok: e.target.checked } : x)))} />
            {it.item}
          </label>
          {!it.ok && <Input style={{ flex: '2 1 200px' }} placeholder="What’s wrong?" value={it.note ?? ''} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)))} />}
        </div>
      ))}
      <Button variant="secondary" busy={busy} onClick={async () => { setBusy(true); await onSave(items.map((x) => ({ ...x, note: x.note || undefined }))); setBusy(false); }}>Save inspection</Button>
    </Card>
  );
}

function SettlementEditor({ m, onSave }: { m: MoveOut; onSave: (d: { reason: string; amountPaise: number; photoFileId?: string }[]) => Promise<unknown> }) {
  const client = useApi();
  const [rows, setRows] = useState<{ reason: string; amountPaise: number | null; photoFileId?: string }[]>(() =>
    m.deductions.length ? m.deductions.map((d) => ({ reason: d.reason, amountPaise: d.amountPaise, photoFileId: d.photoFileId ?? undefined })) : [],
  );
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const held = m.currentDepositHeldPaise ?? 0;
  const total = rows.reduce((a, r) => a + (r.amountPaise ?? 0), 0);
  async function attach(i: number, file: File | undefined) {
    if (!file) return;
    try {
      const id = await uploadFile(client, 'DEDUCTION_PHOTO', file);
      setRows(rows.map((r, j) => (j === i ? { ...r, photoFileId: id } : r)));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <Card ledger className="stack">
      <h3>Deposit settlement</h3>
      <dl className="kv">
        <dt>Deposit held</dt><dd><Money paise={held} /></dd>
        <dt>Unpaid dues</dt><dd className={m.outstandingDuesPaise ? 'danger-text' : ''}><Money paise={m.outstandingDuesPaise ?? 0} /></dd>
      </dl>
      {(m.outstandingDuesPaise ?? 0) > 0 && !rows.some((r) => r.reason === 'Unpaid rent and dues') && (
        <Button small variant="secondary" onClick={() => setRows([...rows, { reason: 'Unpaid rent and dues', amountPaise: m.outstandingDuesPaise ?? 0 }])}>+ Deduct unpaid dues</Button>
      )}
      {rows.map((r, i) => (
        <div key={i} className="grid cols-3" style={{ alignItems: 'end' }}>
          <Field label={`Deduction ${i + 1}`}><Input value={r.reason} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} placeholder="Repainting wall" /></Field>
          <Field label="Amount"><MoneyInput value={r.amountPaise} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, amountPaise: v } : x)))} /></Field>
          <div className="row">
            <label className="btn secondary small">
              {r.photoFileId ? 'Photo ✓' : 'Add photo'}
              <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => void attach(i, e.target.files?.[0])} />
            </label>
            <Button small variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        </div>
      ))}
      <Button small variant="secondary" onClick={() => setRows([...rows, { reason: '', amountPaise: null }])}>+ Add deduction</Button>
      <hr className="divider" />
      <div className="row between">
        <b>Refund</b>
        <b className="money" style={{ fontSize: 22 }}>{formatINR(Math.max(0, held - total))}</b>
      </div>
      {total > held && <Alert tone="warn">Deductions exceed the deposit by {formatINR(total - held)} — the tenant will owe this.</Alert>}
      <Alert>{err}</Alert>
      <Button
        busy={busy}
        onClick={async () => {
          if (rows.some((r) => !r.reason.trim() || !r.amountPaise)) return setErr('Every deduction needs a reason and an amount');
          setBusy(true);
          setErr(null);
          await onSave(rows.map((r) => ({ reason: r.reason.trim(), amountPaise: r.amountPaise!, photoFileId: r.photoFileId })));
          setBusy(false);
        }}
      >
        {m.status === 'ACCEPTED' ? 'Send settlement to tenant' : 'Send revised settlement'}
      </Button>
    </Card>
  );
}
