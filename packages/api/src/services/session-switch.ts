import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { Env, HonoVariables } from "../types";
import { sessionTag, nowIso } from "../lib/utils";
import { centralDB } from "./mailbox-storage";

// Never trust a frontend impersonation flag or the backup cookie alone.
export async function verifiedSuperAdminSwitch(c: Context<{ Bindings: Env; Variables: HonoVariables }>): Promise<boolean> {
    const original = getCookie(c, 'original_session');
    const current = getCookie(c, 'session_token');
    if (!original || !current) return false;
    const parts = original.split('.');
    if (parts.length !== 2 || !parts[0] || parts[1] !== await sessionTag(current)) return false;
    const row = await centralDB(c.env).prepare(`
        SELECT a.user_id FROM sessions a JOIN users admin ON admin.id=a.user_id
        JOIN sessions target ON target.token=?
        WHERE a.token=? AND a.expires_at>? AND target.expires_at>?
          AND admin.role='super_admin' AND admin.must_reset_password=0
          AND target.user_id=? AND a.user_id!=target.user_id
    `).bind(parts[1], await sessionTag(parts[0]), nowIso(), nowIso(), c.get('userId')).first();
    return !!row;
}
