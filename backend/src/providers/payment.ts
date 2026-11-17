import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Payment gateway interface. Invoice status changes ONLY via verified webhooks
 * (or an owner marking cash received) — never from a client-side callback.
 */
export interface PaymentLink {
  linkId: string;
  url: string;
}

export interface NormalizedPaymentEvent {
  eventId: string; // unique per event from the gateway (used for idempotency)
  type: 'payment.succeeded' | 'payment.failed' | 'other';
  linkId: string | null;
  gatewayPaymentId: string | null;
  amountPaise: number; // amount actually paid in this event (may be partial)
  failureReason?: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  createPaymentLink(input: {
    amountPaise: number;
    description: string;
    reference: string; // our Payment id
    customerPhone?: string;
  }): Promise<PaymentLink>;
  /** Verify signature on the RAW request body. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook(rawBody: Buffer): NormalizedPaymentEvent;
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

export function hmacHex(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Built-in sandbox gateway. Payment links point to a simple hosted checkout page
 * served by this backend (/fake-gateway/pay/:linkId) that works in any browser.
 * Clicking "Pay" there sends a SIGNED webhook, exactly like a real gateway would.
 */
export class FakeGatewayProvider implements PaymentProvider {
  readonly name = 'fake';
  constructor(private secret = env.FAKE_GATEWAY_WEBHOOK_SECRET) {}

  async createPaymentLink(_input: { amountPaise: number; description: string; reference: string }) {
    const linkId = `plink_fake_${randomBytes(8).toString('hex')}`;
    return { linkId, url: `${env.PUBLIC_BASE_URL}/fake-gateway/pay/${linkId}` };
  }

  sign(rawBody: Buffer | string): string {
    return hmacHex(this.secret, rawBody);
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const sig = headers['x-fake-signature'];
    if (typeof sig !== 'string') return false;
    return safeEqualHex(this.sign(rawBody), sig);
  }

  parseWebhook(rawBody: Buffer): NormalizedPaymentEvent {
    const body = JSON.parse(rawBody.toString('utf8'));
    return {
      eventId: String(body.id),
      type: body.type === 'payment.succeeded' || body.type === 'payment.failed' ? body.type : 'other',
      linkId: body.data?.linkId ?? null,
      gatewayPaymentId: body.data?.paymentId ?? null,
      amountPaise: Number(body.data?.amountPaise ?? 0),
      failureReason: body.data?.failureReason,
      raw: body,
    };
  }
}

/**
 * Razorpay Payment Links (sandbox with test keys). Not exercised by automated tests;
 * verify against the Razorpay test dashboard before going live.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name = 'razorpay';

  async createPaymentLink(input: {
    amountPaise: number;
    description: string;
    reference: string;
    customerPhone?: string;
  }) {
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: 'INR',
        accept_partial: false,
        description: input.description.slice(0, 2048),
        reference_id: input.reference,
        customer: input.customerPhone ? { contact: input.customerPhone } : undefined,
        notify: { sms: true },
        reminder_enable: false,
      }),
    });
    if (!res.ok) throw new Error(`Razorpay payment link failed with HTTP ${res.status}`);
    const data = (await res.json()) as { id: string; short_url: string };
    return { linkId: data.id, url: data.short_url };
  }

  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
    const sig = headers['x-razorpay-signature'];
    if (typeof sig !== 'string' || !env.RAZORPAY_WEBHOOK_SECRET) return false;
    return safeEqualHex(hmacHex(env.RAZORPAY_WEBHOOK_SECRET, rawBody), sig);
  }

  parseWebhook(rawBody: Buffer): NormalizedPaymentEvent {
    const body = JSON.parse(rawBody.toString('utf8'));
    const payment = body.payload?.payment?.entity;
    const link = body.payload?.payment_link?.entity;
    const type =
      body.event === 'payment_link.paid' ? 'payment.succeeded' : body.event === 'payment.failed' ? 'payment.failed' : 'other';
    return {
      // Razorpay sends x-razorpay-event-id as a header; payment id + event is a stable fallback.
      eventId: String(body.id ?? `${body.event}:${payment?.id ?? link?.id}`),
      type,
      linkId: link?.id ?? null,
      gatewayPaymentId: payment?.id ?? null,
      amountPaise: Number(payment?.amount ?? 0),
      failureReason: payment?.error_description,
      raw: body,
    };
  }
}

let provider: PaymentProvider | null = null;
export function payments(): PaymentProvider {
  if (!provider) provider = env.PAYMENT_PROVIDER === 'razorpay' ? new RazorpayProvider() : new FakeGatewayProvider();
  return provider;
}
export function setPaymentProvider(p: PaymentProvider) {
  provider = p;
}
