import { useState } from 'react';
import { Alert, Async, Button, Card, Field, Input, maskPhone, MoneyInput, PageHead, Select, StatusBadge, toast, useAction, useApi, useAsync } from 'pg-core';
import { useProperty } from '../property';
import type { Property } from '../types';

export function PropertyForm({ property, onSaved }: { property?: Property; onSaved: () => void }) {
  const client = useApi();
  const [f, setF] = useState({
    name: property?.name ?? '',
    address: property?.address ?? '',
    city: property?.city ?? '',
    rentDueDay: String(property?.rentDueDay ?? 5),
    minNoticeDays: String(property?.minNoticeDays ?? 30),
    reservationHoldHours: String(property?.reservationHoldHours ?? 24),
    depositMonths: String(property?.depositMonths ?? 1),
    remindersEnabled: property?.remindersEnabled ?? true,
  });
  const [token, setToken] = useState<number | null>(property?.tokenAmountPaise ?? 200000);
  const [upiId, setUpiId] = useState(property?.upiId ?? '');
  const [upiPayeeName, setUpiPayeeName] = useState(property?.upiPayeeName ?? '');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(async () => {
    const body = {
      name: f.name.trim(),
      address: f.address.trim(),
      city: f.city.trim(),
      rentDueDay: Number(f.rentDueDay),
      minNoticeDays: Number(f.minNoticeDays),
      reservationHoldHours: Number(f.reservationHoldHours),
      depositMonths: Number(f.depositMonths),
      remindersEnabled: f.remindersEnabled,
      tokenAmountPaise: token ?? 0,
      upiId: upiId.trim() ? upiId.trim().toLowerCase() : null,
      upiPayeeName: upiPayeeName.trim() || null,
    };
    if (property) await client.patch(`/api/owner/properties/${property.id}`, body);
    else await client.post('/api/owner/properties', body);
    toast(property ? 'Settings saved' : 'Property created — now add rooms');
    onSaved();
  });
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
      <Card ledger className="stack">
        <h3>The building</h3>
        <Field label="PG name"><Input value={f.name} onChange={set('name')} placeholder="Sunrise PG for Men" required /></Field>
        <Field label="Address"><Input value={f.address} onChange={set('address')} required /></Field>
        <Field label="City"><Input value={f.city} onChange={set('city')} placeholder="Bengaluru" required minLength={2} /></Field>
      </Card>
      <Card ledger className="stack">
        <h3>Rent payments by UPI (free)</h3>
        <p className="muted" style={{ margin: 0 }}>
          Tenants pay straight into your UPI account from GPay, PhonePe or Paytm. No fees. They tap “I’ve paid”, and you confirm once you see the money.
        </p>
        <div className="grid cols-2">
          <Field label="Your UPI ID" hint="e.g. yourname@okaxis or 9876543210@ybl — find it in your UPI app’s profile">
            <Input value={upiId} onChange={(e) => setUpiId(e.target.value)} placeholder="yourname@okaxis" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </Field>
          <Field label="Name shown to tenants" hint="As it appears in your UPI app"><Input value={upiPayeeName} onChange={(e) => setUpiPayeeName(e.target.value)} placeholder="Ramesh Kumar" /></Field>
        </div>
        <p className="faint" style={{ margin: 0 }}>
          Tip: a free business UPI ID (PhonePe Business, Paytm for Business or Google Pay for Business) works most reliably for payment links. Every change here is recorded in the audit log.
        </p>
      </Card>
      <Card ledger className="stack">
        <h3>Rules</h3>
        <div className="grid cols-2">
          <Field label="Rent due on day" hint="1–28 of each month"><Input type="number" min={1} max={28} value={f.rentDueDay} onChange={set('rentDueDay')} /></Field>
          <Field label="Notice period (days)"><Input type="number" min={0} max={180} value={f.minNoticeDays} onChange={set('minNoticeDays')} /></Field>
          <Field label="Default deposit (months of rent)"><Input type="number" min={0} max={12} value={f.depositMonths} onChange={set('depositMonths')} /></Field>
          <Field label="Booking token"><MoneyInput value={token} onChange={setToken} /></Field>
          <Field label="Hold unpaid bookings for (hours)"><Input type="number" min={1} max={336} value={f.reservationHoldHours} onChange={set('reservationHoldHours')} /></Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={f.remindersEnabled} onChange={(e) => setF({ ...f, remindersEnabled: e.target.checked })} />
          Send rent reminders to tenants (3 days before, on the due date, 3 days after; never 9 pm–8 am)
        </label>
      </Card>
      <Alert>{save.error}</Alert>
      <Button type="submit" block busy={save.busy}>{property ? 'Save settings' : 'Create property'}</Button>
    </form>
  );
}

