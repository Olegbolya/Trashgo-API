import { Hono } from 'hono';
import { eq, count, sum, like, desc, sql, or, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, orders, orderHistory } from '../db/schema.js';

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

// GET /admin/users?phone=xxx — search users by phone or name
adminRouter.get('/users', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const q = (c.req.query('phone') ?? '').trim();
  if (!q) return c.json({ data: [] });
  const rows = await db.select({
    id: users.id, phone: users.phone, name: users.name, role: users.role,
    frozen: users.frozen, freezeReason: users.freezeReason,
    balance: users.balance, xp: users.xp, createdAt: users.createdAt,
  }).from(users)
    .where(or(ilike(users.phone, `%${q}%`), ilike(users.name, `%${q}%`)))
    .orderBy(desc(users.createdAt))
    .limit(20);
  return c.json({ data: rows });
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

// POST /admin/run-subscription-cron — manually trigger subscription cron for testing
adminRouter.post('/run-subscription-cron', async (c) => {
  if (!checkAdmin(c)) return forbidden(c);
  const { runSubscriptionCron } = await import('../lib/subscriptionCron.js');
  await runSubscriptionCron();
  return c.json({ data: { ok: true, note: 'Ran. Creates orders only during 06:00 Moscow hour unless that window is active.' } });
});

export default adminRouter;
