/**
 * Utility functions: IDs, password hashing, CSV parsing, R2 key builders.
 */
import { R2_PREFIXES } from '@email-service/shared';
import type { Env } from '../types';

// ─── ID Generators ────────────────────────────────────────────────

/**
 * UUIDv7 — time-ordered, so it clusters well in D1/SQLite indexes.
 * Layout: 48-bit big-endian millisecond timestamp | version 7 | 74 random bits.
 */
export function generateUUIDv7(): string {
  const timestamp = Date.now();
  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp
  bytes[0] = Math.floor(timestamp / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestamp / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestamp / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestamp / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestamp / 2 ** 8) & 0xff;
  bytes[5] = timestamp & 0xff;

  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Opaque 256-bit session token. Deliberately NOT a UUIDv7 — a session token is
 * a bearer credential, and a time-ordered ID leaks its issue time and carries
 * only 74 bits of entropy.
 */
export function generateSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Tags a session's realtime sockets. Hashed, so the hub never holds the bearer token. */
export async function sessionTag(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Close a user's realtime sockets for the given session tags, or all of them.
 * Best-effort: ending a session must never fail because the hub call did.
 * Close code 4001 means the session ended; 4002 means the same browser moved to
 * another session (Switch Back), so the client reconnects instead of signing out.
 */
export async function revokeSockets(env: Env, userId: string, tags?: string[], code: 4001 | 4002 = 4001): Promise<void> {
  try {
    const hub = env.WEBSOCKET_HUB.get(env.WEBSOCKET_HUB.idFromName(userId));
    await hub.fetch(new Request('https://hub/revoke', { method: 'POST', body: JSON.stringify({ tags, code }) }));
  } catch (error) {
    console.error('WebSocket revocation failed', error);
  }
}

// ─── Timestamps ───────────────────────────────────────────────────
// Every timestamp written to D1 goes through here. Mixing ISO-8601 with
// SQLite's datetime('now') format ("YYYY-MM-DD HH:MM:SS") breaks string
// ordering and every < comparison, so all writes use one format.

export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalize a timestamp we did not write ourselves (legacy or external). */
export function toIso(value: string | null | undefined): string {
  if (!value) return nowIso();
  const candidate = value.includes('T') ? value : value.replace(' ', 'T') + 'Z';
  const parsed = new Date(candidate);
  return isNaN(parsed.getTime()) ? nowIso() : parsed.toISOString();
}

// ─── Password Hashing ─────────────────────────────────────────────
// PBKDF2-SHA256 via Web Crypto (the only KDF available in Workers).

const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
  lengthBytes: number
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  const hash = await deriveBits(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH);
  return `${PBKDF2_ITERATIONS}:${toHex(salt)}:${toHex(hash)}`;
}

/**
 * Never throws. A malformed or truncated stored hash returns false rather than
 * a 500 — otherwise one corrupt row turns login into an unhandled crash.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof storedHash !== 'string') return false;

  const parts = storedHash.split(':');
  if (parts.length !== 3) return false;

  const iterations = parseInt(parts[0], 10);
  if (!Number.isFinite(iterations) || iterations < 1 || iterations > 1_000_000) return false;

  const salt = fromHex(parts[1]);
  const expected = fromHex(parts[2]);
  if (!salt || !expected) return false;

  try {
    const derived = await deriveBits(password, salt, iterations, expected.length);
    if (derived.length !== expected.length) return false;
    // Constant-time comparison.
    let diff = 0;
    for (let i = 0; i < derived.length; i++) diff |= derived[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

// ─── Email Address Validation ─────────────────────────────────────

const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/;

export function isValidEmail(address: unknown): address is string {
  return typeof address === 'string' && address.length <= 254 && EMAIL_RE.test(address);
}

/** Normalize a client-supplied recipient list, separating out anything invalid. */
export function normalizeRecipients(
  input: unknown
): { valid: { email: string; name: string }[]; invalid: string[] } {
  const valid: { email: string; name: string }[] = [];
  const invalid: string[] = [];

  for (const entry of Array.isArray(input) ? input : []) {
    const raw = typeof entry === 'string' ? entry : (entry as { email?: unknown } | null)?.email;
    const address = typeof raw === 'string' ? raw.trim().toLowerCase() : '';

    if (isValidEmail(address)) {
      const name = entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined;
      valid.push({ email: address, name: typeof name === 'string' && name.trim() ? name.trim() : '' });
    } else if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
      invalid.push(String(raw));
    }
  }
  return { valid, invalid };
}

// ─── Snippet Extraction ───────────────────────────────────────────

/**
 * `html.replace(/<(tags)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, repl)` in linear time. The regex
 * rescans to the end for every opener with no closer after it, O(openers x length):
 * minutes of CPU for one inbound '<style>'.repeat(n) body.
 */
