import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, Field, formatDate, Input, Modal, openBlob, PageHead, Select, StatusBadge, toast, useAction, useApi, useAsync } from 'pg-core';
import { useProperty } from '../property';

interface Rec {
  id: string;
  status: 'NOT_STARTED' | 'SUBMITTED' | 'ACKNOWLEDGED';
  reference: string | null;
  notes: string | null;
  submittedAt: string | null;
  tenancy: { id: string; startDate: string; property: { name: string; cityCode: string }; bed: { label: string; room: { name: string } }; tenantProfile: { kycStatus: string; user: { name: string } } };
}

interface City { code: string; name: string; authority: string; verified: boolean; note: string }

export function VerificationPage() {
  const client = useApi();
  const { current } = useProperty();
  const state = useAsync(() => client.get<{ items: Rec[] }>(`/api/owner/verification?propertyId=${current!.id}`), [current?.id]);
  const cities = useAsync(() => client.get<{ items: City[] }>('/api/owner/cities'), []);
  const city = cities.data?.items.find((c) => c.code === current?.cityCode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Rec | null>(null);
  const exp = useAction(async (format: 'csv' | 'pdf') => {
    const tenancyIds = [...selected];
    if (!tenancyIds.length) throw new Error('Select at least one tenant');
    await openBlob(client, 'POST', '/api/owner/verification/export', { tenancyIds, format }, `verification-${current?.cityCode}.${format}`);
  });
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <>
      <PageHead eyebrow={current?.name} title="Police verification" sub="Export tenant details in your city’s format, submit them yourself, then track the status here." />
      {city && (
        <Alert tone={city.verified ? 'info' : 'warn'}>
          <b>{city.name}:</b> {city.authority}. {!city.verified && city.note}
        </Alert>
      )}
      <div className="row" style={{ margin: '12px 0' }}>
        <Button variant="secondary" busy={exp.busy} disabled={!selected.size} onClick={() => void exp.run('csv')}>Export CSV ({selected.size})</Button>
        <Button variant="secondary" busy={exp.busy} disabled={!selected.size} onClick={() => void exp.run('pdf')}>Export PDF</Button>
      </div>
      <Alert>{exp.error}</Alert>
      <Card>
        <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="No current tenants" glyph="✓" /> : null)}>
          {(d) => (
            <>
              <label className="check faint">
                <input type="checkbox" checked={selected.size === d.items.length} onChange={(e) => setSelected(e.target.checked ? new Set(d.items.map((r) => r.tenancy.id)) : new Set())} /> Select all
              </label>
              <ul className="list">
                {d.items.map((r) => (
                  <li key={r.id} className="row" style={{ padding: '8px 0', flexWrap: 'nowrap' }}>
                    <input type="checkbox" style={{ width: 20, height: 20 }} checked={selected.has(r.tenancy.id)} onChange={() => toggle(r.tenancy.id)} aria-label={`Select ${r.tenancy.tenantProfile.user.name}`} />
                    <button className="list-item" onClick={() => setEditing(r)}>
                      <div className="grow">
                        <div className="title">{r.tenancy.tenantProfile.user.name}</div>
                        <div className="meta">Room {r.tenancy.bed.room.name}-{r.tenancy.bed.label} · moved in {formatDate(r.tenancy.startDate)}{r.tenancy.tenantProfile.kycStatus !== 'APPROVED' ? ' · KYC not approved' : ''}</div>
                      </div>
                      <StatusBadge status={r.status} />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Async>
      </Card>
      {editing && <StatusModal rec={editing} onClose={() => setEditing(null)} onSaved={state.reload} />}
    </>
  );
}

function StatusModal({ rec, onClose, onSaved }: { rec: Rec; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [status, setStatus] = useState(rec.status);
  const [reference, setReference] = useState(rec.reference ?? '');
  const [notes, setNotes] = useState(rec.notes ?? '');
  const save = useAction(async () => {
    await client.patch(`/api/owner/verification/${rec.id}`, { status, reference: reference || undefined, notes: notes || undefined });
    toast('Status updated');
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={rec.tenancy.tenantProfile.user.name}>
      <div className="stack">
        <Field label="Status">
          <Select value={status} onChange={(e) => setStatus(e.target.value as Rec['status'])}>
            <option value="NOT_STARTED">Not started</option>
            <option value="SUBMITTED">Submitted to police</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
          </Select>
        </Field>
        <Field label="Acknowledgement / reference no."><Input value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
        <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <Alert>{save.error}</Alert>
        <Button block busy={save.busy} onClick={() => void save.run()}>Save</Button>
      </div>
    </Modal>
  );
}
