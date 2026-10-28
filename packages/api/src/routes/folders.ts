import { Hono } from 'hono';
import { SYSTEM_FOLDERS, SYSTEM_FOLDER_LABELS } from '@email-service/shared';
import type { Env, HonoVariables } from '../types';
import { generateUUIDv7, nowIso } from '../lib/utils';
import { mapFolder, type FolderRow } from '../lib/mappers';

const folders = new Hono<{ Bindings: Env; Variables: HonoVariables }>();

// ─── List Folders ─────────────────────────────────────────────────

folders.get('/', async (c) => {
  const userId = c.get('userId');

  const result = await c.env.DB.prepare(
    `SELECT f.*,
       (SELECT COUNT(*) FROM emails e
        WHERE e.folder_id = f.id AND e.user_id = f.user_id AND e.is_read = 0) AS unread_count
     FROM folders f
     WHERE f.user_id = ?
     ORDER BY
       CASE f.type
         WHEN 'inbox' THEN 1
         WHEN 'sent' THEN 2
         WHEN 'drafts' THEN 3
         WHEN 'trash' THEN 4
         WHEN 'archive' THEN 5
         ELSE 6
       END,
       f.name ASC`
  )
    .bind(userId)
    .all<FolderRow>();

  return c.json({ success: true, data: result.results.map(mapFolder) });
});

// ─── Create Custom Folder ─────────────────────────────────────────

folders.post('/', async (c) => {
  const userId = c.get('userId');
  const { name } = await c.req.json<{ name?: unknown }>().catch(() => null) || {};

  const trimmed = typeof name === 'string' ? name.trim() : '';

  if (!trimmed) {
    return c.json({ success: false, error: 'Folder name is required' }, 400);
  }
  if (trimmed.length > 60) {
    return c.json({ success: false, error: 'Folder name must be 60 characters or fewer' }, 400);
  }

  // Block both the type keywords and the display labels, so a user cannot
  // create a second folder called "Inbox".
  const reserved = new Set<string>([
    ...SYSTEM_FOLDERS,
    ...Object.values(SYSTEM_FOLDER_LABELS).map((l) => l.toLowerCase()),
  ]);
  if (reserved.has(trimmed.toLowerCase())) {
    return c.json({ success: false, error: 'Cannot use a system folder name' }, 400);
  }

  const folderId = generateUUIDv7();

  try {
    await c.env.DB.prepare(
      "INSERT INTO folders (id, user_id, name, type, created_at) VALUES (?, ?, ?, 'custom', ?)"
    )
      .bind(folderId, userId, trimmed, nowIso())
      .run();
  } catch (err) {
    if (err instanceof Error && err.message.includes('UNIQUE')) {
      return c.json({ success: false, error: 'A folder with this name already exists' }, 409);
    }
    throw err;
  }

  return c.json(
    {
      success: true,
      data: {
        id: folderId,
        userId,
        name: trimmed,
        type: 'custom',
        unreadCount: 0,
        createdAt: nowIso(),
      },
    },
    201
  );
});

// ─── Delete Custom Folder ─────────────────────────────────────────

folders.delete('/:id', async (c) => {
  const userId = c.get('userId');
  const folderId = c.req.param('id');

  const folder = await c.env.DB.prepare('SELECT type FROM folders WHERE id = ? AND user_id = ?')
    .bind(folderId, userId)
    .first<{ type: string }>();

  if (!folder) return c.json({ success: false, error: 'Folder not found' }, 404);
  if (folder.type !== 'custom') {
    return c.json({ success: false, error: 'Cannot delete system folders' }, 400);
  }

  const inbox = await c.env.DB.prepare(
    "SELECT id FROM folders WHERE user_id = ? AND type = 'inbox'"
  )
    .bind(userId)
    .first<{ id: string }>();

  if (!inbox) return c.json({ success: false, error: 'Inbox folder not found' }, 500);

  // Relocate the mail before dropping the folder, in one batch, so emails can
  // never be left pointing at a folder row that no longer exists.
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE emails SET folder_id = ? WHERE folder_id = ? AND user_id = ?').bind(
      inbox.id,
      folderId,
      userId
    ),
    c.env.DB.prepare('DELETE FROM folders WHERE id = ? AND user_id = ?').bind(folderId, userId),
  ]);

  return c.json({ success: true });
});

export { folders as folderRoutes };
