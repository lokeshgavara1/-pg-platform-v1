import { randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma, isUniqueViolation } from '../../lib/prisma.js';
import { conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { BRAND_GREEN, drawBrandHeader, pdfMoney, renderPdf, table } from '../../lib/pdf.js';
import { toDateString } from '../../lib/dates.js';
import { payments, FakeGatewayProvider, type PaymentProvider } from '../../providers/payment.js';
import { push } from '../../providers/message.js';
import { applyPaymentToInvoice } from './apply.js';

/** Create a gateway payment link for the invoice's outstanding amount (or part of it). */
export async function createPaymentLink(invoiceId: string, opts: { amountPaise?: number; customerPhone?: string } = {}) {
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { property: true } });
  if (inv.status === 'VOID') throw conflict('This invoice is void');
  const outstanding = inv.totalPaise - inv.paidPaise;
  if (outstanding <= 0) throw conflict('This invoice is already paid');
  const amount = Math.min(opts.amountPaise ?? outstanding, outstanding);
  const payment = await prisma.payment.create({
    data: { invoiceId, amountPaise: amount, method: 'GATEWAY', status: 'CREATED', provider: payments().name },
  });
  const link = await payments().createPaymentLink({
    amountPaise: amount,
    description: `${inv.property.name} — invoice ${inv.number}`,
    reference: payment.id,
    customerPhone: opts.customerPhone,
  });
  await prisma.payment.update({ where: { id: payment.id }, data: { gatewayLinkId: link.linkId, gatewayLinkUrl: link.url } });
  return { paymentId: payment.id, amountPaise: amount, url: link.url };
}

/**
 * Process a gateway webhook. Signature is verified on the raw body first; each event id
 * is stored once (unique), so replaying a webhook changes nothing.
 */
export async function processWebhook(
  provider: PaymentProvider,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const signatureOk = provider.verifyWebhook(rawBody, headers);
  let parsedPayload: Prisma.InputJsonValue = {};
  try {
    parsedPayload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    /* keep {} */
  }
  if (!signatureOk) {
    await prisma.webhookEvent
      .create({
        data: {
          provider: provider.name,
          eventId: `rejected_${randomBytes(8).toString('hex')}`,
          type: 'unknown',
          signatureOk: false,
          status: 'REJECTED',
          error: 'Invalid signature',
          payload: parsedPayload,
        },
      })
      .catch(() => undefined);
    return { status: 400, body: { error: { code: 'BAD_SIGNATURE', message: 'Invalid signature' } } };
  }

  const event = provider.parseWebhook(rawBody);
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.webhookEvent.create({
        data: { provider: provider.name, eventId: event.eventId, type: event.type, signatureOk: true, status: 'PROCESSING', payload: parsedPayload },
      });
      if (event.type === 'other' || !event.linkId) {
        await tx.webhookEvent.update({ where: { provider_eventId: { provider: provider.name, eventId: event.eventId } }, data: { status: 'IGNORED' } });
        return { ignored: true };
      }
      const payment = await tx.payment.findUnique({ where: { gatewayLinkId: event.linkId }, include: { invoice: { include: { booking: true, tenancy: { include: { tenantProfile: true } } } } } });
      if (!payment) {
        await tx.webhookEvent.update({ where: { provider_eventId: { provider: provider.name, eventId: event.eventId } }, data: { status: 'IGNORED', error: 'Unknown payment link' } });
        return { ignored: true };
      }
      if (payment.status === 'SUCCESS') {
        await tx.webhookEvent.update({ where: { provider_eventId: { provider: provider.name, eventId: event.eventId } }, data: { status: 'IGNORED', error: 'Payment already succeeded' } });
        return { ignored: true };
      }
      if (event.type === 'payment.failed') {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED', failureReason: event.failureReason ?? 'Payment failed', gatewayPaymentId: event.gatewayPaymentId } });
        await tx.webhookEvent.update({ where: { provider_eventId: { provider: provider.name, eventId: event.eventId } }, data: { status: 'PROCESSED' } });
        return { failed: true };
      }
      // payment.succeeded — atomically claim the payment so two different success events
      // for the same link cannot both apply money (the row lock serialises them).
      const claim = await tx.payment.updateMany({ where: { id: payment.id, status: { not: 'SUCCESS' } }, data: { status: 'SUCCESS' } });
      if (claim.count !== 1) {
        await tx.webhookEvent.update({ where: { provider_eventId: { provider: provider.name, eventId: event.eventId } }, data: { status: 'IGNORED', error: 'Payment already succeeded' } });
        return { ignored: true };
      }
      // The gateway's amount is the truth (may be partial).
      const amount = event.amountPaise > 0 ? event.amountPaise : payment.amountPaise;
      const { applied, invoiceStatus } = await applyPaymentToInvoice(tx, payment.invoiceId, amount, { actorId: null, strict: false });
      const note = applied < amount ? `Overpaid or invoice void: ${amount - applied} paise not applied — refund needed` : undefined;
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: 'SUCCESS', amountPaise: amount, gatewayPaymentId: event.gatewayPaymentId, receivedAt: new Date(), note },
      });
      if (note && payment.invoice.booking) await tx.booking.update({ where: { id: payment.invoice.booking.id }, data: { refundDue: true } });
      await tx.webhookEvent.update({ where: { provider_eventId: { provider: provider.name, eventId: event.eventId } }, data: { status: 'PROCESSED' } });
      return { applied, invoiceStatus, tenantUserId: payment.invoice.tenancy?.tenantProfile.userId ?? payment.invoice.booking?.tenantUserId };
    });
    if ('tenantUserId' in result && result.tenantUserId) {
      await push({ userId: result.tenantUserId, title: 'Payment received', body: `We received ${pdfMoney(result.applied ?? 0).replace('Rs.', '₹')}. Thank you!` });
    }
    return { status: 200, body: { ok: true, ...result, tenantUserId: undefined } };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 200, body: { ok: true, duplicate: true } };
    logger.error('webhook_processing_failed', { provider: provider.name, eventId: event.eventId, error: String(err) });
    await prisma.webhookEvent
      .upsert({
        where: { provider_eventId: { provider: provider.name, eventId: event.eventId } },
        create: { provider: provider.name, eventId: event.eventId, type: event.type, signatureOk: true, status: 'FAILED', error: String(err).slice(0, 500), payload: parsedPayload },
        update: { status: 'FAILED', error: String(err).slice(0, 500) },
      })
      .catch(() => undefined);
    // 500 tells the gateway to retry later.
    return { status: 500, body: { error: { code: 'INTERNAL', message: 'Webhook processing failed' } } };
  }
}

