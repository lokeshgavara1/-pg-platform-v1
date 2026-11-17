import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { idParam, parse } from '../../lib/http.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { storage, verifyFileToken } from '../../providers/storage.js';
import { authenticate, me } from '../auth/middleware.js';
import { createUploadUrl, MAX_FILE_BYTES, sniffMatches, viewUrl } from './service.js';

/** Authenticated: issue signed URLs. Mounted at /api/files. */
export const filesApiRouter = Router();
filesApiRouter.use(authenticate);

filesApiRouter.post('/upload-url', async (req, res) => {
  const input = parse(
    z.object({
      purpose: z.enum(['KYC_ID', 'KYC_PHOTO', 'COMPLAINT_PHOTO', 'DEDUCTION_PHOTO']),
      mimeType: z.string().max(100),
      sizeBytes: z.number().int().positive(),
    }),
    req.body,
  );
  res.status(201).json(await createUploadUrl(me(req), input.purpose, input.mimeType, input.sizeBytes));
});

filesApiRouter.get('/:id/view-url', async (req, res) => {
  const { id } = parse(idParam, req.params);
  res.json(await viewUrl(me(req), id));
});

/** Public, but only reachable with a valid short-lived signed token. Mounted at /files. */
export const signedFilesRouter = Router();

const expired = () => new AppError(403, 'URL_EXPIRED', 'This link is invalid or has expired');

signedFilesRouter.get('/:token', async (req, res) => {
  const p = verifyFileToken(req.params.token);
  if (!p || p.a !== 'get') throw expired();
  const file = await prisma.fileObject.findUnique({ where: { id: p.f } });
  if (!file || file.status !== 'UPLOADED') throw notFound('File');
  const data = await storage().get(file.storageKey);
  await prisma.fileAccessLog.create({ data: { fileId: file.id, userId: p.u, action: 'DOWNLOADED' } });
  res.setHeader('content-type', file.mimeType);
  res.setHeader('cache-control', 'private, no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-disposition', 'inline');
  res.send(data);
});

signedFilesRouter.put('/:token', express.raw({ type: '*/*', limit: MAX_FILE_BYTES }), async (req, res) => {
  const p = verifyFileToken(req.params.token);
  if (!p || p.a !== 'put') throw expired();
  const file = await prisma.fileObject.findUnique({ where: { id: p.f } });
  if (!file) throw notFound('File');
  if (file.status === 'UPLOADED') throw badRequest('This file has already been uploaded');
  const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (data.length === 0) throw badRequest('Empty upload');
  if (data.length > MAX_FILE_BYTES) throw badRequest('File must be smaller than 5 MB');
  if (!sniffMatches(file.mimeType, data)) throw badRequest('File content does not match its type');
  await storage().put(file.storageKey, data);
  await prisma.fileObject.update({ where: { id: file.id }, data: { status: 'UPLOADED', sizeBytes: data.length } });
  await prisma.fileAccessLog.create({ data: { fileId: file.id, userId: p.u, action: 'UPLOADED' } });
  res.json({ ok: true, fileId: file.id });
});
