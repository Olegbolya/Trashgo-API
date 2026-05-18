import { Hono } from 'hono';
import { eq, count, sum, like, desc, sql, or, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, orders, orderHistory, supportMessages } from '../db/schema.js';
import { notifyUser } from '../lib/notify.js';

const adminRouter = new Hono();

function checkAdmin(c: any): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return true; // no secret configured → open (dev)
  const provided = c.req.query('secret') || c.req.header('Authorization')?.replace('Bearer ', '');
  return provided === secret;
}

function forbidden(c: any) {
  return c.json({ error: { code: 'FORBIDDEN', message: 'Admin access required' } }, 403);
}

// GET /admin/stats
adminRouter.get('/stats', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);

  const [totalUsers] = await db.select({ cnt: count() }).from(users);
  const [frozenUsers] = await db.select({ cnt: count() }).from(users).where(eq(users.frozen, true));

  const orderStats = await db.select({ status: orders.status, cnt: count() })
    .from(orders).groupBy(orders.status);

  const [revenue] = await db.select({ total: sum(orders.price) })
    .from(orders).where(eq(orders.status, 'completed'));

  const [disputes] = await db.select({ cnt: count() })
    .from(orderHistory).where(like(orderHistory.note, 'DISPUTE:%'));

  const [paymentDisputes] = await db.select({ cnt: count() })
    .from(orderHistory).where(like(orderHistory.note, 'PAYMENT_DISPUTE:%'));

  const [recentOrders] = await db.select({ cnt: sql<number>`count(*)::int` })
    .from(orders).where(sql`created_at > now() - interval '7 days'`);

  const statusMap: Record<string, number> = {};
  orderStats.forEach(s => { statusMap[s.status] = Number(s.cnt); });

  return c.json({ data: {
    users: Number(totalUsers?.cnt ?? 0),
    frozenUsers: Number(frozenUsers?.cnt ?? 0),
    orders: statusMap,
    revenue: Number(revenue?.total ?? 0),
    disputes: Number(disputes?.cnt ?? 0),
    paymentDisputes: Number(paymentDisputes?.cnt ?? 0),
    recentOrders: Number(recentOrders?.cnt ?? 0),
  } });
});

// GET /admin/frozen
adminRouter.get('/frozen', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const frozen = await db.select({
    id: users.id, phone: users.phone, name: users.name,
    freezeReason: users.freezeReason, createdAt: users.createdAt,
  }).from(users).where(eq(users.frozen, true)).orderBy(desc(users.createdAt));
  return c.json({ data: frozen });
});

// POST /admin/freeze/:id
adminRouter.post('/freeze/:id', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const reason = (body as any)?.reason || 'Заморожен администратором';
  await db.update(users).set({ frozen: true, freezeReason: reason } as any).where(eq(users.id, id));
  return c.json({ data: { ok: true } });
});

// POST /admin/unfreeze/:id
adminRouter.post('/unfreeze/:id', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  await db.update(users).set({ frozen: false, freezeReason: null } as any).where(eq(users.id, id));
  return c.json({ data: { ok: true } });
});

