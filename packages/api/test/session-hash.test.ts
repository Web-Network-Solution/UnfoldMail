import { describe, it, expect, vi } from 'vitest';
import { testDatabase } from './helpers/database';
import { hashPassword, sessionTag } from '../src/lib/utils';
import worker from '../src/index';
import type { Env } from '../src/types';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

const ORIGIN = 'https://mail.example.com';
const PASSWORD = 'correct-horse-battery';

async function fixture() {
  const { sqlite, db } = testDatabase(true);
  const env = {
    DB: db, APP_URL: ORIGIN, EMAIL_DOMAIN: 'example.com',
    WEBSOCKET_HUB: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('{}') }) },
  } as unknown as Env;
  const hash = await hashPassword(PASSWORD);
  sqlite.prepare("INSERT INTO users(id,email,display_name,password_hash,role) VALUES ('root','root@example.com','Root',?,'super_admin')").run(hash);
  sqlite.prepare("UPDATE users SET password_hash=? WHERE id='u'").run(hash);
  const call = (path: string, cookie = '', body?: unknown) => worker.fetch(new Request(ORIGIN + path, {
    method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', Cookie: cookie },
  }), env, {} as ExecutionContext);
  const rows = () => sqlite.prepare('SELECT token, user_id FROM sessions ORDER BY token').all() as { token: string; user_id: string }[];
  return { sqlite, call, rows };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

// Node's Headers has getSetCookie; the Workers types used here do not.
const cookies = (response: Response) => Object.fromEntries((response.headers as unknown as { getSetCookie(): string[] }).getSetCookie().map(c => c.split(';')[0].split('=') as [string, string]));
const login = async (f: Fixture, email: string) => {
  const response = await f.call('/api/auth/login', '', { email, password: PASSWORD });
  expect(response.status).toBe(200);
  return cookies(response).session_token;
};
const me = async (f: Fixture, cookie: string) => {
  const response = await f.call('/api/auth/me', cookie);
  return response.status === 200 ? ((await response.json()) as { data: { email: string } }).data.email : response.status;
};
const tags = async (...tokens: string[]) => (await Promise.all(tokens.map(sessionTag))).sort();

describe('sessions are stored as SHA-256 hashes', () => {
  it('login stores only the hash of the token the cookie carries', async () => {
    const f = await fixture();
    const token = await login(f, 'employee@example.com');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(f.rows()).toEqual([{ token: await sessionTag(token), user_id: 'u' }]);
    expect(await me(f, `session_token=${token}`)).toBe('employee@example.com');
  });

  it('neither a legacy raw-token row nor a leaked stored hash authenticates', async () => {
    const f = await fixture();
    f.sqlite.exec("INSERT INTO sessions(token,user_id,expires_at) VALUES ('legacy-raw','u','2099-01-01T00:00:00.000Z')");
    expect(await me(f, 'session_token=legacy-raw')).toBe(401);
    const token = await login(f, 'employee@example.com');
    expect(await me(f, `session_token=${await sessionTag(token)}`)).toBe(401);
  });

  it('impersonate, stop-impersonate and logout work end to end', async () => {
    const f = await fixture();
    const root = await login(f, 'root@example.com');
    const imp = cookies(await f.call('/api/auth/impersonate', `session_token=${root}`, { targetUserId: 'u' }));
    // The backup cookie keeps the raw admin token; D1 only ever sees hashes.
    expect(imp.original_session).toBe(`${root}.${await sessionTag(imp.session_token)}`);
    expect(f.rows().map(r => r.token)).toEqual(await tags(root, imp.session_token));
    const impersonating = `session_token=${imp.session_token}; original_session=${imp.original_session}`;
    expect(await me(f, impersonating)).toBe('employee@example.com');

    const back = cookies(await f.call('/api/auth/stop-impersonate', impersonating, {})).session_token;
    expect(f.rows()).toEqual([{ token: await sessionTag(back), user_id: 'root' }]);
    expect(await me(f, `session_token=${back}`)).toBe('root@example.com');
    expect(await me(f, `session_token=${root}`)).toBe(401);

    expect((await f.call('/api/auth/logout', `session_token=${back}`, {})).status).toBe(200);
    expect(f.rows()).toEqual([]);
  });

  it('reset-password keeps the caller signed in and ends every other session', async () => {
    const f = await fixture();
    const current = await login(f, 'employee@example.com');
    const other = await login(f, 'employee@example.com');
    const reset = await f.call('/api/auth/reset-password', `session_token=${current}`, { currentPassword: PASSWORD, newPassword: PASSWORD + '-new' });
    expect(reset.status).toBe(200);
    expect(f.rows()).toEqual([{ token: await sessionTag(current), user_id: 'u' }]);
    expect(await me(f, `session_token=${current}`)).toBe('employee@example.com');
    expect(await me(f, `session_token=${other}`)).toBe(401);
  });
});
