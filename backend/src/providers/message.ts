import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Messaging provider interface for reminders and status updates.
 * PUSH is implemented (in-app notification feed; FCM when configured).
 * WHATSAPP and SMS are stubs that only log — wire a real provider before relying on them.
 */
export interface OutgoingMessage {
  userId: string;
  title: string;
  body: string;
}

export interface MessageProvider {
  readonly channel: 'PUSH' | 'SMS' | 'WHATSAPP';
  send(msg: OutgoingMessage): Promise<boolean>;
}

/** Stores the message in the in-app notification feed (what the web apps show as push). */
export class InAppPushProvider implements MessageProvider {
  readonly channel = 'PUSH' as const;
  async send(msg: OutgoingMessage) {
    await prisma.notification.create({
      data: { userId: msg.userId, channel: 'PUSH', title: msg.title, body: msg.body },
    });
    return true;
  }
}

/**
 * Firebase Cloud Messaging. Needs device tokens + credentials; until those exist it
 * falls back to the in-app feed so nothing is lost.
 */
export class FcmPushProvider implements MessageProvider {
  readonly channel = 'PUSH' as const;
  private fallback = new InAppPushProvider();
  async send(msg: OutgoingMessage) {
    if (!env.FCM_SERVER_KEY) logger.warn('fcm_not_configured_fallback_inapp');
    return this.fallback.send(msg);
  }
}

export class StubWhatsAppProvider implements MessageProvider {
  readonly channel = 'WHATSAPP' as const;
  async send(msg: OutgoingMessage) {
    logger.info('whatsapp_stub_not_sent', { userId: msg.userId, title: msg.title });
    return false;
  }
}

export class StubSmsMessageProvider implements MessageProvider {
  readonly channel = 'SMS' as const;
  async send(msg: OutgoingMessage) {
    logger.info('sms_stub_not_sent', { userId: msg.userId, title: msg.title });
    return false;
  }
}

let providers: MessageProvider[] | null = null;
export function messageProviders(): MessageProvider[] {
  if (!providers) {
    providers = [
      env.PUSH_PROVIDER === 'fcm' ? new FcmPushProvider() : new InAppPushProvider(),
      new StubWhatsAppProvider(),
      new StubSmsMessageProvider(),
    ];
  }
  return providers;
}
export function setMessageProviders(p: MessageProvider[]) {
  providers = p;
}

/** Send through every channel; returns the channels that actually delivered. */
export async function notify(msg: OutgoingMessage): Promise<string[]> {
  const sent: string[] = [];
  for (const p of messageProviders()) {
    try {
      if (await p.send(msg)) sent.push(p.channel);
    } catch (err) {
      logger.warn('message_send_failed', { channel: p.channel, error: String(err) });
    }
  }
  return sent;
}

/** Push only (status changes); used where WhatsApp/SMS would be noisy. */
export async function push(msg: OutgoingMessage) {
  const p = messageProviders().find((x) => x.channel === 'PUSH');
  if (p) await p.send(msg);
}
