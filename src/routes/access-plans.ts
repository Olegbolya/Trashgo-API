import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accessPlans } from '../db/schema.js';
import { authMiddleware, type JwtPayload } from '../middleware/auth.js';
import { getSubStatus, countActiveReferees, PLAN_PRICE, REFERRAL_DISCOUNT } from '../lib/subscriptionStatus.js';

const router = new Hono<{ Variables: { user: JwtPayload } }>();
router.use('*', authMiddleware);

// GET /access-plans/status
router.get('/status', async (c) => {
  const { userId } = c.get('user');

  const { status, expiresAt, trialEnd } = await getSubStatus(userId);
  const activeReferrals = await countActiveReferees(userId);
  const discountAmount = activeReferrals * REFERRAL_DISCOUNT;
  const nextPrice = Math.max(0, PLAN_PRICE - discountAmount);

  const hasPending = (await db.select({ id: accessPlans.id })
    .from(accessPlans)
    .where(and(eq(accessPlans.userId, userId), eq(accessPlans.status, 'pending')))
    .limit(1)).length > 0;

  return c.json({ data: {
    status,
    expiresAt: expiresAt?.toISOString() ?? null,
    trialEndsAt: trialEnd.toISOString(),
    activeReferrals,
    discountAmount,
    nextPrice,
    hasPendingRequest: hasPending,
  } });
});

// GET /access-plans/history
router.get('/history', async (c) => {
  const { userId } = c.get('user');

  const history = await db.select()
    .from(accessPlans)
    .where(eq(accessPlans.userId, userId))
    .orderBy(desc(accessPlans.createdAt))
    .limit(20);

  return c.json({ data: history.map(p => ({
    id: p.id,
    status: p.status,
    priceAtPurchase: p.priceAtPurchase,
    paymentRef: p.paymentRef,
    startsAt: p.startsAt?.toISOString() ?? null,
    expiresAt: p.expiresAt?.toISOString() ?? null,
    confirmedAt: p.confirmedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
  })) });
});

// POST /access-plans/request — request manual payment confirmation
router.post('/request', async (c) => {
  const { userId } = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const paymentRef = typeof body.paymentRef === 'string' ? body.paymentRef.trim().slice(0, 200) : null;

  const existing = await db.select({ id: accessPlans.id })
    .from(accessPlans)
    .where(and(eq(accessPlans.userId, userId), eq(accessPlans.status, 'pending')))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: { code: 'ALREADY_PENDING', message: 'У вас уже есть ожидающий запрос на активацию' } }, 409);
  }

  const activeReferrals = await countActiveReferees(userId);
  const priceAtPurchase = Math.max(0, PLAN_PRICE - activeReferrals * REFERRAL_DISCOUNT);

  const [plan] = await db.insert(accessPlans).values({
    userId,
    status: 'pending',
    priceAtPurchase,
    ...(paymentRef ? { paymentRef } : {}),
  }).returning();

  return c.json({ data: {
    id: plan.id,
    priceAtPurchase: plan.priceAtPurchase,
    status: 'pending',
    createdAt: plan.createdAt.toISOString(),
  } }, 201);
});

export default router;
