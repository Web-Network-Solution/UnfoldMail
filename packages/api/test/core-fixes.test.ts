import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { testDatabase } from './helpers/database';
import { hashPassword, sessionTag } from '../src/lib/utils';
import { cleanupDeletedMailbox } from '../src/services/mailbox-deletion';
import worker from '../src/index';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} } }));
import { WebSocketHub } from '../src/durable-objects/websocket-hub';

const ORIGIN = 'https://mail.example.com';
const PASSWORD = 'correct-horse-battery';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
// D1 holds sessionTag(token) (hex SHA-256), never the cookie's raw token.
const stored = (token: string) => createHash('sha256').update(token).digest('hex');
const storedAll = (...tokens: string[]) => tokens.map(stored).sort();

function fixture() {
  const { sqlite, db } = testDatabase(true);
  const hubCalls: { user: string; path: string; body: string; headers: Headers }[] = [];
  let hubFails = false;
  const env = {
    DB: db, APP_URL: ORIGIN, EMAIL_DOMAIN: 'example.com',
    WEBSOCKET_HUB: { idFromName: (name: string) => name, get: (user: string) => {
      if (hubFails) throw new Error('hub unavailable');
      return { fetch: async (request: Request) => {
        hubCalls.push({ user, path: new URL(request.url).pathname, body: await request.text(), headers: request.headers });
        return new Response('{}');
      } };
    } },
  } as unknown as Env;
  sqlite.exec(`INSERT INTO users(id,email,display_name,password_hash,role) VALUES ('root','root@example.com','Root','h','super_admin');
    INSERT INTO sessions(token,user_id,expires_at) VALUES ('${stored('root-session')}','root','2099-01-01T00:00:00.000Z'),('${stored('u-session')}','u','2099-01-01T00:00:00.000Z')`);
  const call = (path: string, init: { method?: string; body?: string; cookie?: string; headers?: Record<string, string> } = {}) =>
    worker.fetch(new Request(ORIGIN + path, { method: init.method, body: init.body, headers: {
      Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: init.cookie ?? 'session_token=root-session', ...init.headers,
    } }), env, {} as ExecutionContext);
  // The default 4001 is left out so only a Switch Back rotation (4002) shows up.
  const revokes = () => hubCalls.filter(c => c.path === '/revoke').map(c => { const { code, ...rest } = JSON.parse(c.body); return { user: c.user, ...rest, ...(code === 4002 ? { code } : {}) }; });
  const role = (id: string) => (sqlite.prepare('SELECT role FROM users WHERE id=?').get(id) as { role: string } | undefined)?.role;
  // Runs `sql` just before the route's batch commits, i.e. a concurrent request winning the race.
  const raceBatch = (sql: string) => { const batch = db.batch.bind(db); db.batch = (async (s: D1PreparedStatement[]) => { sqlite.exec(sql); return batch(s); }) as typeof db.batch; };
  const prepareOverride = (match: string, replacement: string) => {
    const prepare = db.prepare.bind(db); db.prepare = (sql: string) => prepare(sql.startsWith(match) ? replacement : sql);
  };
  return { sqlite, db, env, hubCalls, revokes, call, role, raceBatch, prepareOverride, failHub: () => { hubFails = true; } };
}

