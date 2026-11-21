/**
 * In-process job scheduler (replaces BullMQ/Redis for this single-instance deployment).
 * Runs every hour; every job is idempotent, so restarts, overlaps and catch-up runs are safe.
 */
import { logger } from '../lib/logger.js';
import { expireStaleReservations } from '../modules/beds/status.js';
import { runInvoiceGeneration } from '../modules/invoices/engine.js';
import { prisma } from '../lib/prisma.js';
import { runRentReminders } from './reminders.js';

export async function runAllJobs(now = new Date()) {
  const results: Record<string, unknown> = {};
  const jobs: [string, () => Promise<unknown>][] = [
    ['expireReservations', () => expireStaleReservations(prisma, now)],
    ['generateInvoices', () => runInvoiceGeneration()],
    ['rentReminders', () => runRentReminders(now)],
  ];
  for (const [name, fn] of jobs) {
    try {
      results[name] = await fn();
    } catch (err) {
      results[name] = { error: true };
      logger.error('job_failed', { job: name, error: String(err) });
    }
  }
  logger.info('jobs_ran', results);
  return results;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startScheduler(intervalMs = 60 * 60 * 1000) {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runAllJobs();
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 5000); // shortly after boot
  // Reservation holds are short, so expire them more often than the hourly jobs.
  timer = setInterval(tick, intervalMs);
  const fast = setInterval(() => expireStaleReservations(prisma).catch(() => undefined), 5 * 60 * 1000);
  fast.unref();
  timer.unref();
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
}
