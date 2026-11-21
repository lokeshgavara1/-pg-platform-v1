import express, { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { parse } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { env } from '../../config/env.js';
import { payments, FakeGatewayProvider } from '../../providers/payment.js';
import { buildFakeWebhook, processWebhook } from './service.js';
import { pdfMoney } from '../../lib/pdf.js';

/** Gateway webhooks: raw body is required for signature verification. */
export const webhooksRouter = Router();

webhooksRouter.post('/payments/:provider', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const { provider } = parse(z.object({ provider: z.enum(['fake', 'razorpay']) }), req.params);
  // Only the gateway this server is configured for may post webhooks. (Previously the sandbox
  // webhook stayed reachable in production, guarded only by a default secret.)
  if (env.PAYMENT_PROVIDER !== provider) throw notFound();
  const p = payments();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const result = await processWebhook(p, raw, req.headers);
  res.status(result.status).json(result.body);
});

/**
 * SANDBOX checkout page for the built-in fake gateway. Works in any browser, like a
 * real payment link. The page itself never marks anything paid: it sends a signed
 * webhook, which goes through the same verification path as a real gateway.
 */
export const fakeGatewayRouter = Router();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

fakeGatewayRouter.get('/pay/:linkId', async (req, res) => {
  if (env.PAYMENT_PROVIDER !== 'fake') throw notFound();
  const { linkId } = parse(z.object({ linkId: z.string().regex(/^plink_fake_[0-9a-f]+$/) }), req.params);
  const p = await prisma.payment.findUnique({ where: { gatewayLinkId: linkId }, include: { invoice: { include: { property: true } } } });
  if (!p) throw notFound('Payment link');
  const done = p.status !== 'CREATED';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sandbox payment</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;padding:24px;color:#1a1d21}
.card{max-width:380px;margin:40px auto;background:#fff;border-radius:16px;padding:24px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
.badge{display:inline-block;background:#fff4d6;color:#7a5600;border-radius:999px;padding:4px 10px;font-size:12px;font-weight:600}
h1{font-size:28px;margin:12px 0 4px}p{color:#5b6470;margin:4px 0}button{width:100%;padding:14px;border:0;border-radius:10px;font-size:16px;font-weight:600;margin-top:12px;cursor:pointer}
.pay{background:#2457d6;color:#fff}.fail{background:#eef0f3;color:#1a1d21}.ok{color:#0a7a3d;font-weight:600}</style></head>
<body><div class="card"><span class="badge">SANDBOX — no real money moves</span>
<h1>${esc(pdfMoney(p.amountPaise).replace('Rs.', '₹'))}</h1><p>${esc(p.invoice.property.name)}</p><p>Invoice ${esc(p.invoice.number)}</p>
${done ? `<p class="ok">This link has already been used (status: ${esc(p.status)}).</p>` : `<form method="post" action="/fake-gateway/pay/${esc(linkId)}/complete"><input type="hidden" name="outcome" value="success"><button class="pay">Pay with UPI (simulate success)</button></form>
<form method="post" action="/fake-gateway/pay/${esc(linkId)}/complete"><input type="hidden" name="outcome" value="fail"><button class="fail">Simulate failure</button></form>`}
</div></body></html>`);
});

fakeGatewayRouter.post('/pay/:linkId/complete', express.urlencoded({ extended: false }), async (req, res) => {
  if (env.PAYMENT_PROVIDER !== 'fake') throw notFound();
  const { linkId } = parse(z.object({ linkId: z.string().regex(/^plink_fake_[0-9a-f]+$/) }), req.params);
  const { outcome } = parse(z.object({ outcome: z.enum(['success', 'fail']) }), req.body);
  const p = await prisma.payment.findUnique({ where: { gatewayLinkId: linkId } });
  if (!p) throw notFound('Payment link');
  const { raw, signature } = buildFakeWebhook(linkId, outcome, p.amountPaise);
  // Deliver the webhook to ourselves through the normal verification path.
  const result = await processWebhook(new FakeGatewayProvider(), raw, { 'x-fake-signature': signature });
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment ${outcome === 'success' ? 'done' : 'failed'}</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;text-align:center;padding:60px 24px}div{max-width:360px;margin:auto;background:#fff;border-radius:16px;padding:28px}</style></head>
<body><div><h2>${outcome === 'success' && result.status === 200 ? '✅ Payment successful' : '❌ Payment failed'}</h2><p>You can close this page and return to the app.</p></div></body></html>`);
});
