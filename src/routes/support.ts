import { Hono } from 'hono';
import { eq, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supportMessages, users } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { sendTelegramNotification } from '../lib/telegram.js';

const supportRouter = new Hono<{ Variables: { user: JwtPayload } }>();
supportRouter.use('*', authMiddleware);

// POST /support — send a support message
supportRouter.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const message = ((body as any)?.message ?? '').toString().trim().slice(0, 2000);
  if (!message) return c.json({ error: { code: 'VALIDATION', message: 'Message required' } }, 400);
  const category = ((body as any)?.category ?? '').toString().trim().slice(0, 50) || null;

  const [[row], [sender]] = await Promise.all([
    db.insert(supportMessages).values({ userId, message, ...(category ? { category } : {}) }).returning(),
    db.select({ name: users.name, phone: users.phone }).from(users).where(eq(users.id, userId)).limit(1),
  ]);

  // Notify admin via Telegram
  const adminChatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (adminChatId) {
    const who = sender?.name || sender?.phone || userId.slice(-8);
    sendTelegramNotification(adminChatId, `💬 Обращение в поддержку от ${who}`, message).catch(() => {});
  }

  return c.json({ data: { id: row.id, message: row.message, createdAt: row.createdAt.toISOString(), status: row.status, reply: null, category: row.category ?? null } }, 201);
});

// GET /support — get my support thread
supportRouter.get('/', async (c) => {
  const { userId } = c.get('user');

  const rows = await db.select().from(supportMessages)
    .where(eq(supportMessages.userId, userId))
    .orderBy(desc(supportMessages.createdAt))
    .limit(50);

  return c.json({
    data: rows.map(r => ({
      id: r.id,
      message: r.message,
      reply: r.reply,
      repliedAt: r.repliedAt?.toISOString() ?? null,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      category: r.category ?? null,
      readAt: r.readAt?.toISOString() ?? null,
    })),
  });
});

// PATCH /support/read-all — mark all replied messages as read by the user
supportRouter.patch('/read-all', async (c) => {
  const { userId } = c.get('user');
  const { isNotNull } = await import('drizzle-orm');
  await db.update(supportMessages)
    .set({ readAt: new Date() } as any)
    .where(
      sql`user_id = ${userId} AND reply IS NOT NULL AND read_at IS NULL`
    );
  return c.json({ data: { ok: true } });
});

export default supportRouter;
