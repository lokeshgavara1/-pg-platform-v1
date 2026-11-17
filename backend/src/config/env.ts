import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://localhost:5174,http://localhost:5175'),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  OTP_HASH_SECRET: z.string().min(32),
  FILE_SIGNING_SECRET: z.string().min(32),
  SMS_PROVIDER: z.enum(['console']).default('console'),
  PAYMENT_PROVIDER: z.enum(['fake', 'razorpay']).default('fake'),
  FAKE_GATEWAY_WEBHOOK_SECRET: z.string().min(16).default('dev-fake-gateway-secret-change-me'),
  RAZORPAY_KEY_ID: z.string().optional().default(''),
  RAZORPAY_KEY_SECRET: z.string().optional().default(''),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional().default(''),
  PUSH_PROVIDER: z.enum(['inapp', 'fcm']).default('inapp'),
  FCM_SERVER_KEY: z.string().optional().default(''),
  STORAGE_DIR: z.string().default('./storage'),
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

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
