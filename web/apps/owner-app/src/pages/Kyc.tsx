import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, Field, formatDateTime, Initials, maskPhone, Modal, openFile, PageHead, StatusBadge, Tabs, TextArea, toast, useAction, useApi, useAsync } from 'pg-core';

interface KycRow {
  id: string;
  kycStatus: string;
  kycRejectReason: string | null;
  idType: string | null;
  idLast4: string | null;
  kycIdFileId: string | null;
  kycPhotoFileId: string | null;
  kycSubmittedAt: string | null;
  user: { id: string; name: string; phone: string };
}

export function KycPage() {
  const client = useApi();
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'NOT_SUBMITTED'>('PENDING');
  const state = useAsync(() => client.get<{ items: KycRow[] }>(`/api/owner/kyc?status=${status}`), [status]);
  const [rejecting, setRejecting] = useState<KycRow | null>(null);
  const approve = useAction(async (r: KycRow) => {
    await client.post(`/api/owner/kyc/${r.id}/approve`);
    toast(`${r.user.name}’s KYC approved`);
    state.reload();
  });
  const view = useAction((fileId: string) => openFile(client, fileId));

  return (
    <>
      <PageHead title="KYC review" sub="Documents open through short-lived private links, and every view is logged." />
      <Tabs value={status} onChange={setStatus} options={[{ value: 'PENDING', label: 'To review' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' }, { value: 'NOT_SUBMITTED', label: 'Not submitted' }]} />
      <Alert>{approve.error || view.error}</Alert>
      <Async state={state} empty={(d) => (d.items.length === 0 ? <Card><EmptyState title="Nothing to review" glyph="◉" /></Card> : null)}>
        {(d) => (
          <div className="stack reveal">
            {d.items.map((r) => (
              <Card key={r.id} ledger>
                <div className="row between">
                  <div className="row">
                    <Initials name={r.user.name} />
                    <div>
                      <b>{r.user.name}</b>
                      <div className="faint mono">{maskPhone(r.user.phone)}</div>
                    </div>
                  </div>
                  <StatusBadge status={r.kycStatus} />
                </div>
                <p className="muted">
                  {r.idType ? `${r.idType.replace('_', ' ')}${r.idLast4 ? ` · ends ${r.idLast4}` : ''}` : 'No ID submitted'}
                  {r.kycSubmittedAt && ` · submitted ${formatDateTime(r.kycSubmittedAt)}`}
                </p>
                {r.kycRejectReason && <Alert tone="warn">{r.kycRejectReason}</Alert>}
                <div className="row">
                  {r.kycIdFileId && <Button small variant="secondary" onClick={() => void view.run(r.kycIdFileId!)}>View ID</Button>}
                  {r.kycPhotoFileId && <Button small variant="secondary" onClick={() => void view.run(r.kycPhotoFileId!)}>View photo</Button>}
                  {r.kycStatus === 'PENDING' && (
                    <>
                      <Button small busy={approve.busy} onClick={() => void approve.run(r)}>Approve</Button>
                      <Button small variant="danger" onClick={() => setRejecting(r)}>Reject</Button>
                    </>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
      {rejecting && <RejectModal row={rejecting} onClose={() => setRejecting(null)} onDone={state.reload} />}
    </>
  );
}

function RejectModal({ row, onClose, onDone }: { row: KycRow; onClose: () => void; onDone: () => void }) {
  const client = useApi();
  const [reason, setReason] = useState('');
  const save = useAction(async () => {
    await client.post(`/api/owner/kyc/${row.id}/reject`, { reason });
    toast('Rejected — the tenant has been told why');
    onDone();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={`Reject ${row.user.name}’s KYC`}>
      <div className="stack">
        <Field label="Reason" hint="Be specific so they can fix it, e.g. “Photo of ID is blurry”."><TextArea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <Alert>{save.error}</Alert>
        <Button variant="danger" block busy={save.busy} disabled={reason.trim().length < 3} onClick={() => void save.run()}>Reject</Button>
      </div>
    </Modal>
  );
}
