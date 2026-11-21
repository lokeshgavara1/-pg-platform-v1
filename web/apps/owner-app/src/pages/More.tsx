import { Link } from 'react-router-dom';
import { Card, ConnectGoogleCard, PageHead } from 'pg-core';
import { useProperty } from '../property';

const ITEMS = [
  { to: '/bookings', icon: '⌂', title: 'Bookings', sub: 'Reservations from the tenant app — confirm or cancel' },
  { to: '/kyc', icon: '◉', title: 'KYC review', sub: 'Approve or reject ID documents' },
  { to: '/complaints', icon: '⚑', title: 'Complaints', sub: 'Assign to staff, update and close' },
  { to: '/notices', icon: '✉', title: 'Notices', sub: 'Post to the whole PG or one room' },
  { to: '/move-outs', icon: '⇥', title: 'Move-outs', sub: 'Notices, inspection and deposit settlement' },
  { to: '/properties', icon: '⚙', title: 'Properties & settings', sub: 'Rent due day, notice period, reminders, staff, invite code' },
];

export function MorePage() {
  const { current } = useProperty();
  return (
    <>
      <PageHead eyebrow={current?.name} title="More" />
      <Card>
        <ul className="list reveal">
          {ITEMS.map((i) => (
            <li key={i.to}>
              <Link className="list-item" to={i.to}>
                <span className="avatar" style={{ background: 'var(--primary-soft)', color: 'var(--primary)' }} aria-hidden>{i.icon}</span>
                <div className="grow">
                  <div className="title">{i.title}</div>
                  <div className="meta">{i.sub}</div>
                </div>
                <span aria-hidden>›</span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <div style={{ marginTop: 12 }}><ConnectGoogleCard /></div>
    </>
  );
}
