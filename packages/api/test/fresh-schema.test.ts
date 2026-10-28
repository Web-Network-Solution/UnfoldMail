import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_TABLES } from '../src/services/mailbox-storage';

const sql = readFileSync(join(__dirname, '../schema/fresh.sql'), 'utf8');
const history = join(__dirname, '../migrations');
const baselineFiles = readdirSync(history).filter(f => f.endsWith('.sql') && f <= '0021_dedicated_mailbox_provisioning.sql').sort();

describe('clean central database initialization', () => {
  it('matches retained central schema, defaults and upgrade ledger without legacy mailbox tables', () => {
    const fresh = new DatabaseSync(':memory:');
    const upgraded = new DatabaseSync(':memory:');
    try {
      fresh.exec(sql);
      for (const file of baselineFiles) upgraded.exec(readFileSync(join(history, file), 'utf8'));
      const objects = fresh.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'").all();
      for (const object of objects) {
        const previous = upgraded.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(object.name);
        expect(String(previous?.sql).replace(/\r\n/g, '\n')).toBe(String(object.sql).replace(/\r\n/g, '\n'));
      }
      const tables = fresh.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      for (const table of LOCAL_TABLES) expect(tables).not.toContain(table);
      expect(tables.some(name => String(name).startsWith('emails_fts'))).toBe(false);
      expect(fresh.prepare('SELECT * FROM settings ORDER BY key').all()).toEqual(upgraded.prepare('SELECT * FROM settings ORDER BY key').all());
      expect(fresh.prepare('SELECT name FROM d1_migrations ORDER BY name').all().map(r => r.name)).toEqual(baselineFiles);
      expect(fresh.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      fresh.exec("INSERT INTO users(id,email,display_name,password_hash) VALUES('new','new@example.com','New','h')");
      expect(fresh.prepare('SELECT state,provision_new FROM mailbox_routes').get()).toEqual({ state: 'copying', provision_new: 1 });
      fresh.exec("DELETE FROM users WHERE id='new'");
      expect(fresh.prepare('SELECT * FROM mailbox_routes').all()).toEqual([]);
    } finally { fresh.close(); upgraded.close(); }
  });

  // Fresh installs run db:init (the baseline marks 0001-0021 applied), then db:migrate.
  it('applies post-baseline migrations identically to a fresh baseline and an upgraded database', () => {
    const fresh = new DatabaseSync(':memory:');
    const upgraded = new DatabaseSync(':memory:');
    try {
      fresh.exec(sql);
      for (const file of baselineFiles) upgraded.exec(readFileSync(join(history, file), 'utf8'));
      const applied = new Set(fresh.prepare('SELECT name FROM d1_migrations').all().map(r => r.name));
      const later = readdirSync(history).filter(f => f.endsWith('.sql') && !applied.has(f)).sort();
      expect(later).toContain('0022_sessions_expires_index.sql');
      for (const file of later) for (const db of [fresh, upgraded]) db.exec(readFileSync(join(history, file), 'utf8'));
      for (const object of fresh.prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'").all()) {
        expect(String(upgraded.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(object.name)?.sql).replace(/\r\n/g, '\n')).toBe(String(object.sql).replace(/\r\n/g, '\n'));
      }
      // The expired-session purge must use the index, not scan every session.
      for (const db of [fresh, upgraded]) {
        const plan = db.prepare('EXPLAIN QUERY PLAN DELETE FROM sessions WHERE expires_at < ?').all('2026-01-01T00:00:00.000Z');
        expect(plan.map(r => r.detail).join(' ')).toContain('idx_sessions_expires');
      }
    } finally { fresh.close(); upgraded.close(); }
  });

  it('refuses existing installations before modifying data or schema', () => {
    for (const existing of ["CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('keep')", sql]) {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec(existing);
        const before = db.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
        expect(() => db.exec(sql)).toThrow();
        expect(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(before);
        if (existing !== sql) expect(db.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'keep' });
      } finally { db.close(); }
    }
  });
});
