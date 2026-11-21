import { Alert, Async, Button, Card, EmptyState, formatDate, formatDateTime, formatINR, Money, parseRupees, toast, useAction, useApi, useAsync } from 'pg-core';

interface Reported {
  id: string;
  amountPaise: number;
  upiRef: string | null;
  createdAt: string;
  invoice: {
    id: string;
    number: string;
    kind: string;
    periodStart: string | null;
    totalPaise: number;
    paidPaise: number;
    tenancy: { id: string; tenantProfile: { user: { name: string } }; bed: { label: string; room: { name: string } } } | null;
    booking: { tenantUser: { name: string }; bed: { label: string; room: { name: string } } } | null;
  };
}

/** Direct UPI payments tenants say they made. The owner checks their UPI app, then confirms or rejects. */
export function ReportedPayments({ propertyId, onChanged }: { propertyId: string; onChanged?: () => void }) {
  const client = useApi();
  const state = useAsync(() => client.get<{ items: Reported[] }>(`/api/owner/payments/reported?propertyId=${propertyId}`), [propertyId]);
  const act = useAction(async (p: Reported, action: 'confirm' | 'partial' | 'reject') => {
    if (action === 'reject') {
      const reason = prompt('Why are you rejecting it? (the tenant will see this)', 'Payment not received in my account');
      if (!reason) return;
      await client.post(`/api/owner/payments/${p.id}/reject`, { reason });
      toast('Rejected — the tenant has been told');
    } else {
      let amountPaise: number | undefined;
      if (action === 'partial') {
        const typed = prompt(`How much did you actually receive? (reported ${formatINR(p.amountPaise)})`);
        if (!typed) return;
        const v = parseRupees(typed);
        if (!v) throw new Error('Enter an amount like 4500');
        amountPaise = v;
      }
      await client.post(`/api/owner/payments/${p.id}/confirm`, amountPaise ? { amountPaise } : {});
      toast('Confirmed — receipt sent to the tenant');
    }
    state.reload();
    onChanged?.();
  });

  return (
    <Async state={state} empty={(d) => (d.items.length === 0 ? <Card><EmptyState title="Nothing to confirm" glyph="✓">When a tenant pays your UPI ID and taps “I’ve paid”, it shows up here.</EmptyState></Card> : null)}>
      {(d) => (
        <div className="stack reveal">
          <Alert tone="info">Before confirming, open your UPI app or bank SMS and check that the amount (and reference number, if given) really arrived.</Alert>
          <Alert>{act.error}</Alert>
          {d.items.map((p) => {
            const who = p.invoice.tenancy?.tenantProfile.user.name ?? p.invoice.booking?.tenantUser.name ?? 'Tenant';
            const bed = p.invoice.tenancy?.bed ?? p.invoice.booking?.bed;
            return (
              <Card key={p.id} ledger>
                <div className="row between">
                  <div>
                    <b>{who}</b>
                    <div className="faint">
                      {bed ? `Room ${bed.room.name}-${bed.label} · ` : ''}
                      {p.invoice.kind === 'RENT' ? `Rent ${formatDate(p.invoice.periodStart).slice(2)}` : p.invoice.kind === 'TOKEN' ? 'Booking token' : `${p.invoice.kind.toLowerCase()} invoice`} · reported {formatDateTime(p.createdAt)}
                    </div>
                  </div>
                  <Money paise={p.amountPaise} className="money" />
                </div>
                <div className="faint" style={{ marginTop: 6 }}>
                  UPI reference: {p.upiRef ? <b className="mono">{p.upiRef}</b> : 'not given'}
                </div>
                <div className="row" style={{ marginTop: 12 }}>
                  <Button busy={act.busy} onClick={() => void act.run(p, 'confirm')}>Received {formatINR(p.amountPaise)}</Button>
                  <Button variant="secondary" busy={act.busy} onClick={() => void act.run(p, 'partial')}>Received less</Button>
                  <Button variant="ghost" busy={act.busy} onClick={() => void act.run(p, 'reject')}>Not received</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </Async>
  );
}