/** Build and sign a webhook like the fake gateway would. Used by its checkout page and by tests. */
export function buildFakeWebhook(
  linkId: string,
  outcome: 'success' | 'fail',
  amountPaise: number,
  eventId = `evt_fake_${randomBytes(8).toString('hex')}`,
) {
  const body = JSON.stringify({
    id: eventId,
    type: outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
    data: { linkId, paymentId: `pay_fake_${randomBytes(6).toString('hex')}`, amountPaise, failureReason: outcome === 'fail' ? 'Declined by bank (sandbox)' : undefined },
  });
  const raw = Buffer.from(body);
  return { raw, signature: new FakeGatewayProvider().sign(raw) };
}

export async function receiptPdf(paymentId: string): Promise<Buffer> {
  const p = await prisma.payment.findUniqueOrThrow({
    where: { id: paymentId },
    include: {
      invoice: {
        include: {
          property: { include: { owner: true } },
          tenancy: { include: { tenantProfile: { include: { user: true } }, bed: { include: { room: true } } } },
          booking: { include: { tenantUser: true } },
        },
      },
    },
  });
  const inv = p.invoice;
  const tenantName = inv.tenancy?.tenantProfile.user.name ?? inv.booking?.tenantUser.name ?? '-';
  return renderPdf((doc) => {
    drawBrandHeader(doc);
    doc.font('Helvetica-Bold').fontSize(18).fillColor(BRAND_GREEN).text('Payment Receipt');
    doc.font('Helvetica').fontSize(10).fillColor('#555').text(inv.property.name).text(inv.property.address).moveDown();
    doc.fillColor('#111');
    table(doc, [
      ['Receipt no.', `RCPT-${p.id.slice(-8).toUpperCase()}`],
      ['Date received', p.receivedAt ? toDateString(p.receivedAt) : '-'],
      ['Received from', tenantName],
      ...(inv.tenancy ? ([['Room / bed', `${inv.tenancy.bed.room.name} / ${inv.tenancy.bed.label}`]] as [string, string][]) : []),
      ['Invoice', `${inv.number} (${inv.kind})`],
      ...(inv.periodStart && inv.periodEnd ? ([['Period', `${toDateString(inv.periodStart)} to ${toDateString(inv.periodEnd)}`]] as [string, string][]) : []),
      ['Payment method', p.method === 'GATEWAY' ? `Online (${p.provider})` : p.method === 'UPI_DIRECT' ? (p.reportedById ? `UPI to owner${p.upiRef ? ` (ref ${p.upiRef})` : ''}, confirmed by owner` : 'UPI (recorded by owner)') : 'Cash (recorded by owner)'],
      ...(p.gatewayPaymentId ? ([['Gateway reference', p.gatewayPaymentId]] as [string, string][]) : []),
      ['Amount received', pdfMoney(p.amountPaise)],
      ['Invoice balance after this payment', pdfMoney(inv.totalPaise - inv.paidPaise)],
    ]);
    if (p.note) doc.moveDown().fontSize(9).fillColor('#555').text(`Note: ${p.note}`);
    doc.moveDown(2).fontSize(8).fillColor('#888').text(`Issued by ${inv.property.owner.name} via PGPAL. This is a computer-generated receipt.`);
  });
}