describe('last super admin', () => {
  it('refuses demoting the last super admin to admin, allows it while another remains', async () => {
    const f = fixture();
    expect((await f.call('/api/admin/users/root', { method: 'PUT', body: JSON.stringify({ role: 'admin' }) })).status).toBe(400);
    expect(f.role('root')).toBe('super_admin');
    f.sqlite.exec("UPDATE users SET role='super_admin' WHERE id='u'");
    expect((await f.call('/api/admin/users/root', { method: 'PUT', body: JSON.stringify({ role: 'admin' }) })).status).toBe(200);
    expect(f.role('root')).toBe('admin');
  });

  it('re-checks inside the UPDATE so concurrent demotions cannot both succeed', async () => {
    const f = fixture();
    f.sqlite.exec("UPDATE users SET role='super_admin' WHERE id='u'");
    f.raceBatch("UPDATE users SET role='admin' WHERE id='u'");
    const response = await f.call('/api/admin/users/root', { method: 'PUT', body: JSON.stringify({ role: 'admin', newPassword: PASSWORD }) });
    expect(response.status).toBe(400);
    expect(f.role('root')).toBe('super_admin');
    expect(f.sqlite.prepare("SELECT token FROM sessions WHERE user_id='root'").all()).toHaveLength(1);
  });

  it('re-checks inside the DELETE for the last super admin specifically, not any admin', async () => {
    const f = fixture();
    f.sqlite.exec("UPDATE users SET role='super_admin' WHERE id='u'");
    f.raceBatch("UPDATE users SET role='admin' WHERE id='root'");
    expect((await f.call('/api/admin/users/u', { method: 'DELETE' })).status).toBe(400);
    expect(f.role('u')).toBe('super_admin');
  });
});

