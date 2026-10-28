import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import type { Env, HonoVariables } from '../types';
import { sessionTag, verifyPassword, nowIso } from '../lib/utils';
import { mailboxEnv, centralDB } from '../services/mailbox-storage';
import { protocolMailboxRoutes } from './protocol-mailbox';
type App = {
    Bindings: Env;
    Variables: HonoVariables;
};
export type ProtocolPolicy = {
    imap: boolean;
    smtp: boolean;
    pop3: boolean;
    hostname: string;
};
export async function protocolPolicy(env: Env): Promise<ProtocolPolicy> {
    const row = await centralDB(env).prepare("SELECT value FROM settings WHERE key='protocol_policy'").first<{
        value: string;
    }>();
    return { imap: false, smtp: false, pop3: false, hostname: '', ...(row ? JSON.parse(row.value) : {}) };
}
// Never trust a frontend impersonation flag or the backup cookie alone.
async function verifiedSuperAdminSwitch(c: Context<App>): Promise<boolean> {
    const original = getCookie(c, 'original_session');
    const current = getCookie(c, 'session_token');
    if (!original || !current) return false;
    const parts = original.split('.');
    if (parts.length !== 2 || !parts[0] || parts[1] !== await sessionTag(current)) return false;
    const row = await centralDB(c.env).prepare(`
        SELECT a.user_id FROM sessions a JOIN users admin ON admin.id=a.user_id
        JOIN sessions target ON target.token=?
        WHERE a.token=? AND a.expires_at>? AND target.expires_at>?
          AND admin.role='super_admin' AND admin.must_reset_password=0
          AND target.user_id=? AND a.user_id!=target.user_id
    `).bind(parts[1], await sessionTag(parts[0]), nowIso(), nowIso(), c.get('userId')).first();
    return !!row;
}
export const protocolSettings = new Hono<App>();
protocolSettings.use('*', bodyLimit({ maxSize: 4096 }));
protocolSettings.get('/', async (c) => {
    const rows = await c.env.DB.prepare('SELECT id,name,created_at,last_used_at,revoked_at FROM protocol_passwords WHERE user_id=? ORDER BY created_at DESC').bind(c.get('userId')).all();
    return c.json({ success: true, data: { passwords: rows.results, policy: await protocolPolicy(c.env) } });
});
protocolSettings.post('/', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 60 || (b.password !== undefined && (typeof b.password !== 'string' || b.password.length > 1024)))
        return c.json({ success: false, error: 'Enter a device name and your current password' }, 400);
    const u = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id=?').bind(c.get('userId')).first<{
        password_hash: string;
    }>();
    const adminSwitch = await verifiedSuperAdminSwitch(c);
    if (!u || (!adminSwitch && (typeof b.password !== 'string' || !await verifyPassword(b.password, u.password_hash))))
        return c.json({ success: false, error: 'Current password is incorrect' }, 403);
    const count = await c.env.DB.prepare('SELECT COUNT(*) n FROM protocol_passwords WHERE user_id=? AND revoked_at IS NULL').bind(c.get('userId')).first<{
        n: number;
    }>();
    if ((count?.n || 0) >= 20)
        return c.json({ success: false, error: 'Revoke an old device first (20 active devices maximum)' }, 400);
    const password = 'mp_' + Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, '0')).join('');
    const id = crypto.randomUUID();
    await c.env.DB.prepare('INSERT INTO protocol_passwords(id,user_id,name,token_hash,account_hash,created_at) VALUES(?,?,?,?,?,?)')
        .bind(id, c.get('userId'), b.name.trim(), await sessionTag(password), await sessionTag(u.password_hash), nowIso()).run();
    c.header('Cache-Control', 'no-store');
    return c.json({ success: true, data: { id, password } }, 201);
});
protocolSettings.delete('/:id', async (c) => {
    await c.env.DB.prepare('UPDATE protocol_passwords SET revoked_at=? WHERE id=? AND user_id=?').bind(nowIso(), c.req.param('id'), c.get('userId')).run();
    return c.json({ success: true });
});
export const protocolAdmin = new Hono<App>();
protocolAdmin.use('*', async (c, next) => { if (c.get('userRole') !== 'super_admin')
    return c.json({ success: false, error: 'Super admin required' }, 403); await next(); });
