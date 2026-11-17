// Runs before each test file (and before src/config/env.ts is imported):
// point the app at the separate test database.
import { config } from 'dotenv';

config();
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.STORAGE_DIR = './storage-test';
process.env.PAYMENT_PROVIDER = 'fake';
process.env.PUBLIC_BASE_URL = 'http://localhost:4000';
process.env.JOBS_ENABLED = 'false';
