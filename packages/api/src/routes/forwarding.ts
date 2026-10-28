import type { Database } from "../services/mailbox-storage";
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ForwardingConfig, ForwardingPolicy, MailFilter } from '@email-service/shared';
import type { Env, HonoVariables } from '../types';
import { generateUUIDv7, isValidEmail, nowIso, emailBodyTextKey } from '../lib/utils';
import { destinationAllowed, getForwardingConfig, getForwardingPolicy, htmlText, matchesFilter } from '../services/mail-filters';

type Context = { Bindings: Env; Variables: HonoVariables };
const forwarding = new Hono<Context>();
const admin = new Hono<Context>();
const limit = bodyLimit({ maxSize: 64 * 1024 });
forwarding.use('*', limit);
admin.use('*', limit);
admin.use('*', async (c, next) => {
  if (c.get('userRole') !== 'super_admin') return c.json({ success: false, error: 'Super-admin access required' }, 403);
  await next();
});
/** A validation failure whose message is written for the user. Anything else is internal and never echoed. */
class Invalid extends Error {}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const address = (v: unknown): v is string => typeof v === 'string' && v.length <= 254 && !/[\s<>\r\n]/.test(v) && isValidEmail(v);
const domain = (v: unknown): v is string => typeof v === 'string' && v.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(v);

