import { Hono } from 'hono';
import type { Env, HonoVariables } from '../types';
import { toFtsQuery } from '../lib/fts';
import { toIso } from '../lib/utils';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@email-service/shared';

const search = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

// ─── Full-Text Search ─────────────────────────────────────────────

search.get('/', async (c) => {
  const userId = c.get('userId');
  const query = c.req.query('q')?.trim() || '';
  const folderId = c.req.query('folderId');
  // Archived mail is INCLUDED by default. The requirement is explicit that
  // archived email stays searchable, and defaulting to exclude it meant the
  // one thing users search for — old mail — was the one thing hidden.
  // Pass includeArchived=false to narrow to non-archived.
  const includeArchived = c.req.query('includeArchived') !== 'false';
  // Trash is EXCLUDED by default, as in Gmail; Drafts stay searchable.
  const includeTrash = c.req.query('includeTrash') === 'true';
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(c.req.query('pageSize') || String(DEFAULT_PAGE_SIZE), 10) || DEFAULT_PAGE_SIZE)
  );
  const offset = (page - 1) * pageSize;

  if (query.length < 2) {
    return c.json({ success: false, error: 'Search query must be at least 2 characters' }, 400);
  }

  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) {
    return c.json({
      success: true,
      data: [],
      pagination: { page, pageSize, total: 0, totalPages: 0 },
    });
  }

  // Archived mail stays searchable — that was an explicit requirement — and is
  // included when the caller asks for it.
  const filters = ['emails_fts MATCH ?', 'fts.user_id = ?'];
  const params: unknown[] = [ftsQuery, userId];

  if (!includeArchived) filters.push('e.is_archived = 0');
  // An explicit folderId already scopes the search, and asking for the Trash
  // folder must return its contents, so the exclusion only applies without one.
  if (!includeTrash && !folderId) filters.push("e.folder_id NOT IN (SELECT id FROM folders WHERE type = 'trash')");
  if (folderId) {
    filters.push('e.folder_id = ?');
    params.push(folderId);
  }

  const where = `WHERE ${filters.join(' AND ')}`;

  // NOTE: emails_fts (per-mailbox, from MAILBOX_SCHEMA) is a normal FTS5 table
  // with email_id / user_id UNINDEXED. A contentless table (content='') stores
  // no column values, so this JOIN would match zero rows.
  const results = await c.env.DB.prepare(
    `SELECT e.id, e.subject, e.sender, e.sender_name, e.snippet, e.received_at,
            e.folder_id, e.is_archived, e.is_read, e.has_attachments, e.thread_id
     FROM emails_fts fts
     JOIN emails e ON e.id = fts.email_id
     ${where}
     ORDER BY rank
     LIMIT ? OFFSET ?`
  )
    .bind(...params, pageSize, offset)
    .all<{
      id: string;
      subject: string | null;
      sender: string;
      sender_name: string | null;
      snippet: string | null;
      received_at: string;
      folder_id: string;
      is_archived: number;
      is_read: number;
      has_attachments: number;
      thread_id: string;
    }>();

  const countResult = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total
     FROM emails_fts fts
     JOIN emails e ON e.id = fts.email_id
     ${where}`
  )
    .bind(...params)
    .first<{ total: number }>();

  const total = countResult?.total || 0;

  return c.json({
    success: true,
    data: results.results.map((r) => ({
      id: r.id,
      subject: r.subject || '',
      sender: r.sender,
      senderName: r.sender_name || undefined,
      snippet: r.snippet || '',
      receivedAt: toIso(r.received_at),
      folderId: r.folder_id,
      threadId: r.thread_id,
      isArchived: !!r.is_archived,
      isRead: !!r.is_read,
      hasAttachments: !!r.has_attachments,
    })),
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  });
});

export { search as searchRoutes };
