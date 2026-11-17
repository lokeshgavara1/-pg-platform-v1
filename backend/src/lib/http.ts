import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { z, ZodError, type ZodType } from 'zod';
import { AppError, badRequest } from './errors.js';
import { logger, reportError } from './logger.js';
import { Prisma } from '@prisma/client';

/** Validate request parts with zod; throws a 400 with the issues on failure. */
export function parse<T extends ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest(
      'Invalid input',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function paged<T>(items: T[], total: number, page: number, pageSize: number) {
  return { items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const idParam = z.object({ id: z.string().min(1).max(64) });

export const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const paiseSchema = z.number().int().min(0).max(10_000_000_00); // up to ₹1 crore
export const phoneSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .pipe(z.string().regex(/^(\+91)?[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'))
  .transform((s) => (s.startsWith('+91') ? s : `+91${s}`));

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  (req as Request & { id: string }).id = id;
  res.setHeader('x-request-id', id);
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', {
      requestId: id,
      method: req.method,
      // Path only — never the query string (could contain signed tokens).
      path: req.baseUrl + (req.route?.path ?? req.path),
      status: res.statusCode,
      ms: Date.now() - start,
      userId: (req as Request & { user?: { id: string } }).user?.id,
    });
  });
  next();
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid input', details: err.issues } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'This record already exists' } });
    return;
  }
  if ((err as { type?: string })?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' } });
    return;
  }
  reportError(err, { requestId: (req as Request & { id?: string }).id, path: req.path, method: req.method });
  // Never leak internals.
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
