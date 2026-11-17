import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Async, Button, Card, EmptyState, formatDate, formatDateTime, maskPhone, Money, PageHead, StatusBadge, Tabs, toast, useAction, useApi, useAsync } from 'pg-core';
import { useProperty } from '../property';

interface Booking {
  id: string;
  status: string;
  holdUntil: string;
  moveInDate: string;
  rentPaise: number;
  depositPaise: number;
  tokenAmountPaise: number;
  refundDue: boolean;
  cancelReason: string | null;
  tenancyId: string | null;
  bed: { label: string; room: { name: string } };
  tenantUser: { name: string; phone: string };
}

export function BookingsPage() {
  const client = useApi();
  const nav = useNavigate();
  const { current } = useProperty();
  const [status, setStatus] = useState<'LIVE' | 'CONVERTED' | 'CANCELLED' | 'EXPIRED'>('LIVE');
  const state = useAsync(() => client.get<{ items: Booking[] }>(`/api/owner/bookings?propertyId=${current!.id}&status=${status}`), [current?.id, status]);
  const act = useAction(async (b: Booking, action: 'confirm' | 'cancel' | 'refund-done') => {
    if (action === 'cancel') {
      const reason = prompt('Reason for cancelling (the tenant will see this)');
      if (!reason) return;
      await client.post(`/api/owner/bookings/${b.id}/cancel`, { reason });
      toast('Booking cancelled');
    } else if (action === 'confirm') {
      const t = await client.post<{ id: string }>(`/api/owner/bookings/${b.id}/confirm`);
      toast('Confirmed — tenant added');
      return nav(`/tenancies/${t.id}`);
    } else {
      await client.post(`/api/owner/bookings/${b.id}/refund-done`);
      toast('Refund marked as done');
    }
    state.reload();
  });

  return (
    <>
      <PageHead eyebrow={current?.name} title="Bookings" sub={<>Tenants book with your invite code <b className="mono">{current?.inviteCode}</b>. Unpaid reservations hold a bed for {current?.reservationHoldHours} hours.</>} />
      <Tabs value={status} onChange={setStatus} options={[{ value: 'LIVE', label: 'Waiting' }, { value: 'CONVERTED', label: 'Confirmed' }, { value: 'CANCELLED', label: 'Cancelled' }, { value: 'EXPIRED', label: 'Expired' }]} />
      <Alert>{act.error}</Alert>
      <Async state={state} empty={(d) => (d.items.length === 0 ? <Card><EmptyState title="No bookings" glyph="⌂">Share your invite code so tenants can book a bed and pay the token from their phone.</EmptyState></Card> : null)}>
        {(d) => (
          <div className="stack reveal">
            {d.items.map((b) => (
              <Card key={b.id} ledger>
                <div className="row between">
                  <div>
                    <b>{b.tenantUser.name}</b> <span className="faint mono">{maskPhone(b.tenantUser.phone)}</span>
                    <div className="faint">Room {b.bed.room.name}-{b.bed.label} · moving in {formatDate(b.moveInDate)}</div>
                  </div>
                  <StatusBadge status={b.status} label={b.status === 'PAID' ? 'Token paid' : b.status === 'RESERVED' ? 'Awaiting token' : undefined} />
                </div>
                <dl className="kv" style={{ marginTop: 10 }}>
                  <dt>Token</dt><dd><Money paise={b.tokenAmountPaise} /></dd>
                  <dt>Rent / deposit</dt><dd><Money paise={b.rentPaise} /> / <Money paise={b.depositPaise} /></dd>
                  {b.status === 'RESERVED' && (<><dt>Hold expires</dt><dd>{formatDateTime(b.holdUntil)}</dd></>)}
                  {b.cancelReason && (<><dt>Reason</dt><dd>{b.cancelReason}</dd></>)}
                </dl>
                <div className="row" style={{ marginTop: 12 }}>
                  {b.status === 'PAID' && <Button busy={act.busy} onClick={() => void act.run(b, 'confirm')}>Confirm & add tenant</Button>}
                  {(b.status === 'PAID' || b.status === 'RESERVED') && <Button variant="secondary" busy={act.busy} onClick={() => void act.run(b, 'cancel')}>Cancel</Button>}
                  {b.refundDue && <Button variant="accent" busy={act.busy} onClick={() => void act.run(b, 'refund-done')}>Mark token refunded</Button>}
                  {b.tenancyId && <Button variant="ghost" onClick={() => nav(`/tenancies/${b.tenancyId}`)}>Open tenant ›</Button>}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
    </>
  );
}