protocolAdmin.use('*', bodyLimit({ maxSize: 4096 }));
protocolAdmin.get('/', async (c) => c.json({ success: true, data: await protocolPolicy(c.env) }));
protocolAdmin.put('/', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (!b || !['imap', 'smtp', 'pop3'].every(k => typeof b[k] === 'boolean') || typeof b.hostname !== 'string' || (b.hostname !== '' && !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(b.hostname)))
        return c.json({ success: false, error: 'Invalid protocol settings or hostname' }, 400);
    if ((b.imap || b.smtp || b.pop3) && (!b.hostname || (c.env.PROTOCOL_GATEWAY_SECRET?.length || 0) < 32))
        return c.json({ success: false, error: 'Configure the gateway hostname and a strong shared secret before enabling access' }, 400);
    const policy = { imap: b.imap, smtp: b.smtp, pop3: b.pop3, hostname: b.hostname };
    await c.env.DB.prepare("INSERT INTO settings(key,value) VALUES('protocol_policy',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(policy)).run();
    return c.json({ success: true, data: policy });
});
protocolAdmin.get('/users', async (c) => {
    const q = (c.req.query('q') || '').slice(0, 100).replace(/[\\%_]/g, '\\$&');
    const rows = await c.env.DB.prepare("SELECT u.id,u.email,u.display_name,COALESCE(a.enabled,1) enabled FROM users u LEFT JOIN protocol_user_access a ON a.user_id=u.id WHERE u.email LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\' ORDER BY u.email LIMIT 50").bind('%' + q + '%', '%' + q + '%').all();
    return c.json({ success: true, data: rows.results });
});
protocolAdmin.put('/users/:id', async (c) => {
    const b = await c.req.json().catch(() => null);
    if (typeof b?.enabled !== 'boolean')
        return c.json({ success: false, error: 'Invalid access setting' }, 400);
    if (!await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(c.req.param('id')).first())
        return c.json({ success: false, error: 'User not found' }, 404);
    await c.env.DB.prepare('INSERT INTO protocol_user_access(user_id,enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').bind(c.req.param('id'), b.enabled ? 1 : 0).run();
    return c.json({ success: true });
});
export const protocolGateway = new Hono<App>();
protocolGateway.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const secret = c.req.header('X-Gateway-Key') || '';
    if (!c.env.PROTOCOL_GATEWAY_SECRET || c.env.PROTOCOL_GATEWAY_SECRET.length < 32 || secret.length > 512 || await sessionTag(secret) !== await sessionTag(c.env.PROTOCOL_GATEWAY_SECRET))
        return c.json({ error: 'Unauthorized' }, 401);
    const protocol = c.req.header('X-Mail-Protocol');
    if (!['imap', 'smtp', 'pop3'].includes(protocol || '') || !(await protocolPolicy(c.env))[protocol as 'imap'])
        return c.json({ error: 'Protocol disabled' }, 403);
    let email = '', password = '';
    try {
        const h = c.req.header('Authorization') || '';
        if (!h.startsWith('Basic ') || h.length > 2048)
            throw Error();
        const v = atob(h.slice(6));
        const i = v.indexOf(':');
        email = v.slice(0, i).toLowerCase();
        password = v.slice(i + 1);
    }
    catch {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!/^mp_[a-f0-9]{64}$/.test(password))
        return c.json({ error: 'Unauthorized' }, 401);
    const row = await centralDB(c.env).prepare(`SELECT p.id,p.user_id,p.account_hash,u.email,u.password_hash FROM protocol_passwords p JOIN users u ON u.id=p.user_id
 LEFT JOIN protocol_user_access a ON a.user_id=u.id WHERE p.token_hash=? AND lower(u.email)=? AND p.revoked_at IS NULL AND u.must_reset_password=0 AND COALESCE(a.enabled,1)=1`)
        .bind(await sessionTag(password), email).first<{
        id: string;
        user_id: string;
        account_hash: string;
        email: string;
        password_hash: string;
    }>();
    if (!row || row.account_hash !== await sessionTag(row.password_hash))
        return c.json({ error: 'Unauthorized' }, 401);
    c.set('userId', row.user_id);
    c.set('userEmail', row.email);
    await centralDB(c.env).prepare("UPDATE protocol_passwords SET last_used_at=? WHERE id=? AND (last_used_at IS NULL OR last_used_at<?)").bind(nowIso(), row.id, new Date(Date.now() - 3600000).toISOString()).run();
    c.env = await mailboxEnv(c.env, row.user_id);
    await next();
});
protocolGateway.get('/auth', c => c.json({ email: c.get('userEmail') }));
protocolGateway.route('/', protocolMailboxRoutes);
