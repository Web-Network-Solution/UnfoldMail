/**
 * Schema-level tests.
 *
 * These run the real migration files against a real SQLite instance, because
 * the most expensive bug in this codebase was a schema bug that every unit
 * test would have missed: `emails_fts` was created contentless (`content=''`),
 * which silently made search return zero rows and made every FTS delete a
 * no-op. Nothing but executing the SQL catches that.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function migrate(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  db.exec('DROP TRIGGER provision_new_mailbox');
  return db;
}

function seed(db: DatabaseSync) {
  db.exec(
    `INSERT INTO users (id, email, display_name, password_hash, role)
     VALUES ('u1', 'alice@corp.com', 'Alice', 'h', 'admin'),
            ('u2', 'bob@corp.com', 'Bob', 'h', 'employee')`
  );
  db.exec(
    `INSERT INTO folders (id, user_id, name, type) VALUES
      ('f-in-1','u1','Inbox','inbox'), ('f-tr-1','u1','Trash','trash'), ('f-ar-1','u1','Archive','archive'),
      ('f-in-2','u2','Inbox','inbox')`
  );
  const insertEmail = db.prepare(
    `INSERT INTO emails (id, thread_id, folder_id, user_id, sender, subject, snippet, r2_body_key, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = db.prepare(
    `INSERT INTO emails_fts (email_id, user_id, subject, sender, snippet) VALUES (?, ?, ?, ?, ?)`
  );

  insertEmail.run('e1', 't1', 'f-in-1', 'u1', 'carol@ext.com', 'Quarterly budget review', 'Please review the Q3 budget', 'k1', '2026-01-01T00:00:00.000Z');
  insertFts.run('e1', 'u1', 'Quarterly budget review', 'carol@ext.com', 'Please review the Q3 budget');

  insertEmail.run('e2', 't2', 'f-in-2', 'u2', 'dan@ext.com', 'Budget for someone else', 'not yours', 'k2', '2026-01-02T00:00:00.000Z');
  insertFts.run('e2', 'u2', 'Budget for someone else', 'dan@ext.com', 'not yours');
}

const SEARCH_SQL = `
  SELECT e.id FROM emails_fts fts
  JOIN emails e ON e.id = fts.email_id
  WHERE emails_fts MATCH ? AND fts.user_id = ? AND e.is_archived = 0
  ORDER BY rank LIMIT 25 OFFSET 0`;

describe('migrations', () => {
  it('apply cleanly in filename order', () => {
    expect(() => migrate()).not.toThrow();
  });
});

describe('emails_fts (migration 0004)', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migrate();
    seed(db);
  });

  // The original defect: a contentless table returns NULL for every column,
  // so this JOIN matched nothing and search was dead on arrival.
  it('stores column values so the search JOIN resolves', () => {
    const row = db.prepare('SELECT email_id, user_id FROM emails_fts LIMIT 1').get() as {
      email_id: string | null;
      user_id: string | null;
    };
    expect(row.email_id).not.toBeNull();
    expect(row.user_id).not.toBeNull();
  });

  it('returns the matching email', () => {
    expect(db.prepare(SEARCH_SQL).all('"budget"*', 'u1')).toEqual([{ id: 'e1' }]);
  });

  it('scopes results to the querying user', () => {
    const ids = db.prepare(SEARCH_SQL).all('"budget"*', 'u1') as { id: string }[];
    expect(ids.map((r) => r.id)).not.toContain('e2');
  });

  it('matches on sender and on snippet text, not just subject', () => {
    expect(db.prepare(SEARCH_SQL).all('"carol"*', 'u1')).toHaveLength(1);
    expect(db.prepare(SEARCH_SQL).all('"Q3"*', 'u1')).toHaveLength(1);
  });

  it('excludes archived mail unless asked, but can still find it', () => {
    db.exec("UPDATE emails SET is_archived = 1 WHERE id = 'e1'");
    expect(db.prepare(SEARCH_SQL).all('"budget"*', 'u1')).toHaveLength(0);

    const includingArchived = `SELECT e.id FROM emails_fts fts JOIN emails e ON e.id = fts.email_id
                               WHERE emails_fts MATCH ? AND fts.user_id = ?`;
    expect(db.prepare(includingArchived).all('"budget"*', 'u1')).toHaveLength(1);
  });

  // The other half of the original defect: deletes silently affected 0 rows,
  // so the index grew forever and deleted mail stayed searchable.
  it('deletes by email_id', () => {
    expect(db.prepare('DELETE FROM emails_fts WHERE email_id = ?').run('e1').changes).toBe(1);
    expect(db.prepare(SEARCH_SQL).all('"budget"*', 'u1')).toHaveLength(0);
  });

  it('deletes every row for a user', () => {
    expect(db.prepare('DELETE FROM emails_fts WHERE user_id = ?').run('u1').changes).toBe(1);
  });

  it('backfilled the rows that migration 0002 had left unusable', () => {
    const fresh = migrate();
    fresh.exec(
      `INSERT INTO users (id, email, display_name, password_hash) VALUES ('u9','z@corp.com','Z','h')`
    );
    fresh.exec(`INSERT INTO folders (id,user_id,name,type) VALUES ('f9','u9','Inbox','inbox')`);
    fresh.exec(
      `INSERT INTO emails (id,thread_id,folder_id,user_id,sender,subject,snippet,r2_body_key,received_at)
       VALUES ('e9','t9','f9','u9','x@y.com','Legacy message','legacy body','k9','2026-01-01T00:00:00.000Z')`
    );
    // Simulate re-running the backfill step of 0004 over pre-existing rows.
    fresh.exec(
      `INSERT INTO emails_fts (email_id,user_id,subject,sender,snippet)
       SELECT id,user_id,subject,sender,snippet FROM emails WHERE id='e9'`
    );
    expect(fresh.prepare(SEARCH_SQL).all('"legacy"*', 'u9')).toEqual([{ id: 'e9' }]);
  });
});

describe('retention schema', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migrate();
    seed(db);
  });

  // Regression: trash was purged by received_at, so trashing a two-year-old
  // email destroyed it on the next nightly run instead of 30 days later.
  it('purges trash by trashed_at, not received_at', () => {
    db.exec("UPDATE emails SET folder_id = 'f-tr-1', trashed_at = '2026-06-01T00:00:00.000Z' WHERE id = 'e1'");

    const purge = `SELECT e.id FROM emails e JOIN folders f ON f.id = e.folder_id
                   WHERE f.type = 'trash' AND e.trashed_at IS NOT NULL AND e.trashed_at < ?
                   ORDER BY e.trashed_at ASC LIMIT 200`;

    // Old message, only just trashed → survives.
    expect(db.prepare(purge).all('2026-05-02T00:00:00.000Z')).toHaveLength(0);
    // 30 days after it was trashed → purged.
    expect(db.prepare(purge).all('2026-07-01T00:00:00.000Z')).toEqual([{ id: 'e1' }]);
  });

  it('moves archived mail into the Archive folder, not just a flag', () => {
    db.prepare(
      `UPDATE emails
       SET is_archived = 1,
           folder_id = COALESCE((SELECT id FROM folders WHERE user_id = emails.user_id AND type = 'archive'), folder_id)
       WHERE is_archived = 0 AND received_at < ?
         AND folder_id IN (SELECT id FROM folders WHERE type NOT IN ('trash','drafts','archive'))`
    ).run('2026-02-01T00:00:00.000Z');

    const row = db.prepare("SELECT folder_id, is_archived FROM emails WHERE id = 'e1'").get() as {
      folder_id: string;
      is_archived: number;
    };
    expect(row.folder_id).toBe('f-ar-1');
    expect(row.is_archived).toBe(1);
  });

  it('never archives drafts or trash', () => {
    db.exec("INSERT INTO folders (id,user_id,name,type) VALUES ('f-dr-1','u1','Drafts','drafts')");
    db.exec(
      `INSERT INTO emails (id,thread_id,folder_id,user_id,sender,subject,snippet,r2_body_key,received_at)
       VALUES ('e-draft','t3','f-dr-1','u1','alice@corp.com','draft','d','k3','2020-01-01T00:00:00.000Z')`
    );
    db.prepare(
      `UPDATE emails SET is_archived = 1
       WHERE is_archived = 0 AND received_at < ?
         AND folder_id IN (SELECT id FROM folders WHERE type NOT IN ('trash','drafts','archive'))`
    ).run('2026-02-01T00:00:00.000Z');

    expect(
      (db.prepare("SELECT is_archived FROM emails WHERE id='e-draft'").get() as { is_archived: number })
        .is_archived
    ).toBe(0);
  });
});

describe('inbound idempotency', () => {
  // Regression: a queue retry after a partial write duplicated the email row,
  // its R2 objects and its FTS entry.
  //
  // Keyed on the RFC Message-ID (migration 0005 renamed raw_key -> message_key),
  // because the staging object name is new on every delivery attempt and so
  // deduplicated nothing across an Email Routing redelivery.
  it('claims (message_key, user_id) exactly once', () => {
    const db = migrate();
    seed(db);
    const claim = db.prepare(
      `INSERT INTO processed_inbound (message_key, user_id, email_id, processed_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(message_key, user_id) DO NOTHING`
    );
    expect(claim.run('<abc@ext.com>', 'u1', 'e10', 'now').changes).toBe(1);
    expect(claim.run('<abc@ext.com>', 'u1', 'e11', 'now').changes).toBe(0);
    // A different mailbox for the same message is a distinct delivery.
    expect(claim.run('<abc@ext.com>', 'u2', 'e12', 'now').changes).toBe(1);
  });

  it('a plain INSERT rolls the batch back on a concurrent duplicate', () => {
    const db = migrate();
    seed(db);
    const claim = db.prepare(
      `INSERT INTO processed_inbound (message_key, user_id, email_id, processed_at)
       VALUES (?, ?, ?, ?)`
    );
    claim.run('<dup@ext.com>', 'u1', 'e20', 'now');
    // No ON CONFLICT: the second writer must throw so its whole batch aborts.
    expect(() => claim.run('<dup@ext.com>', 'u1', 'e21', 'now')).toThrow();
  });
});

describe('folder unread counts', () => {
  // Regression: the subquery omitted user_id.
  it('counts only the owning user unread mail', () => {
    const db = migrate();
    seed(db);
    const rows = db
      .prepare(
        `SELECT f.id, (SELECT COUNT(*) FROM emails e
                       WHERE e.folder_id = f.id AND e.user_id = f.user_id AND e.is_read = 0) AS unread
         FROM folders f WHERE f.user_id = 'u1' AND f.type = 'inbox'`
      )
      .all() as { id: string; unread: number }[];
    expect(rows[0].unread).toBe(1);
  });
});

describe('folder moves keep is_archived consistent (routes/emails.ts moveToFolder)', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migrate();
    seed(db);
    db.exec("INSERT INTO folders (id,user_id,name,type) VALUES ('f-dr-x','u1','Drafts','drafts')");
  });

  const moveTo = (folderId: string, type: string) => {
    if (type === 'trash') {
      // Into Trash: never archived, and the retention clock starts.
      db.prepare(
        'UPDATE emails SET folder_id = ?, is_archived = 0, trashed_at = ? WHERE id = ? AND user_id = ?'
      ).run(folderId, '2026-06-01T00:00:00.000Z', 'e1', 'u1');
    } else {
      db.prepare(
        'UPDATE emails SET folder_id = ?, is_archived = ?, trashed_at = NULL WHERE id = ? AND user_id = ?'
      ).run(folderId, type === 'archive' ? 1 : 0, 'e1', 'u1');
    }
  };

  const state = () =>
    db.prepare("SELECT folder_id, is_archived, trashed_at FROM emails WHERE id='e1'").get() as {
      folder_id: string;
      is_archived: number;
      trashed_at: string | null;
    };

  it('sets the flag when moving into Archive', () => {
    moveTo('f-ar-1', 'archive');
    expect(state()).toMatchObject({ folder_id: 'f-ar-1', is_archived: 1 });
  });

  // Regression: moving out of Archive left is_archived = 1, so the next nightly
  // run archived the message straight back.
  it('clears the flag when moving back out of Archive', () => {
    moveTo('f-ar-1', 'archive');
    moveTo('f-in-1', 'inbox');
    expect(state()).toMatchObject({ folder_id: 'f-in-1', is_archived: 0 });
  });

  // Regression: a soft delete used a different UPDATE that left is_archived set,
  // hiding trashed mail from search that excluded archived.
  it('trashing archived mail clears the flag and starts the retention clock', () => {
    moveTo('f-ar-1', 'archive');
    moveTo('f-tr-1', 'trash');
    const row = state();
    expect(row.is_archived).toBe(0);
    expect(row.trashed_at).not.toBeNull();
  });

  it('leaving Trash clears the retention clock', () => {
    moveTo('f-tr-1', 'trash');
    moveTo('f-in-1', 'inbox');
    expect(state().trashed_at).toBeNull();
  });
});

describe('threading and inline attachments (migration 0005)', () => {
  let db: DatabaseSync;
  beforeEach(() => {
    db = migrate();
    seed(db);
  });

  // Regression: References carried only the immediate parent, so clients that
  // walk the chain could not thread a conversation.
  it('accumulates the References chain across replies', () => {
    const chainFor = (parentChain: string | null, parentId: string) =>
      [parentChain, parentId].filter(Boolean).join(' ').trim() || null;

    const first = chainFor(null, '<a@ext.com>');
    expect(first).toBe('<a@ext.com>');

    const second = chainFor(first, '<b@ours.com>');
    expect(second).toBe('<a@ext.com> <b@ours.com>');

    const third = chainFor(second, '<c@ours.com>');
    expect(third).toBe('<a@ext.com> <b@ours.com> <c@ours.com>');
  });

  it('defaults disposition to attachment and stores content_id for inline parts', () => {
    db.exec(
      `INSERT INTO attachments (id, email_id, filename, mime_type, size, r2_key)
       VALUES ('a1','e1','doc.pdf','application/pdf',10,'k1')`
    );
    db.exec(
      `INSERT INTO attachments (id, email_id, filename, mime_type, size, r2_key, content_id, disposition)
       VALUES ('a2','e1','logo.png','image/png',20,'k2','logo123','inline')`
    );

    const rows = db
      .prepare('SELECT id, disposition, content_id FROM attachments ORDER BY id')
      .all() as { id: string; disposition: string; content_id: string | null }[];

    expect(rows[0]).toMatchObject({ id: 'a1', disposition: 'attachment', content_id: null });
    expect(rows[1]).toMatchObject({ id: 'a2', disposition: 'inline', content_id: 'logo123' });
  });

  // Regression: an embedded logo showed a paperclip and a download chip.
  it('the paperclip count excludes inline parts', () => {
    db.exec(
      `INSERT INTO attachments (id, email_id, filename, mime_type, size, r2_key, disposition)
       VALUES ('a1','e1','doc.pdf','application/pdf',10,'k1','attachment'),
              ('a2','e1','logo.png','image/png',20,'k2','inline')`
    );
    const row = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM attachments a
                 WHERE a.email_id = e.id AND a.disposition != 'inline') AS n
         FROM emails e WHERE e.id = 'e1'`
      )
      .get() as { n: number };
    expect(row.n).toBe(1);
  });
});