describe('sessions and impersonation', () => {
  it('stop-impersonate does not restore an original session that expired earlier today', async () => {
    const f = fixture();
    const today = new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z';
    f.sqlite.exec(`INSERT INTO sessions(token,user_id,expires_at) VALUES ('${stored('expired-root')}','root','${today}')`);
    const response = await f.call('/api/auth/stop-impersonate', { method: 'POST', cookie: `session_token=u-session; original_session=expired-root.${await sessionTag('u-session')}` });
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') || '').not.toContain('session_token=expired-root');
    expect(f.revokes()).toEqual([{ user: 'u', tags: [await sessionTag('u-session')] }, { user: 'root', tags: [await sessionTag('expired-root')] }]);
  });

  // Node's Headers has getSetCookie; the Workers types used here do not.
  const setCookies = (response: Response) => (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
  const cookies = (response: Response) => Object.fromEntries(setCookies(response).map(c => c.split(';')[0].split('=') as [string, string]));
  const sessions = (f: ReturnType<typeof fixture>) => (f.sqlite.prepare('SELECT token FROM sessions ORDER BY token').all() as { token: string }[]).map(r => r.token);

  const impersonate = async (f: ReturnType<typeof fixture>) => {
    const set = cookies(await f.call('/api/auth/impersonate', { method: 'POST', body: JSON.stringify({ targetUserId: 'u' }) }));
    expect(set.original_session).toBe(`root-session.${await sessionTag(set.session_token)}`);
    return { token: set.session_token, cookie: `session_token=${set.session_token}; original_session=${set.original_session}` };
  };

  it('binds the backup to its impersonation; stop-impersonate restores it under a fresh token', async () => {
    const f = fixture();
    const old = await impersonate(f);
    const stopped = await f.call('/api/auth/stop-impersonate', { method: 'POST', cookie: old.cookie });
    const restored = cookies(stopped).session_token;
    expect(cookies(stopped)).toEqual({ session_token: restored, original_session: '' });
    expect(restored).toMatch(/^[0-9a-f]{64}$/);
    expect(f.sqlite.prepare('SELECT user_id, expires_at FROM sessions WHERE token=?').get(stored(restored))).toEqual({ user_id: 'root', expires_at: '2099-01-01T00:00:00.000Z' });
    expect(sessions(f)).toEqual(storedAll(restored, 'u-session'));
    // Restored: the browser only moved sessions, so its sockets reconnect (4002) rather than sign out.
    expect(f.revokes()).toEqual([{ user: 'u', tags: [await sessionTag(old.token)], code: 4002 }, { user: 'root', tags: [await sessionTag('root-session')], code: 4002 }]);
    // A late request with the old cookies can only end the old, already ended backup.
    const late = await f.call('/api/auth/me', { cookie: old.cookie });
    expect(late.status).toBe(401);
    expect(setCookies(late)).toEqual([]);
    expect((await f.call('/api/auth/me', { cookie: `session_token=${restored}` })).status).toBe(200);
  });

  it('a request that finds the impersonation dead mid-switch-back cannot sign the admin out', async () => {
    const f = fixture();
    const old = await impersonate(f);
    // Lands right after stop-impersonate ends the impersonated session.
    const prepare = f.db.prepare.bind(f.db);
    let late: Response | undefined, raced = false;
    f.db.prepare = (sql: string) => {
      const statement = prepare(sql);
      if (raced || !sql.startsWith('DELETE FROM sessions')) return statement;
      raced = true;
      const first = statement.first.bind(statement);
      statement.first = (async () => { const row = await first(); late = await f.call('/api/auth/me', { cookie: old.cookie }); return row; }) as typeof statement.first;
      return statement;
    };
    const restored = cookies(await f.call('/api/auth/stop-impersonate', { method: 'POST', cookie: old.cookie })).session_token;
    expect(late?.status).toBe(401);
    expect(restored).toBeTruthy();
    expect(sessions(f)).toEqual(storedAll(restored, 'u-session'));
  });

  it('a dead impersonation ends only the backup bound to it, without touching cookies', async () => {
    const f = fixture();
    for (const original of ['root-session', `root-session.${await sessionTag('u-session')}`]) {
      expect((await f.call('/api/auth/me', { cookie: `session_token=gone; original_session=${original}` })).status).toBe(401);
    }
    expect(sessions(f)).toEqual(storedAll('root-session', 'u-session'));
    const response = await f.call('/api/auth/me', { cookie: `session_token=gone; original_session=root-session.${await sessionTag('gone')}` });
    expect(response.status).toBe(401);
    expect(setCookies(response)).toEqual([]);
    expect(sessions(f)).toEqual(storedAll('u-session'));
    expect(f.revokes()).toEqual([{ user: 'root', tags: [await sessionTag('root-session')] }]);
  });

  it.each(['root-session', 'root-session.not-this-session'])('never restores a leftover backup (%s) for another session', async (backup) => {
    const f = fixture();
    const response = await f.call('/api/auth/stop-impersonate', { method: 'POST', cookie: `session_token=u-session; original_session=${backup}` });
    expect(response.status).toBe(200);
    expect(cookies(response)).toEqual({ original_session: '' });
    expect(sessions(f)).toEqual([]);
  });

  it('login ends a presented backup session and clears its cookie', async () => {
    const f = fixture();
    f.sqlite.prepare("UPDATE users SET password_hash=? WHERE id='u'").run(await hashPassword(PASSWORD));
    const response = await f.call('/api/auth/login', { method: 'POST', cookie: 'original_session=root-session.x', body: JSON.stringify({ email: 'employee@example.com', password: PASSWORD }) });
    expect(response.status).toBe(200);
    expect(cookies(response).original_session).toBe('');
    expect(sessions(f)).not.toContain(stored('root-session'));
    expect(f.revokes()).toEqual([{ user: 'root', tags: [await sessionTag('root-session')] }]);
  });

  it('logout with a dead session still ends the backup session and clears both cookies', async () => {
    const f = fixture();
    const response = await f.call('/api/auth/logout', { method: 'POST', cookie: 'session_token=dead; original_session=root-session.x' });
    expect(response.status).toBe(200);
    expect(cookies(response)).toEqual({ session_token: '', original_session: '' });
    expect(sessions(f)).toEqual(storedAll('u-session'));
    expect(f.revokes()).toEqual([{ user: 'root', tags: [await sessionTag('root-session')] }]);
  });

  it('refuses nested impersonation, but a stale backup does not block a new one', async () => {
    const f = fixture();
    f.sqlite.exec("UPDATE users SET role='super_admin' WHERE id='u'");
    const bound = `root-session.${await sessionTag('u-session')}`;
    const nested = await f.call('/api/auth/impersonate', { method: 'POST', cookie: `session_token=u-session; original_session=${bound}`, body: JSON.stringify({ targetUserId: 'root' }) });
    expect(nested.status).toBe(400);
    expect(setCookies(nested)).toEqual([]);
    f.sqlite.exec(`INSERT INTO sessions(token,user_id,expires_at) VALUES ('${stored('stale')}','root','2099-01-01T00:00:00.000Z')`);
    const fresh = await f.call('/api/auth/impersonate', { method: 'POST', cookie: 'session_token=root-session; original_session=stale.gone', body: JSON.stringify({ targetUserId: 'u' }) });
    expect(fresh.status).toBe(200);
    expect(cookies(fresh).original_session).toMatch(/^root-session\./);
    expect(sessions(f)).not.toContain(stored('stale'));
  });

  it('a 401 never deletes the session cookie, so a late one cannot remove a newer cookie', async () => {
    const f = fixture();
    f.sqlite.exec(`INSERT INTO sessions(token,user_id,expires_at) VALUES ('${stored('old')}','u','2000-01-01T00:00:00.000Z')`);
    for (const token of ['dead', 'old']) {
      const response = await f.call('/api/auth/me', { cookie: `session_token=${token}` });
      expect(response.status).toBe(401);
      expect(setCookies(response)).toEqual([]);
    }
    expect(sessions(f)).not.toContain(stored('old'));
  });

  it('rejects a malformed or non-string signature with 400 and keeps the stored one', async () => {
    const f = fixture();
    for (const body of ['{bad', 'null', '5', '{"signatureHtml":5}']) {
      expect((await f.call('/api/auth/signature', { method: 'PUT', body })).status).toBe(400);
    }
    expect((await f.call('/api/auth/signature', { method: 'PUT', body: JSON.stringify({ signatureHtml: '<b>Root</b>' }) })).status).toBe(200);
    expect(f.sqlite.prepare("SELECT signature_html FROM users WHERE id='root'").get()).toEqual({ signature_html: '<b>Root</b>' });
  });

  it('logout while impersonating also ends the original session and closes both sockets', async () => {
    const f = fixture();
    const response = await f.call('/api/auth/logout', { method: 'POST', cookie: 'session_token=u-session; original_session=root-session' });
    expect(response.status).toBe(200);
    expect(f.sqlite.prepare('SELECT token FROM sessions').all()).toEqual([]);
    expect(f.revokes()).toEqual([
      { user: 'u', tags: [await sessionTag('u-session')] },
      { user: 'root', tags: [await sessionTag('root-session')] },
    ]);
  });

  it('logout still succeeds when the hub is unavailable', async () => {
    const f = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f.failHub();
    expect((await f.call('/api/auth/logout', { method: 'POST', cookie: 'session_token=u-session' })).status).toBe(200);
    expect(f.sqlite.prepare('SELECT token FROM sessions WHERE token=?').all(stored('u-session'))).toEqual([]);
  });

  it('password changes close every socket of that user', async () => {
    const f = fixture();
    f.sqlite.prepare("UPDATE users SET password_hash=? WHERE id='u'").run(await hashPassword('old-password-1'));
    const own = await f.call('/api/auth/reset-password', { method: 'POST', cookie: 'session_token=u-session', body: JSON.stringify({ currentPassword: 'old-password-1', newPassword: PASSWORD }) });
    expect(own.status).toBe(200);
    expect((await f.call('/api/admin/users/u', { method: 'PUT', body: JSON.stringify({ newPassword: PASSWORD + '!' }) })).status).toBe(200);
    expect(f.revokes()).toEqual([{ user: 'u' }, { user: 'u' }]);
  });

  it('account deletion cleanup closes every socket of the deleted user', async () => {
    const f = fixture();
    f.sqlite.exec("INSERT INTO mailbox_deletions(user_id) VALUES ('gone')");
    const env = { ...f.env, MAILBOXES: { idFromName: (n: string) => n, get: () => ({ destroyDeletedAccount: async () => {} }) },
      EMAIL_BUCKET: { list: async () => ({ objects: [], truncated: false }), delete: async () => {} } } as unknown as Env;
    await cleanupDeletedMailbox(env, 'gone');
    expect(f.revokes()).toEqual([{ user: 'gone' }]);
  });

  it('validates the session once on /api/admin/* and keeps the password-reset gate', async () => {
    const f = fixture();
    let lookups = 0;
    const prepare = f.db.prepare.bind(f.db);
    f.db.prepare = (sql: string) => { if (sql.includes('FROM sessions s')) lookups++; return prepare(sql); };
    expect((await f.call('/api/admin/retention')).status).toBe(200);
    expect(lookups).toBe(1);
    f.sqlite.exec("UPDATE users SET must_reset_password=1 WHERE id='root'");
    const blocked = await f.call('/api/admin/retention');
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'PASSWORD_RESET_REQUIRED' });
  });
});

