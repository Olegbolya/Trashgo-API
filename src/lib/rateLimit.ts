import { db } from '../db/index.js';
import { rateLimits } from '../db/schema.js';
import { sql } from 'drizzle-orm';

// Clean up expired buckets every 10 minutes (runs in background)
setInterval(async () => {
  try {
    await db.delete(rateLimits).where(sql`${rateLimits.resetAt} <= NOW()`);
  } catch { /* ignore */ }
}, 10 * 60 * 1000);

/**
 * Returns 0 if allowed, or seconds until window resets if blocked.
 * Uses PostgreSQL upsert so it survives process restarts.
 */
export async function rateLimit(key: string, max = 5, windowMs = 60 * 60 * 1000): Promise<number> {
  const resetAt = new Date(Date.now() + windowMs);

  try {
    const [row] = await db.execute(sql`
      INSERT INTO rate_limits (key, count, reset_at)
      VALUES (${key}, 1, ${resetAt})
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.reset_at <= NOW() THEN 1
          ELSE rate_limits.count + 1
        END,
        reset_at = CASE
          WHEN rate_limits.reset_at <= NOW() THEN ${resetAt}
          ELSE rate_limits.reset_at
        END
      RETURNING count, reset_at
    `) as any[];

    const count = Number(row?.count ?? 1);
    const windowEnd = new Date(row?.reset_at ?? resetAt);

    if (count > max) {
      return Math.max(1, Math.ceil((windowEnd.getTime() - Date.now()) / 1000));
    }
    return 0;
  } catch {
    // Fall back to allowing the request if DB is unavailable
    return 0;
  }
}
