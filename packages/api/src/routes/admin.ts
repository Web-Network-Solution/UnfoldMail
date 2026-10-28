import { mailboxMetrics, readMailboxReports } from '../services/mailbox-reporting';
import { cleanupDeletedMailbox } from '../services/mailbox-deletion';
import type { Database } from "../services/mailbox-storage";
import { meetingProviders } from '@email-service/shared';
import { enabledMeetingProviders } from '../services/meeting-policy';
import { Hono } from 'hono';
import { formPart, type Env, type HonoVariables } from '../types';
import {
  generateUUIDv7,
  hashPassword,
  isValidEmail,
  nowIso,
  parseCsvUsers,
  revokeSockets,
} from '../lib/utils';
import { mapUser, type UserRow } from '../lib/mappers';
import { mailboxEnv } from '../services/mailbox-storage';
import { MIN_PASSWORD_LENGTH } from '@email-service/shared';

const admin = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

/** Bulk import runs PBKDF2 per row; cap the batch so one request cannot blow the CPU budget. */
const MAX_BULK_USERS = 100;

/** A concurrent create for the same address loses the race at the UNIQUE index. */
const isDuplicateEmail = (error: unknown) => /UNIQUE constraint failed: users\.email/.test(String(error));

async function countSuperAdmins(db: Database, excludingUserId?: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS count FROM users WHERE role = 'super_admin' AND id != ?`)
    .bind(excludingUserId || '')
    .first<{ count: number }>();
  return row?.count || 0;
}

// ─── List All Users ───────────────────────────────────────────────

admin.get('/users', async (c) => {
  const requesterRole = c.get('userRole');
  const db = c.env.DB;

  const [userResult, metrics, sharedStorageResult] = await Promise.all([
    db.prepare(`SELECT id,email,display_name,role,must_reset_password,signature_html,created_at,updated_at FROM users ORDER BY created_at DESC`).all<UserRow>(),
    mailboxMetrics(c.env),
    db.prepare('SELECT user_id,COALESCE(SUM(size),0) AS total_size FROM shared_files GROUP BY user_id').all<{user_id:string;total_size:number}>(),
  ]);
  const sentMap = new Map(metrics.map(m=>[m.user_id,m.sent]));
  const receivedMap = new Map(metrics.map(m=>[m.user_id,m.received]));
  const attachMap = new Map(metrics.map(m=>[m.user_id,m.attachment_bytes]));
  const sharedMap = new Map(sharedStorageResult.results.map(m=>[m.user_id,m.total_size]));

  // Admin users cannot see super_admin users
  const users = userResult.results
    .filter((u) => requesterRole === 'super_admin' || u.role !== 'super_admin')
    .map((u) => ({
      ...mapUser(u),
      totalSent: sentMap.get(u.id) || 0,
      totalReceived: receivedMap.get(u.id) || 0,
      storageUsed: (attachMap.get(u.id) || 0) + (sharedMap.get(u.id) || 0),
    }));

  return c.json({ success: true, data: users });
});

// ─── Create Single User ──────────────────────────────────────────

admin.post('/users', async (c) => {
  const { email, displayName, password, role, mustResetPassword } = await c.req
    .json<{
      email?: string;
      displayName?: string;
      password?: string;
      role?: string;
      mustResetPassword?: boolean;
    }>()
    .catch(() => ({}) as never);

  if (!email || !displayName || !password) {
    return c.json({ success: false, error: 'Email, displayName, and password are required' }, 400);
  }

  const normalizedEmail = email.toLowerCase().trim();

  if (!isValidEmail(normalizedEmail)) {
    return c.json({ success: false, error: 'Invalid email address' }, 400);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400
    );
  }
  const validRoles = ['super_admin', 'admin', 'employee'];
  if (role !== undefined && !validRoles.includes(role)) {
    return c.json({ success: false, error: "Role must be 'super_admin', 'admin', or 'employee'" }, 400);
  }

  // Admin users can only create employees
  const requesterRole = c.get('userRole');
  if (requesterRole !== 'super_admin' && role && role !== 'employee') {
    return c.json({ success: false, error: 'Only super admins can create admin or super admin users' }, 403);
  }

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(normalizedEmail)
    .first();

  if (existing) {
    return c.json({ success: false, error: 'A user with this email already exists' }, 409);
  }

  const userId = generateUUIDv7();
  const timestamp = nowIso();

  const inserted = await c.env.DB.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, role, must_reset_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      userId,
      normalizedEmail,
      displayName.trim(),
      await hashPassword(password),
      role || 'employee',
      mustResetPassword ? 1 : 0,
      timestamp,
      timestamp
    )
    .run()
    .catch((error) => { if (isDuplicateEmail(error)) return null; throw error; });

  if (!inserted) {
    return c.json({ success: false, error: 'A user with this email already exists' }, 409);
  }

  await mailboxEnv(c.env, userId).catch(error => console.error('Account created; mailbox provisioning will retry', {userId,error}));

  return c.json(
    {
      success: true,
      data: {
        id: userId,
        email: normalizedEmail,
        displayName: displayName.trim(),
        role: role || 'employee',
        mustResetPassword: !!mustResetPassword,
      },
    },
    201
  );
});

// ─── Bulk Import Users (CSV) ──────────────────────────────────────

admin.post('/users/bulk', async (c) => {
  const contentType = c.req.header('Content-Type') || '';
  let csvContent: string | null = null;

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    const csvFile = formPart(formData, 'csv');
    const csvText = formPart(formData, 'csvText');
    csvContent =
      csvFile && typeof csvFile !== 'string'
        ? await csvFile.text()
        : typeof csvText === 'string'
          ? csvText
          : null;
  } else {
    const body = await c.req.json<{ csvContent?: string }>().catch(() => ({}) as never);
    csvContent = body.csvContent || null;
  }

  if (!csvContent) {
    return c.json({ success: false, error: 'CSV file or csvContent is required' }, 400);
  }

  let users;
  try {
    users = parseCsvUsers(csvContent);
  } catch (err) {
    return c.json(
      { success: false, error: `CSV parsing error: ${err instanceof Error ? err.message : 'invalid'}` },
      400
    );
  }

  if (users.length === 0) {
    return c.json({ success: false, error: 'No valid users found in CSV' }, 400);
  }
  if (users.length > MAX_BULK_USERS) {
    return c.json(
      {
        success: false,
        error: `A single import is limited to ${MAX_BULK_USERS} users (received ${users.length}). Split the file.`,
      },
      400
    );
  }

  const results: { email: string; status: 'created' | 'skipped'; reason?: string }[] = [];

  // Existing addresses in one query rather than one round trip per row.
  const existingRows = await c.env.DB.prepare('SELECT email FROM users').all<{ email: string }>();
  const taken = new Set(existingRows.results.map((r) => r.email));

  for (const user of users) {
    if (!isValidEmail(user.email)) {
      results.push({ email: user.email, status: 'skipped', reason: 'Invalid email address' });
      continue;
    }
    if (!user.displayName) {
      results.push({ email: user.email, status: 'skipped', reason: 'Missing displayName' });
      continue;
    }
    if (user.password.length < MIN_PASSWORD_LENGTH) {
      results.push({
        email: user.email,
        status: 'skipped',
        reason: `Password shorter than ${MIN_PASSWORD_LENGTH} characters`,
      });
      continue;
    }
    if (taken.has(user.email)) {
      results.push({ email: user.email, status: 'skipped', reason: 'Already exists' });
      continue;
    }

    const userId = generateUUIDv7();
    const timestamp = nowIso();

    const inserted = await c.env.DB.prepare(
      `INSERT INTO users (id, email, display_name, password_hash, role, must_reset_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'employee', ?, ?, ?)`
    )
      .bind(
        userId,
        user.email,
        user.displayName,
        await hashPassword(user.password),
        user.mustResetPassword ? 1 : 0,
        timestamp,
        timestamp
      )
      .run()
      .catch((error) => { if (isDuplicateEmail(error)) return null; throw error; });

    if (!inserted) {
      taken.add(user.email);
      results.push({ email: user.email, status: 'skipped', reason: 'Already exists' });
      continue;
    }

    await mailboxEnv(c.env, userId).catch(error => console.error('Account created; mailbox provisioning will retry', {userId,error}));
    taken.add(user.email);
    results.push({ email: user.email, status: 'created' });
  }

  const created = results.filter((r) => r.status === 'created').length;

  return c.json({
    success: true,
    data: {
      results,
      summary: { total: users.length, created, skipped: results.length - created },
    },
  });
});

// ─── Update User ──────────────────────────────────────────────────

admin.put('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const requestorId = c.get('userId');

  const { displayName, role, mustResetPassword, newPassword } = await c.req
    .json<{
      displayName?: string;
      role?: string;
      mustResetPassword?: boolean;
      newPassword?: string;
    }>()
    .catch(() => ({}) as never);

  const target = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: string; role: string }>();

  // Previously an update against a nonexistent id silently reported success.
  if (!target) return c.json({ success: false, error: 'User not found' }, 404);

  const validRoles = ['super_admin', 'admin', 'employee'];
  if (role !== undefined && !validRoles.includes(role)) {
    return c.json({ success: false, error: "Role must be 'super_admin', 'admin', or 'employee'" }, 400);
  }

  // Admin users can only edit employees
  const requesterRole = c.get('userRole');
  if (requesterRole !== 'super_admin' && (target.role === 'admin' || target.role === 'super_admin')) {
    return c.json({ success: false, error: 'Only super admins can edit admin users' }, 403);
  }
  if (requesterRole !== 'super_admin' && role && role !== 'employee') {
    return c.json({ success: false, error: 'Only super admins can assign admin or super admin roles' }, 403);
  }
  if (newPassword !== undefined && newPassword.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { success: false, error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` },
      400
    );
  }

  // Guard against locking everyone out of the admin panel.
  if (role === 'employee' && (target.role === 'admin' || target.role === 'super_admin') && targetId === requestorId) {
    return c.json({ success: false, error: 'You cannot remove your own admin role' }, 400);
  }
  // Any demotion of the last super admin (to admin too) permanently locks
  // every super-admin-only control, and bootstrap stays closed.
  const demotesSuperAdmin = target.role === 'super_admin' && role !== undefined && role !== 'super_admin';
  if (demotesSuperAdmin && (await countSuperAdmins(c.env.DB, targetId)) === 0) {
    return c.json({ success: false, error: 'At least one super admin must remain' }, 400);
  }

  const updates: string[] = [];
  const params: unknown[] = [];

  if (displayName !== undefined) {
    if (!displayName.trim()) {
      return c.json({ success: false, error: 'Display name cannot be empty' }, 400);
    }
    updates.push('display_name = ?');
    params.push(displayName.trim());
  }
  if (role !== undefined) {
    updates.push('role = ?');
    params.push(role);
  }
  if (mustResetPassword !== undefined) {
    updates.push('must_reset_password = ?');
    params.push(mustResetPassword ? 1 : 0);
  }
  if (newPassword) {
    updates.push('password_hash = ?');
    params.push(await hashPassword(newPassword));
  }

  if (updates.length === 0) {
    return c.json({ success: false, error: 'No fields to update' }, 400);
  }

  updates.push('updated_at = ?');
  params.push(nowIso(), targetId);

  // Re-assert the last-super-admin invariant in the UPDATE itself, as the
  // delete route does: two concurrent demotions could both pass the check.
  let guard = '';
  if (demotesSuperAdmin) {
    guard = " AND EXISTS (SELECT 1 FROM users other WHERE other.role = 'super_admin' AND other.id != ?)";
    params.push(targetId);
  }
  const statements = [
    c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?${guard}`).bind(...params),
  ];

  // An admin-forced password change must not leave old sessions alive.
  if (newPassword) {
    statements.push(
      c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND changes() > 0').bind(targetId)
    );
  }

  const [updated] = await c.env.DB.batch(statements);
  if (demotesSuperAdmin && !updated.meta?.changes) {
    return c.json({ success: false, error: 'At least one super admin must remain' }, 400);
  }
  if (newPassword) await revokeSockets(c.env, targetId);

  return c.json({ success: true, message: 'User updated' });
});

// ─── Delete User ──────────────────────────────────────────────────

admin.delete('/users/:id', async (c) => {
  const targetId = c.req.param('id');
  const requestorId = c.get('userId');

  if (targetId === requestorId) {
    return c.json({ success: false, error: 'Cannot delete your own account' }, 400);
  }

  const target = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?')
    .bind(targetId)
    .first<{ id: string; role: string }>();

  if (!target) return c.json({ success: false, error: 'User not found' }, 404);

  // Admin users can only delete employees
  const requesterRole = c.get('userRole');
  if (requesterRole !== 'super_admin' && (target.role === 'admin' || target.role === 'super_admin')) {
    return c.json({ success: false, error: 'Only super admins can delete admin users' }, 403);
  }

  if (target.role === 'super_admin' && (await countSuperAdmins(c.env.DB, targetId)) === 0) {
    return c.json({ success: false, error: 'At least one super admin must remain' }, 400);
  }

  // Re-assert the invariant inside the DELETE itself. The check above is a
  // separate statement, so two admins deleting each other at the same moment
  // could both pass it and empty the users table — which also re-opens
  // /auth/bootstrap to whoever reaches it first.
  // The last super admin specifically: a remaining plain admin cannot reach
  // any super-admin-only control.
  const deletion = c.env.DB.prepare(
    `DELETE FROM users
     WHERE id = ?
       AND (role NOT IN ('admin', 'super_admin')
             OR EXISTS (SELECT 1 FROM users other WHERE other.role IN ('admin', 'super_admin') AND other.id != ?))
       AND (role != 'super_admin'
             OR EXISTS (SELECT 1 FROM users other WHERE other.role = 'super_admin' AND other.id != ?))`
  )
    .bind(targetId, targetId, targetId)
    ;
  const guarded = (await c.env.DB.batch([
    c.env.DB.prepare('UPDATE mailbox_routes SET purge_legacy=1 WHERE user_id=?').bind(targetId),
    deletion,
    c.env.DB.prepare('INSERT INTO mailbox_deletions(user_id) SELECT ? WHERE changes()>0 ON CONFLICT(user_id) DO NOTHING').bind(targetId),
    c.env.DB.prepare('UPDATE mailbox_routes SET purge_legacy=0 WHERE user_id=?').bind(targetId),
  ]))[1];

  if (!guarded.meta?.changes) {
    return c.json({ success: false, error: target.role === 'super_admin' ? 'At least one super admin must remain' : 'At least one admin must remain' }, 400);
  }

  let cleanupPending=true;
  try {
    // Finish small accounts immediately; large accounts continue through cron.
    for(let page=0;page<4 && cleanupPending;page++) cleanupPending=!await cleanupDeletedMailbox(c.env,targetId);
  } catch(error) { console.error('Account removed; durable cleanup will retry',{userId:targetId,error}); }
  return c.json({ success: true, cleanupPending, message: cleanupPending
    ? 'User deleted. Private storage cleanup will continue automatically. Shared download links remain available.'
    : 'User and private mailbox data deleted. Shared download links remain available.' });
});

// Organization policies require server-side super-admin authorization.
for (const path of ['/retention', '/meeting-providers']) {
  admin.use(path, async (c, next) => {
    if (c.get('userRole') !== 'super_admin') return c.json({success:false,error:'Super admin access required'},403);
    await next();
  });
}
admin.get('/meeting-providers', async c => c.json({success:true,data:await enabledMeetingProviders(c.env)}));
admin.put('/meeting-providers', async c => {
  const body = await c.req.json().catch(() => null);
  const providers = body?.providers;
  if (!Array.isArray(providers) || providers.length > 4 || providers.some((p: unknown) => typeof p !== 'string' || !Object.hasOwn(meetingProviders,p)) || new Set(providers).size !== providers.length) {
    return c.json({success:false,error:'Choose a valid list of meeting providers'},400);
  }
  await c.env.DB.prepare("INSERT INTO settings(key,value) VALUES('meeting_providers',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(providers)).run();
  return c.json({success:true,data:providers});
});

// ─── Retention Policy ─────────────────────────────────────────────

admin.get('/retention', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('archive_after_days', 'delete_trash_after_days')"
  ).all<{ key: string; value: string }>();

  const settings = Object.fromEntries(rows.results.map((r) => [r.key, r.value]));

  return c.json({
    success: true,
    data: {
      archiveAfterDays: parseInt(settings.archive_after_days || '365', 10),
      deleteTrashAfterDays: parseInt(settings.delete_trash_after_days || '30', 10),
    },
  });
});

admin.put('/retention', async (c) => {
  const { archiveAfterDays, deleteTrashAfterDays } = await c.req
    .json<{ archiveAfterDays?: number; deleteTrashAfterDays?: number }>()
    .catch(() => ({}) as never);

  const statements: D1PreparedStatement[] = [];
  const clamp = (value: number) => String(Math.min(36_500, Math.max(1, Math.floor(value))));

  if (archiveAfterDays !== undefined) {
    if (!Number.isFinite(archiveAfterDays)) {
      return c.json({ success: false, error: 'archiveAfterDays must be a number' }, 400);
    }
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('archive_after_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(clamp(archiveAfterDays))
    );
  }

  if (deleteTrashAfterDays !== undefined) {
    if (!Number.isFinite(deleteTrashAfterDays)) {
      return c.json({ success: false, error: 'deleteTrashAfterDays must be a number' }, 400);
    }
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO settings (key, value) VALUES ('delete_trash_after_days', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(clamp(deleteTrashAfterDays))
    );
  }

  if (statements.length === 0) {
    return c.json({ success: false, error: 'Nothing to update' }, 400);
  }

  await c.env.DB.batch(statements);
  return c.json({ success: true, message: 'Retention policy updated' });
});

// ─── Dashboard Stats ──────────────────────────────────────────────

admin.get('/stats', async (c) => {
  const db = c.env.DB;
  const migrated = await mailboxMetrics(c.env);
  const sum = (key: keyof (typeof migrated)[number]) => migrated.reduce((n,m)=>n+Number(m[key]),0);
  const requesterRole = c.get('userRole');

  // Admin users should not see super_admin in the count
  const userCountQuery = requesterRole === 'super_admin'
    ? db.prepare('SELECT COUNT(*) AS count FROM users')
    : db.prepare("SELECT COUNT(*) AS count FROM users WHERE role != 'super_admin'");

  const [userCount, sharedFileStats] = await db.batch<{count?:number;bytes?:number}>([
    userCountQuery,
    db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM shared_files'),
  ]);
  const sharedFileRow=sharedFileStats.results[0] || {};

  return c.json({
    success: true,
    data: {
      ...(requesterRole === 'super_admin' ? {
        databaseBytes: userCount.meta.size_after,
        databaseLimitBytes: 10_000_000_000,
      } : {}),
      totalUsers: userCount.results[0]?.count || 0,
      totalEmails: sum('emails'),
      totalAttachments: (sharedFileRow.count || 0) + sum('attachments'),
      storageUsedBytes: (sharedFileRow.bytes || 0) + sum('bytes') + sum('attachment_bytes'),
      emailsToday: sum('today'),
      emailsThisWeek: sum('week'),
      emailDomain: c.env.EMAIL_DOMAIN || '',
    },
  });
});

// ─── Reports & Analytics ──────────────────────────────────────────

admin.get('/reports', async (c) => {
  const requesterRole = c.get('userRole');
  const db = c.env.DB;

  const startParam = c.req.query('startDate');
  const endParam = c.req.query('endDate');

  // Default: last 30 days
  const now = new Date();
  const defaultStart = new Date(now.getTime() - 29 * 86_400_000);

  let startIso: string;
  let endIso: string;

  if (startParam) {
    startIso = `${startParam.slice(0,10)}T00:00:00.000Z`;
  } else {
    startIso = defaultStart.toISOString().slice(0, 10) + 'T00:00:00.000Z';
  }

  if (endParam) {
    endIso = `${endParam.slice(0,10)}T23:59:59.999Z`;
  } else {
    endIso = now.toISOString().slice(0, 10) + 'T23:59:59.999Z';
  }

  const validDate=(value:string)=> /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10)===value;
  if ((startParam && !validDate(startParam)) || (endParam && !validDate(endParam)) || startIso>endIso) {
    return c.json({success:false,error:'Choose a valid start and end date.'},400);
  }
  const published = await readMailboxReports(c.env,startIso.slice(0,10),endIso.slice(0,10));
  c.header('Cache-Control','private, no-store');
  const [sharedFileStats,dailySharedStats,userRows,userSharedStats] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM shared_files WHERE created_at>=? AND created_at<=?').bind(startIso,endIso).first<{count:number;bytes:number}>(),
    db.prepare('SELECT substr(created_at,1,10) AS day,COALESCE(SUM(size),0) AS bytes FROM shared_files WHERE created_at>=? AND created_at<=? GROUP BY day ORDER BY day').bind(startIso,endIso).all<{day:string;bytes:number}>(),
    db.prepare('SELECT id,email,display_name,role FROM users ORDER BY email').all<UserRow>(),
    db.prepare('SELECT user_id,COALESCE(SUM(size),0) AS total_size FROM shared_files WHERE created_at>=? AND created_at<=? GROUP BY user_id').bind(startIso,endIso).all<{user_id:string;total_size:number}>(),
  ]);
  const sentStats={count:0,bytes:0},receivedStats={count:0,bytes:0},totalEmailStats={count:0,bytes:0},attachmentStats={count:0,bytes:0},activeUserStats={count:0};
  const dailySentStats={results:[] as {day:string;count:number}[]},dailyReceivedStats={results:[] as {day:string;count:number}[]};
  const dailyEmailStats={results:[] as {day:string;bytes:number}[]},dailyAttachmentStats={results:[] as {day:string;bytes:number}[]};
  const userSentStats={results:[] as {user_id:string;cnt:number}[]},userReceivedStats={results:[] as {user_id:string;cnt:number}[]};
  const userEmailStats={results:[] as {user_id:string;total_size:number}[]},userAttachStats={results:[] as {user_id:string;total_size:number}[]};

  for (const {userId,report} of published.reports) {
    const days=report.emails.filter(d=>d.day>=startIso.slice(0,10) && d.day<=endIso.slice(0,10));
    const attachments=report.attachments.filter(d=>d.day>=startIso.slice(0,10) && d.day<=endIso.slice(0,10));
    const sums=days.reduce((s,d)=>({n:s.n+d.n,bytes:s.bytes+d.bytes,sent:s.sent+d.sent,received:s.received+d.received,sentBytes:s.sentBytes+d.sent_bytes,receivedBytes:s.receivedBytes+d.received_bytes}),{n:0,bytes:0,sent:0,received:0,sentBytes:0,receivedBytes:0});
    const att=attachments.reduce((s,d)=>({n:s.n+d.n,bytes:s.bytes+d.bytes}),{n:0,bytes:0});
    if(sentStats){sentStats.count+=sums.sent;sentStats.bytes+=sums.sentBytes;}
    if(receivedStats){receivedStats.count+=sums.received;receivedStats.bytes+=sums.receivedBytes;}
    if(totalEmailStats){totalEmailStats.count+=sums.n;totalEmailStats.bytes+=sums.bytes;}
    if(attachmentStats){attachmentStats.count+=att.n;attachmentStats.bytes+=att.bytes;}
    if(activeUserStats && sums.n) activeUserStats.count++;
    userSentStats.results.push({user_id:userId,cnt:sums.sent});
    userReceivedStats.results.push({user_id:userId,cnt:sums.received});
    userEmailStats.results.push({user_id:userId,total_size:sums.bytes});
    userAttachStats.results.push({user_id:userId,total_size:att.bytes});
    for(const d of days) {
      dailySentStats.results.push({day:d.day,count:d.sent});
      dailyReceivedStats.results.push({day:d.day,count:d.received});
      dailyEmailStats.results.push({day:d.day,bytes:d.bytes});
    }
    for(const d of attachments) dailyAttachmentStats.results.push({day:d.day,bytes:d.bytes});
  }

  // Merge Daily Activity
  const dailyMap = new Map<
    string,
    { sent: number; received: number; emailBytes: number; attachmentBytes: number; sharedBytes: number }
  >();

  const getEntry = (day: string) => {
    let entry = dailyMap.get(day);
    if (!entry) {
      entry = { sent: 0, received: 0, emailBytes: 0, attachmentBytes: 0, sharedBytes: 0 };
      dailyMap.set(day, entry);
    }
    return entry;
  };

  for (const r of dailySentStats.results) {
    getEntry(r.day).sent += r.count;
  }
  for (const r of dailyReceivedStats.results) {
    getEntry(r.day).received += r.count;
  }
  for (const r of dailyEmailStats.results) {
    getEntry(r.day).emailBytes += r.bytes;
  }
  for (const r of dailyAttachmentStats.results) {
    getEntry(r.day).attachmentBytes += r.bytes;
  }
  for (const r of dailySharedStats.results) {
    getEntry(r.day).sharedBytes = r.bytes;
  }

  const daily = Array.from(dailyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date,
      sent: data.sent,
      received: data.received,
      totalEmails: data.sent + data.received,
      storageBytes: data.emailBytes + data.attachmentBytes + data.sharedBytes,
      attachmentBytes: data.attachmentBytes,
    }));

  // Merge Per-User Activity
  const userSentMap = new Map(userSentStats.results.map((r) => [r.user_id, r.cnt]));
  const userReceivedMap = new Map(userReceivedStats.results.map((r) => [r.user_id, r.cnt]));
  const userEmailMap = new Map(userEmailStats.results.map((r) => [r.user_id, r.total_size]));
  const userAttachMap = new Map(userAttachStats.results.map((r) => [r.user_id, r.total_size]));
  const userSharedMap = new Map(userSharedStats.results.map((r) => [r.user_id, r.total_size]));

  const users = userRows.results
    .filter((u) => requesterRole === 'super_admin' || u.role !== 'super_admin')
    .map((u) => {
      const sent = userSentMap.get(u.id) || 0;
      const received = userReceivedMap.get(u.id) || 0;
      const storageUsedBytes =
        (userEmailMap.get(u.id) || 0) +
        (userAttachMap.get(u.id) || 0) +
        (userSharedMap.get(u.id) || 0);
      return {
        id: u.id,
        email: u.email,
        displayName: u.display_name,
        role: u.role,
        sent,
        received,
        totalEmails: sent + received,
        storageUsedBytes,
      };
    });

  const totalSent = sentStats?.count || 0;
  const totalReceived = receivedStats?.count || 0;
  const emailBytes = totalEmailStats?.bytes || 0;
  const attachmentBytes = attachmentStats?.bytes || 0;
  const sharedFilesBytes = sharedFileStats?.bytes || 0;
  const totalStorageBytes = emailBytes + attachmentBytes + sharedFilesBytes;

  return c.json({
    success: true,
    data: {
      freshness: published.freshness,
      startDate: startIso.slice(0, 10),
      endDate: endIso.slice(0, 10),
      summary: {
        totalSent,
        totalReceived,
        totalEmails: totalEmailStats?.count || (totalSent + totalReceived),
        totalAttachments: attachmentStats?.count || 0,
        attachmentBytes,
        totalSharedFiles: sharedFileStats?.count || 0,
        sharedFilesBytes,
        emailBytes,
        totalStorageBytes,
        activeUsers: activeUserStats?.count || 0,
      },
      daily,
      users,
    },
  });
});

export { admin as adminRoutes };
