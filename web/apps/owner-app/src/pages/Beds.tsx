import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Async, Button, EmptyState, Field, formatDateTime, Input, Modal, MoneyInput, PageHead, StatusBadge, toast, useAction, useApi, useAsync } from 'pg-core';
import { useProperty } from '../property';
import { BedGrid, BedLegend } from '../components/BedGrid';
import type { Bed, Room } from '../types';

export function BedsPage() {
  const client = useApi();
  const nav = useNavigate();
  const { current } = useProperty();
  const state = useAsync(() => client.get<{ items: Room[] }>(`/api/owner/properties/${current!.id}/rooms`), [current?.id]);
  const [addOpen, setAddOpen] = useState(false);
  const [editRoom, setEditRoom] = useState<Room | null>(null);
  const [picked, setPicked] = useState<{ room: Room; bed: Bed } | null>(null);

  function onBed(room: Room, bed: Bed) {
    const o = bed.occupancy;
    if (o?.tenancyId) return nav(`/tenancies/${o.tenancyId}`);
    setPicked({ room, bed });
  }

  return (
    <>
      <PageHead eyebrow={current?.name} title="Beds" sub={<BedLegend />} actions={<Button onClick={() => setAddOpen(true)}>+ Add room</Button>} />
      <Async state={state} empty={(d) => (d.items.length === 0 ? <EmptyState title="No rooms yet" glyph="▦">Add a room with its sharing type and rent — its beds are created for you.</EmptyState> : null)}>
        {(d) => <BedGrid rooms={d.items} onBed={onBed} onRoom={setEditRoom} />}
      </Async>
      <AddRoomModal open={addOpen} onClose={() => setAddOpen(false)} propertyId={current!.id} onSaved={state.reload} />
      {editRoom && <EditRoomModal room={editRoom} onClose={() => setEditRoom(null)} onSaved={state.reload} />}
      {picked && <BedModal room={picked.room} bed={picked.bed} onClose={() => setPicked(null)} onChanged={state.reload} />}
    </>
  );
}

function AddRoomModal({ open, onClose, propertyId, onSaved }: { open: boolean; onClose: () => void; propertyId: string; onSaved: () => void }) {
  const client = useApi();
  const [name, setName] = useState('');
  const [floor, setFloor] = useState('0');
  const [sharing, setSharing] = useState('2');
  const [rent, setRent] = useState<number | null>(null);
  const save = useAction(async () => {
    if (!name.trim()) throw new Error('Enter a room name or number');
    if (!rent) throw new Error('Enter the monthly rent per bed');
    await client.post(`/api/owner/properties/${propertyId}/rooms`, { name: name.trim(), floor: Number(floor) || 0, sharingType: Number(sharing), rentPaise: rent });
    toast(`Room ${name} added with ${sharing} beds`);
    setName('');
    onSaved();
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title="Add a room">
      <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
        <div className="grid cols-2">
          <Field label="Room name / number"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="101" autoFocus /></Field>
          <Field label="Floor"><Input type="number" inputMode="numeric" value={floor} onChange={(e) => setFloor(e.target.value)} /></Field>
        </div>
        <Field label="Sharing" hint="One bed is created for each person">
          <div className="tabs" style={{ marginBottom: 0 }}>
            {['1', '2', '3', '4', '5', '6'].map((s) => (
              <button type="button" key={s} className={sharing === s ? 'on' : ''} onClick={() => setSharing(s)}>{s === '1' ? 'Single' : `${s}-share`}</button>
            ))}
          </div>
        </Field>
        <Field label="Monthly rent per bed"><MoneyInput value={rent} onChange={setRent} placeholder="8,500" /></Field>
        <Alert>{save.error}</Alert>
        <Button type="submit" block busy={save.busy}>Add room</Button>
      </form>
    </Modal>
  );
}

function EditRoomModal({ room, onClose, onSaved }: { room: Room; onClose: () => void; onSaved: () => void }) {
  const client = useApi();
  const [name, setName] = useState(room.name);
  const [rent, setRent] = useState<number | null>(room.rentPaise);
  const [sharing, setSharing] = useState(String(room.sharingType));
  const save = useAction(async () => {
    await client.patch(`/api/owner/rooms/${room.id}`, { name, rentPaise: rent ?? undefined, sharingType: Number(sharing) });
    toast('Room updated');
    onSaved();
    onClose();
  });
  const deactivate = useAction(async () => {
    if (!confirm(`Deactivate room ${room.name}? It must have no tenants.`)) return;
    await client.post(`/api/owner/rooms/${room.id}/deactivate`);
    toast('Room deactivated');
    onSaved();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={`Room ${room.name}`}>
      <div className="stack">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Default rent per bed" hint="Applies to new tenants. Change a current tenant’s rent on their page."><MoneyInput value={rent} onChange={setRent} /></Field>
        <Field label="Beds in room" hint="To reduce, deactivate a vacant bed instead."><Input type="number" min={1} max={20} value={sharing} onChange={(e) => setSharing(e.target.value)} /></Field>
        <Alert>{save.error || deactivate.error}</Alert>
        <Button block busy={save.busy} onClick={() => void save.run()}>Save</Button>
        <Button block variant="secondary" busy={deactivate.busy} onClick={() => void deactivate.run()}>Deactivate room</Button>
      </div>
    </Modal>
  );
}

function BedModal({ room, bed, onClose, onChanged }: { room: Room; bed: Bed; onClose: () => void; onChanged: () => void }) {
  const client = useApi();
  const nav = useNavigate();
  const st = bed.occupancy?.status ?? 'VACANT';
  const toggle = useAction(async () => {
    await client.post(`/api/owner/beds/${bed.id}/${bed.status === 'ACTIVE' ? 'deactivate' : 'activate'}`);
    onChanged();
    onClose();
  });
  return (
    <Modal open onClose={onClose} title={`Bed ${room.name}-${bed.label}`}>
      <div className="stack">
        <div className="row"><StatusBadge status={st} /></div>
        {st === 'VACANT' && (
          <Button block onClick={() => nav(`/tenants/new?bedId=${bed.id}`)}>Add a tenant to this bed</Button>
        )}
        {st === 'RESERVED' && (
          <>
            <p className="muted" style={{ margin: 0 }}>
              {bed.occupancy?.bookingStatus === 'PAID' ? 'Token paid — waiting for your confirmation.' : `Held until ${formatDateTime(bed.occupancy?.holdUntil ?? null)} unless the token is paid.`}
            </p>
            <Button block variant="secondary" onClick={() => nav('/bookings')}>Open bookings</Button>
          </>
        )}
        {(st === 'VACANT' || st === 'INACTIVE') && (
          <Button block variant="secondary" busy={toggle.busy} onClick={() => void toggle.run()}>
            {bed.status === 'ACTIVE' ? 'Deactivate bed (not rentable)' : 'Make bed rentable again'}
          </Button>
        )}
        <Alert>{toggle.error}</Alert>
      </div>
    </Modal>
  );
}
