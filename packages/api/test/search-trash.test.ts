import { expect, it } from 'vitest';
import { Hono } from 'hono';
import { testDatabase } from './helpers/database';
import { searchRoutes } from '../src/routes/search';
import type { Env, HonoVariables } from '../src/types';

function fixture() {
  const t = testDatabase();
  t.email('inbox'); t.email('draft', 'drafts'); t.email('trashed', 'trash'); t.email('archived', 'archive');
  t.sqlite.exec("UPDATE emails SET is_archived = 1 WHERE id = 'archived'");
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use('*', async (c, next) => { c.set('userId', 'u'); await next(); });
  app.route('/search', searchRoutes);
  const search = async (qs = '') => {
    const r = await app.request(`/search?q=searchable${qs}`, {}, { DB: t.db } as unknown as Env);
    const body = await r.json() as { data: { id: string }[]; pagination: { total: number } };
    expect(body.pagination.total).toBe(body.data.length);
    return body.data.map((e) => e.id).sort();
  };
  return { search, close: () => t.sqlite.close() };
}

it('excludes Trash by default but keeps Drafts and archived mail', async () => {
  const f = fixture();
  expect(await f.search()).toEqual(['archived', 'draft', 'inbox']);
  expect(await f.search('&includeArchived=false')).toEqual(['draft', 'inbox']);
  f.close();
});

it('includes Trash when asked or when searching the Trash folder', async () => {
  const f = fixture();
  expect(await f.search('&includeTrash=true')).toEqual(['archived', 'draft', 'inbox', 'trashed']);
  expect(await f.search('&folderId=trash')).toEqual(['trashed']);
  expect(await f.search('&folderId=in')).toEqual(['inbox']);
  f.close();
});