describe('user creation races the UNIQUE index', () => {
  it('single create returns 409 when a concurrent create wins', async () => {
    const f = fixture();
    f.prepareOverride('SELECT id FROM users WHERE email', 'SELECT id FROM users WHERE email = ? AND 0');
    const response = await f.call('/api/admin/users', { method: 'POST', body: JSON.stringify({ email: 'employee@example.com', displayName: 'Dup', password: PASSWORD }) });
    expect(response.status).toBe(409);
  });

  it('bulk import reports the lost race per row and keeps importing', async () => {
    const f = fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    f.prepareOverride('SELECT email FROM users', 'SELECT email FROM users WHERE 0');
    const csvContent = `email,displayName,password\nemployee@example.com,Dup,${PASSWORD}\nnew@example.com,New,${PASSWORD}`;
    const response = await f.call('/api/admin/users/bulk', { method: 'POST', body: JSON.stringify({ csvContent }) });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: { results: unknown[] } }).data.results).toEqual([
      { email: 'employee@example.com', status: 'skipped', reason: 'Already exists' },
      { email: 'new@example.com', status: 'created' },
    ]);
  });
});

describe('mailbox admin status', () => {
  it('returns 404 for an unknown id without instantiating a MailboxDO', async () => {
    const f = fixture();
    const get = vi.fn(() => ({ status: async () => ({ migration: null, databaseBytes: 0 }) }));
    f.env.MAILBOXES = { idFromName: (n: string) => n, get } as unknown as Env['MAILBOXES'];
    expect((await f.call('/api/admin/mailboxes/nope')).status).toBe(404);
    expect(get).not.toHaveBeenCalled();
    expect((await f.call('/api/admin/mailboxes/u')).status).toBe(200);
  });
});

