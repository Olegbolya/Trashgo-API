/** Normalize a Russian phone number to E.164 format: +79XXXXXXXXX */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+7${digits}`;               // 9XXXXXXXXX
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;  // 79XXXXXXXXX
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;  // 89XXXXXXXXX
  return `+${digits}`; // fallback: just prepend +
}
