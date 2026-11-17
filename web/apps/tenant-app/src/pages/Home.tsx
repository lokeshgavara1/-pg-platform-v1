import { Link, useNavigate } from 'react-router-dom';
import { Alert, Async, Button, Card, formatDate, formatDateTime, formatINR, Money, PageHead, StatusBadge, useApi, useAsync } from 'pg-core';
import type { Home } from '../types';

export function HomePage() {
  const client = useApi();
  const nav = useNavigate();
  const state = useAsync(() => client.get<Home>('/api/tenant/home'), []);
  const notices = useAsync(() => client.get<{ items: { id: string; title: string; body: string; createdAt: string }[] }>('/api/tenant/notices'), []);
  return (
    <Async state={state}>
      {(h) => {
        const first = h.user.name.split(' ')[0];
        if (!h.stay) {
          return (
            <>
              <PageHead eyebrow="Welcome" title={`Hi ${first}`} sub="You’re not linked to a PG yet." />
              <div className="stack reveal">
                {h.booking ? (
                  <Card ledger className="stack">
                    <div className="row between"><h3>Your reservation</h3><StatusBadge status={h.booking.status} label={h.booking.status === 'PAID' ? 'Token paid' : 'Pay token to hold'} /></div>
                    <p style={{ margin: 0 }}>{h.booking.property.name} · Room {h.booking.bed.room.name}, bed {h.booking.bed.label} · moving in {formatDate(h.booking.moveInDate)}</p>
                    {h.booking.status === 'RESERVED' ? (
                      <>
                        <p className="faint" style={{ margin: 0 }}>Held until {formatDateTime(h.booking.holdUntil)}. Pay the token before then to keep the bed.</p>
                        <Button onClick={() => nav('/dues')}>Pay token</Button>
                      </>
                    ) : (
                      <Alert tone="info">Token received. The owner will confirm your booking — you’ll get a notification.</Alert>
                    )}
                  </Card>
                ) : (
                  <Card ledger className="stack">
                    <h3>Have an invite code?</h3>
                    <p className="muted" style={{ margin: 0 }}>Ask your PG owner for their 8-character code to see free beds and book one.</p>
                    <Button onClick={() => nav('/join')}>Enter invite code</Button>
                  </Card>
                )}
                <Card className="stack">
                  <h3>Already living in a PG?</h3>
                  <p className="muted" style={{ margin: 0 }}>Ask your owner to add you with this phone number. Your stay will appear here automatically.</p>
                </Card>
              </div>
            </>
          );
        }
        const s = h.stay;
        return (
          <>
            <PageHead eyebrow={s.propertyName} title={`Hi ${first}`} sub={`Room ${s.room} · bed ${s.bed}`} />
            <div className="stack reveal">
              <div className={`card stat ${h.dues.outstandingPaise > 0 ? 'hero' : ''}`}>
                <div className="label">{h.dues.overduePaise > 0 ? 'Overdue — please pay' : h.dues.outstandingPaise > 0 ? 'Rent due' : 'All paid'}</div>
                <div className="value">{formatINR(h.dues.outstandingPaise)}</div>
                <div className="sub">{h.dues.nextDueDate ? `Due ${formatDate(h.dues.nextDueDate)}` : `Rent is due on day ${s.rentDueDay} each month`}</div>
                {h.dues.outstandingPaise > 0 && (
                  <Button variant="accent" style={{ marginTop: 12 }} onClick={() => nav('/dues')}>Pay by UPI</Button>
                )}
              </div>

              {(h.kycStatus !== 'APPROVED' || h.agreement?.status === 'DRAFT') && (
                <Card ledger>
                  <div className="card-head"><h3>To do</h3></div>
                  <ul className="list">
                    {h.kycStatus !== 'APPROVED' && (
                      <li>
                        <Link className="list-item" to="/kyc">
                          <div className="grow">
                            <div className="title">{h.kycStatus === 'REJECTED' ? 'Re-upload your ID' : h.kycStatus === 'PENDING' ? 'KYC under review' : 'Upload your ID'}</div>
                            <div className="meta">Needed for police verification</div>
                          </div>
                          <StatusBadge status={h.kycStatus} />
                        </Link>
                      </li>
                    )}
                    {h.agreement?.status === 'DRAFT' && (
                      <li>
                        <Link className="list-item" to="/agreement">
                          <div className="grow"><div className="title">Sign your rental agreement</div><div className="meta">Read it, then confirm with an OTP</div></div>
                          <StatusBadge status="DRAFT" label="To sign" />
                        </Link>
                      </li>
                    )}
                  </ul>
                </Card>
              )}

              <Card ledger>
                <div className="card-head"><h3>My stay</h3>{s.status === 'NOTICE' && <StatusBadge status="NOTICE" label="On notice" />}</div>
                <dl className="kv">
                  <dt>Monthly rent</dt><dd><Money paise={s.rentPaise} /></dd>
                  <dt>Deposit held</dt><dd><Money paise={s.depositHeldPaise} /></dd>
                  <dt>Since</dt><dd>{formatDate(s.startDate)}</dd>
                  {s.endDate && (<><dt>Moving out</dt><dd>{formatDate(s.endDate)}</dd></>)}
                </dl>
                <div className="row" style={{ marginTop: 12 }}>
                  <Button small variant="secondary" onClick={() => nav('/agreement')}>Agreement</Button>
                  <Button small variant="secondary" onClick={() => nav('/move-out')}>{s.status === 'NOTICE' ? 'Move-out & deposit' : 'Give notice'}</Button>
                </div>
              </Card>

              {notices.data && notices.data.items.length > 0 && (
                <Card ledger>
                  <div className="card-head"><h3>Latest notice</h3><Link to="/notices" className="faint">All ›</Link></div>
                  <b>{notices.data.items[0].title}</b>
                  <p className="muted" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{notices.data.items[0].body}</p>
                </Card>
              )}
            </div>
          </>
        );
      }}
    </Async>
  );
}