describe('queue maintenance republication', () => {
  const run = async (body: Record<string, unknown>, env: Env) => {
    const message = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await worker.queue({ messages: [message] } as unknown as MessageBatch<never>, env, {} as ExecutionContext);
    return message;
  };
  const queueEnv = () => {
    const f = fixture();
    // No MAILBOXES binding: every mailbox resolves as under maintenance.
    return { ...f.env, OUTBOUND_QUEUE: { send: vi.fn(async () => {}) } } as unknown as Env & { OUTBOUND_QUEUE: { send: ReturnType<typeof vi.fn> } };
  };

  it('republishes with a counter while under the cap', async () => {
    const env = queueEnv();
    const message = await run({ kind: 'outbound', userId: 'u', emailId: 'e' }, env);
    expect(env.OUTBOUND_QUEUE.send).toHaveBeenCalledWith({ kind: 'outbound', userId: 'u', emailId: 'e', republishes: 1 }, { delaySeconds: 60 });
    expect(message.ack).toHaveBeenCalled();
  });

  it('falls through to retry (and so the DLQ) after the cap', async () => {
    const env = queueEnv();
    const message = await run({ kind: 'outbound', userId: 'u', emailId: 'e', republishes: 60 }, env);
    expect(env.OUTBOUND_QUEUE.send).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('drops jobs whose user no longer exists', async () => {
    const env = queueEnv();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = await run({ kind: 'forwarding', userId: 'deleted', id: 'f' }, env);
    expect(env.OUTBOUND_QUEUE.send).not.toHaveBeenCalled();
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalled();
  });
});

describe('scheduled isolation', () => {
  it.each([
    ['* * * * *', ['mailbox_deletions', 'mailbox_routes', 'calendar_deliveries']],
    ['*/15 * * * *', ['mailbox_forwarding_snapshots']],
  ])('keeps running later steps after one fails (%s)', async (cron, tables) => {
    const seen: string[] = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = {
      DB: { prepare: (sql: string) => { seen.push(sql); throw new Error('D1 down'); } },
      EMAIL_BUCKET: { list: async () => { throw new Error('R2 down'); } },
    } as unknown as Env;
    await worker.scheduled({ cron } as ScheduledController, env, {} as ExecutionContext);
    for (const table of tables) expect(seen.some(sql => sql.includes(table)), table).toBe(true);
    expect(error).toHaveBeenCalledTimes(tables.length === 1 ? 2 : 3);
  });
});

describe('realtime session binding', () => {
  it('forwards the upgrade with server-set session headers, overwriting client values', async () => {
    const f = fixture();
    await f.call('/api/ws', { cookie: 'session_token=u-session', headers: { Upgrade: 'websocket', 'X-Session-Tag': 'forged', 'X-Session-Expires': '2999-01-01T00:00:00.000Z' } });
    const forwarded = f.hubCalls.find(c => c.path === '/api/ws')!;
    expect(forwarded.user).toBe('u');
    expect(forwarded.headers.get('X-Session-Tag')).toBe(await sessionTag('u-session'));
    expect(forwarded.headers.get('X-Session-Expires')).toBe('2099-01-01T00:00:00.000Z');
    expect(forwarded.headers.get('Upgrade')).toBe('websocket');
  });

  it('closes a socket the hub accepted after its session was deleted', async () => {
    const f = fixture();
    const hubs = f.env.WEBSOCKET_HUB as unknown as { get(user: string): { fetch(r: Request): Promise<Response> } };
    const get = hubs.get;
    hubs.get = (user) => ({ fetch: async (request) => {
      const response = await get(user).fetch(request);
      if (new URL(request.url).pathname !== '/api/ws') return response;
      // u's logout committed while this upgrade was in flight.
      if (user === 'u') f.sqlite.prepare('DELETE FROM sessions WHERE token=?').run(stored('u-session'));
      return { status: 101, headers: new Headers() } as Response;
    } });
    // Hono rebuilds the route's response and Node's Response rejects 101; workerd accepts it.
    vi.stubGlobal('Response', class extends Response {
      upgrade?: boolean;
      constructor(body?: BodyInit | null, init?: ResponseInit) {
        super(body, init && { status: init.status === 101 ? 200 : init.status, headers: init.headers });
        this.upgrade = init?.status === 101;
      }
      get status() { return this.upgrade ? 101 : super.status; }
    });
    const upgrade = { Upgrade: 'websocket' };
    expect((await f.call('/api/ws', { cookie: 'session_token=root-session', headers: upgrade })).status).toBe(101);
    expect(f.revokes()).toEqual([]);
    expect((await f.call('/api/ws', { cookie: 'session_token=u-session', headers: upgrade })).status).toBe(101);
    expect(f.revokes()).toEqual([{ user: 'u', tags: [await sessionTag('u-session')] }]);
  });

  type Socket = { tags: string[]; attachment: unknown; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>; deserializeAttachment(): unknown; serializeAttachment(v: unknown): void };
  const socket = (tag = '', expiresAt?: string): Socket => ({
    tags: [tag], attachment: expiresAt ? { expiresAt } : null, send: vi.fn(), close: vi.fn(),
    deserializeAttachment() { return this.attachment; }, serializeAttachment(v) { this.attachment = v; },
  });
  const hub = (...sockets: Socket[]) => {
    const pairs: unknown[][] = [];
    vi.stubGlobal('WebSocketRequestResponsePair', class { constructor(...args: unknown[]) { pairs.push(args); } });
    const ctx = {
      setWebSocketAutoResponse: vi.fn(),
      acceptWebSocket: vi.fn((ws: Socket, tags: string[]) => { ws.tags = tags; sockets.push(ws); }),
      getWebSockets: (tag?: string) => sockets.filter(ws => tag === undefined || ws.tags.includes(tag)),
    };
    return { hub: new WebSocketHub(ctx as unknown as DurableObjectState, {} as Env), ctx, pairs, sockets };
  };
  const post = (path: string, body: unknown) => new Request('https://hub' + path, { method: 'POST', body: JSON.stringify(body) });
  const future = '2099-01-01T00:00:00.000Z', past = '2000-01-01T00:00:00.000Z';

  it('keeps answering pings in the runtime and records the session on upgrade', async () => {
    const h = hub();
    expect(h.pairs).toEqual([['{"type":"ping"}', '{"type":"pong"}']]);
    expect((await h.hub.fetch(new Request('https://hub/api/ws', { headers: { Upgrade: 'websocket' } }))).status).toBe(400);
    const server = socket();
    vi.stubGlobal('WebSocketPair', class { 0 = socket(); 1 = server; });
    // Node's Response rejects status 101; workerd accepts it with a webSocket.
    vi.stubGlobal('Response', class { constructor(public body: unknown, public init: { status: number }) {} get status() { return this.init.status; } });
    const response = await h.hub.fetch(new Request('https://hub/api/ws', { headers: { Upgrade: 'websocket', 'X-Session-Tag': 'tag-a', 'X-Session-Expires': future } }));
    expect(response.status).toBe(101);
    expect(h.ctx.acceptWebSocket).toHaveBeenCalledWith(server, ['tag-a']);
    expect(server.attachment).toEqual({ expiresAt: future });
  });

  it('closes expired or unbound sockets on notify instead of sending to them', async () => {
    const live = socket('a', future), expired = socket('b', past), unbound = socket('c');
    const h = hub(live, expired, unbound);
    await h.hub.fetch(post('/notify', { type: 'new_email', payload: { subject: 'secret' } }));
    expect(live.send).toHaveBeenCalledTimes(1);
    for (const ws of [expired, unbound]) {
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(4001, 'Session ended');
    }
  });

  it('revokes the tagged sockets, or all of them without tags', async () => {
    const a = socket('a', future), b = socket('b', future), c = socket('c', future);
    const h = hub(a, b, c);
    await h.hub.fetch(post('/revoke', { tags: ['a', 'c'] }));
    expect([a, b, c].map(ws => ws.close.mock.calls.length)).toEqual([1, 0, 1]);
    await h.hub.fetch(post('/revoke', {}));
    expect(b.close).toHaveBeenCalledWith(4001, 'Session ended');
    const d = socket('d', future);
    await hub(d).hub.fetch(post('/revoke', { tags: ['d'], code: 4002 }));
    expect(d.close).toHaveBeenCalledWith(4002, 'Session rotated');
  });

  it('answers the client close handshake, mapping reserved codes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = hub(), ws = socket();
    await h.hub.webSocketClose(ws as unknown as WebSocket, 1000, 'Reconnecting', true);
    await h.hub.webSocketClose(ws as unknown as WebSocket, 1005, '', true);
    expect(ws.close.mock.calls).toEqual([[1000, 'Reconnecting'], [1000, '']]);
    ws.close.mockImplementation(() => { throw new Error('already closed'); });
    await expect(h.hub.webSocketClose(ws as unknown as WebSocket, 4001, 'Session ended', true)).resolves.toBeUndefined();
  });
});
