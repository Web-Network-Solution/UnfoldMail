import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  validateContact,
  parseContacts,
  contactFile,
  type Contact,
} from "@email-service/shared/productivity";
import type { Env, HonoVariables } from "../types";
import { generateUUIDv7, nowIso } from "../lib/utils";

const routes = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
routes.use(
  "*",
  bodyLimit({
    maxSize: 1100000,
    onError: (c) =>
      c.json(
        { success: false, error: "Import is too large (1 MB maximum)" },
        413,
      ),
  }),
);
routes.onError((e, c) => {
  if (/UNIQUE/.test(e.message))
    return c.json(
      { success: false, error: "A contact with this email already exists" },
      409,
    );
  console.error("Contacts operation failed", e);
  return c.json(
    { success: false, error: "Unable to complete contact operation" },
    500,
  );
});
interface Row extends Omit<Contact, "groups"> {
  groups_json: string;
}
const map = (r: Row): Contact => ({
  id: r.id,
  name: r.name,
  email: r.email,
  phone: r.phone,
  company: r.company,
  notes: r.notes,
  revision: r.revision,
  groups: JSON.parse(r.groups_json),
});
routes.get("/", async (c) => {
  const q = (c.req.query("q") || "").slice(0, 160),
    group = (c.req.query("group") || "").slice(0, 60);
  const page = Math.max(0, Math.min(1000, Number(c.req.query("page")) || 0));
  const where = `user_id=? AND (instr(lower(name),lower(?))>0 OR instr(lower(email),lower(?))>0 OR instr(lower(company),lower(?))>0) AND (?='' OR EXISTS(SELECT 1 FROM json_each(groups_json) WHERE value=?))`;
  const [rows, count, groups] = await Promise.all([
    c.env.DB.prepare(
      `SELECT * FROM contacts WHERE ${where} ORDER BY name COLLATE NOCASE,id LIMIT 100 OFFSET ?`,
    )
      .bind(c.get("userId"), q, q, q, group, group, page * 100)
      .all<Row>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total FROM contacts WHERE ${where}`)
      .bind(c.get("userId"), q, q, q, group, group)
      .first<{ total: number }>(),
    c.env.DB.prepare(
      "SELECT DISTINCT value AS name FROM contacts,json_each(groups_json) WHERE user_id=? ORDER BY value LIMIT 200",
    )
      .bind(c.get("userId"))
      .all<{ name: string }>(),
  ]);
  return c.json({
    success: true,
    data: {
      contacts: rows.results.map(map),
      total: count?.total || 0,
      groups: groups.results.map((g) => g.name),
    },
  });
});
routes.get("/directory", async (c) => {
  const q = (c.req.query("q") || "").slice(0, 160),
    page = Math.max(0, Math.min(1000, Number(c.req.query("page")) || 0));
  // Only directory fields are exposed; never role, signature, or authentication data.
  const rows = await c.env.DB.prepare(
    `SELECT id,display_name AS name,email FROM users WHERE role='employee' AND (instr(lower(display_name),lower(?))>0 OR instr(lower(email),lower(?))>0) ORDER BY display_name COLLATE NOCASE,id LIMIT 101 OFFSET ?`,
  )
    .bind(q, q, page * 100)
    .all<{ id: string; name: string; email: string }>();
  return c.json({
    success: true,
    data: {
      contacts: rows.results
        .slice(0, 100)
        .map((r) => ({
          ...r,
          phone: "",
          company: "",
          notes: "",
          groups: [],
          revision: 0,
          directory: true,
        })),
      hasMore: rows.results.length > 100,
    },
  });
});
routes.get("/suggest", async (c) => {
  const q = (c.req.query("q") || "").trim().slice(0, 160);
  if (!q) return c.json({ success: true, data: [] });
  const rows = await c.env.DB.prepare(
    `SELECT name,email FROM contacts WHERE user_id=? AND (instr(lower(name),lower(?))>0 OR instr(lower(email),lower(?))>0)
    UNION SELECT display_name AS name,email FROM users WHERE role='employee' AND (instr(lower(display_name),lower(?))>0 OR instr(lower(email),lower(?))>0) LIMIT 12`,
  )
    .bind(c.get("userId"), q, q, q, q)
    .all<{ name: string; email: string }>();
  const groups = await c.env.DB.prepare(
    `SELECT j.value AS name,group_concat(email, ', ') AS email,COUNT(*) AS members FROM contacts,json_each(groups_json) j WHERE user_id=? AND instr(lower(j.value),lower(?))>0 GROUP BY j.value HAVING COUNT(*)<=50 LIMIT 5`,
  )
    .bind(c.get("userId"), q)
    .all<{ name: string; email: string; members: number }>();
  return c.json({
    success: true,
    data: [
      ...new Map(rows.results.map((r) => [r.email.toLowerCase(), r])).values(),
      ...groups.results.map((g) => ({
        name: `${g.name} (group · ${g.members})`,
        email: g.email,
      })),
    ],
  });
});
routes.get("/export", async (c) => {
  const format = c.req.query("format") === "vcf" ? "vcf" : "csv";
  const rows = await c.env.DB.prepare(
    "SELECT * FROM contacts WHERE user_id=? ORDER BY name LIMIT 10001",
  )
    .bind(c.get("userId"))
    .all<Row>();
  if (rows.results.length > 10000)
    return c.json(
      { success: false, error: "Export supports up to 10,000 contacts" },
      400,
    );
  return c.body(contactFile(rows.results.map(map), format), 200, {
    "Content-Type":
      format === "csv"
        ? "text/csv; charset=utf-8"
        : "text/vcard; charset=utf-8",
    "Content-Disposition": `attachment; filename="contacts.${format}"`,
    "Cache-Control": "no-store",
  });
});
routes.post("/import", async (c) => {
  let contacts;
  try {
    const input = await c.req.json();
    contacts = parseContacts(
      input.content,
      input.format === "vcf" ? "vcf" : "csv",
    );
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid import",
      },
      400,
    );
  }
  const existing = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE user_id=?",
  )
    .bind(c.get("userId"))
    .first<{ n: number }>();
  if ((existing?.n || 0) + contacts.length > 10000)
    return c.json({ success: false, error: "Contact limit is 10,000" }, 400);
  const results = await c.env.DB.batch(
    contacts.map((v) =>
      c.env.DB.prepare(
        "INSERT OR IGNORE INTO contacts(id,user_id,name,email,phone,company,notes,groups_json,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(
        generateUUIDv7(),
        c.get("userId"),
        v.name,
        v.email,
        v.phone,
        v.company,
        v.notes,
        JSON.stringify(v.groups),
        nowIso(),
      ),
    ),
  );
  const imported = results.reduce((n, r) => n + r.meta.changes, 0);
  return c.json({
    success: true,
    data: { imported, skipped: contacts.length - imported },
  });
});
routes.post("/", async (c) => {
  let v;
  try {
    v = validateContact(await c.req.json());
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid contact",
      },
      400,
    );
  }
  const id = generateUUIDv7();
  const result = await c.env.DB.prepare(
    `INSERT INTO contacts(id,user_id,name,email,phone,company,notes,groups_json,updated_at) SELECT ?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM contacts WHERE user_id=?)<10000`,
  )
    .bind(
      id,
      c.get("userId"),
      v.name,
      v.email,
      v.phone,
      v.company,
      v.notes,
      JSON.stringify(v.groups),
      nowIso(),
      c.get("userId"),
    )
    .run();
  if (!result.meta.changes)
    return c.json({ success: false, error: "Contact limit is 10,000" }, 400);
  return c.json({ success: true, data: { ...v, id, revision: 1 } }, 201);
});
routes.put("/:id", async (c) => {
  let v, revision;
  try {
    const raw = await c.req.json();
    v = validateContact(raw);
    revision = raw.revision;
    if (!Number.isInteger(revision))
      throw new Error("Reload this contact before editing");
  } catch (e) {
    return c.json(
      {
        success: false,
        error: e instanceof Error ? e.message : "Invalid contact",
      },
      400,
    );
  }
  const result = await c.env.DB.prepare(
    "UPDATE contacts SET name=?,email=?,phone=?,company=?,notes=?,groups_json=?,revision=revision+1,updated_at=? WHERE id=? AND user_id=? AND revision=?",
  )
    .bind(
      v.name,
      v.email,
      v.phone,
      v.company,
      v.notes,
      JSON.stringify(v.groups),
      nowIso(),
      c.req.param("id"),
      c.get("userId"),
      revision,
    )
    .run();
  if (!result.meta.changes)
    return c.json(
      {
        success: false,
        error: "Contact changed or was removed. Reload and try again.",
      },
      409,
    );
  return c.json({ success: true });
});
routes.delete("/:id", async (c) => {
  const result = await c.env.DB.prepare("DELETE FROM contacts WHERE id=? AND user_id=?")
    .bind(c.req.param("id"), c.get("userId"))
    .run();
  if (!result.meta.changes)
    return c.json({ success: false, error: "Contact not found" }, 404);
  return c.json({ success: true });
});
export { routes as contactRoutes };
