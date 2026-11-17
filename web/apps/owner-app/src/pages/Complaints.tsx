import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, Field, formatDateTime, Modal, openFile, PageHead, Select, StatusBadge, Tabs, TextArea, titleCase, toast, useAction, useApi, useAsync, type Paged } from 'pg-core';
import { useProperty } from '../property';

interface Complaint {
  id: string;
  category: string;
  description: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
  closingNote: string | null;
  createdAt: string;
  propertyId: string;
  property: { name: string };
  tenancy: { bed: { label: string; room: { name: string } } };
  raisedBy: { name: string };
  assignedTo: { id: string; name: string } | null;
  updates: { id: string; message: string; toStatus: string | null; createdAt: string }[];
  photos: { id: string }[];
}

export function ComplaintsPage({ staff = false }: { staff?: boolean }) {
  const client = useApi();
  const { current } = useProperty();
  const [status, setStatus] = useState<'ACTIVE' | 'RESOLVED' | 'CLOSED'>('ACTIVE');
  const state = useAsync(
    () => client.get<Paged<Complaint>>(`/api/owner/complaints?status=${status}&pageSize=50${!staff && current ? `&propertyId=${current.id}` : ''}`),
    [status, current?.id, staff],
  );
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHead eyebrow={staff ? 'Assigned to you' : current?.name} title="Complaints" />
      <Tabs value={status} onChange={setStatus} options={[{ value: 'ACTIVE', label: 'Open' }, { value: 'RESOLVED', label: 'Resolved' }, { value: 'CLOSED', label: 'Closed' }]} />
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="No complaints" glyph="⚑" /> : null)}>
          {(d) => (
            <ul className="list">
              {d.items.map((c) => (
                <li key={c.id}>
                  <button className="list-item" onClick={() => setOpen(c.id)}>
                    <div className="grow">
                      <div className="title">{titleCase(c.category)} · Room {c.tenancy.bed.room.name}</div>
                      <div className="meta">{c.raisedBy.name} · {formatDateTime(c.createdAt)}{c.assignedTo ? ` · ${c.assignedTo.name}` : ''}</div>
                    </div>
                    <StatusBadge status={c.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
      {open && <ComplaintModal id={open} staff={staff} onClose={() => setOpen(null)} onChanged={state.reload} />}
    </>
  );
}

function ComplaintModal({ id, staff, onClose, onChanged }: { id: string; staff: boolean; onClose: () => void; onChanged: () => void }) {
  const client = useApi();
  const state = useAsync(() => client.get<Complaint>(`/api/owner/complaints/${id}`), [id]);
  const staffList = useAsync(
    () => (staff || !state.data ? Promise.resolve({ items: [] }) : client.get<{ items: { userId: string; status: string; user: { name: string } }[] }>(`/api/owner/properties/${state.data.propertyId}/staff`)),
    [state.data?.propertyId, staff],
  );
  const [message, setMessage] = useState('');
  const [newStatus, setNewStatus] = useState('');
  const refresh = () => { state.reload(); onChanged(); };
  const update = useAction(async () => {
    await client.post(`/api/owner/complaints/${id}/updates`, { message, status: newStatus || undefined });
    setMessage('');
    setNewStatus('');
    toast('Update sent to the tenant');
    refresh();
  });
  const close = useAction(async () => {
    await client.post(`/api/owner/complaints/${id}/close`, { note: message });
    setMessage('');
    toast('Complaint closed');
    refresh();
  });
  const assign = useAction(async (staffUserId: string) => {
    await client.post(`/api/owner/complaints/${id}/assign`, { staffUserId: staffUserId || null });
    toast('Assignment updated');
    refresh();
  });
  return (
    <Modal open onClose={onClose} title="Complaint">
      <Async state={state}>
        {(c) => (
          <div className="stack">
            <div className="row between">
              <b>{titleCase(c.category)} · Room {c.tenancy.bed.room.name}-{c.tenancy.bed.label}</b>
              <StatusBadge status={c.status} />
            </div>
            <p style={{ margin: 0 }}>{c.description}</p>
            <div className="faint">Raised by {c.raisedBy.name} · {formatDateTime(c.createdAt)}</div>
            {c.photos.length > 0 && (
              <div className="row">{c.photos.map((p, i) => <Button key={p.id} small variant="secondary" onClick={() => void openFile(client, p.id)}>Photo {i + 1}</Button>)}</div>
            )}
            {!staff && c.status !== 'CLOSED' && (
              <Field label="Assigned to">
                <Select value={c.assignedTo?.id ?? ''} onChange={(e) => void assign.run(e.target.value)}>
                  <option value="">Nobody</option>
                  {staffList.data?.items.filter((s) => s.status === 'ACTIVE').map((s) => <option key={s.userId} value={s.userId}>{s.user.name}</option>)}
                </Select>
              </Field>
            )}
            {c.updates.length > 0 && (
              <ul className="timeline">
                {c.updates.map((u) => (
                  <li key={u.id}>
                    <div>{u.message} {u.toStatus && <StatusBadge status={u.toStatus} />}</div>
                    <div className="faint">{formatDateTime(u.createdAt)}</div>
                  </li>
                ))}
              </ul>
            )}
            {c.status !== 'CLOSED' ? (
              <>
                <Field label="Update or closing note"><TextArea value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Electrician will come at 5 pm" /></Field>
                <Field label="Change status (optional)">
                  <Select value={newStatus} onChange={(e) => setNewStatus(e.target.value)}>
                    <option value="">Keep as {c.status.toLowerCase().replace('_', ' ')}</option>
                    <option value="IN_PROGRESS">In progress</option>
                    <option value="RESOLVED">Resolved</option>
                    <option value="OPEN">Re-open</option>
                  </Select>
                </Field>
                <Alert>{update.error || close.error || assign.error}</Alert>
                <div className="row">
                  <Button busy={update.busy} disabled={message.trim().length < 2} onClick={() => void update.run()}>Send update</Button>
                  {!staff && <Button variant="secondary" busy={close.busy} disabled={message.trim().length < 2} onClick={() => void close.run()}>Close with note</Button>}
                </div>
              </>
            ) : (
              <Alert tone="ok">Closed: {c.closingNote}</Alert>
            )}
          </div>
        )}
      </Async>
    </Modal>
  );
}
