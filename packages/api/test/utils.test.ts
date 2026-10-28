import { describe, expect, it } from 'vitest';
import {
  extractSnippet,
  generateSessionToken,
  generateUUIDv7,
  hashPassword,
  isValidEmail,
  normalizeRecipients,
  parseCsv,
  parseCsvUsers,
  sanitizeFilename,
  toIso,
  verifyPassword,
} from '../src/lib/utils';
import { toFtsQuery } from '../src/lib/fts';
import { mapEmail, type EmailRow } from '../src/lib/mappers';

describe('generateUUIDv7', () => {
  it('produces a valid v7 UUID', () => {
    const id = generateUUIDv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  // v7 orders across milliseconds; within a single millisecond the tail is
  // random, which is what the spec allows and all D1 needs for index locality.
  it('is time-ordered across milliseconds', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(generateUUIDv7());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('generateSessionToken', () => {
  it('is 256 bits of hex, not a time-ordered UUID', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateSessionToken()));
    expect(tokens.size).toBe(500);
  });
});

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
  });

  it('salts, so the same password hashes differently each time', async () => {
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });

  // Regression: a malformed stored hash used to throw, turning login into a 500.
  it.each([
    ['empty', ''],
    ['no separators', 'deadbeef'],
    ['too few parts', '100000:abcd'],
    ['non-numeric iterations', 'abc:abcd:abcd'],
    ['odd-length hex', '100000:abc:abcd'],
    ['non-hex payload', '100000:zzzz:zzzz'],
    ['absurd iteration count', '99999999999:abcd:abcd'],
  ])('returns false without throwing for a %s hash', async (_label, stored) => {
    await expect(verifyPassword('anything', stored)).resolves.toBe(false);
  });
});

describe('toFtsQuery', () => {
  it('quotes every token so FTS5 operators cannot be injected', () => {
    expect(toFtsQuery('NOT budget')).toBe('"NOT" AND "budget"*');
  });

  it('strips the characters that raise an FTS5 syntax error', () => {
    expect(toFtsQuery('a" OR "b')).toBe('"a" AND "OR" AND "b"*');
    expect(toFtsQuery('(budget')).toBe('"budget"*');
  });

  it('prefix-matches the final token so search works while typing', () => {
    expect(toFtsQuery('quarterly bud')).toBe('"quarterly" AND "bud"*');
  });

  it('returns null when nothing searchable remains', () => {
    expect(toFtsQuery('   ')).toBeNull();
    expect(toFtsQuery('*^~')).toBeNull();
  });
});

describe('normalizeRecipients', () => {
  it('accepts objects and bare strings, lowercasing the address', () => {
    const { valid, invalid } = normalizeRecipients([
      { email: 'Alice@Corp.com', name: 'Alice' },
      'BOB@corp.com',
    ]);
    expect(valid).toEqual([{ email: 'alice@corp.com', name: 'Alice' }, { email: 'bob@corp.com', name: '' }]);
    expect(invalid).toEqual([]);
  });

  // Regression: an unvalidated list used to produce a row in Sent for mail
  // that could never be delivered.
  it('separates out malformed addresses', () => {
    const { valid, invalid } = normalizeRecipients(['good@corp.com', 'not-an-email', 'a@b']);
    expect(valid).toEqual([{ email: 'good@corp.com', name: '' }]);
    expect(invalid).toEqual(['not-an-email', 'a@b']);
  });

  it('tolerates non-array input', () => {
    expect(normalizeRecipients(undefined).valid).toEqual([]);
    expect(normalizeRecipients('nope').valid).toEqual([]);
  });
});

describe('isValidEmail', () => {
  it.each(['a@b.com', 'first.last@sub.domain.co.uk'])('accepts %s', (address) => {
    expect(isValidEmail(address)).toBe(true);
  });

  it.each(['', 'a@b', 'no-at-sign', 'a b@c.com', 'a@b,c.com', null, 42])(
    'rejects %s',
    (address) => {
      expect(isValidEmail(address)).toBe(false);
    }
  );
});

