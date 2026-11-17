import { randomBytes } from 'node:crypto';
import type { FileObject, FilePurpose, User } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { signedFileUrl, storage, UPLOAD_URL_TTL_SECONDS, VIEW_URL_TTL_SECONDS } from '../../providers/storage.js';

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const IMAGES = ['image/jpeg', 'image/png', 'image/webp'];

export const ALLOWED_TYPES: Record<FilePurpose, string[]> = {
  KYC_ID: [...IMAGES, 'application/pdf'],
  KYC_PHOTO: IMAGES,
  COMPLAINT_PHOTO: IMAGES,
  DEDUCTION_PHOTO: IMAGES,
  AGREEMENT: ['application/pdf'],
  RECEIPT: ['application/pdf'],
};

/** Which roles may upload which purposes through the signed-upload flow. */
const UPLOAD_ROLES: Partial<Record<FilePurpose, User['role'][]>> = {
  KYC_ID: ['TENANT'],
  KYC_PHOTO: ['TENANT'],
  COMPLAINT_PHOTO: ['TENANT'],
  DEDUCTION_PHOTO: ['OWNER'],
};

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

/** Check the file's magic bytes match its declared type (don't trust the client). */
export function sniffMatches(mime: string, data: Buffer): boolean {
  if (mime === 'image/jpeg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mime === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/webp') return data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'application/pdf') return data.subarray(0, 5).toString('ascii') === '%PDF-';
  return false;
}

export async function createUploadUrl(user: User, purpose: FilePurpose, mimeType: string, sizeBytes: number) {
  if (!UPLOAD_ROLES[purpose]?.includes(user.role)) throw forbidden('You cannot upload this kind of file');
  if (!ALLOWED_TYPES[purpose].includes(mimeType)) throw badRequest(`File type not allowed. Use: ${ALLOWED_TYPES[purpose].join(', ')}`);
  if (sizeBytes <= 0 || sizeBytes > MAX_FILE_BYTES) throw badRequest('File must be smaller than 5 MB');
  const key = `${purpose.toLowerCase()}/${user.id}/${randomBytes(12).toString('hex')}.${EXT[mimeType]}`;
  const file = await prisma.fileObject.create({ data: { ownerUserId: user.id, purpose, storageKey: key, mimeType, sizeBytes } });
  await prisma.fileAccessLog.create({ data: { fileId: file.id, userId: user.id, action: 'UPLOAD_URL' } });
  return { fileId: file.id, ...signedFileUrl(file.id, user.id, 'put', UPLOAD_URL_TTL_SECONDS), method: 'PUT', headers: { 'content-type': mimeType } };
}

/** Store a server-generated file (PDFs) directly. */
export async function storeGeneratedFile(ownerUserId: string, purpose: FilePurpose, mimeType: string, data: Buffer) {
  const key = `${purpose.toLowerCase()}/${ownerUserId}/${randomBytes(12).toString('hex')}.${EXT[mimeType] ?? 'bin'}`;
  await storage().put(key, data);
  return prisma.fileObject.create({
    data: { ownerUserId, purpose, storageKey: key, mimeType, sizeBytes: data.length, status: 'UPLOADED' },
  });
}

/**
 * Who may open a file. Owners: KYC of their own tenants/applicants, photos and
 * agreements for their properties. Staff: photos of complaints assigned to them.
 * Tenants: their own files, their agreement, deduction photos on their settlement.
 * Admins: no access to tenant documents.
 */
export async function canAccessFile(user: User, file: FileObject): Promise<boolean> {
  if (user.role === 'ADMIN') return false;
  if (file.ownerUserId === user.id) return true;
  switch (file.purpose) {
    case 'KYC_ID':
    case 'KYC_PHOTO': {
      if (user.role !== 'OWNER') return false;
      const profile = await prisma.tenantProfile.findFirst({ where: { OR: [{ kycIdFileId: file.id }, { kycPhotoFileId: file.id }] } });
      return !!profile && (await ownerCanSeeTenant(user.id, profile.userId));
    }
    case 'COMPLAINT_PHOTO': {
      if (!file.complaintId) return false;
      const c = await prisma.complaint.findUnique({ where: { id: file.complaintId }, include: { property: true } });
      if (!c) return false;
      if (user.role === 'OWNER') return c.property.ownerId === user.id;
      if (user.role === 'STAFF') return c.assignedToId === user.id;
      return false;
    }
    case 'AGREEMENT': {
      const a = await prisma.agreement.findFirst({
        where: { OR: [{ pdfFileId: file.id }, { signedPdfFileId: file.id }] },
        include: { tenancy: { include: { property: true, tenantProfile: true } } },
      });
      if (!a) return false;
      if (user.role === 'OWNER') return a.tenancy.property.ownerId === user.id;
      if (user.role === 'TENANT') return a.tenancy.tenantProfile.userId === user.id;
      return false;
    }
    case 'DEDUCTION_PHOTO': {
      if (user.role !== 'TENANT') return false;
      const d = await prisma.settlementDeduction.findFirst({
        where: { photoFileId: file.id, status: 'ACTIVE' },
        include: { moveOut: { include: { tenancy: { include: { tenantProfile: true } } } } },
      });
      return d?.moveOut.tenancy.tenantProfile.userId === user.id;
    }
    default:
      return false;
  }
}

export async function ownerCanSeeTenant(ownerId: string, tenantUserId: string) {
  const [t, b] = await Promise.all([
    prisma.tenancy.count({ where: { property: { ownerId }, tenantProfile: { userId: tenantUserId } } }),
    prisma.booking.count({ where: { property: { ownerId }, tenantUserId } }),
  ]);
  return t + b > 0;
}

export async function viewUrl(user: User, fileId: string) {
  const file = await prisma.fileObject.findUnique({ where: { id: fileId } });
  if (!file || file.status !== 'UPLOADED' || !(await canAccessFile(user, file))) throw notFound('File');
  await prisma.fileAccessLog.create({ data: { fileId, userId: user.id, action: 'VIEW_URL' } });
  return { ...signedFileUrl(file.id, user.id, 'get', VIEW_URL_TTL_SECONDS), mimeType: file.mimeType };
}

/** Validate that the caller owns uploaded files of the right purpose. */
export async function assertOwnUploadedFiles(userId: string, fileIds: string[], purpose: FilePurpose) {
  if (fileIds.length === 0) return [];
  const files = await prisma.fileObject.findMany({ where: { id: { in: fileIds } } });
  if (files.length !== new Set(fileIds).size) throw badRequest('Unknown file');
  for (const f of files) {
    if (f.ownerUserId !== userId) throw badRequest('Unknown file');
    if (f.purpose !== purpose) throw badRequest(`File has the wrong purpose (expected ${purpose})`);
    if (f.status !== 'UPLOADED') throw badRequest('File upload is not complete');
  }
  return files;
}
