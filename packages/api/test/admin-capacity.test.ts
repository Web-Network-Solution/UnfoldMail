import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { adminRoutes } from '../src/routes/admin';
import type { Env, HonoVariables } from '../src/types';

describe('admin capacity visibility', () => {
  for (const role of ['admin', 'super_admin'] as const) {
    it(`${role} receives only the permitted capacity fields`, async () => {
      const statement = { async all() { return {results:[{user_id:'u',emails:1,bytes:100,attachments:0,attachment_bytes:0,sent:1,received:0,today:1,week:1}]}; }, bind() { return this; } };
      const env = {
        EMAIL_DOMAIN: 'example.com',
        DB: {
          prepare: () => statement,
          batch: async () => Array.from({ length: 6 }, () => ({
            results: [{ count: 1, bytes: 100 }],
            meta: { size_after: 8_000_000_000 },
          })),
        },
      } as unknown as Env;
      const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
      app.use('*', async (c, next) => { c.set('userRole', role); await next(); });
      app.route('/admin', adminRoutes);
      const response = await app.request('/admin/stats', {}, env);
      expect(response.status).toBe(200);
      const { data } = await response.json() as { data: Record<string, unknown> };
      expect(data.totalEmails).toBe(1);
      if (role === 'super_admin') {
        expect(data.databaseBytes).toBe(8_000_000_000);
        expect(data.databaseLimitBytes).toBe(10_000_000_000);
      } else {
        expect(data).not.toHaveProperty('databaseBytes');
        expect(data).not.toHaveProperty('databaseLimitBytes');
      }
    });
  }
});
