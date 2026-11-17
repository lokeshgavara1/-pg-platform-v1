import { beforeEach, describe, expect, it } from 'vitest';
import { addTenant, api, JPEG_BYTES, makeUser, ownerWithProperty, PNG_BYTES, resetDb, uploadFile } from '../helpers.js';
import { prisma } from '../../src/lib/prisma.js';
import { signFileToken } from '../../src/providers/storage.js';

describe('KYC upload and review', () => {
  beforeEach(resetDb);

  async function submittedTenant() {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenant, tenancy } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const idFileId = await uploadFile(tenant, 'KYC_ID', JPEG_BYTES, 'image/jpeg');
    const photoFileId = await uploadFile(tenant, 'KYC_PHOTO');
    await api().post('/api/tenant/kyc/submit').set(tenant.auth).send({ idType: 'AADHAAR', idLast4: '1234', idFileId, photoFileId }).expect(200);
    const profile = await prisma.tenantProfile.findUniqueOrThrow({ where: { userId: tenant.user.id } });
    return { owner, tenant, tenancy, profile, idFileId, photoFileId };
  }

  it('enforces file type, size and content', async () => {
    const tenant = await makeUser('TENANT');
    await api().post('/api/files/upload-url').set(tenant.auth).send({ purpose: 'KYC_PHOTO', mimeType: 'application/pdf', sizeBytes: 100 }).expect(400);
    await api().post('/api/files/upload-url').set(tenant.auth).send({ purpose: 'KYC_ID', mimeType: 'image/gif', sizeBytes: 100 }).expect(400);
    await api().post('/api/files/upload-url').set(tenant.auth).send({ purpose: 'KYC_ID', mimeType: 'image/png', sizeBytes: 6 * 1024 * 1024 }).expect(400);
    const r = await api().post('/api/files/upload-url').set(tenant.auth).send({ purpose: 'KYC_ID', mimeType: 'image/png', sizeBytes: 100 }).expect(201);
    // Declared PNG but the bytes are not a PNG.
    await api().put(new URL(r.body.url).pathname).set('content-type', 'image/png').send(Buffer.from('<script>alert(1)</script>')).expect(400);
    // Owners cannot upload tenant KYC.
    const owner = await makeUser('OWNER');
    await api().post('/api/files/upload-url').set(owner.auth).send({ purpose: 'KYC_ID', mimeType: 'image/png', sizeBytes: 100 }).expect(403);
  });

  it('stores only the last 4 digits and never the full ID number', async () => {
    const tenant = await makeUser('TENANT');
    const idFileId = await uploadFile(tenant, 'KYC_ID');
    const photoFileId = await uploadFile(tenant, 'KYC_PHOTO');
    await api().post('/api/tenant/kyc/submit').set(tenant.auth).send({ idType: 'AADHAAR', idLast4: '123456789012', idFileId, photoFileId }).expect(400);
    await api().post('/api/tenant/kyc/submit').set(tenant.auth).send({ idType: 'AADHAAR', idNumber: '123456789012', idFileId, photoFileId }).expect(200);
    const p = await prisma.tenantProfile.findUniqueOrThrow({ where: { userId: tenant.user.id } });
    expect(JSON.stringify(p)).not.toContain('123456789012');
  });

  it('owner approves with an audit row; tenant sees the status', async () => {
    const { owner, tenant, profile } = await submittedTenant();
    expect(profile.kycStatus).toBe('PENDING');
    const list = await api().get('/api/owner/kyc?status=PENDING').set(owner.auth).expect(200);
    expect(list.body.items).toHaveLength(1);
    await api().post(`/api/owner/kyc/${profile.id}/approve`).set(owner.auth).expect(200);
    const me = await api().get('/api/tenant/kyc').set(tenant.auth).expect(200);
    expect(me.body.kycStatus).toBe('APPROVED');
    const logs = await prisma.auditLog.findMany({ where: { entityId: profile.id }, orderBy: { createdAt: 'asc' } });
    expect(logs.map((l) => l.action)).toEqual(['KYC_SUBMITTED', 'KYC_APPROVED']);
    expect(logs[1].actorId).toBe(owner.user.id);
  });

  it('reject requires a reason and lets the tenant resubmit', async () => {
    const { owner, tenant, profile } = await submittedTenant();
    await api().post(`/api/owner/kyc/${profile.id}/reject`).set(owner.auth).send({}).expect(400);
    await api().post(`/api/owner/kyc/${profile.id}/reject`).set(owner.auth).send({ reason: 'Photo is blurry' }).expect(200);
    const me = await api().get('/api/tenant/kyc').set(tenant.auth).expect(200);
    expect(me.body).toMatchObject({ kycStatus: 'REJECTED', kycRejectReason: 'Photo is blurry' });
    const idFileId = await uploadFile(tenant, 'KYC_ID');
    const photoFileId = await uploadFile(tenant, 'KYC_PHOTO');
    await api().post('/api/tenant/kyc/submit').set(tenant.auth).send({ idType: 'PASSPORT', idFileId, photoFileId }).expect(200);
  });

  it('another owner cannot review or view the files; admin cannot view KYC files', async () => {
    const { profile, idFileId } = await submittedTenant();
    const other = await makeUser('OWNER');
    await api().post(`/api/owner/kyc/${profile.id}/approve`).set(other.auth).expect(404);
    await api().get(`/api/files/${idFileId}/view-url`).set(other.auth).expect(404);
    const admin = await makeUser('ADMIN');
    await api().get(`/api/files/${idFileId}/view-url`).set(admin.auth).expect(404);
    const otherTenant = await makeUser('TENANT');
    await api().get(`/api/files/${idFileId}/view-url`).set(otherTenant.auth).expect(404);
  });

  it('files open only through short-lived signed URLs and every access is logged', async () => {
    const { owner, idFileId } = await submittedTenant();
    const v = await api().get(`/api/files/${idFileId}/view-url`).set(owner.auth).expect(200);
    expect(new Date(v.body.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    const file = await api().get(new URL(v.body.url).pathname).expect(200);
    expect(file.headers['cache-control']).toContain('no-store');
    expect(Buffer.from(file.body).subarray(0, 3)).toEqual(JPEG_BYTES.subarray(0, 3));
    const logs = await prisma.fileAccessLog.findMany({ where: { fileId: idFileId } });
    expect(logs.map((l) => l.action).sort()).toEqual(['DOWNLOADED', 'UPLOADED', 'UPLOAD_URL', 'VIEW_URL']);

    // Expired and upload-only tokens do not open the file.
    const expired = signFileToken({ f: idFileId, a: 'get', u: owner.user.id, e: Math.floor(Date.now() / 1000) - 1 });
    const r = await api().get(`/files/${expired}`).expect(403);
    expect(r.body.error.code).toBe('URL_EXPIRED');
    const putTok = signFileToken({ f: idFileId, a: 'put', u: owner.user.id, e: Math.floor(Date.now() / 1000) + 60 });
    await api().get(`/files/${putTok}`).expect(403);
    // A used upload URL cannot overwrite the file.
    await api().put(`/files/${putTok}`).set('content-type', 'image/png').send(PNG_BYTES).expect(400);
  });

  it('a tenant cannot submit someone else’s files', async () => {
    const a = await makeUser('TENANT');
    const b = await makeUser('TENANT');
    const idFileId = await uploadFile(a, 'KYC_ID');
    const photoFileId = await uploadFile(a, 'KYC_PHOTO');
    await api().post('/api/tenant/kyc/submit').set(b.auth).send({ idType: 'AADHAAR', idFileId, photoFileId }).expect(400);
  });
});

describe('agreement and dev e-sign', () => {
  beforeEach(resetDb);

  it('generates a PDF, signs with OTP, marks it as test-only, and shows it in both apps', async () => {
    const { owner, property, rooms } = await ownerWithProperty();
    const { tenancy, tenant } = await addTenant(owner, property.id, rooms[0].beds[0].id);
    const a = await api().post(`/api/owner/tenancies/${tenancy.id}/agreement`).set(owner.auth).expect(201);
    expect(a.body).toMatchObject({ status: 'DRAFT', esignDevOnly: true });
    const view = await api().get(`/api/files/${a.body.pdfFileId}/view-url`).set(tenant.auth).expect(200);
    const pdf = await api().get(new URL(view.body.url).pathname).expect(200);
    expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');

    const { ConsoleSmsProvider } = await import('../../src/providers/sms.js');
    await api().post(`/api/tenant/agreement/${a.body.id}/request-otp`).set(tenant.auth).expect(200);
    const otp = ConsoleSmsProvider.lastCodes.get(tenant.user.phone)!;
    const wrong = otp === '000000' ? '111111' : '000000';
    await api().post(`/api/tenant/agreement/${a.body.id}/sign`).set(tenant.auth).send({ otp: wrong }).expect(400);
    // The wrong guess burned the code.
    await api().post(`/api/tenant/agreement/${a.body.id}/sign`).set(tenant.auth).send({ otp }).expect(400);
    await api().post(`/api/tenant/agreement/${a.body.id}/request-otp`).set(tenant.auth).expect(200);
    const otp2 = ConsoleSmsProvider.lastCodes.get(tenant.user.phone)!;
    const signed = await api().post(`/api/tenant/agreement/${a.body.id}/sign`).set(tenant.auth).send({ otp: otp2 }).expect(200);
    expect(signed.body).toMatchObject({ status: 'SIGNED', esignDevOnly: true });
    expect(signed.body.signOtpHash).toBeUndefined();
    await api().get(`/api/files/${signed.body.signedPdfFileId}/view-url`).set(owner.auth).expect(200);
    const stranger = await makeUser('OWNER');
    await api().get(`/api/files/${signed.body.signedPdfFileId}/view-url`).set(stranger.auth).expect(404);
  });
});
