import express, { Router } from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';
import { errorHandler, notFoundHandler, requestId } from './lib/http.js';
import { limiters, rateLimitMiddleware } from './lib/rateLimit.js';
import { authenticate, requireRole } from './modules/auth/middleware.js';
import { authRouter } from './modules/auth/routes.js';
import { propertiesRouter } from './modules/properties/routes.js';
import { tenanciesRouter } from './modules/tenancies/routes.js';
import { invoicesRouter } from './modules/invoices/routes.js';
import { dashboardRouter } from './modules/dashboard/routes.js';
import { fakeGatewayRouter, webhooksRouter } from './modules/payments/routes.js';
import { ownerBookingsRouter, tenantBookingsRouter } from './modules/bookings/routes.js';
import { filesApiRouter, signedFilesRouter } from './modules/files/routes.js';
import { ownerKycRouter, tenantKycRouter } from './modules/kyc/routes.js';
import { ownerAgreementsRouter, tenantAgreementsRouter } from './modules/agreements/routes.js';
import { ownerComplaintsRouter, tenantComplaintsRouter } from './modules/complaints/routes.js';
import { ownerNoticesRouter, tenantNoticesRouter } from './modules/notices/routes.js';
import { ownerMoveOutRouter, tenantMoveOutRouter } from './modules/moveout/routes.js';
import { verificationRouter } from './modules/verification/routes.js';
import { tenantRouter } from './modules/tenant/routes.js';
import { notificationsRouter } from './modules/notifications/routes.js';
import { adminRouter } from './modules/admin/routes.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Behind one reverse proxy (Caddy/nginx) in production; needed for per-IP rate limits.
  app.set('trust proxy', 'loopback');

  app.use(requestId);
  app.use((_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    next();
  });
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use(cors({ origin: origins, credentials: false, exposedHeaders: ['x-request-id', 'content-disposition'] }));

  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ ok: true, db: 'up', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  // Raw-body routes must come before express.json().
  app.use('/webhooks', rateLimitMiddleware(limiters.webhookPerIp), webhooksRouter);
  app.use('/fake-gateway', rateLimitMiddleware(limiters.publicPerIp), fakeGatewayRouter);
  app.use('/files', rateLimitMiddleware(limiters.publicPerIp), signedFilesRouter);

  app.use(express.json({ limit: '200kb' }));

  const api = Router();
  api.use('/auth', rateLimitMiddleware(limiters.publicPerIp), authRouter);
  api.use('/files', filesApiRouter);
  api.use('/notifications', authenticate, notificationsRouter);

  const owner = Router();
  owner.use(authenticate, requireRole('OWNER', 'STAFF'));
  for (const r of [
    propertiesRouter,
    tenanciesRouter,
    invoicesRouter,
    dashboardRouter,
    ownerBookingsRouter,
    ownerKycRouter,
    ownerAgreementsRouter,
    ownerComplaintsRouter,
    ownerNoticesRouter,
    ownerMoveOutRouter,
    verificationRouter,
  ])
    owner.use(r);
  api.use('/owner', owner);

  const tenant = Router();
  tenant.use(authenticate, requireRole('TENANT'));
  for (const r of [tenantRouter, tenantBookingsRouter, tenantKycRouter, tenantAgreementsRouter, tenantComplaintsRouter, tenantNoticesRouter, tenantMoveOutRouter]) tenant.use(r);
  api.use('/tenant', tenant);

  api.use('/admin', authenticate, requireRole('ADMIN'), adminRouter);

  app.use('/api', api);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
