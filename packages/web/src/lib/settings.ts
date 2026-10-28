import type { MailFilter } from '@email-service/shared';
export const settingsSections = [
  { id: 'account', label: 'Account management', description: 'Your profile and email signature', keywords: 'name email profile signature html account' },
  { id: 'security', label: 'Security', description: 'Password and account protection', keywords: 'password change reset devices sessions login security' },
  { id: 'forwarding', label: 'Forwarding & Filters', description: 'Route and organize incoming mail', keywords: 'forward address destination rules filters archive folder star read attachments size subject sender' },
  { id: 'activity', label: 'Forwarding activity', description: 'Delivery history and troubleshooting', keywords: 'activity delivery history retry cancel failed queued uncertain status' },
  { id: 'system', label: 'System settings', description: 'Appearance, images and workspace preferences', keywords: 'system theme appearance dark light display preferences remote images pictures privacy tracking' },
  { id: 'mail-apps', label: 'Mail apps', description: 'Outlook, IMAP, SMTP and device passwords', keywords: 'outlook imap smtp pop3 app device password clients' },
] as const;
export type SettingsSection = typeof settingsSections[number]['id'];
export function findSettings(search: string) {
  const words = search.trim().toLowerCase().split(/\s+/);
  return settingsSections.filter(s => words.every(w => `${s.label} ${s.description} ${s.keywords}`.toLowerCase().includes(w)));
}
export function addressError(value: string) {
  return value.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value) ? 'Enter a complete email address, such as name@example.com.' : '';
}
export function filterErrors(rule: MailFilter): Record<string, string> {
  const errors: Record<string,string> = {};
  if (!rule.name.trim()) errors.name = 'Give this filter a name.';
  for (const k of ['from', 'to'] as const) if (rule.conditions[k] && addressError(rule.conditions[k]!)) errors[k] = addressError(rule.conditions[k]!);
  if (rule.conditions.fromDomain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(rule.conditions.fromDomain)) errors.fromDomain = 'Enter a domain such as example.com, without @ or https://.';
  for (const k of ['subject','contains','excludes'] as const) if (rule.conditions[k] !== undefined && !rule.conditions[k]!.trim()) errors[k] = 'Enter text or clear this condition.';
  for (const k of ['minBytes','maxBytes'] as const) { const n = rule.conditions[k]; if (n !== undefined && (!Number.isSafeInteger(n) || n < 0 || n > 25*1024*1024)) errors[k] = 'Use a size between 0 and 25,600 KiB.'; }
  if ((rule.conditions.minBytes ?? 0) > (rule.conditions.maxBytes ?? Infinity)) errors.maxBytes = 'Maximum size must be at least the minimum size.';
  const a = rule.actions;
  if (!a.forwardTo?.length && !a.folderId && !a.archive && !a.star && !a.markRead) errors.actions = 'Choose at least one action for this filter.';
  return errors;
}

export function passwordFeedback(current: string, next: string, confirm: string, minimum: number) {
  return {
    next: next && next.length < minimum ? `Use at least ${minimum} characters.` : next && next === current ? 'Choose a password different from your current password.' : '',
    confirm: confirm && next !== confirm ? 'Passwords do not match yet.' : '',
  };
}

/** Per-browser: load remote images in received mail. Off by default, so tracking pixels stay blocked. */
const REMOTE_IMAGES_KEY = 'mail-remote-images';
const remoteImageListeners = new Set<() => void>();
export function remoteImagesAllowed() {
  try { return localStorage.getItem(REMOTE_IMAGES_KEY) === 'always'; } catch { return false; }
}
export function setRemoteImagesAllowed(allowed: boolean) {
  // localStorage can be unavailable (private mode, blocked cookies): non-fatal.
  try { if (allowed) localStorage.setItem(REMOTE_IMAGES_KEY, 'always'); else localStorage.removeItem(REMOTE_IMAGES_KEY); } catch { /* keep the default */ }
  remoteImageListeners.forEach(l => l());
}
/** useSyncExternalStore subscriber, so every open message follows a change at once. */
export function onRemoteImagesChange(listener: () => void) {
  remoteImageListeners.add(listener);
  return () => { remoteImageListeners.delete(listener); };
}
