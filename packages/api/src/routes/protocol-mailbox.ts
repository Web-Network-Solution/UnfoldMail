import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env, HonoVariables } from '../types';
import { generateUUIDv7, nowIso, emailBodyTextKey } from '../lib/utils';
import { cleanupProtocolObjects } from '../services/protocol-cleanup';
import { exportProtocolMail, importProtocolMail, ProtocolConflictError, ProtocolInputError } from '../services/protocol-mail';
import { notifyDelivery } from '../services/outbox';
const r = new Hono<{
    Bindings: Env;
    Variables: HonoVariables;
}>();
const allowedFlags = ['\\Seen', '\\Flagged', '\\Answered', '\\Deleted', '\\Draft'];
r.use('*', bodyLimit({ maxSize: 25 * 1024 * 1024 }));
r.use('*', async (c, next) => {
    const p = c.req.header('X-Mail-Protocol');
    const path = c.req.path;
    if (p === 'smtp' && !path.endsWith('/submit'))
        return c.json({ error: 'Not permitted' }, 403);
    if (p === 'pop3' && !(/\/(revision|folders|messages|raw\/[^/]+|pop-delete)$/.test(path)))
        return c.json({ error: 'Not permitted' }, 403);
    await next();
});
r.onError((e, c) => e instanceof ProtocolConflictError ? c.json({ error: e.message }, 409) : e instanceof ProtocolInputError ? c.json({ error: e.message }, 400) : c.json({ error: 'Mailbox operation unavailable; reconnect and retry' }, 503));
r.get('/revision', async (c) => c.json(await c.env.DB.prepare("SELECT COALESCE(MAX(seq),0) revision FROM protocol_changes").first()));
// A single SQL statement reads the journal cursor and current rows atomically.
// An offline client beyond the retained journal receives 409 and does a full resync.
r.get('/changes', async (c) => {
    const folder=c.req.query('folder'),after=Number(c.req.query('after'));
    if (!folder || !Number.isSafeInteger(after) || after<0) throw new ProtocolInputError('Invalid change cursor');
    const row=await c.env.DB.prepare(`SELECT
      (SELECT COALESCE(MAX(seq),0) FROM protocol_changes) revision,
      (SELECT COALESCE(MIN(seq),0) FROM protocol_changes) oldest,
      (SELECT COUNT(*) FROM folders WHERE id=? AND user_id=?) present,
      (SELECT json_group_array(json_object('id',x.email_id,'uid',p.uid,'date',e.received_at,'size',e.size,
        'rawSize',p.raw_size,'seen',e.is_read,'starred',e.is_starred,'answered',p.answered,'deleted',p.deleted,
        'draft',p.draft,'folderType',f.type))
       FROM (SELECT DISTINCT email_id FROM protocol_changes WHERE seq>? AND folder_id=? AND email_id IS NOT NULL LIMIT 1001) x
       LEFT JOIN emails e ON e.id=x.email_id AND e.folder_id=? AND e.user_id=?
       LEFT JOIN protocol_messages p ON p.email_id=e.id LEFT JOIN folders f ON f.id=e.folder_id) changes`)
       .bind(folder,c.get('userId'),after,folder,folder,c.get('userId')).first<{revision:number;oldest:number;present:number;changes:string}>();
    if (!row?.present) return c.json({error:'Folder not found'},404);
    const changed=JSON.parse(row.changes || '[]') as any[];
    if (after<row.oldest-1 || after>row.revision || changed.length>1000) return c.json({error:'Full mailbox resync required'},409);
    return c.json({revision:row.revision,removed:changed.filter(e=>e.uid==null).map(e=>e.id),messages:changed.filter(e=>e.uid!=null).map(e=>({
        id:e.id,uid:e.uid,date:new Date(e.date).toISOString(),size:e.size,rawSize:e.rawSize,
        flags:[e.seen?'\\Seen':'',e.starred?'\\Flagged':'',e.answered?'\\Answered':'',e.deleted?'\\Deleted':'',e.draft || e.folderType==='drafts'?'\\Draft':''].filter(Boolean)
    }))});
});
r.get('/folders', async (c) => {
    const rows = await c.env.DB.prepare(`SELECT f.id,f.name,f.type,COALESCE(s.subscribed,1) subscribed FROM folders f LEFT JOIN protocol_subscriptions s ON s.folder_id=f.id WHERE f.user_id=? ORDER BY f.name`).bind(c.get('userId')).all();
    return c.json({ folders: rows.results.filter((f: any) => c.req.header('X-Mail-Protocol') !== 'pop3' || f.type === 'inbox') });
});
r.post('/folders', async (c) => {
    const b = await c.req.json();
    if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 60 || /[\r\n\x00-\x1f]/.test(b.name) || ['inbox', 'sent', 'drafts', 'trash', 'archive'].includes(b.name.toLowerCase()))
        throw new ProtocolInputError('Invalid or reserved folder name');
    const id = generateUUIDv7();
    await c.env.DB.prepare("INSERT INTO folders(id,user_id,name,type) VALUES(?,?,?,'custom')").bind(id, c.get('userId'), b.name.trim()).run();
    return c.json({ id });
});
r.patch('/folders/:id', async (c) => {
    const b = await c.req.json(), id = c.req.param('id');
    const f = await c.env.DB.prepare('SELECT type FROM folders WHERE id=? AND user_id=?').bind(id, c.get('userId')).first<{
        type: string;
    }>();
    if (!f)
        return c.json({ error: 'Not found' }, 404);
    if (typeof b.subscribed === 'boolean') {
        await c.env.DB.prepare('INSERT INTO protocol_subscriptions(folder_id,subscribed) VALUES(?,?) ON CONFLICT(folder_id) DO UPDATE SET subscribed=excluded.subscribed').bind(id, b.subscribed ? 1 : 0).run();
    }
    else {
        if (f.type !== 'custom' || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 60 || /[\r\n\x00-\x1f]/.test(b.name) || ['inbox', 'sent', 'drafts', 'trash', 'archive'].includes(b.name.toLowerCase()))
            throw new ProtocolInputError('Invalid folder rename');
        await c.env.DB.prepare('UPDATE folders SET name=? WHERE id=? AND user_id=?').bind(b.name.trim(), id, c.get('userId')).run();
    }
    return c.json({ ok: true });
});
r.delete('/folders/:id', async (c) => {
    const id = c.req.param('id'), f = await c.env.DB.prepare('SELECT type FROM folders WHERE id=? AND user_id=?').bind(id, c.get('userId')).first<{
        type: string;
    }>();
    if (!f || f.type !== 'custom')
        throw new ProtocolInputError('Only custom folders can be removed');
    if (await c.env.DB.prepare('SELECT id FROM emails WHERE folder_id=? LIMIT 1').bind(id).first())
        throw new ProtocolInputError('Empty the folder before removing it');
    await c.env.DB.prepare('DELETE FROM folders WHERE id=? AND user_id=?').bind(id, c.get('userId')).run();
    return c.json({ ok: true });
});
r.get('/messages', async (c) => {
    const folder = c.req.query('folder'), after = Number(c.req.query('after') || 0);
    if (!folder || !Number.isSafeInteger(after) || after < 0)
        throw new ProtocolInputError('Invalid page');
    const f = await c.env.DB.prepare('SELECT type FROM folders WHERE id=? AND user_id=?').bind(folder, c.get('userId')).first<{
        type: string;
    }>();
    if (!f)
        return c.json({ error: 'Not found' }, 404);
    if (c.req.header('X-Mail-Protocol') === 'pop3' && f.type !== 'inbox')
        return c.json({ error: 'Inbox only' }, 403);
    const rows = await c.env.DB.prepare(`SELECT p.uid,e.id,e.received_at,e.size,e.is_read,e.is_starred,p.answered,p.deleted,p.draft,p.raw_size FROM protocol_messages p JOIN emails e ON e.id=p.email_id WHERE e.user_id=? AND e.folder_id=? AND p.uid>? ORDER BY p.uid LIMIT 500`).bind(c.get('userId'), folder, after).all<any>();
    const seq = await c.env.DB.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='protocol_messages'),0)+1 next, (SELECT MAX(uid) FROM protocol_messages) n").first<{
        next: number;
    }>();
    return c.json({ next: seq?.next || 1, messages: rows.results.map(e => ({ uid: e.uid, id: e.id, date: new Date(e.received_at).toISOString(), size: e.size, rawSize: e.raw_size, flags: [e.is_read ? '\\Seen' : '', e.is_starred ? '\\Flagged' : '', e.answered ? '\\Answered' : '', e.deleted ? '\\Deleted' : '', e.draft || f.type === 'drafts' ? '\\Draft' : ''].filter(Boolean) })) });
});
r.get('/raw/:id', async (c) => {
    const uid = Number(c.req.query('uid'));
    if (!Number.isSafeInteger(uid) || uid < 1)
        throw new ProtocolInputError('Message UID required');
    if (c.req.header('X-Mail-Protocol') === 'pop3' && !await c.env.DB.prepare("SELECT e.id FROM emails e JOIN folders f ON f.id=e.folder_id WHERE e.id=? AND e.user_id=? AND f.type='inbox'").bind(c.req.param('id'), c.get('userId')).first())
        return c.json({ error: 'Not found' }, 404);
    const raw = await exportProtocolMail(c.env, c.get('userId'), c.req.param('id'), uid);
    if (!raw)
        return c.json({ error: 'Not found' }, 404);
    return new Response(raw, { headers: { 'Content-Type': 'message/rfc822', 'Cache-Control': 'no-store' } });
});
r.patch('/flags/:id', async (c) => {
    const b = await c.req.json(), op = b.operation || 'set';
    if (!['set', 'add', 'remove'].includes(op) || !Array.isArray(b.flags) || b.flags.some((f: unknown) => typeof f !== 'string' || !allowedFlags.includes(f)))
        throw new ProtocolInputError('Unsupported flags');
    const id = c.req.param('id'), uid = Number(c.req.query('uid'));
    if (!Number.isSafeInteger(uid) || uid < 1)
        throw new ProtocolInputError('Message UID required');
    const expr = (column: string, flag: string) => op === 'set' ? (b.flags.includes(flag) ? '1' : '0') : b.flags.includes(flag) ? (op === 'add' ? '1' : '0') : column;
    await c.env.DB.batch([c.env.DB.prepare(`UPDATE emails SET is_read=${expr('is_read', '\\Seen')},is_starred=${expr('is_starred', '\\Flagged')} WHERE id=? AND user_id=? AND EXISTS(SELECT 1 FROM protocol_messages WHERE email_id=? AND uid=?)`).bind(id, c.get('userId'), id, uid), c.env.DB.prepare(`UPDATE protocol_messages SET answered=${expr('answered', '\\Answered')},deleted=${expr('deleted', '\\Deleted')},draft=${expr('draft', '\\Draft')} WHERE email_id=? AND uid=? AND EXISTS(SELECT 1 FROM emails WHERE id=? AND user_id=?)`).bind(id, uid, id, c.get('userId'))]);
    const row = await c.env.DB.prepare('SELECT e.is_read,e.is_starred,p.answered,p.deleted,p.draft FROM emails e JOIN protocol_messages p ON p.email_id=e.id WHERE e.id=? AND e.user_id=? AND p.uid=?').bind(id, c.get('userId'), uid).first<any>();
    if (!row)
        return c.json({ error: 'Not found' }, 404);
    await notifyDelivery(c.env, c.get('userId'));
    return c.json({ flags: [row.is_read ? '\\Seen' : '', row.is_starred ? '\\Flagged' : '', row.answered ? '\\Answered' : '', row.deleted ? '\\Deleted' : '', row.draft ? '\\Draft' : ''].filter(Boolean) });
});
r.post('/append', async (c) => {
    const folder = c.req.query('folder') || '', flags = (c.req.header('X-Mail-Flags') || '').split(',').filter(Boolean), date = c.req.header('X-Mail-Date') || nowIso();
    if (flags.some(f => !allowedFlags.includes(f)) || !Number.isFinite(Date.parse(date)))
        throw new ProtocolInputError('Invalid flags or date');
    const id = await importProtocolMail(c.env, c.get('userId'), c.get('userEmail'), new Uint8Array(await c.req.arrayBuffer()), folder, flags, new Date(date).toISOString(), undefined, c.req.header('X-Request-ID'));
    await notifyDelivery(c.env, c.get('userId'));
    return c.json({ id });
});
r.post('/submit', async (c) => {
    if (c.req.header('X-Mail-Protocol') !== 'smtp')
        return c.json({ error: 'SMTP access required' }, 403);
    let recipients: string[];
    try {
        recipients = JSON.parse(c.req.header('X-Mail-Recipients') || '[]');
    }
    catch {
        throw new ProtocolInputError('Invalid recipients');
    }
    if (!Array.isArray(recipients) || recipients.some(x => typeof x !== 'string'))
        throw new ProtocolInputError('Invalid recipients');
    const folder = await c.env.DB.prepare("SELECT id FROM folders WHERE user_id=? AND type='sent'").bind(c.get('userId')).first<{
        id: string;
    }>();
    if (!folder)
        throw Error('Sent missing');
    const id = await importProtocolMail(c.env, c.get('userId'), c.get('userEmail'), new Uint8Array(await c.req.arrayBuffer()), folder.id, ['\\Seen'], nowIso(), recipients);
    await notifyDelivery(c.env, c.get('userId'));
    return c.json({ id });
});
async function remove(env: Env, userId: string, id: string, pop: boolean, uid?: number) {
    const e = await env.DB.prepare(`SELECT e.r2_body_key FROM emails e JOIN folders f ON f.id=e.folder_id JOIN protocol_messages p ON p.email_id=e.id WHERE e.id=? AND e.user_id=? AND ${pop ? "f.type='inbox'" : "p.deleted=1 AND p.uid=?"}`).bind(...(pop ? [id, userId] : [id, userId, uid!])).first<{
        r2_body_key: string;
    }>();
    if (!e)
        return false;
    if (await env.DB.prepare("SELECT email_id FROM outbound_jobs WHERE email_id=? AND status IN ('queued','sending','uncertain')").bind(id).first())
        throw new ProtocolInputError('Resolve pending delivery before deleting');
    const a = await env.DB.prepare('SELECT r2_key FROM attachments WHERE email_id=?').bind(id).all<{
        r2_key: string;
    }>();
    const cleanupId = crypto.randomUUID();
    const keys = [e.r2_body_key, emailBodyTextKey(userId, id, e.r2_body_key), e.r2_body_key.replace(/body\.html$/, 'protocol.eml'), ...a.results.map(x => x.r2_key)];
    const result = await env.DB.batch([env.DB.prepare(`DELETE FROM emails WHERE id=? AND user_id=? AND ${pop ? "folder_id IN (SELECT id FROM folders WHERE type='inbox')" : "EXISTS(SELECT 1 FROM protocol_messages WHERE email_id=? AND uid=? AND deleted=1)"} AND NOT EXISTS(SELECT 1 FROM outbound_jobs WHERE email_id=? AND status IN ('queued','sending','uncertain'))`).bind(...(pop ? [id, userId, id] : [id, userId, id, uid!, id])), env.DB.prepare('DELETE FROM emails_fts WHERE email_id=? AND NOT EXISTS(SELECT 1 FROM emails WHERE id=?)').bind(id, id), env.DB.prepare('INSERT INTO protocol_object_gc(id,email_id,keys_json,not_before) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM emails WHERE id=?)').bind(cleanupId, id, JSON.stringify(keys), nowIso(), id)]);
    if (!result[0].meta.changes)
        return false;
    await cleanupProtocolObjects(env, cleanupId);
    return true;
}
r.post('/expunge', async (c) => {
    const b = await c.req.json();
    if (!Array.isArray(b.ids) || b.ids.length > 100 || b.ids.some((x: unknown) => typeof x !== 'string'))
        throw new ProtocolInputError('Invalid message IDs');
    const deleted: string[] = [];
    for (const id of b.ids) {
        const uid = b.uids?.[id];
        if (!Number.isSafeInteger(uid) || uid < 1)
            throw new ProtocolInputError('Message UID required');
        if (await remove(c.env, c.get('userId'), id, false, uid))
            deleted.push(id);
    }
    await notifyDelivery(c.env, c.get('userId'));
    return c.json({ deleted });
});
r.post('/pop-delete', async (c) => {
    const b = await c.req.json();
    if (c.req.header('X-Mail-Protocol') !== 'pop3' || !Array.isArray(b.ids) || b.ids.length > 100 || b.ids.some((x: unknown) => typeof x !== 'string'))
        throw new ProtocolInputError('Invalid deletion');
    for (const id of b.ids)
        await remove(c.env, c.get('userId'), id, true);
    return c.json({ ok: true });
});
export { r as protocolMailboxRoutes };
