import { cleanupProtocolObjects } from './protocol-cleanup';
import PostalMime from 'postal-mime';
import type { Env } from '../types';
import { emailBodyKey, emailBodyTextKey, generateUUIDv7, nowIso, sessionTag, isValidEmail, extractSnippet } from '../lib/utils';
import { ftsInsertStatement } from '../lib/fts';
import { MAX_OUTBOUND_MESSAGE_SIZE, MAX_RECIPIENTS, encodedMessageBytes } from '@email-service/shared';
import type { OutboundPayload } from './outbox';
import { sharedFileStatements, retainSharedFiles } from './shared-files';
const clean = (s: unknown) => String(s || '').replace(/[\r\n\x00-\x1f]/g, ' ');
const b64 = (b: Uint8Array) => {
    let s = '';
    for (let i = 0; i < b.length; i += 8192)
        s += String.fromCharCode(...b.subarray(i, i + 8192));
    return btoa(s);
};
const encoded = (s: string) => {
    const words: string[] = [];
    let chunk = '';
    for (const char of clean(s)) {
        if (new TextEncoder().encode(chunk + char).length > 30) {
            words.push('=?UTF-8?B?' + b64(new TextEncoder().encode(chunk)) + '?=');
            chunk = '';
        }
        chunk += char;
    }
    if (chunk)
        words.push('=?UTF-8?B?' + b64(new TextEncoder().encode(chunk)) + '?=');
    return words.join('\r\n ');
};
const block = (b: Uint8Array) => b64(b).match(/.{1,76}/g)?.join('\r\n') || '';
const addresses = (s: string) => {
    try {
        return JSON.parse(s).map((a: {
            name?: string;
            email: string;
        }) => (a.name ? encoded(a.name) + ' ' : '') + '<' + clean(a.email).replace(/[<>]/g, '') + '>').join(',\r\n ');
    }
    catch {
        return '';
    }
};
/** Deterministic MIME export for existing normalized webmail records. */
export async function exportProtocolMail(env: Env, userId: string, id: string, expectedUid?: number): Promise<Uint8Array | null> {
    const e = await env.DB.prepare('SELECT e.*,p.uid AS protocol_uid FROM emails e JOIN protocol_messages p ON p.email_id=e.id WHERE e.id=? AND e.user_id=?').bind(id, userId).first<Record<string, any>>();
    if (!e)
        return null;
    if (expectedUid !== undefined && e.protocol_uid !== expectedUid)
        throw new ProtocolConflictError('Message changed; refresh the mailbox');
    const finish = async (bytes: Uint8Array) => {
        // R2 reads await network I/O: recheck after reading to catch concurrent edits/moves.
        const current = await env.DB.prepare('SELECT uid FROM protocol_messages WHERE email_id=?').bind(id).first<{
            uid: number;
        }>();
        if (current?.uid !== e.protocol_uid)
            throw new ProtocolConflictError('Message changed; refresh the mailbox');
        await env.DB.prepare('UPDATE protocol_messages SET raw_size=? WHERE email_id=? AND uid=?').bind(bytes.length, id, e.protocol_uid).run();
        return bytes;
    };
    const body = await env.EMAIL_BUCKET.get(e.r2_body_key), text = await env.EMAIL_BUCKET.get(emailBodyTextKey(userId, id, e.r2_body_key));
    if (!body || !text)
        throw Error('Message storage unavailable');
    const raw = /body\.html$/.test(e.r2_body_key) ? await env.EMAIL_BUCKET.get(e.r2_body_key.replace(/body\.html$/, 'protocol.eml')) : null;
    if (raw) {
        const bytes = new Uint8Array(await raw.arrayBuffer());
        return finish(bytes);
    }
    const boundary = 'rwa_' + id.replace(/[^a-zA-Z0-9]/g, '');
    const lines = [`From: ${e.sender_name ? encoded(e.sender_name) + ' ' : ''}<${clean(e.sender).replace(/[<>]/g, '')}>`, `To: ${addresses(e.recipients_to)}`];
    if (e.recipients_cc !== '[]')
        lines.push('Cc: ' + addresses(e.recipients_cc));
    lines.push('Subject: ' + encoded(e.subject), 'Date: ' + new Date(e.received_at).toUTCString(), 'Message-ID: ' + clean(e.message_id || `<${id}@${env.EMAIL_DOMAIN}>`));
    if (e.in_reply_to)
        lines.push('In-Reply-To: ' + clean(e.in_reply_to));
    if (e.references_chain)
        lines.push('References: ' + clean(e.references_chain));
    lines.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`, '');
    lines.push(`--${boundary}`, `Content-Type: multipart/alternative; boundary="${boundary}_alt"`, '');
    for (const [kind, value] of [['plain', await text.text()], ['html', await body.text()]])
        lines.push(`--${boundary}_alt`, `Content-Type: text/${kind}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', block(new TextEncoder().encode(value)));
    lines.push(`--${boundary}_alt--`);
    const parts = await env.DB.prepare('SELECT * FROM attachments WHERE email_id=? ORDER BY id').bind(id).all<Record<string, any>>();
    for (const a of parts.results) {
        const obj = await env.EMAIL_BUCKET.get(a.r2_key);
        if (!obj)
            throw Error('Attachment storage unavailable');
        lines.push(`--${boundary}`, 'Content-Type: ' + clean(a.mime_type), 'Content-Transfer-Encoding: base64', `Content-Disposition: ${a.disposition === 'inline' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
        if (a.content_id)
            lines.push('Content-ID: <' + clean(a.content_id).replace(/[<>]/g, '') + '>');
        lines.push('', block(new Uint8Array(await obj.arrayBuffer())));
    }
    lines.push(`--${boundary}--`, '');
    const bytes = new TextEncoder().encode(lines.join('\r\n'));
    return finish(bytes);
}
export class ProtocolInputError extends Error {
}
export class ProtocolConflictError extends Error {
}
async function resumeSubmission(env: Env, id: string, userId: string): Promise<string> {
    // A known rejection can be retried; unknown provider acceptance must never be resent automatically.
    await env.DB.batch([
        env.DB.prepare("UPDATE outbound_jobs SET status='queued',attempts=0,next_attempt_at=?,updated_at=? WHERE email_id=? AND user_id=? AND status='failed'").bind(nowIso(), nowIso(), id, userId),
        env.DB.prepare("UPDATE emails SET delivery_status='queued',delivery_error=NULL WHERE id=? AND user_id=? AND delivery_status='failed' AND EXISTS(SELECT 1 FROM outbound_jobs WHERE email_id=? AND status='queued')").bind(id, userId, id),
        env.DB.prepare("DELETE FROM protocol_notices WHERE email_id=? AND status='failed' AND EXISTS(SELECT 1 FROM outbound_jobs WHERE email_id=? AND status='queued')").bind(id, id),
    ]);
    const job = await env.DB.prepare('SELECT status FROM outbound_jobs WHERE email_id=? AND user_id=?').bind(id, userId).first<{
        status: string;
    }>();
    if (job?.status === 'uncertain')
        throw new ProtocolConflictError('Delivery is uncertain; check with the recipient before retrying');
    if (!job || !['queued', 'sending', 'sent'].includes(job.status))
        throw new Error('Submission unavailable');
    if (job.status === 'queued') {
        try {
            await env.OUTBOUND_QUEUE.send({ kind: 'outbound', emailId: id, userId });
        }
        catch { /* Alarm repairs publication. */ }
    }
    return id;
}
export async function importProtocolMail(env: Env, userId: string, userEmail: string, raw: Uint8Array, folderId: string, flags: string[], date: string, recipients?: string[], requestId?: string) {
    const sending = !!recipients;
    const parsed = await PostalMime.parse(raw.buffer as ArrayBuffer);
    if (sending && (!parsed.from?.address || parsed.from.address.toLowerCase() !== userEmail.toLowerCase() || !userEmail.toLowerCase().endsWith('@' + env.EMAIL_DOMAIN.toLowerCase())))
        throw new ProtocolInputError('From address must match your mailbox');
    if (sending && (!recipients!.length || recipients!.length > MAX_RECIPIENTS || recipients!.some(x => !isValidEmail(x))))
        throw new ProtocolInputError('Invalid recipients');
    const folder = await env.DB.prepare('SELECT id,type FROM folders WHERE id=? AND user_id=?').bind(folderId, userId).first<{
        id: string;
        type: string;
    }>();
    if (!folder)
        throw new ProtocolInputError('Folder not found');
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)), byte => byte.toString(16).padStart(2, '0')).join('');
    const key = sending ? 'smtp-' + await sessionTag(digest + '\n' + JSON.stringify([...new Set(recipients!.map(x => x.toLowerCase()))].sort())) : requestId;
    if (!key || key.length > 150)
        throw new ProtocolInputError('Request ID required');
    const saved = await env.DB.prepare('SELECT email_id FROM protocol_imports WHERE request_id=?').bind(key).first<{
        email_id: string;
    }>();
    if (saved)
        return sending ? resumeSubmission(env, saved.email_id, userId) : saved.email_id;
    // Outlook commonly APPENDs the exact submitted MIME to Sent. Reuse the durable sent copy.
    if (!sending && folder.type === 'sent') {
        const sent = await env.DB.prepare('SELECT p.email_id FROM protocol_imports p JOIN emails e ON e.id=p.email_id WHERE p.request_id=? AND e.folder_id=?').bind('sentcopy-' + digest, folderId).first<{
            email_id: string;
        }>();
        if (sent)
            return sent.email_id;
    }
    const id = generateUUIDv7(), bodyKey = emailBodyKey(userId, id), textKey = emailBodyTextKey(userId, id), rawKey = bodyKey.replace(/body\.html$/, 'protocol.eml');
    const bodyHtml = parsed.html || '', bodyText = parsed.text || '', subject = parsed.subject || '';
    const flattened = (items: any[] | undefined): {
        email: string;
        name?: string;
    }[] => (items || []).flatMap(a => a.group ? flattened(a.group) : a.address ? [{ email: a.address, name: a.name }] : []);
    const to = flattened(parsed.to), cc = flattened(parsed.cc), bcc = flattened(parsed.bcc);
    const replies = flattened(parsed.replyTo);
    if (sending && (replies.length > 1 || replies.some(a => !isValidEmail(a.email))))
        throw new ProtocolInputError('Use one valid Reply-To address');
    const att = parsed.attachments.map(a => ({ id: crypto.randomUUID(), filename: a.filename || 'attachment', mimeType: a.mimeType, size: (a.content as ArrayBuffer).byteLength, content: a.content as ArrayBuffer, disposition: a.disposition === 'inline' ? 'inline' as const : 'attachment' as const, contentId: a.contentId, r2Key: '' }));
    att.forEach(a => a.r2Key = `attachments/${userId}/${id}/${a.id}`);
    const size = encodedMessageBytes(new TextEncoder().encode(bodyHtml + bodyText).byteLength) + 16384 + att.reduce((n, a) => n + encodedMessageBytes(a.size) + 300, 0);
    if (sending && (size > MAX_OUTBOUND_MESSAGE_SIZE || att.length > 32))
        throw new ProtocolInputError('Message exceeds the Cloudflare sending limit');
    const shared = await sharedFileStatements(env, id, userId, bodyHtml, bodyText);
    const cleanupId = crypto.randomUUID();
    const keys = [bodyKey, textKey, rawKey, ...att.map(a => a.r2Key)];
    // Record before the first write. A crashed import is collected after a grace period.
    await env.DB.prepare('INSERT INTO protocol_object_gc(id,email_id,keys_json,not_before) VALUES(?,?,?,?)')
        .bind(cleanupId, id, JSON.stringify(keys), new Date(Date.now() + 86400000).toISOString()).run();
    try {
        await env.EMAIL_BUCKET.put(bodyKey, bodyHtml);
        await env.EMAIL_BUCKET.put(textKey, bodyText);
        await env.EMAIL_BUCKET.put(rawKey, raw);
        for (const a of att)
            await env.EMAIL_BUCKET.put(a.r2Key, a.content);
        const parent = parsed.inReplyTo ? await env.DB.prepare('SELECT thread_id FROM emails WHERE user_id=? AND message_id=? LIMIT 1').bind(userId, parsed.inReplyTo).first<{
            thread_id: string;
        }>() : null;
        const statements = [
            env.DB.prepare("INSERT INTO mailbox_write_guard(valid) SELECT CASE WHEN EXISTS(SELECT 1 FROM protocol_object_gc WHERE id=? AND state='pending') THEN 1 ELSE 0 END").bind(cleanupId),
            env.DB.prepare('DELETE FROM mailbox_write_guard'),
            env.DB.prepare(`INSERT INTO emails(id,thread_id,folder_id,user_id,sender,sender_name,recipients_to,recipients_cc,recipients_bcc,subject,snippet,r2_body_key,is_read,is_starred,has_attachments,size,message_id,in_reply_to,references_chain,received_at,is_archived,trashed_at,delivery_status)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, parent?.thread_id || id, folderId, userId, parsed.from?.address || userEmail, parsed.from?.name || '', JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, extractSnippet(bodyText || bodyHtml), bodyKey, flags.includes('\\Seen') ? 1 : 0, flags.includes('\\Flagged') ? 1 : 0, att.length ? 1 : 0, raw.length, parsed.messageId || null, parsed.inReplyTo || null, parsed.references || null, date, folder.type === 'archive' ? 1 : 0, folder.type === 'trash' ? nowIso() : null, sending ? 'queued' : null),
            env.DB.prepare('UPDATE protocol_messages SET answered=?,deleted=?,draft=?,raw_size=? WHERE email_id=?').bind(flags.includes('\\Answered') ? 1 : 0, flags.includes('\\Deleted') ? 1 : 0, flags.includes('\\Draft') ? 1 : 0, raw.length, id),
            env.DB.prepare('INSERT INTO protocol_imports(request_id,email_id) VALUES(?,?)').bind(key, id), ftsInsertStatement(env.DB, { emailId: id, userId, subject, sender: parsed.from?.address || userEmail, snippet: extractSnippet(bodyText || bodyHtml) }), ...shared
        ];
        for (const a of att)
            statements.push(env.DB.prepare('INSERT INTO attachments(id,email_id,filename,mime_type,size,r2_key,content_id,disposition) VALUES(?,?,?,?,?,?,?,?)').bind(a.id, id, a.filename, a.mimeType, a.size, a.r2Key, a.contentId || null, a.disposition));
        if (sending) {
            statements.push(env.DB.prepare('INSERT OR IGNORE INTO protocol_imports(request_id,email_id) VALUES(?,?)').bind('sentcopy-' + digest, id));
            const allowed = new Set(recipients!.map(x => x.toLowerCase()));
            const visibleTo = to.filter(a => allowed.has(a.email.toLowerCase())), visibleCC = cc.filter(a => allowed.has(a.email.toLowerCase()));
            const visible = new Set([...visibleTo, ...visibleCC].map(a => a.email.toLowerCase()));
            const payload: OutboundPayload = { from: { email: userEmail }, to: visibleTo, cc: visibleCC, bcc: recipients!.filter(x => !visible.has(x.toLowerCase())).map(email => ({ email })), subject, bodyKey, replyTo: replies[0]?.email, inReplyTo: parsed.inReplyTo, references: parsed.references, attachments: att.map(({ content, ...a }) => a) };
            statements.push(env.DB.prepare('INSERT INTO outbound_jobs(email_id,user_id,payload,request_id,next_attempt_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id, userId, JSON.stringify(payload), key, nowIso(), nowIso()));
        }
        statements.push(env.DB.prepare("DELETE FROM protocol_object_gc WHERE id=? AND state='pending'").bind(cleanupId));
        await env.DB.batch(statements);
    }
    catch (error) {
        // A timed-out RPC may have committed. Preserve objects until its identity can be checked.
        const winner = await env.DB.prepare('SELECT email_id FROM protocol_imports WHERE request_id=?').bind(key).first<{
            email_id: string;
        }>();
        if (winner?.email_id === id)
            return sending ? resumeSubmission(env, id, userId) : id;
        // Read succeeded, so this import did not commit. Expedite its durable cleanup.
        await env.DB.prepare('UPDATE protocol_object_gc SET not_before=? WHERE id=?').bind(nowIso(), cleanupId).run();
        await cleanupProtocolObjects(env, cleanupId);
        if (winner)
            return sending ? resumeSubmission(env, winner.email_id, userId) : winner.email_id;
        throw error;
    }
    if (sending) {
        await retainSharedFiles(env, bodyHtml, bodyText);
        try {
            await env.OUTBOUND_QUEUE.send({ kind: 'outbound', emailId: id, userId });
        }
        catch { /* Mailbox alarm repairs publication. */ }
    }
    return id;
}
/** A locally delivered failure notice: SMTP acceptance means queued, not final delivery. */
export async function repairProtocolNotices(env: Env, userId: string) {
    const rows = await env.DB.prepare(`SELECT j.email_id,j.status,e.subject FROM outbound_jobs j JOIN emails e ON e.id=j.email_id
 WHERE j.user_id=? AND j.request_id LIKE 'smtp-%' AND j.status IN ('failed','uncertain')
 AND NOT EXISTS(SELECT 1 FROM protocol_notices p WHERE p.email_id=j.email_id AND p.status=j.status) LIMIT 5`).bind(userId).all<{
        email_id: string;
        status: string;
        subject: string;
    }>();
    if (!rows.results.length)
        return;
    const user = await (env.CONTROL_DB || env.DB).prepare('SELECT email FROM users WHERE id=?').bind(userId).first<{
        email: string;
    }>();
    const inbox = await env.DB.prepare("SELECT id FROM folders WHERE user_id=? AND type='inbox'").bind(userId).first<{
        id: string;
    }>();
    if (!user || !inbox)
        return;
    for (const row of rows.results) {
        const subject = (row.status === 'failed' ? 'Delivery failed: ' : 'Check delivery: ') + row.subject;
        const text = row.status === 'failed' ? 'Your message was accepted for sending, but delivery failed. Open Sent in webmail to review the error and retry.' : 'Delivery of your message could not be confirmed. Check with the recipient before retrying to avoid duplicate delivery. Open Sent in webmail to review its status.';
        const raw = new TextEncoder().encode([`From: Mail delivery <${user.email}>`, `To: <${user.email}>`, 'Subject: ' + encoded(subject), 'Date: ' + new Date().toUTCString(), `Message-ID: <notice-${row.email_id}-${row.status}@${env.EMAIL_DOMAIN}>`, 'Auto-Submitted: auto-replied', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', block(new TextEncoder().encode(text + '\n\nOriginal subject: ' + row.subject + '\nReference: ' + row.email_id)), ''].join('\r\n'));
        await importProtocolMail(env, userId, user.email, raw, inbox.id, [], nowIso(), undefined, 'notice-' + row.email_id + '-' + row.status);
        await env.DB.prepare('INSERT OR IGNORE INTO protocol_notices(email_id,status) VALUES(?,?)').bind(row.email_id, row.status).run();
    }
}