// GET /admin/disputes — customer disputes (DISPUTE: prefix in orderHistory.note)
adminRouter.get('/disputes', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const rows = await db.select({
    id: orderHistory.id,
    orderId: orderHistory.orderId,
    note: orderHistory.note,
    createdAt: orderHistory.createdAt,
    orderStatus: orders.status,
    address: orders.address,
    price: orders.price,
    customerId: orders.customerId,
    contractorId: orders.contractorId,
  }).from(orderHistory)
    .leftJoin(orders, eq(orderHistory.orderId, orders.id))
    .where(like(orderHistory.note, 'DISPUTE:%'))
    .orderBy(desc(orderHistory.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

// GET /admin/disputes/payment — payment disputes (PAYMENT_DISPUTE: prefix)
adminRouter.get('/disputes/payment', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const rows = await db.select({
    id: orderHistory.id,
    orderId: orderHistory.orderId,
    note: orderHistory.note,
    createdAt: orderHistory.createdAt,
    orderStatus: orders.status,
    address: orders.address,
    price: orders.price,
    customerId: orders.customerId,
    contractorId: orders.contractorId,
  }).from(orderHistory)
    .leftJoin(orders, eq(orderHistory.orderId, orders.id))
    .where(like(orderHistory.note, 'PAYMENT_DISPUTE:%'))
    .orderBy(desc(orderHistory.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

// GET /admin/users?q=xxx&offset=0 — list all users or search by phone/name
adminRouter.get('/users', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const q = (c.req.query('q') ?? c.req.query('phone') ?? '').trim();
  const offset = Math.max(0, parseInt(c.req.query('offset') ?? '0', 10) || 0);
  const limit = 30;

  const baseSelect = {
    id: users.id, phone: users.phone, name: users.name, role: users.role,
    frozen: users.frozen, freezeReason: users.freezeReason,
    balance: users.balance, xp: users.xp, createdAt: users.createdAt,
    telegramLinked: users.telegramChatId,
  };

  const rows = q
    ? await db.select(baseSelect).from(users)
        .where(or(ilike(users.phone, `%${q}%`), ilike(users.name, `%${q}%`)))
        .orderBy(desc(users.createdAt)).limit(limit)
    : await db.select(baseSelect).from(users)
        .orderBy(desc(users.createdAt)).limit(limit + 1).offset(offset);

  const hasMore = !q && rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    data: page.map(r => ({ ...r, telegramLinked: !!r.telegramLinked })),
    meta: { hasMore, nextOffset: hasMore ? offset + limit : null },
  });
});

// GET /admin/users/:id/orders — orders for a specific user
adminRouter.get('/users/:id/orders', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const rows = await db.select({
    id: orders.id, address: orders.address, status: orders.status,
    price: orders.price, createdAt: orders.createdAt,
    customerId: orders.customerId, contractorId: orders.contractorId,
  }).from(orders)
    .where(or(eq(orders.customerId, id), eq(orders.contractorId, id)))
    .orderBy(desc(orders.createdAt))
    .limit(50);
  return c.json({ data: rows });
});

// POST /admin/disputes/:id/close — mark dispute as resolved
adminRouter.post('/disputes/:id/close', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const resolution = (body as any)?.resolution || 'Закрыт администратором';
  await db.update(orderHistory)
    .set({ note: sql`note || ' [CLOSED: ' || ${resolution} || ']'` } as any)
    .where(eq(orderHistory.id, id));
  return c.json({ data: { ok: true } });
});

// GET /admin/support?status=open|escalated|all — list support messages
adminRouter.get('/support', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const status = c.req.query('status') ?? 'open';
  const rows = await db.select({
    id: supportMessages.id,
    message: supportMessages.message,
    reply: supportMessages.reply,
    repliedAt: supportMessages.repliedAt,
    status: supportMessages.status,
    createdAt: supportMessages.createdAt,
    userId: supportMessages.userId,
    userName: users.name,
    userPhone: users.phone,
    telegramChatId: users.telegramChatId,
    readAt: supportMessages.readAt,
    category: supportMessages.category,
    isBotReply: supportMessages.isBotReply,
    escalated: supportMessages.escalated,
  }).from(supportMessages)
    .leftJoin(users, eq(supportMessages.userId, users.id))
    .where(
      status === 'all' ? sql`true` :
      status === 'escalated' ? eq(supportMessages.escalated, true) :
      eq(supportMessages.status, status)
    )
    .orderBy(desc(supportMessages.createdAt))
    .limit(100);
  return c.json({ data: rows.map(r => ({ ...r, repliedAt: r.repliedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), readAt: r.readAt?.toISOString() ?? null, category: r.category ?? null })) });
});

// GET /admin/support/count — count open + escalated support messages
adminRouter.get('/support/count', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const [[openRow], [escalatedRow]] = await Promise.all([
    db.select({ cnt: count() }).from(supportMessages).where(eq(supportMessages.status, 'open')),
    db.select({ cnt: count() }).from(supportMessages).where(eq(supportMessages.escalated, true)),
  ]);
  return c.json({ data: { open: Number(openRow?.cnt ?? 0), escalated: Number(escalatedRow?.cnt ?? 0) } });
});

// POST /admin/support/:id/reply — admin replies to a support message
adminRouter.post('/support/:id/reply', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const id = c.req.param('id');
  const body = await c.req.json().catch(() => ({}));
  const reply = ((body as any)?.reply ?? '').toString().trim();
  if (!reply) return c.json({ error: { code: 'VALIDATION', message: 'Reply required' } }, 400);

  const [updated] = await db.update(supportMessages)
    .set({ reply, repliedAt: new Date(), status: 'closed' } as any)
    .where(eq(supportMessages.id, id))
    .returning();

  if (!updated) return c.json({ error: { code: 'NOT_FOUND', message: 'Message not found' } }, 404);

  // Notify user about admin reply via push + Telegram
  notifyUser(updated.userId, '💬 Ответ поддержки', reply);

  return c.json({ data: { ok: true } });
});

// POST /admin/run-subscription-cron — manually trigger subscription cron for testing
adminRouter.post('/run-subscription-cron', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const { runSubscriptionCron } = await import('../lib/subscriptionCron.js');
  await runSubscriptionCron();
  return c.json({ data: { ok: true, note: 'Ran. Creates orders only during 06:00 Moscow hour unless that window is active.' } });
});

export default adminRouter;
