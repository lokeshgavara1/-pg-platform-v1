import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, Field, formatDate, formatINR, Input, Money, openFile, PageHead, StatusBadge, TextArea, toast, todayIST, useAction, useApi, useAsync } from 'pg-core';
import type { Home } from '../types';

interface MoveOut {
  id: string;
  status: string;
  requestedMoveOutDate: string;
  ownerNote: string | null;
  depositHeldPaise: number | null;
  refundPaise: number | null;
  balanceDuePaise: number | null;
  tenantComment: string | null;
  deductions: { id: string; reason: string; amountPaise: number; photoFileId: string | null }[];
}

const STEP_TEXT: Record<string, string> = {
  REQUESTED: 'Notice sent. Waiting for your owner to accept.',
  ACCEPTED: 'Accepted. Your owner will inspect the room and send the deposit settlement.',
  SETTLEMENT_PROPOSED: 'Your deposit settlement is ready. Please review it.',
  DISPUTED: 'You disputed the settlement. Your owner will send a revised one.',
  TENANT_ACCEPTED: 'You accepted. Your owner will pay the refund and complete the move-out.',
  COMPLETED: 'Move-out complete.',
  REJECTED: 'Your owner declined this notice.',
};

export function MoveOutPage() {
  const client = useApi();
  const home = useAsync(() => client.get<Home>('/api/tenant/home'), []);
  const state = useAsync(() => client.get<{ moveOut: MoveOut | null }>('/api/tenant/move-out'), []);
  const [date, setDate] = useState('');
  const [comment, setComment] = useState('');
  const [disputing, setDisputing] = useState(false);
  const give = useAction(async () => {
    await client.post('/api/tenant/move-out', { moveOutDate: date });
    toast('Notice sent to your owner');
    state.reload();
  });
  const accept = useAction(async () => {
    await client.post('/api/tenant/move-out/accept');
    toast('Settlement accepted');
    state.reload();
  });
  const dispute = useAction(async () => {
    await client.post('/api/tenant/move-out/dispute', { comment });
    setDisputing(false);
    toast('Dispute sent');
    state.reload();
  });

  return (
    <>
      <PageHead title="Moving out" />
      <Async state={state}>
        {({ moveOut: m }) => {
          const stay = home.data?.stay;
          const minDate = todayIST(stay?.minNoticeDays ?? 0);
          const canGive = stay && stay.status === 'ACTIVE' && (!m || m.status === 'REJECTED' || m.status === 'COMPLETED');
          return (
            <div className="stack reveal">
              {m && m.status !== 'COMPLETED' && (
                <Card ledger className="stack">
                  <div className="row between"><h3>Leaving {formatDate(m.requestedMoveOutDate)}</h3><StatusBadge status={m.status} /></div>
                  <p className="muted" style={{ margin: 0 }}>{STEP_TEXT[m.status]}</p>
                  {m.ownerNote && <Alert tone="info">Owner: {m.ownerNote}</Alert>}
                </Card>
              )}
              {m && m.refundPaise !== null && ['SETTLEMENT_PROPOSED', 'DISPUTED', 'TENANT_ACCEPTED', 'COMPLETED'].includes(m.status) && (
                <Card ledger className="stack">
                  <h3>Deposit settlement</h3>
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
                        <tr><td><b>You get back</b></td><td className="num"><b className="ok-text"><Money paise={m.refundPaise} /></b></td></tr>
                        {(m.balanceDuePaise ?? 0) > 0 && <tr><td className="danger-text">You still owe</td><td className="num danger-text"><Money paise={m.balanceDuePaise} /></td></tr>}
                      </tbody>
                    </table>
                  </div>
                  {m.status === 'SETTLEMENT_PROPOSED' && !disputing && (
                    <div className="row">
                      <Button busy={accept.busy} onClick={() => { if (confirm(`Accept a refund of ${formatINR(m.refundPaise)}?`)) void accept.run(); }}>Accept</Button>
                      <Button variant="secondary" onClick={() => setDisputing(true)}>Dispute</Button>
                    </div>
                  )}
                  {disputing && (
                    <>
                      <Field label="What do you disagree with?"><TextArea value={comment} onChange={(e) => setComment(e.target.value)} /></Field>
                      <Button variant="danger" busy={dispute.busy} disabled={comment.trim().length < 5} onClick={() => void dispute.run()}>Send dispute</Button>
                    </>
                  )}
                  <Alert>{accept.error || dispute.error}</Alert>
                </Card>
              )}
              {canGive && (
                <Card ledger className="stack">
                  <h3>Give move-out notice</h3>
                  <p className="muted" style={{ margin: 0 }}>Your PG needs at least {stay!.minNoticeDays} days’ notice. Rent for the last month is charged only up to your move-out date.</p>
                  <Field label="Move-out date" hint={`Earliest: ${formatDate(minDate)}`}><Input type="date" min={minDate} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
                  <Alert>{give.error}</Alert>
                  <Button disabled={!date} busy={give.busy} onClick={() => void give.run()}>Send notice</Button>
                </Card>
              )}
              {!stay && !m && <Card><EmptyState title="No active stay" glyph="⇥" /></Card>}
              {m?.status === 'COMPLETED' && <Alert tone="ok">Your move-out is complete. Thank you for staying with us!</Alert>}
            </div>
          );
        }}
      </Async>
    </>
  );
}
