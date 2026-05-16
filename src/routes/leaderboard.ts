import { Hono } from 'hono';
import { db } from '../db/index.js';
import { orders, users } from '../db/schema.js';
import { eq, desc, and, count as drizzleCount, avg, sql } from 'drizzle-orm';

const router = new Hono();

const leaderboardCache = new Map<string, { data: unknown[]; ts: number }>();
const CACHE_TTL = 60_000;

// GET /leaderboard?district=xxx&limit=20
router.get('/', async (c) => {
  const district = c.req.query('district');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 50);

  const cacheKey = `${district ?? ''}-${limit}`;
  const cached = leaderboardCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return c.json({ data: cached.data });
  }

  // LEFT JOIN so contractors with 0 completed orders still appear
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      district: users.district,
      level: users.level,
      xp: users.xp,
      ordersCompleted: drizzleCount(orders.id),
      avgRating: avg(orders.ratingByCustomer),
    })
    .from(users)
    .leftJoin(orders, and(eq(orders.contractorId, users.id), eq(orders.status, 'completed')))
    .where(
      district
        ? and(eq(users.role, 'contractor'), eq(users.district, district))
        : eq(users.role, 'contractor')
    )
    .groupBy(users.id, users.name, users.district, users.level, users.xp)
    .orderBy(desc(drizzleCount(orders.id)), desc(users.xp))
    .limit(limit);

  const data = rows.map((r, i) => ({
    rank: i + 1,
    id: r.id,
    name: r.name,
    district: r.district,
    level: r.level,
    xp: r.xp,
    ordersCompleted: Number(r.ordersCompleted),
    avgRating: r.avgRating ? Number(Number(r.avgRating).toFixed(1)) : null,
  }));
  leaderboardCache.set(cacheKey, { data, ts: Date.now() });
  return c.json({ data });
});

export default router;
