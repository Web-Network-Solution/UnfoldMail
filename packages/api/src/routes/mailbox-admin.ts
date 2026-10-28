import { Hono } from 'hono';
import type { Env, HonoVariables } from '../types';
import { mailboxStub } from '../services/mailbox-storage';

const routes = new Hono<{Bindings:Env;Variables:HonoVariables}>();
routes.use('*', async (c,next) => {
  if (c.get('userRole')!=='super_admin') return c.json({success:false,error:'Super-admin access required'},403);
  if (!c.env.MAILBOXES) return c.json({success:false,error:'Mailbox storage is not configured'},503);
  await next();
});
routes.get('/', async c => {
  const rows = await c.env.DB.prepare(`SELECT u.id,u.email,u.display_name,COALESCE(r.state,'copying') AS state,
    m.database_bytes,m.emails,m.updated_at AS metrics_updated_at FROM users u
    LEFT JOIN mailbox_routes r ON r.user_id=u.id LEFT JOIN mailbox_metrics m ON m.user_id=u.id
    ORDER BY u.email LIMIT 2000`).all();
  return c.json({success:true,data:rows.results});
});
routes.get('/:id', async c => {
  // Checked first: reaching the DO for an unknown id creates its storage and then fails with a 500.
  if (!await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(c.req.param('id')).first()) return c.json({success:false,error:'User not found'},404);
  const status = await mailboxStub(c.env,c.req.param('id')).status(c.req.param('id'));
  return c.json({success:true,data:status});
});
export { routes as mailboxAdminRoutes };
