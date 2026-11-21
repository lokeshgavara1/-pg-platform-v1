import { useState } from 'react';
import { Alert, Async, Button, Card, Field, Input, PageHead, Select, StatusBadge, toast, uploadFile, useAction, useApi, useAsync } from 'pg-core';

interface Kyc {
  kycStatus: 'NOT_SUBMITTED' | 'PENDING' | 'APPROVED' | 'REJECTED';
  kycRejectReason: string | null;
  idType: string | null;
  idLast4: string | null;
}

const ID_TYPES = [
  { value: 'AADHAAR', label: 'Aadhaar' },
  { value: 'PASSPORT', label: 'Passport' },
  { value: 'DRIVING_LICENCE', label: 'Driving licence' },
  { value: 'VOTER_ID', label: 'Voter ID' },
  { value: 'PAN', label: 'PAN card' },
];

export function KycPage() {
  const client = useApi();
  const state = useAsync(() => client.get<Kyc>('/api/tenant/kyc'), []);
  return (
    <>
      <PageHead title="My ID & details" sub="Your PG keeps a copy of your ID on file. Documents are stored privately and only your owner can open them." />
      <Async state={state}>
        {(k) => (
          <div className="stack reveal">
            <Card ledger>
              <div className="row between"><h3>Status</h3><StatusBadge status={k.kycStatus} /></div>
              {k.kycStatus === 'PENDING' && <p className="muted">Submitted — your owner will review it soon.</p>}
              {k.kycStatus === 'APPROVED' && <p className="muted">Verified{k.idType ? ` · ${k.idType.replace('_', ' ')}` : ''}{k.idLast4 ? ` ending ${k.idLast4}` : ''}.</p>}
              {k.kycStatus === 'REJECTED' && <Alert tone="warn">Not accepted: {k.kycRejectReason}. Please upload again.</Alert>}
            </Card>
            {(k.kycStatus === 'NOT_SUBMITTED' || k.kycStatus === 'REJECTED') && <UploadForm onDone={state.reload} />}
            <ProfileForm />
          </div>
        )}
      </Async>
    </>
  );
}

function FilePick({ label, hint, accept, file, onFile }: { label: string; hint: string; accept: string; file: File | null; onFile: (f: File | null) => void }) {
  return (
    <Field label={label} hint={hint}>
      <label className="btn secondary block" style={{ justifyContent: 'flex-start' }}>
        <span aria-hidden>{file ? '✓' : '📷'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{file ? file.name : 'Take photo or choose file'}</span>
        <input type="file" accept={accept} capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      </label>
    </Field>
  );
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const client = useApi();
  const [idType, setIdType] = useState('AADHAAR');
  const [last4, setLast4] = useState('');
  const [idFile, setIdFile] = useState<File | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const submit = useAction(async () => {
    if (!idFile || !photo) throw new Error('Add both your ID and a photo of yourself');
    if (last4 && !/^[0-9A-Za-z]{4}$/.test(last4)) throw new Error('Enter only the last 4 characters of your ID number');
    const [idFileId, photoFileId] = await Promise.all([uploadFile(client, 'KYC_ID', idFile), uploadFile(client, 'KYC_PHOTO', photo)]);
    await client.post('/api/tenant/kyc/submit', { idType, idLast4: last4 || undefined, idFileId, photoFileId });
    toast('Submitted for review');
    onDone();
  });
  return (
    <Card ledger className="stack">
      <h3>Upload documents</h3>
      <Field label="ID type">
        <Select value={idType} onChange={(e) => setIdType(e.target.value)}>
          {ID_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
        </Select>
      </Field>
      <Field label="Last 4 digits of the ID number (optional)" hint="We never store your full ID number.">
        <Input className="input mono" maxLength={4} value={last4} onChange={(e) => setLast4(e.target.value.toUpperCase())} placeholder="1234" />
      </Field>
      <FilePick label="ID document" hint="Clear photo or PDF, under 5 MB. Photos are compressed before upload." accept="image/jpeg,image/png,image/webp,application/pdf" file={idFile} onFile={setIdFile} />
      <FilePick label="Your photo" hint="A clear photo of your face." accept="image/jpeg,image/png,image/webp" file={photo} onFile={setPhoto} />
      <Alert>{submit.error}</Alert>
      <Button block busy={submit.busy} onClick={() => void submit.run()}>Submit for review</Button>
    </Card>
  );
}

interface Profile { guardianName: string | null; guardianPhone: string | null; fatherName: string | null; permanentAddress: string | null; occupation: string | null; workplace: string | null }

function ProfileForm() {
  const client = useApi();
  const state = useAsync(() => client.get<Profile>('/api/tenant/profile'), []);
  return (
    <Async state={state}>
      {(p) => <ProfileFields initial={p} />}
    </Async>
  );
}

function ProfileFields({ initial }: { initial: Profile }) {
    const client = useApi();
    const [f, setF] = useState({
      fatherName: initial.fatherName ?? '',
      permanentAddress: initial.permanentAddress ?? '',
      occupation: initial.occupation ?? '',
      workplace: initial.workplace ?? '',
      guardianName: initial.guardianName ?? '',
      guardianPhone: initial.guardianPhone?.replace(/^\+91/, '') ?? '',
    });
    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
    const save = useAction(async () => {
      const body: Record<string, string> = {};
      for (const [k, v] of Object.entries(f)) if (v.trim()) body[k] = k === 'guardianPhone' ? v.replace(/\D/g, '').slice(-10) : v.trim();
      await client.patch('/api/tenant/profile', body);
      toast('Details saved');
    });
    return (
      <Card ledger className="stack">
        <h3>About me (optional)</h3>
        <Field label="Father’s name"><Input value={f.fatherName} onChange={set('fatherName')} /></Field>
        <Field label="Permanent (home) address"><Input value={f.permanentAddress} onChange={set('permanentAddress')} /></Field>
        <div className="grid cols-2">
          <Field label="Occupation"><Input value={f.occupation} onChange={set('occupation')} placeholder="Student / Engineer" /></Field>
          <Field label="College / company"><Input value={f.workplace} onChange={set('workplace')} /></Field>
          <Field label="Emergency contact name"><Input value={f.guardianName} onChange={set('guardianName')} /></Field>
          <Field label="Emergency contact phone"><Input inputMode="numeric" value={f.guardianPhone} onChange={set('guardianPhone')} /></Field>
        </div>
        <Alert>{save.error}</Alert>
        <Button variant="secondary" busy={save.busy} onClick={() => void save.run()}>Save details</Button>
      </Card>
    );
}
