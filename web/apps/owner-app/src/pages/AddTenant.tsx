import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Async, Button, Card, Field, formatINR, Input, MoneyInput, PageHead, Select, todayIST, useAction, useApi, useAsync } from 'pg-core';
import { useProperty } from '../property';
import type { Room } from '../types';

export function AddTenantPage() {
  const client = useApi();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { current } = useProperty();
  const rooms = useAsync(() => client.get<{ items: Room[] }>(`/api/owner/properties/${current!.id}/rooms`), [current?.id]);
  const vacant = useMemo(
    () => (rooms.data?.items ?? []).flatMap((r) => r.beds.filter((b) => b.occupancy?.status === 'VACANT').map((b) => ({ room: r, bed: b }))),
    [rooms.data],
  );

  const [bedId, setBedId] = useState(params.get('bedId') ?? '');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [guardianName, setGuardianName] = useState('');
  const [guardianPhone, setGuardianPhone] = useState('');
  const [joinDate, setJoinDate] = useState(todayIST());
  const [rent, setRent] = useState<number | null>(null);
  const [deposit, setDeposit] = useState<number | null>(null);
  const [collected, setCollected] = useState<number | null>(null);
  const [food, setFood] = useState<number | null>(null);

  // Default rent & deposit from the chosen bed's room.
  useEffect(() => {
    const v = vacant.find((x) => x.bed.id === bedId);
    if (v) {
      setRent(v.room.rentPaise);
      const dep = v.room.rentPaise * (current?.depositMonths ?? 1);
      setDeposit(dep);
      setCollected(dep);
    }
  }, [bedId, vacant, current?.depositMonths]);

  const save = useAction(async () => {
    if (!bedId) throw new Error('Choose a bed');
    if (!rent) throw new Error('Enter the monthly rent');
    const t = await client.post<{ id: string }>('/api/owner/tenants', {
      propertyId: current!.id,
      bedId,
      name: name.trim(),
      phone: phone.replace(/\D/g, '').slice(-10),
      guardianName: guardianName.trim() || undefined,
      guardianPhone: guardianPhone ? guardianPhone.replace(/\D/g, '').slice(-10) : undefined,
      joinDate,
      rentPaise: rent,
      depositPaise: deposit ?? 0,
      depositCollectedPaise: collected ?? 0,
      charges: food ? [{ name: 'Food', amountPaise: food }] : [],
    });
    nav(`/tenancies/${t.id}`, { replace: true });
  });

  return (
    <>
      <PageHead eyebrow={current?.name} title="Add a tenant" sub="For someone already living here or moving in now. They can log in to the tenant app with this phone number." />
      <Async state={rooms}>
        {() =>
          vacant.length === 0 ? (
            <Alert tone="warn">No vacant beds. Add a room or free up a bed first.</Alert>
          ) : (
            <form className="stack reveal" onSubmit={(e) => { e.preventDefault(); void save.run(); }}>
              <Card ledger className="stack">
                <h3>Who</h3>
                <Field label="Full name"><Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} autoComplete="off" /></Field>
                <Field label="Mobile number"><Input inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="98765 43210" required /></Field>
                <div className="grid cols-2">
                  <Field label="Guardian name (optional)"><Input value={guardianName} onChange={(e) => setGuardianName(e.target.value)} /></Field>
                  <Field label="Guardian phone (optional)"><Input inputMode="numeric" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)} /></Field>
                </div>
              </Card>
              <Card ledger className="stack">
                <h3>Where and when</h3>
                <Field label="Bed">
                  <Select value={bedId} onChange={(e) => setBedId(e.target.value)} required>
                    <option value="">Choose a vacant bed…</option>
                    {vacant.map(({ room, bed }) => (
                      <option key={bed.id} value={bed.id}>Room {room.name} · bed {bed.label} · {formatINR(room.rentPaise)}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Join date" hint="For people already living here, rent is billed from this month — older months are not invoiced.">
                  <Input type="date" value={joinDate} onChange={(e) => setJoinDate(e.target.value)} required />
                </Field>
              </Card>
              <Card ledger className="stack">
                <h3>Money</h3>
                <div className="grid cols-2">
                  <Field label="Monthly rent"><MoneyInput value={rent} onChange={setRent} /></Field>
                  <Field label="Food / other monthly charge" hint="Optional"><MoneyInput value={food} onChange={setFood} placeholder="0" /></Field>
                  <Field label="Security deposit"><MoneyInput value={deposit} onChange={setDeposit} /></Field>
                  <Field label="Deposit already received" hint="Anything not yet received becomes a deposit invoice."><MoneyInput value={collected} onChange={setCollected} /></Field>
                </div>
              </Card>
              <Alert>{save.error}</Alert>
              <Button type="submit" block busy={save.busy}>Add tenant</Button>
            </form>
          )
        }
      </Async>
    </>
  );
}
