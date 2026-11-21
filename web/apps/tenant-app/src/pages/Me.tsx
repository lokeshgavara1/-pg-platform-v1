import { Link } from 'react-router-dom';
import { Card, ConnectGoogleCard, Initials, maskPhone, PageHead, useAuth } from 'pg-core';

const LINKS = [
  { to: '/kyc', title: 'My ID & details', sub: 'Upload your ID and keep your details up to date' },
  { to: '/agreement', title: 'Rental agreement', sub: 'Read and sign' },
  { to: '/dues', title: 'Payments & receipts', sub: 'Pay rent, download receipts' },
  { to: '/move-out', title: 'Moving out', sub: 'Give notice, deposit settlement' },
  { to: '/join', title: 'Book a bed in a PG', sub: 'Use an invite code' },
];

export function MePage() {
  const { session, logout } = useAuth();
  return (
    <>
      <PageHead title="Me" />
      <Card ledger className="row">
        <Initials name={session?.user.name ?? ''} />
        <div>
          <b>{session?.user.name}</b>
          <div className="faint mono">{maskPhone(session?.user.phone ?? '')}</div>
        </div>
      </Card>
      <div style={{ margin: '12px 0' }}><ConnectGoogleCard /></div>
      <Card>
        <ul className="list">
          {LINKS.map((l) => (
            <li key={l.to}>
              <Link className="list-item" to={l.to}>
                <div className="grow"><div className="title">{l.title}</div><div className="meta">{l.sub}</div></div>
                <span aria-hidden>›</span>
              </Link>
            </li>
          ))}
          <li>
            <button className="list-item danger-text" onClick={() => void logout()}>Log out</button>
          </li>
        </ul>
      </Card>
    </>
  );
}
