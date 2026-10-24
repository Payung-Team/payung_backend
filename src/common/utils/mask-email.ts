/**
 * อีเมลสำหรับ log เท่านั้น (PYG-700) — "somchai@example.com" → "s***@example.com"
 * ห้าม log อีเมลเต็ม · ถ้ามี userId ให้ log userId แทน
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '(none)';
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
