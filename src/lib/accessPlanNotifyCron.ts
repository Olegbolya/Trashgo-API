import { eq, and, gt, lt, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, accessPlans } from '../db/schema.js';
import { notifyUser } from './notify.js';
import { trialEndsAt, getSubStatus } from './subscriptionStatus.js';

// Track notifications sent today to avoid duplicates across hourly runs
const sentToday = new Set<string>(); // userId:type:date

function moscowDate(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}

function moscowHour(): number {
  return parseInt(new Date().toLocaleTimeString('en-US', { timeZone: 'Europe/Moscow', hour: 'numeric', hour12: false }), 10);
}

function markSent(userId: string, type: string): boolean {
  const key = `${userId}:${type}:${moscowDate()}`;
  if (sentToday.has(key)) return false;
  sentToday.add(key);
  // Cleanup old keys after 2000 entries to prevent memory leak
  if (sentToday.size > 2000) sentToday.clear();
  return true;
}

export async function runAccessPlanNotifyCron() {
  // Only run at 10:00 Moscow time
  if (moscowHour() !== 10) return;

  const now = new Date();
  const allUsers = await db.select({ id: users.id, createdAt: users.createdAt }).from(users);

  for (const u of allUsers) {
    const trialEnd = trialEndsAt(u.createdAt);
    const msToTrialEnd = trialEnd.getTime() - now.getTime();
    const daysToTrialEnd = Math.ceil(msToTrialEnd / 86_400_000);

    // Trial expiry warnings
    if (daysToTrialEnd === 7 && markSent(u.id, 'trial_7')) {
      notifyUser(u.id,
        '⏳ TrashGo',
        'Пробный период заканчивается через 7 дней. Подключите абонемент от 0₽/мес',
      );
    } else if (daysToTrialEnd === 3 && markSent(u.id, 'trial_3')) {
      notifyUser(u.id,
        '⏳ TrashGo',
        'До конца пробного периода 3 дня. Оформите абонемент, чтобы продолжить работу.',
      );
    } else if (daysToTrialEnd <= 0 && daysToTrialEnd > -1 && markSent(u.id, 'trial_expired')) {
      // Trial expired today — check if they have an active plan
      const [activePlan] = await db.select({ id: accessPlans.id })
        .from(accessPlans)
        .where(and(eq(accessPlans.userId, u.id), eq(accessPlans.status, 'active'), gt(accessPlans.expiresAt!, now)))
        .limit(1);
      if (!activePlan) {
        notifyUser(u.id, '🔴 TrashGo', 'Доступ приостановлен. Оплатите абонемент для продолжения работы');
      }
    }

    // Active plan expiry warnings
    const [nearExpirePlan] = await db.select({ expiresAt: accessPlans.expiresAt })
      .from(accessPlans)
      .where(and(
        eq(accessPlans.userId, u.id),
        eq(accessPlans.status, 'active'),
        gt(accessPlans.expiresAt!, now),
      ))
      .limit(1);

    if (nearExpirePlan?.expiresAt) {
      const daysLeft = Math.ceil((nearExpirePlan.expiresAt.getTime() - now.getTime()) / 86_400_000);
      if (daysLeft === 7 && markSent(u.id, 'plan_7')) {
        notifyUser(u.id, '⏳ TrashGo', 'Абонемент заканчивается через 7 дней. Продлите заранее.');
      } else if (daysLeft === 3 && markSent(u.id, 'plan_3')) {
        notifyUser(u.id, '⏳ TrashGo', 'Абонемент заканчивается через 3 дня. Продлите, чтобы не прерывать работу.');
      } else if (daysLeft === 0 && markSent(u.id, 'plan_expiring_today')) {
        notifyUser(u.id, '⚠️ TrashGo', 'Ваш абонемент истекает сегодня. Продлите для непрерывного доступа.');
      }
    }
  }
}

export function startAccessPlanNotifyCron() {
  // Check every hour; actual send only happens at 10 AM Moscow
  setInterval(runAccessPlanNotifyCron, 60 * 60 * 1000);
  setTimeout(runAccessPlanNotifyCron, 15_000);
}
