import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, Field, formatDateTime, Input, Modal, PageHead, Select, TextArea, toast, useAction, useApi, useAsync } from 'pg-core';
import { useProperty } from '../property';
import type { Room } from '../types';

interface Notice {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  room: { name: string } | null;
}

export function NoticesPage() {
  const client = useApi();
  const { current } = useProperty();
  const state = useAsync(() => client.get<{ items: Notice[] }>(`/api/owner/notices?propertyId=${current!.id}`), [current?.id]);
  const [open, setOpen] = useState(false);
  const archive = useAction(async (id: string) => {
    if (!confirm('Remove this notice for tenants?')) return;
    await client.post(`/api/owner/notices/${id}/archive`);
    state.reload();
  });
  return (
    <>
      <PageHead eyebrow={current?.name} title="Notices" actions={<Button onClick={() => setOpen(true)}>+ Post notice</Button>} />
      <Alert>{archive.error}</Alert>
      <Async state={state} empty={(d) => (d.items.length === 0 ? <Card><EmptyState title="No notices" glyph="✉">Tenants see notices in their app and get a notification.</EmptyState></Card> : null)}>
        {(d) => (
          <div className="stack reveal">
            {d.items.map((n) => (
              <Card key={n.id} ledger>
                <div className="row between">
                  <h3>{n.title}</h3>
                  <Button small variant="ghost" onClick={() => void archive.run(n.id)}>Remove</Button>
                </div>
                <p style={{ whiteSpace: 'pre-wrap' }}>{n.body}</p>
                <div className="faint">{n.room ? `Room ${n.room.name}` : 'Everyone'} · {formatDateTime(n.createdAt)}</div>
              </Card>
            ))}
          </div>
        )}
      </Async>
      {open && <NewNotice onClose={() => setOpen(false)} onSaved={state.reload} />}
    </>
  );
}

function NewNotice({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const { current } = useProperty();
  const rooms = useAsync(() => client.get<{ items: Room[] }>(`/api/owner/properties/${current!.id}/rooms`), [current?.id]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [roomId, setRoomId] = useState('');
  const save = useAction(async () => {
    await client.post('/api/owner/notices', { propertyId: current!.id, roomId: roomId || undefined, title, body });
    toast('Notice posted');
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="Post a notice">
      <div className="stack">
        <Field label="To">
          <Select value={roomId} onChange={(e) => setRoomId(e.target.value)}>
            <option value="">Everyone in {current?.name}</option>
            {rooms.data?.items.map((r) => <option key={r.id} value={r.id}>Room {r.name} only</option>)}
          </Select>
        </Field>
        <Field label="Title"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="Message"><TextArea value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <Alert>{save.error}</Alert>
        <Button block busy={save.busy} onClick={() => void save.run()}>Post</Button>
      </div>
    </Modal>
  );
}
