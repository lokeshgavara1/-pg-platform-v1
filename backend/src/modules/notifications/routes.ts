import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { me } from '../auth/middleware.js';

/** In-app notification feed (the web apps' "push" channel). Any signed-in user, own rows only. */
export const notificationsRouter = Router();

notificationsRouter.get('/', async (req, res) => {
  const user = me(req);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
  ]);
  res.json({ items, unread });
});

notificationsRouter.post('/read-all', async (req, res) => {
  const user = me(req);
  await prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
  res.json({ ok: true });
});
