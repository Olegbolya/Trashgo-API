import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { supportMessages, users } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';

const supportRouter = new Hono<{ Variables: { user: JwtPayload } }>();
supportRouter.use('*', authMiddleware);

// POST /support — send a support message
supportRouter.post('/', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const message = ((body as any)?.message ?? '').toString().trim().slice(0, 2000);
  if (!message) return c.json({ error: { code: 'VALIDATION', message: 'Message required' } }, 400);

  const [row] = await db.insert(supportMessages)
    .values({ userId, message })
    .returning();

  return c.json({ data: { id: row.id, message: row.message, createdAt: row.createdAt.toISOString(), status: row.status, reply: null } }, 201);
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
    })),
  });
});

export default supportRouter;
