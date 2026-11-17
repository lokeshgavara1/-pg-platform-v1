import { runAllJobs } from './scheduler.js';
import { prisma } from '../lib/prisma.js';

const results = await runAllJobs();
console.warn(JSON.stringify(results, null, 2));
await prisma.$disconnect();
