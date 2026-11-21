import { env } from './config/env.js';
import { createApp } from './app.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

const app = createApp();
const server = app.listen(env.PORT, env.HOST, () => {
  logger.info('server_started', { host: env.HOST, port: env.PORT, env: env.NODE_ENV, payments: env.PAYMENT_PROVIDER, sms: env.SMS_PROVIDER });
  if (env.JOBS_ENABLED) startScheduler();
});

async function shutdown(signal: string) {
  logger.info('shutting_down', { signal });
  stopScheduler();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