/** Reject malformed JSON and unknown keys rather than silently saving ineffective rules. */
export function validateRule(value: unknown): MailFilter {
  if (!object(value) || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 ||
      typeof value.enabled !== 'boolean' || typeof value.stop !== 'boolean' ||
      !['all', 'any'].includes(String(value.match)) || !object(value.conditions) || !object(value.actions)) throw new Invalid('Invalid filter');
  const c = value.conditions, a = value.actions;
  if (Object.keys(c).some(k => !['from','fromDomain','to','subject','contains','excludes','hasAttachments','minBytes','maxBytes'].includes(k)) ||
      Object.keys(a).some(k => !['forwardTo','folderId','archive','markRead','star'].includes(k))) throw new Invalid('Unknown filter field');
  for (const k of ['from', 'to']) if (c[k] !== undefined && !address(c[k])) throw new Invalid('Enter a complete sender/recipient address');
  if (c.fromDomain !== undefined && !domain(c.fromDomain)) throw new Invalid('Invalid sender domain');
  for (const k of ['subject','contains','excludes']) if (c[k] !== undefined && (typeof c[k] !== 'string' || !c[k].trim() || c[k].length > 200)) throw new Invalid('Filter text must be 1–200 characters');
  if (c.hasAttachments !== undefined && typeof c.hasAttachments !== 'boolean') throw new Invalid('Invalid attachment condition');
  for (const k of ['minBytes','maxBytes']) if (c[k] !== undefined && (typeof c[k] !== 'number' || !Number.isSafeInteger(c[k]) || c[k] < 0 || c[k] > 25 * 1024 * 1024)) throw new Invalid('Size must be between 0 and 25 MiB');
  if (typeof c.minBytes === 'number' && typeof c.maxBytes === 'number' && c.minBytes > c.maxBytes) throw new Invalid('Minimum size exceeds maximum');
  for (const k of ['archive','markRead','star']) if (a[k] !== undefined && typeof a[k] !== 'boolean') throw new Invalid('Invalid filter action');
  if (a.folderId !== undefined && (typeof a.folderId !== 'string' || !a.folderId || a.folderId.length > 64)) throw new Invalid('Invalid folder');
  if (a.archive && a.folderId) throw new Invalid('Choose either archive or move to a folder');
  if (a.forwardTo !== undefined && (!Array.isArray(a.forwardTo) || a.forwardTo.length > 10 || !a.forwardTo.every(address))) throw new Invalid('Invalid forwarding destinations');
  if (!a.archive && !a.folderId && !a.markRead && !a.star && !(Array.isArray(a.forwardTo) && a.forwardTo.length)) throw new Invalid('Choose at least one action');
  return { ...(value as unknown as MailFilter), name: value.name.trim(),
    conditions: { ...c, ...(c.from ? { from: String(c.from).toLowerCase() } : {}), ...(c.to ? { to: String(c.to).toLowerCase() } : {}), ...(c.fromDomain ? { fromDomain: String(c.fromDomain).toLowerCase() } : {}) },
    actions: { ...a, ...(Array.isArray(a.forwardTo) ? { forwardTo: [...new Set(a.forwardTo.map(v => v.toLowerCase()))] } : {}) } };
}
function audit(db: Database, id: string, email: string, action: string, details: unknown) {
  return db.prepare('INSERT INTO forwarding_audit(id,actor_id,actor_email,action,details,created_at) VALUES(?,?,?,?,?,?)')
    .bind(generateUUIDv7(), id, email, action, JSON.stringify(details), nowIso());
}
forwarding.get('/', async c => c.json({ success: true, data: {
  config: await getForwardingConfig(c.env.DB, c.get('userId')), policy: await getForwardingPolicy(c.env.DB),
} }));
forwarding.put('/', async c => {
  try {
    const v: unknown = await c.req.json().catch(() => null);
    if (!object(v) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0 || !Array.isArray(v.destinations) || v.destinations.length > 10 || !v.destinations.every(address) || !Array.isArray(v.rules) || v.rules.length > 50) throw new Invalid('Use at most 10 destinations and 50 filters');
    const destinations = [...new Set(v.destinations.map(x => x.toLowerCase()))];
    if (v.forwardAll !== null && (!address(v.forwardAll) || !destinations.includes(v.forwardAll.toLowerCase()))) throw new Invalid('Choose a saved forwarding address');
    const rules = v.rules.map(validateRule);
    if (new Set(rules.map(r => r.id)).size !== rules.length) throw new Invalid('Duplicate filter ID');
    const policy = await getForwardingPolicy(c.env.DB);
    const used = new Set([...(v.forwardAll ? [String(v.forwardAll).toLowerCase()] : []), ...rules.filter(r => r.enabled).flatMap(r => r.actions.forwardTo || [])]);
    for (const dest of destinations) if (dest === c.get('userEmail').toLowerCase()) throw new Invalid('You cannot forward to yourself');
    for (const dest of used) if (!destinationAllowed(dest, c.get('userEmail'), c.env.EMAIL_DOMAIN, policy)) throw new Invalid(`Forwarding to ${dest} is restricted by the administrator`);
    for (const rule of rules) {
      if (rule.actions.forwardTo?.some(d => !destinations.includes(d))) throw new Invalid('A filter uses an address that is not saved');
      if (rule.actions.folderId && !await c.env.DB.prepare("SELECT id FROM folders WHERE id = ? AND user_id = ? AND type IN ('inbox','custom','archive')").bind(rule.actions.folderId, c.get('userId')).first()) throw new Invalid('Choose a folder from your mailbox');
    }
    const config: ForwardingConfig = { revision: Number(v.revision) + 1, destinations, forwardAll: v.forwardAll ? String(v.forwardAll).toLowerCase() : null, rules };
    const write = v.revision === 0
      ? c.env.DB.prepare('INSERT OR IGNORE INTO forwarding_configs(user_id,revision,config,updated_at) VALUES(?,1,?,?)')
        .bind(c.get('userId'), JSON.stringify(config), nowIso())
      : c.env.DB.prepare('UPDATE forwarding_configs SET revision=revision+1,config=?,updated_at=? WHERE user_id=? AND revision=?')
        .bind(JSON.stringify(config), nowIso(), c.get('userId'), v.revision);
    const result = await c.env.DB.batch([
      write,
      c.env.DB.prepare(`INSERT INTO forwarding_audit(id,actor_id,actor_email,action,details,created_at)
        SELECT ?,?,?,'settings_updated',?,? WHERE changes() > 0`)
        .bind(generateUUIDv7(), c.get('userId'), c.get('userEmail'), JSON.stringify(config), nowIso()),
    ]);
    if (!result[0].meta.changes) return c.json({ success: false, error: 'Settings changed in another tab. Reload and try again.' }, 409);
    return c.json({ success: true, data: config });
  } catch (err) {
    if (err instanceof Invalid) return c.json({ success: false, error: err.message }, 400);
    throw err;
  }
});
forwarding.post('/preview', async c => {
  let rule: MailFilter;
  try { rule = validateRule(await c.req.json()); } catch (e) { return c.json({ success: false, error: (e as Error).message }, 400); }
  const rows = await c.env.DB.prepare(`SELECT e.* FROM emails e JOIN folders f ON f.id=e.folder_id
    WHERE e.user_id=? AND e.delivery_status IS NULL AND f.type NOT IN ('sent','drafts','trash') ORDER BY e.received_at DESC LIMIT 25`)
    .bind(c.get('userId')).all<{ id: string; sender: string; recipients_to: string; recipients_cc: string; subject: string; r2_body_key: string; has_attachments: number; size: number; received_at: string }>();
  const matches = []; let scanned = 0, skipped = 0;
  for (const row of rows.results) {
    let text = '';
    if (rule.conditions.contains || rule.conditions.excludes) {
      const body = await c.env.EMAIL_BUCKET.get(emailBodyTextKey(c.get('userId'), row.id, row.r2_body_key));
      const html = !body || !body.size ? await c.env.EMAIL_BUCKET.get(row.r2_body_key) : null;
      const source = html || body;
      if (!source || source.size > 1024 * 1024) { skipped++; continue; }
      // Same text inbound filtering sees: the stored plain-text body verbatim, else the HTML's visible text.
      text = html ? htmlText(await source.text()) : await source.text();
    }
    scanned++;
    const recipients = [...JSON.parse(row.recipients_to), ...JSON.parse(row.recipients_cc)].map((r: { email: string }) => r.email);
    if (matchesFilter(rule, { from: row.sender, to: [...recipients, c.get('userEmail')], subject: row.subject, text, hasAttachments: !!row.has_attachments, size: row.size })) matches.push({ id: row.id, subject: row.subject, sender: row.sender, receivedAt: row.received_at });
  }
  return c.json({ success: true, data: { matches, scanned, skipped } });
});
forwarding.get('/activity', async c => {
  const result = await c.env.DB.prepare('SELECT id,destination,subject,status,error,created_at,attempts FROM forwarding_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(c.get('userId')).all();
  return c.json({ success: true, data: result.results });
});
forwarding.post('/activity/:id/:action', async c => {
  const action = c.req.param('action');
  if (!['retry', 'cancel'].includes(action)) return c.json({ success: false, error: 'Unknown action' }, 400);
  // Uncertain deliveries are never automatically resent; explicit acknowledgement required.
  const body = await c.req.json<{ acknowledgeDuplicate?: boolean }>().catch(() => ({} as { acknowledgeDuplicate?: boolean }));
  const statuses = action === 'cancel' ? "'queued','failed','uncertain'" : body.acknowledgeDuplicate === true ? "'failed','uncertain'" : "'failed'";
  const result = await c.env.DB.prepare(`UPDATE forwarding_jobs SET status=?,error=NULL,next_attempt_at=?,updated_at=?,attempts=CASE WHEN ?='queued' THEN 0 ELSE attempts END WHERE id=? AND user_id=? AND status IN (${statuses})`)
    .bind(action === 'retry' ? 'queued' : 'cancelled', nowIso(), nowIso(), action === 'retry' ? 'queued' : 'cancelled', c.req.param('id'), c.get('userId')).run();
  if (!result.meta.changes) return c.json({ success: false, error: 'Delivery changed or requires duplicate-delivery acknowledgement. Refresh activity.' }, 409);
  await audit(c.env.DB, c.get('userId'), c.get('userEmail'), `delivery_${action}`, { id: c.req.param('id') }).run();
  return c.json({ success: true });
});
admin.get('/', async c => c.json({ success: true, data: await getForwardingPolicy(c.env.DB) }));
admin.put('/', async c => {
  const v: unknown = await c.req.json().catch(() => null);
  if (!object(v) || typeof v.enabled !== 'boolean' || typeof v.allowExternal !== 'boolean' || !Array.isArray(v.allowedDomains) || v.allowedDomains.length > 50 || !v.allowedDomains.every(domain)) return c.json({ success: false, error: 'Invalid forwarding policy' }, 400);
  const policy: ForwardingPolicy = { enabled: v.enabled, allowExternal: v.allowExternal, allowedDomains: [...new Set(v.allowedDomains.map(x => x.toLowerCase()))] };
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO settings(key,value) VALUES('forwarding_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(policy)),
    audit(c.env.DB, c.get('userId'), c.get('userEmail'), 'policy_updated', policy),
  ]);
  return c.json({ success: true, data: policy });
});
admin.get('/audit', async c => {
  const before = c.req.query('before') || '9999';
  const result = await c.env.DB.prepare('SELECT id,actor_email,action,details,created_at FROM forwarding_audit WHERE id < ? ORDER BY id DESC LIMIT 100').bind(before).all();
  return c.json({ success: true, data: result.results });
});
export { forwarding as forwardingRoutes, admin as forwardingAdminRoutes };
