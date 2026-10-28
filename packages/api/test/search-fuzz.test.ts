/**
 * Adversarial coverage for the search query sanitizer.
 *
 * `toFtsQuery` output goes straight into an FTS5 `MATCH`. FTS5 has its own
 * expression grammar, so an unescaped user query can raise
 * "fts5: syntax error near ..." — which surfaces as a 500 on every search for
 * anything containing a quote, a paren, or a bare operator keyword.
 *
 * These run the generated expression against a real FTS5 table, because the
 * only thing that proves an expression is well-formed is SQLite accepting it.
 */
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { toFtsQuery } from '../src/lib/fts';

let db: DatabaseSync;

beforeAll(() => {
  db = new DatabaseSync(':memory:');
  db.exec(
    "CREATE VIRTUAL TABLE t USING fts5(email_id UNINDEXED, user_id UNINDEXED, subject, sender, snippet, tokenize='unicode61')"
  );
  db.prepare('INSERT INTO t VALUES (?,?,?,?,?)').run(
    'e1',
    'u1',
    'Quarterly budget review',
    'alice@corp.com',
    'Please review the Q3 budget'
  );
});

const QUOTE = String.fromCharCode(34);
const BACKSLASH = String.fromCharCode(92);
const NUL = String.fromCharCode(0);
const TAB = String.fromCharCode(9);
const NEWLINE = String.fromCharCode(10);

const HOSTILE_INPUTS: [string, string][] = [
  ['plain word', 'budget'],
  ['bare NOT operator', 'NOT budget'],
  ['bare OR operator', 'a OR b'],
  ['trailing AND', 'a AND'],
  ['operator alone', 'AND'],
  ['NEAR function', 'NEAR(a b)'],
  ['column filter', 'subject:budget'],
  ['quote injection', 'a' + QUOTE + ' OR ' + QUOTE + '1' + QUOTE + '=' + QUOTE + '1'],
  ['unbalanced open parens', '((('],
  ['unbalanced close parens', ')))'],
  ['bare star', '*'],
  ['double star', '**'],
  ['caret prefix', '^abc'],
  ['hyphenated', 'a-b'],
  ['double hyphen (SQL comment)', 'a--b'],
  ['lone hyphen', '-'],
  ['lone quote', QUOTE],
  ['double quote pair', QUOTE + QUOTE],
  ['lone backslash', BACKSLASH],
  ['escaped quote', 'a' + BACKSLASH + QUOTE + 'b'],
  ['braces', '{a}'],
  ['brackets', '[a]'],
  ['multiple colons', 'a:b:c'],
  ['tilde prefix', '~a'],
  ['tilde suffix', 'a~'],
  ['lone question mark', '?'],
  ['embedded question mark', 'a?b'],
  ['apostrophe', "it's"],
  ['accented', 'café'],
  ['CJK', '日本語'],
  ['emoji', '🎉'],
  ['very long token', 'a'.repeat(500)],
  ['many tokens', Array.from({ length: 100 }, (_, i) => 'w' + i).join(' ')],
  ['NUL byte', NUL + 'abc'],
  ['tab and newline', 'a' + TAB + 'b' + NEWLINE + 'c'],
  ['all operators', 'AND OR NOT NEAR'],
  ['only hyphens', '- - -'],
  ['many quotes', QUOTE.repeat(5)],
  ['sql-ish', "'; DROP TABLE emails; --"],
];

describe('toFtsQuery never produces an invalid FTS5 expression', () => {
  it.each(HOSTILE_INPUTS)('%s', (_label, raw) => {
    const query = toFtsQuery(raw);

    // Returning null is a valid outcome — the route short-circuits to an empty
    // result set rather than issuing a MATCH.
    if (query === null) return;

    expect(() => db.prepare('SELECT email_id FROM t WHERE t MATCH ?').all(query)).not.toThrow();
  });
});

describe('toFtsQuery semantics', () => {
  it('neutralizes operators instead of honouring them', () => {
    // "a OR b" must not actually mean OR — it is three literal terms ANDed,
    // which matches nothing here rather than returning everything.
    const query = toFtsQuery('a OR b');
    expect(query).not.toBeNull();
    expect(db.prepare('SELECT email_id FROM t WHERE t MATCH ?').all(query!)).toHaveLength(0);
  });

  it('still finds real matches', () => {
    expect(db.prepare('SELECT email_id FROM t WHERE t MATCH ?').all(toFtsQuery('budget')!)).toEqual([
      { email_id: 'e1' },
    ]);
  });

  it('caps the term count so a pathological query cannot build a huge expression', () => {
    const query = toFtsQuery(Array.from({ length: 200 }, (_, i) => 'w' + i).join(' '));
    expect(query!.split(' AND ')).toHaveLength(16);
  });
});
