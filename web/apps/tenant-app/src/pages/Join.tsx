import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Alert, Async, Button, Card, EmptyState, Field, formatINR, Input, Modal, Money, PageHead, toast, todayIST, useAction, useApi, useAsync } from 'pg-core';

interface Pg {
  id: string;
  name: string;
  address: string;
  tokenAmountPaise: number;
  reservationHoldHours: number;
  payByUpi?: boolean;
  minNoticeDays: number;
  rooms: { id: string; name: string; floor: number; sharingType: number; rentPaise: number; depositPaise: number; beds: { id: string; label: string; available: boolean }[] }[];
}

export function JoinPage() {
  const { code: initial } = useParams();
  const nav = useNavigate();
  const [code, setCode] = useState(initial ?? '');
  const [active, setActive] = useState(initial ?? '');
  return (
    <>
      <PageHead title="Find your bed" sub="Enter the code your PG owner gave you." />
      <form className="row" style={{ marginBottom: 16 }} onSubmit={(e) => { e.preventDefault(); setActive(code.trim().toUpperCase()); nav(`/join/${code.trim().toUpperCase()}`, { replace: true }); }}>
        <Input style={{ flex: 1, textTransform: 'uppercase', fontFamily: 'var(--font-mono)', letterSpacing: '.15em' }} placeholder="SUNRISE1" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} aria-label="Invite code" />
        <Button type="submit">Open</Button>
      </form>
      {active && <PgBeds code={active} />}
    </>
  );
}

function PgBeds({ code }: { code: string }) {
  const client = useApi();
  const state = useAsync(() => client.get<Pg>(`/api/tenant/pg/${encodeURIComponent(code)}`), [code]);
  const [pick, setPick] = useState<{ room: Pg['rooms'][number]; bed: { id: string; label: string } } | null>(null);
  return (
    <Async state={state}>
      {(pg) => {
        const free = pg.rooms.filter((r) => r.beds.some((b) => b.available));
        return (
          <div className="stack reveal">
            <Card ledger>
              <h2>{pg.name}</h2>
              <p className="muted" style={{ margin: '4px 0 0' }}>{pg.address}</p>
              <p className="faint">Booking token {formatINR(pg.tokenAmountPaise)} (adjusted in your deposit) · {pg.minNoticeDays} days’ notice to leave</p>
            </Card>
            {free.length === 0 && <Card><EmptyState title="No free beds right now" glyph="▦">Check back later or ask the owner.</EmptyState></Card>}
            {free.map((r) => (
              <Card key={r.id} className="room-card">
                <div className="row between">
                  <div>
                    <div className="room-name">Room {r.name}</div>
                    <div className="faint">{r.sharingType === 1 ? 'Single' : `${r.sharingType}-sharing`} · floor {r.floor}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <Money paise={r.rentPaise} /> <span className="faint">/month</span>
                    <div className="faint">Deposit {formatINR(r.depositPaise)}</div>
                  </div>
                </div>
                <div className="beds">
                  {r.beds.map((b) => (
                    <button key={b.id} disabled={!b.available} className={`bed ${b.available ? 'vacant' : 'occupied'}`} onClick={() => setPick({ room: r, bed: b })} aria-label={`Bed ${b.label} ${b.available ? 'available' : 'taken'}`}>
                      <span className="lbl">{b.label}</span>
                      <span className="who">{b.available ? 'Free' : 'Taken'}</span>
                    </button>
                  ))}
                </div>
              </Card>
            ))}
            {pick && <ReserveModal pg={pg} room={pick.room} bed={pick.bed} onClose={() => setPick(null)} />}
          </div>
        );
      }}
    </Async>
  );
}

function ReserveModal({ pg, room, bed, onClose }: { pg: Pg; room: Pg['rooms'][number]; bed: { id: string; label: string }; onClose: () => void }) {
  const client = useApi();
  const nav = useNavigate();
  const [moveIn, setMoveIn] = useState(todayIST());
  const reserve = useAction(async () => {
    if (pg.payByUpi) {
      // Free direct UPI: reserve, then pay the token from the Pay screen.
      await client.post('/api/tenant/bookings', { bedId: bed.id, moveInDate: moveIn });
      toast('Bed reserved — now pay the token by UPI');
      return nav('/dues');
    }
    const win = window.open('', '_blank');
    const r = await client.post<{ payment: { url: string } | null }>('/api/tenant/bookings', { bedId: bed.id, moveInDate: moveIn });
    if (r.payment && win) win.location.href = r.payment.url;
    else win?.close();
    nav('/');
  });
  return (
    <Modal open onClose={onClose} title={`Room ${room.name} · bed ${bed.label}`}>
      <div className="stack">
        <dl className="kv">
          <dt>Monthly rent</dt><dd><Money paise={room.rentPaise} /></dd>
          <dt>Deposit</dt><dd><Money paise={room.depositPaise} /></dd>
          <dt>Token to pay now</dt><dd><Money paise={pg.tokenAmountPaise} /></dd>
        </dl>
        <Field label="Move-in date"><input className="input" type="date" min={todayIST()} max={todayIST(90)} value={moveIn} onChange={(e) => setMoveIn(e.target.value)} /></Field>
        <Alert tone="info">The bed is held for {pg.reservationHoldHours} hours. Pay the token to keep it; the owner then confirms your booking. The token counts towards your deposit.</Alert>
        <Alert>{reserve.error}</Alert>
        <Button block busy={reserve.busy} onClick={() => void reserve.run()}>Reserve & pay {formatINR(pg.tokenAmountPaise)}</Button>
      </div>
    </Modal>
  );
}