describe('parseCsv', () => {
  it('handles quoted commas, escaped quotes and CRLF', () => {
    const csv = 'a,b\r\n"x,1","he said ""hi"""\r\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b'],
      ['x,1', 'he said "hi"'],
    ]);
  });

  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('parseCsvUsers', () => {
  it('parses the documented columns', () => {
    const rows = parseCsvUsers(
      'email,displayName,password,mustResetPassword\nA@Corp.com,Alice,secret123,true\nbob@corp.com,Bob,hunter2222,false\n'
    );
    expect(rows).toEqual([
      { email: 'a@corp.com', displayName: 'Alice', password: 'secret123', mustResetPassword: true },
      { email: 'bob@corp.com', displayName: 'Bob', password: 'hunter2222', mustResetPassword: false },
    ]);
  });

  // Regression: a name containing a comma used to shift every later column.
  it('does not corrupt a row containing a quoted comma', () => {
    const rows = parseCsvUsers(
      'email,displayName,password\ncarol@corp.com,"Carol, PhD",secret123\n'
    );
    expect(rows[0]).toEqual({
      email: 'carol@corp.com',
      displayName: 'Carol, PhD',
      password: 'secret123',
      mustResetPassword: false,
    });
  });

  it('throws when a required column is missing', () => {
    expect(() => parseCsvUsers('email,password\na@b.com,x\n')).toThrow(/displayName/);
  });

  it('returns nothing for a header-only file', () => {
    expect(parseCsvUsers('email,displayName,password\n')).toEqual([]);
  });
});

describe('sanitizeFilename', () => {
  it('neutralizes path traversal', () => {
    for (const evil of ['../../etc/passwd', 'C:\\evil\\payload.exe', '/etc/shadow']) {
      const safe = sanitizeFilename(evil);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
      expect(safe.startsWith('.')).toBe(false);
    }
  });

  it('keeps ordinary names intact', () => {
    expect(sanitizeFilename('Q3 Report (final).pdf')).toBe('Q3 Report (final).pdf');
  });

  it('falls back for an empty name', () => {
    expect(sanitizeFilename('')).toBe('unnamed');
  });
});

describe('extractSnippet', () => {
  it('strips markup and collapses whitespace', () => {
    expect(extractSnippet('<p>Hello   <b>there</b></p>')).toBe('Hello there');
  });

  it('drops script bodies rather than leaking their source', () => {
    expect(extractSnippet('<script>alert(1)</script>Hi')).toBe('Hi');
  });

  it('truncates with an ellipsis', () => {
    expect(extractSnippet('x'.repeat(300))).toHaveLength(201);
  });
});

describe('toIso', () => {
  // Regression: rows were written in two formats, so string comparison and
  // ORDER BY silently disagreed about which email was newer.
  it('normalizes SQLite datetime() output to ISO-8601', () => {
    expect(toIso('2026-01-02 03:04:05')).toBe('2026-01-02T03:04:05.000Z');
  });

  it('passes ISO through unchanged', () => {
    expect(toIso('2026-01-02T03:04:05.000Z')).toBe('2026-01-02T03:04:05.000Z');
  });

  it('falls back to now for junk instead of yielding Invalid Date', () => {
    expect(Number.isNaN(Date.parse(toIso('not a date')))).toBe(false);
  });
});

describe('mapEmail', () => {
  const row: EmailRow = {
    id: 'e1',
    thread_id: 't1',
    folder_id: 'f1',
    user_id: 'u1',
    sender: 'alice@corp.com',
    sender_name: 'Alice',
    recipients_to: '[{"email":"bob@corp.com","name":"Bob"}]',
    recipients_cc: null,
    recipients_bcc: '[]',
    subject: 'Budget',
    snippet: 'Please review',
    r2_body_key: 'emails/u1/e1/body.html',
    is_read: 0,
    is_starred: 1,
    is_archived: 0,
    has_attachments: 1,
    size: 2048,
    in_reply_to: null,
    message_id: '<abc@corp.com>',
    received_at: '2026-01-02 03:04:05',
  };

  // Regression: routes used to spread the raw snake_case row, so the UI read
  // undefined for every one of these and rendered "Invalid Date".
  it('exposes camelCase fields the client actually reads', () => {
    const email = mapEmail(row);
    expect(email.receivedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(email.senderName).toBe('Alice');
    expect(email.messageId).toBe('<abc@corp.com>');
    expect(email.threadId).toBe('t1');
    expect(email.folderId).toBe('f1');
  });

  it('coerces SQLite integers to booleans', () => {
    const email = mapEmail(row);
    expect(email.isRead).toBe(false);
    expect(email.isStarred).toBe(true);
    expect(email.hasAttachments).toBe(true);
  });

  it('parses recipient JSON and tolerates null or corrupt values', () => {
    expect(mapEmail(row).recipientsTo).toEqual([{ email: 'bob@corp.com', name: 'Bob' }]);
    expect(mapEmail(row).recipientsCc).toEqual([]);
    expect(mapEmail({ ...row, recipients_to: 'not json' }).recipientsTo).toEqual([]);
  });

  it('lets callers override derived fields', () => {
    expect(mapEmail(row, { isRead: true, bodyHtml: '<p>hi</p>' }).isRead).toBe(true);
  });
});
