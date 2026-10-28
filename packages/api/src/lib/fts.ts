import type { Database } from "../services/mailbox-storage";
/**
 * FTS5 index maintenance.
 *
 * Every write to `emails_fts` goes through here. Previously each call site
 * hand-wrote its own SQL, which is how three separate delete paths ended up
 * being silent no-ops against a contentless table.
 *
 * The table lives in each MailboxDO (created by MAILBOX_SCHEMA). It is a plain
 * FTS5 table with `email_id` and `user_id` marked UNINDEXED: their values are
 * stored and readable, so joins and `DELETE ... WHERE email_id = ?` both work,
 * while only the text columns are tokenized.
 */

export interface FtsRow {
  emailId: string;
  userId: string;
  subject: string;
  sender: string;
  snippet: string;
}

export function ftsInsertStatement(db: Database, row: FtsRow): D1PreparedStatement {
  return db
    .prepare(
      'INSERT INTO emails_fts (email_id, user_id, subject, sender, snippet) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(row.emailId, row.userId, row.subject || '', row.sender || '', row.snippet || '');
}

export function ftsDeleteStatement(db: Database, emailId: string): D1PreparedStatement {
  return db.prepare('DELETE FROM emails_fts WHERE email_id = ?').bind(emailId);
}

/**
 * Delete many rows in one statement.
 *
 * `email_id` is UNINDEXED, so each single-row delete costs a full scan of the
 * index. The retention purge removes hundreds of rows at a time; issuing them
 * one by one turned that into hundreds of scans.
 */
export function ftsDeleteManyStatement(
  db: Database,
  emailIds: string[]
): D1PreparedStatement {
  const placeholders = emailIds.map(() => '?').join(',');
  return db.prepare(`DELETE FROM emails_fts WHERE email_id IN (${placeholders})`).bind(...emailIds);
}

/**
 * Every caller batches its FTS write together with the D1 rows it belongs to,
 * so only the *Statement builders above are exported. Standalone `ftsInsert` /
 * `ftsDelete` / `ftsDeleteForUser` helpers existed but had no call sites left
 * after the writes moved into batches — a convenience wrapper that runs its
 * statement outside the transaction is exactly what this module exists to
 * prevent.
 */

/**
 * Turn a user's raw search box input into a safe FTS5 MATCH expression.
 *
 * Every token is quoted, which neutralizes FTS5 operators (AND/OR/NOT/NEAR),
 * column filters (`col:`), and the special characters that otherwise raise
 * "fts5: syntax error near ...". The final token gets a `*` so the query
 * matches as the user types.
 *
 * Returns null when there is nothing searchable left.
 */
export function toFtsQuery(raw: string): string | null {
  // Strip control characters first. A NUL byte in particular survives the
  // punctuation filter and terminates the SQL string early inside SQLite,
  // raising "fts5: unterminated string" — a 500 on ?q=%00abc. Done with a
  // code-point filter so no literal control bytes appear in this source file.
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) as number;
    cleaned += code < 0x20 || code === 0x7f ? ' ' : ch;
  }

  const tokens = cleaned
    .replace(/["'^~*?:()[\]{}\\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16); // a pathological query should not build a 10k-term expression

  if (tokens.length === 0) return null;

  return tokens
    .map((token, i) => (i === tokens.length - 1 ? `"${token}"*` : `"${token}"`))
    .join(' AND ');
}
