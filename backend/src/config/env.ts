import 'dotenv/config';
import { z } from 'zod';
import { providerProblems } from './providerGuard.js';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  // 127.0.0.1 on servers so the API is reachable only through the reverse proxy.
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174,http://localhost:5175'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  OTP_HASH_SECRET: z.string().min(32),
  FILE_SIGNING_SECRET: z.string().min(32),
  // console = print OTP (local development only); none = no OTP login (Google sign-in instead)
  SMS_PROVIDER: z.enum(['console', 'none']).default('console'),
  // fake = sandbox (local development only); none = direct UPI + cash only; razorpay = gateway
  PAYMENT_PROVIDER: z.enum(['fake', 'razorpay', 'none']).default('fake'),
  // dev = OTP test signature (local development only, not legally valid); none = sign on paper
  ESIGN_PROVIDER: z.enum(['dev', 'none']).default('dev'),
  FAKE_GATEWAY_WEBHOOK_SECRET: z.string().min(16).default('dev-fake-gateway-secret-change-me'),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
  PUSH_PROVIDER: z.enum(['inapp', 'fcm']).default('inapp'),
  FCM_SERVER_KEY: z.string().optional().default(''),
  STORAGE_DIR: z.string().default('./storage'),
  // Firebase project id for free "Sign in with Google". Empty = Google sign-in switched off.
  FIREBASE_PROJECT_ID: z.string().optional().default(''),
  // Where each app lives; used to build one-time login links (WhatsApp / admin CLI).
  OWNER_APP_URL: z.string().url().default('http://localhost:5173'),
  TENANT_APP_URL: z.string().url().default('http://localhost:5174'),
  ADMIN_APP_URL: z.string().url().default('http://localhost:5175'),
  JOBS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

const problems = providerProblems(parsed.data);
if (problems.length) {
  console.error('Refusing to start:');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
