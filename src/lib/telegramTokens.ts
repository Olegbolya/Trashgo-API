// In-memory store for Telegram OTP tokens
// Maps short random token → { phone, code, exp, linkOnly? }
// linkOnly=true means the user is linking their account (already logged in) — no OTP needed
export const telegramTokens = new Map<string, { phone: string; code: string; exp: number; linkOnly?: boolean }>();

export function cleanupTelegramTokens() {
  const now = Date.now();
  for (const [key, val] of telegramTokens) {
    if (val.exp < now) telegramTokens.delete(key);
  }
}