export function PropertiesPage() {
  const { current, reload, properties, setCurrentId } = useProperty();
  const [adding, setAdding] = useState(false);
  if (!current) return null;
  return (
    <>
      <PageHead title="Properties & settings" actions={<Button variant="secondary" onClick={() => setAdding(!adding)}>{adding ? 'Cancel' : '+ Another property'}</Button>} />
      {adding ? (
        <PropertyForm onSaved={() => { setAdding(false); reload(); }} />
      ) : (
        <div className="stack">
          {properties.length > 1 && (
            <Select value={current.id} onChange={(e) => setCurrentId(e.target.value)} aria-label="Property">
              {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}
          <InviteCard property={current} onChanged={reload} />
          <PropertyForm key={current.id} property={current} onSaved={reload} />
          <StaffCard propertyId={current.id} />
        </div>
      )}
    </>
  );
}

function InviteCard({ property, onChanged }: { property: Property; onChanged: () => void }) {
  const client = useApi();
  const rotate = useAction(async () => {
    if (!confirm('Create a new code? The old code stops working.')) return;
    await client.post(`/api/owner/properties/${property.id}/invite-code/rotate`);
    onChanged();
  });
  // Set VITE_TENANT_APP_URL at build time on servers; locally the tenant app runs on port 5174.
  const tenantBase = (import.meta.env.VITE_TENANT_APP_URL as string | undefined)?.replace(/\/$/, '') ?? `${location.protocol}//${location.hostname}:5174`;
  const tenantUrl = `${tenantBase}/join/${property.inviteCode}`;
  return (
    <Card ledger>
      <div className="card-head"><h3>Tenant invite code</h3></div>
      <div className="row between">
        <span className="money" style={{ fontSize: 30, letterSpacing: '.12em' }}>{property.inviteCode}</span>
        <div className="row">
          <Button small variant="secondary" onClick={() => { void navigator.clipboard?.writeText(tenantUrl); toast('Booking link copied'); }}>Copy link</Button>
          <Button small variant="ghost" busy={rotate.busy} onClick={() => void rotate.run()}>New code</Button>
        </div>
      </div>
      <p className="faint">Tenants enter this code in the tenant app to see vacant beds and book.</p>
    </Card>
  );
}

function StaffCard({ propertyId }: { propertyId: string }) {
  const client = useApi();
  const state = useAsync(() => client.get<{ items: { userId: string; status: string; user: { name: string; phone: string } }[] }>(`/api/owner/properties/${propertyId}/staff`), [propertyId]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const add = useAction(async () => {
    await client.post(`/api/owner/properties/${propertyId}/staff`, { name, phone: phone.replace(/\D/g, '').slice(-10) });
    setName('');
    setPhone('');
    toast('Staff added — tap “Login link” to send them a sign-in link');
    state.reload();
  });
  const remove = useAction(async (userId: string) => {
    await client.post(`/api/owner/properties/${propertyId}/staff/${userId}/deactivate`);
    state.reload();
  });
  const sendLink = useAction(async (userId: string) => {
    // Open WhatsApp first so the browser doesn't block the new tab.
    const win = window.open('', '_blank');
    const r = await client.post<{ url: string; name: string; phone: string; expiresAt: string }>(`/api/owner/properties/${propertyId}/staff/${userId}/login-link`);
    const text = `Hi ${r.name.split(' ')[0]}, open this link and tap "Continue with Google" to use the PGPAL staff app. It works once and expires on ${r.expiresAt.slice(0, 10)}:\n${r.url}`;
    const wa = `https://wa.me/${r.phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
    if (win) win.location.href = wa;
    else {
      void navigator.clipboard?.writeText(text);
      toast('Message copied — paste it in WhatsApp');
    }
  });
  return (
    <Card ledger className="stack">
      <h3>Staff</h3>
      <p className="faint" style={{ margin: 0 }}>Staff see and update only the complaints you assign to them.</p>
      <Async state={state}>
        {(d) => (
          <ul className="list">
            {d.items.map((s) => (
              <li key={s.userId} className="row between" style={{ padding: '8px 0' }}>
                <span>{s.user.name} <span className="faint mono">{maskPhone(s.user.phone)}</span></span>
                {s.status === 'ACTIVE' ? (
                  <span className="row" style={{ gap: 4 }}>
                    <Button small variant="secondary" busy={sendLink.busy} onClick={() => void sendLink.run(s.userId)}>Login link</Button>
                    <Button small variant="ghost" onClick={() => void remove.run(s.userId)}>Remove</Button>
                  </span>
                ) : (
                  <StatusBadge status="INACTIVE" />
                )}
              </li>
            ))}
          </ul>
        )}
      </Async>
      <div className="grid cols-2">
        <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input placeholder="Mobile number" inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <Alert>{add.error || remove.error || sendLink.error}</Alert>
      <Button variant="secondary" busy={add.busy} onClick={() => void add.run()}>Add staff</Button>
    </Card>
  );
}
