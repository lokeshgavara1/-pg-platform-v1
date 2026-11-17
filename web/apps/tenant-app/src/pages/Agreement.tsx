import { useState } from 'react';
import { Alert, Async, Button, Card, EmptyState, Field, formatDateTime, Input, openFile, PageHead, StatusBadge, toast, useAction, useApi, useAsync } from 'pg-core';

interface Agreement {
  id: string;
  status: 'DRAFT' | 'SIGNED';
  pdfFileId: string;
  signedPdfFileId: string | null;
  signedAt: string | null;
  esignDevOnly: boolean;
}

export function AgreementPage() {
  const client = useApi();
  const state = useAsync(() => client.get<{ agreement: Agreement | null }>('/api/tenant/agreement'), []);
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState('');
  const [read, setRead] = useState(false);
  const request = useAction(async (id: string) => {
    await client.post(`/api/tenant/agreement/${id}/request-otp`);
    setOtpSent(true);
    setOtp('');
  });
  const sign = useAction(async (id: string) => {
    await client.post(`/api/tenant/agreement/${id}/sign`, { otp });
    toast('Agreement signed');
    state.reload();
  });
  return (
    <>
      <PageHead title="Rental agreement" />
      <Async state={state} empty={(d) => (!d.agreement ? <Card><EmptyState title="No agreement yet" glyph="§">Your owner will send it here when it’s ready.</EmptyState></Card> : null)}>
        {({ agreement: a }) => (
          <div className="stack reveal">
            {a!.esignDevOnly && (
              <Alert tone="warn">
                <span className="dev-stamp">Test mode</span> This app is using a development e-sign for testing. The OTP signature is <b>not legally valid</b>.
              </Alert>
            )}
            <Card ledger className="stack">
              <div className="row between"><h3>Your agreement</h3><StatusBadge status={a!.status} /></div>
              <Button variant="secondary" onClick={() => { setRead(true); void openFile(client, a!.signedPdfFileId ?? a!.pdfFileId); }}>Open PDF</Button>
              {a!.status === 'SIGNED' && <p className="muted" style={{ margin: 0 }}>Signed {formatDateTime(a!.signedAt)}.</p>}
            </Card>
            {a!.status === 'DRAFT' && (
              <Card ledger className="stack">
                <h3>Sign with OTP</h3>
                <label className="check"><input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I have read the agreement and accept its terms.</label>
                {!otpSent ? (
                  <Button disabled={!read} busy={request.busy} onClick={() => void request.run(a!.id)}>Send OTP to my phone</Button>
                ) : (
                  <>
                    <Field label="OTP"><Input className="input otp-input" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} autoComplete="one-time-code" /></Field>
                    <Button disabled={otp.length !== 6 || !read} busy={sign.busy} onClick={() => void sign.run(a!.id)}>Sign agreement</Button>
                    <Button variant="ghost" busy={request.busy} onClick={() => void request.run(a!.id)}>Send a new OTP</Button>
                  </>
                )}
                <Alert>{request.error || sign.error}</Alert>
              </Card>
            )}
          </div>
        )}
      </Async>
    </>
  );
}