export function stripBlocks(html: string, tags: string[], repl = ''): string {
  const open = new RegExp(`<(${tags.join('|')})\\b`, 'gi'), dead = new Set<string>();
  const close = new Map(tags.map((t) => [t, new RegExp(`<\\/${t}\\s*>`, 'gi')]));
  let out = '', from = 0, m: RegExpExecArray | null;
  // ponytail: an opener with no '>' or closer after it dooms every later opener of that tag, so each tag scans to the end at most once.
  while ((m = open.exec(html))) {
    const tag = m[1].toLowerCase(), end = close.get(tag)!;
    if (dead.has(tag)) continue;
    const gt = html.indexOf('>', open.lastIndex);
    end.lastIndex = gt + 1;
    if (gt < 0 || !end.exec(html)) { dead.add(tag); continue; }
    out += html.slice(from, m.index) + repl; from = open.lastIndex = end.lastIndex;
  }
  return out + html.slice(from);
}

/**
 * `html.replace(re, repl)` for a `<…[^>]*>` tag pattern. Past the first '<' after the last
 * '>' nothing can match, yet each opener there would rescan to the end ('<'.repeat(n)).
 */
export function replaceTags(html: string, re: RegExp, repl = ''): string {
  const cut = html.indexOf('<', html.lastIndexOf('>') + 1);
  return cut < 0 ? html.replace(re, repl) : html.slice(0, cut).replace(re, repl) + html.slice(cut);
}

export function extractSnippet(text: string, maxLength: number = 200): string {
  const cleaned = replaceTags(stripBlocks(text || '', ['script', 'style'], ' '), /<[^>]*>/g, ' ') // drop script/style bodies, strip tags
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) + '…' : cleaned;
}

// ─── R2 Key Builders ─────────────────────────────────────────────

export function inboundRawKey(id: string): string {
  return `${R2_PREFIXES.inbound}/${id}.eml`;
}

export function emailBodyKey(userId: string, emailId: string): string {
  return `${R2_PREFIXES.emailBody}/${userId}/${emailId}/body.html`;
}

export function emailBodyTextKey(userId: string, emailId: string, bodyKey?: string): string {
  // HTML and text are an immutable pair under the same revision directory.
  // Old rows keep their original keys without a data rewrite.
  if (bodyKey?.endsWith('/body.html')) return bodyKey.slice(0, -4) + 'txt';
  return `${R2_PREFIXES.emailBody}/${userId}/${emailId}/body.txt`;
}

/**
 * Attachment key. The attachment ID sits in the path so two attachments sharing
 * a filename on one email cannot overwrite each other.
 */
export function attachmentKey(
  userId: string,
  emailId: string,
  attachmentId: string,
  filename: string
): string {
  return `${R2_PREFIXES.attachments}/${userId}/${emailId}/${attachmentId}/${sanitizeFilename(filename)}`;
}

export function uploadKey(userId: string, attachmentId: string, filename: string): string {
  return `${R2_PREFIXES.uploads}/${userId}/${attachmentId}/${sanitizeFilename(filename)}`;
}

/**
 * Strip path separators and control characters from an untrusted filename.
 * Uses a code-point filter rather than a regex so no literal control bytes
 * ever appear in this source file.
 */
export function sanitizeFilename(filename: string): string {
  let cleaned = '';
  for (const ch of filename || '') {
    const code = ch.codePointAt(0) as number;
    cleaned += code < 0x20 || code === 0x7f || ch === '/' || ch === '\\' ? '_' : ch;
  }
  cleaned = cleaned.replace(/^\.+/, '_').trim();
  return (cleaned || 'unnamed').slice(0, 200);
}

// ─── CSV Parser ───────────────────────────────────────────────────
// RFC-4180 subset: quoted fields, escaped quotes, embedded commas and
// newlines, CRLF line endings. A naive split(',') corrupts any row with a
// quoted comma, and split('\n') leaves a stray CR on every field.

export interface CsvUserRow {
  email: string;
  displayName: string;
  password: string;
  mustResetPassword: boolean;
}

const CR = '\r';
const LF = '\n';

export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  const endRow = () => {
    row.push(field);
    field = '';
    if (row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === LF || ch === CR) {
      if (ch === CR && content[i + 1] === LF) i++;
      endRow();
    } else {
      field += ch;
    }
  }
  endRow();

  return rows;
}

export function parseCsvUsers(csvContent: string): CsvUserRow[] {
  const rows = parseCsv(csvContent);
  if (rows.length < 2) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s_-]/g, ''));
  const emailIdx = headers.indexOf('email');
  const nameIdx = headers.indexOf('displayname');
  const passIdx = headers.indexOf('password');
  const resetIdx = headers.indexOf('mustresetpassword');

  if (emailIdx === -1 || nameIdx === -1 || passIdx === -1) {
    throw new Error('CSV must have columns: email, displayName, password');
  }

  return rows.slice(1).map((cols) => {
    const reset = resetIdx !== -1 ? (cols[resetIdx] || '').trim().toLowerCase() : '';
    return {
      email: (cols[emailIdx] || '').trim().toLowerCase(),
      displayName: (cols[nameIdx] || '').trim(),
      password: (cols[passIdx] || '').trim(),
      mustResetPassword: reset === 'true' || reset === '1' || reset === 'yes',
    };
  });
}
