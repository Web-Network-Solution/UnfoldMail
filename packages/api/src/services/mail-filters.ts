import type { Database } from "../services/mailbox-storage";
import type { ForwardingConfig, ForwardingPolicy, MailFilter } from '@email-service/shared';
import { replaceTags } from '../lib/utils';

export const emptyForwarding = (): ForwardingConfig => ({ revision: 0, destinations: [], forwardAll: null, rules: [] });
export const defaultForwardingPolicy: ForwardingPolicy = { enabled: true, allowExternal: true, allowedDomains: [] };
/** Transactional notifications are forwardable; replies, bounces and our own forwards are not. */
export function blocksAutomaticForwarding(headers: { key: string; value: string }[], envelopeSender: string): boolean {
  if (!envelopeSender.trim() || envelopeSender.trim() === '<>') return true;
  return headers.some(({ key, value }) => {
    const name = key.toLowerCase();
    if (name === 'x-rwa-auto-forwarded') return true;
    if (name === 'auto-submitted') return value.split(';')[0].trim().toLowerCase() === 'auto-replied';
    return name === 'content-type' && /^multipart\/report\b/i.test(value.trim()) && /report-type\s*=\s*"?(delivery-status|disposition-notification)\b/i.test(value);
  });
}
/**
 * Filter text of an HTML-only body. Comments and style, script and head contents are not words the reader sees.
 * Linear: `/<!--[\s\S]*?-->|<(head|script|style)\b[\s\S]*?<\/\1\s*>/gi` rescans to the end for every unclosed opener.
 */
export function htmlText(html: string): string {
  const open = /<!--|<(head|script|style)\b/gi, dead = new Set<string>();
  let out = '', from = 0, m: RegExpExecArray | null;
  // ponytail: a closer missing once is missing for every later opener of that tag, so each tag is searched to the end at most once.
  while ((m = open.exec(html))) {
    const tag = (m[1] || '!--').toLowerCase();
    if (dead.has(tag)) continue;
    // Tokenizer closers: `<!-->` and `<!--->` are empty comments, and `--!>` closes like `-->`.
    const close = m[1] ? new RegExp(`<\\/${tag}\\s*>`, 'gi') : /(?<=<!--)-?>|--!?>/g;
    close.lastIndex = open.lastIndex;
    if (!close.exec(html)) { dead.add(tag); continue; }
    out += html.slice(from, m.index) + ' '; from = open.lastIndex = close.lastIndex;
  }
  return replaceTags(out + html.slice(from), /<[^>]*>/g, ' ');
}
export interface FilterMessage {
  from: string; to: string[]; subject: string; text: string; hasAttachments: boolean; size: number;
}
function matchesNormalized(rule: Pick<MailFilter, 'conditions' | 'match'>, mail: FilterMessage, body: string): boolean {
  const c = rule.conditions;
  const checks: boolean[] = [];
  if (c.from) checks.push(mail.from.toLowerCase() === c.from.toLowerCase());
  if (c.fromDomain) checks.push(mail.from.split('@').pop()?.toLowerCase() === c.fromDomain.toLowerCase());
  if (c.to) checks.push(mail.to.some(to => to.toLowerCase() === c.to!.toLowerCase()));
  if (c.subject) checks.push(mail.subject.includes(c.subject.toLowerCase()));
  if (c.contains) checks.push(body.includes(c.contains.toLowerCase()));
  if (c.excludes) checks.push(!body.includes(c.excludes.toLowerCase()));
  if (c.hasAttachments !== undefined) checks.push(mail.hasAttachments === c.hasAttachments);
  if (c.minBytes !== undefined) checks.push(mail.size >= c.minBytes);
  if (c.maxBytes !== undefined) checks.push(mail.size <= c.maxBytes);
  return !checks.length || (rule.match === 'all' ? checks.every(Boolean) : checks.some(Boolean));
}
export function matchesFilter(rule: Pick<MailFilter, 'conditions' | 'match'>, mail: FilterMessage): boolean {
  return matchesNormalized(rule, { ...mail, subject: mail.subject.toLowerCase() }, `${mail.subject}\n${mail.text}`.toLowerCase());
}

export function evaluateFilters(config: ForwardingConfig, mail: FilterMessage) {
  // Normalize the potentially large message once, not once per configured rule.
  const normalized = { ...mail, subject: mail.subject.toLowerCase() };
  const searchable = config.rules.some(r => r.enabled && (r.conditions.contains || r.conditions.excludes))
    ? `${mail.subject}\n${mail.text}`.toLowerCase() : '';
  const destinations = new Set<string>(config.forwardAll ? [config.forwardAll] : []);
  let folderId: string | undefined;
  let archive = false, markRead = false, star = false;
  for (const rule of config.rules) {
    if (!rule.enabled || !matchesNormalized(rule, normalized, searchable)) continue;
    for (const address of rule.actions.forwardTo || []) destinations.add(address);
    // Later matching move/archive action wins; independent flags accumulate.
    if (rule.actions.folderId) { folderId = rule.actions.folderId; archive = false; }
    if (rule.actions.archive) { archive = true; folderId = undefined; }
    markRead ||= !!rule.actions.markRead;
    star ||= !!rule.actions.star;
    if (rule.stop) break;
  }
  return { destinations: [...destinations], folderId, archive, markRead, star };
}
export function destinationAllowed(address: string, sender: string, domain: string, policy: ForwardingPolicy) {
  const target = address.toLowerCase();
  const targetDomain = target.split('@')[1];
  return policy.enabled && target !== sender.toLowerCase() &&
    (policy.allowExternal || targetDomain === domain.toLowerCase()) &&
    (!policy.allowedDomains.length || policy.allowedDomains.includes(targetDomain));
}
export async function getForwardingConfig(db: Database, userId: string): Promise<ForwardingConfig> {
  const row = await db.prepare('SELECT config, revision FROM forwarding_configs WHERE user_id = ?')
    .bind(userId).first<{ config: string; revision: number }>();
  return row ? { ...JSON.parse(row.config), revision: row.revision } : emptyForwarding();
}
export async function getForwardingPolicy(db: Database): Promise<ForwardingPolicy> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'forwarding_policy'").first<{ value: string }>();
  return row ? JSON.parse(row.value) : { ...defaultForwardingPolicy };
}
