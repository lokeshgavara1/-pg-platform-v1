import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, Field, formatDateTime, Modal, PageHead, Select, StatusBadge, TextArea, titleCase, toast, uploadFile, useAction, useApi, useAsync } from 'pg-core';

const CATEGORIES = ['ELECTRICAL', 'PLUMBING', 'CLEANING', 'FOOD', 'WIFI', 'FURNITURE', 'SECURITY', 'NOISE', 'OTHER'];

interface Complaint {
  id: string;
  category: string;
  description: string;
  status: string;
  closingNote: string | null;
  createdAt: string;
  updates: { id: string; message: string; toStatus: string | null; createdAt: string }[];
  photos: { id: string }[];
}

export function ComplaintsPage() {
  const client = useApi();
  const state = useAsync(() => client.get<{ items: Complaint[] }>('/api/tenant/complaints'), []);
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<Complaint | null>(null);
  return (
    <>
      <PageHead title="Help & complaints" actions={<Button onClick={() => setCreating(true)}>+ New complaint</Button>} />
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="No complaints" glyph="⚑">Something broken? Raise a complaint and track it here.</EmptyState> : null)}>
          {(d) => (
            <ul className="list">
              {d.items.map((c) => (
                <li key={c.id}>
                  <button className="list-item" onClick={() => setOpen(c)}>
                    <div className="grow">
                      <div className="title">{titleCase(c.category)}</div>
                      <div className="meta">{c.description.slice(0, 60)} · {formatDateTime(c.createdAt)}</div>
                    </div>
                    <StatusBadge status={c.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
      {creating && <NewComplaint onClose={() => setCreating(false)} onSaved={state.reload} />}
      {open && (
        <Modal open onClose={() => setOpen(null)} title={titleCase(open.category)}>
          <div className="stack">
            <StatusBadge status={open.status} />
            <p style={{ margin: 0 }}>{open.description}</p>
            <ul className="timeline">
              <li><div>Raised</div><div className="faint">{formatDateTime(open.createdAt)}</div></li>
              {open.updates.map((u) => (
                <li key={u.id}><div>{u.message} {u.toStatus && <StatusBadge status={u.toStatus} />}</div><div className="faint">{formatDateTime(u.createdAt)}</div></li>
              ))}
            </ul>
          </div>
        </Modal>
      )}
    </>
  );
}

function NewComplaint({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [category, setCategory] = useState('ELECTRICAL');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<File[]>([]);
  const save = useAction(async () => {
    if (description.trim().length < 5) throw new Error('Describe the problem in a few words');
    const photoFileIds = await Promise.all(photos.map((p) => uploadFile(client, 'COMPLAINT_PHOTO', p)));
    await client.post('/api/tenant/complaints', { category, description: description.trim(), photoFileIds });
    toast('Complaint sent to your owner');
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title="New complaint">
      <div className="stack">
        <Field label="What’s it about?">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
          </Select>
        </Field>
        <Field label="Describe the problem"><TextArea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Fan in my room is not working since yesterday" /></Field>
        <Field label={`Photos (${photos.length}/3)`} hint="Optional — up to 3">
          <label className="btn secondary block">
            📷 Add photo
            <input type="file" accept="image/*" capture="environment" hidden disabled={photos.length >= 3} onChange={(e) => { const f = e.target.files?.[0]; if (f) setPhotos([...photos, f].slice(0, 3)); e.target.value = ''; }} />
          </label>
        </Field>
        {photos.length > 0 && (
          <div className="row">{photos.map((p, i) => <button key={i} className="badge" onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>{p.name.slice(0, 16)} ✕</button>)}</div>
        )}
        <Alert>{save.error}</Alert>
        <Button block busy={save.busy} onClick={() => void save.run()}>Send complaint</Button>
      </div>
    </Modal>
  );
}
