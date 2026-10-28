import { centralDB } from '../services/mailbox-storage';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { MAX_LARGE_FILE_SIZE } from '@email-service/shared';
import type { Env, HonoVariables } from '../types';
import { generateUUIDv7, nowIso, sanitizeFilename } from '../lib/utils';

// Below Cloudflare's request limit; uniform R2 parts except the final part.
export const LARGE_UPLOAD_PART_SIZE = 8 * 1024 * 1024;
const routes = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
routes.use('*',async(c,next)=>{c.env={...c.env,DB:centralDB(c.env),MAILBOX_USER_ID:undefined};await next();});
type Upload = { id: string; filename: string; size: number; r2_key: string; upload_id: string | null; status: string | null; part_size: number };
async function ownedUpload(env: Env, id: string, userId: string) {
  return env.DB.prepare(`SELECT s.id,s.filename,s.size,s.r2_key,u.upload_id,u.status,u.part_size
    FROM shared_files s LEFT JOIN shared_uploads u ON u.share_id=s.id
    WHERE s.id=? AND s.user_id=? AND s.lifecycle != 'deleting'
      AND (u.share_id IS NULL OR s.created_at > ?)`)
    .bind(id, userId, new Date(Date.now() - 6 * 86_400_000).toISOString()).first<Upload>();
}

routes.post('/', bodyLimit({ maxSize: 8 * 1024,
  onError: c => c.json({ success: false, error: 'Upload metadata is too large' }, 413),
}), async c => {
  const input = await c.req.json<{ filename?: unknown; size?: unknown; mimeType?: unknown; partSize?: unknown }>().catch(() => null);
  if (!input || typeof input.filename !== 'string' || !input.filename.trim() || input.filename.length > 1024 ||
      typeof input.size !== 'number' || !Number.isSafeInteger(input.size) || input.size <= 0) {
    return c.json({ success: false, error: 'Provide a filename and a valid non-empty file size' }, 400);
  }
  if (input.size > MAX_LARGE_FILE_SIZE) return c.json({ success: false, error: 'File exceeds the 1 GB limit' }, 413);
  const partSize = input.partSize ?? LARGE_UPLOAD_PART_SIZE;
  if (![5,8,16,32].some(mib => partSize === mib*1024*1024)) return c.json({ success: false, error: 'Invalid upload chunk size' }, 400);
  const id = generateUUIDv7();
  const filename = sanitizeFilename(input.filename);
  const key = `shared-files/${id}/${filename}`;
  const mimeType = typeof input.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(input.mimeType) ? input.mimeType : 'application/octet-stream';
  const userId = c.get('userId');
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO shared_files(id,user_id,filename,mime_type,size,r2_key,created_at,lifecycle)
      VALUES (?,?,?,?,?,?,?,'staged')`).bind(id,userId,filename,mimeType,input.size,key,nowIso()),
    c.env.DB.prepare('INSERT INTO shared_uploads(share_id,part_size) VALUES (?,?)').bind(id,partSize),
  ]);
  // Record first: interrupted initiation is discoverable. R2 lifecycle aborts
  // incomplete multipart uploads after seven days, including lost responses.
  const upload = await c.env.EMAIL_BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: mimeType }, customMetadata: { uploadedBy: userId, originalFilename: filename },
  });
  await c.env.DB.prepare('UPDATE shared_uploads SET upload_id=? WHERE share_id=?').bind(upload.uploadId,id).run();
  return c.json({ success: true, data: { shareId: id, partSize } }, 201);
});

routes.get('/:id', async c => {
  const row = await ownedUpload(c.env,c.req.param('id'),c.get('userId'));
  if (!row) return c.json({ success: false, error: 'Upload not found or expired; select the file again' }, 404);
  const parts = await c.env.DB.prepare('SELECT part_number FROM shared_upload_parts WHERE share_id=? ORDER BY part_number').bind(row.id).all<{part_number:number}>();
  c.header('Cache-Control','no-store');
  return c.json({ success: true, data: { shareId:row.id,partSize:row.part_size,status:row.status || 'complete',
    completedParts:parts.results.map(part=>part.part_number) } });
});

routes.delete('/:id', async c => {
  // Claim cancellation before touching storage. A completion that already won
  // cannot be cancelled, nor can a saved/sent shared link ever be deleted here:
  // every mailbox reference is pinned centrally (email_shared_files lives in the mailbox DO).
  const row = await c.env.DB.prepare(`SELECT s.id,s.r2_key,s.lifecycle,u.upload_id,u.status FROM shared_files s
    LEFT JOIN shared_uploads u ON u.share_id=s.id WHERE s.id=? AND s.user_id=?`)
    .bind(c.req.param('id'),c.get('userId')).first<{id:string;r2_key:string;lifecycle:string;upload_id:string|null;status:string|null}>();
  if (!row) return c.json({ success:true });
  if (row.lifecycle !== 'deleting') {
    const claim = await c.env.DB.prepare(`UPDATE shared_files SET lifecycle='deleting' WHERE id=? AND lifecycle='staged'
      AND EXISTS (SELECT 1 FROM shared_uploads WHERE share_id=? AND status='uploading')
      AND NOT EXISTS (SELECT 1 FROM mailbox_shared_pins WHERE share_id=?)`).bind(row.id,row.id,row.id).run();
    if (!claim.meta.changes) return c.json({success:false,error:'This upload is already finishing or has been saved; it cannot be cancelled.'},409);
  }
  if (row.upload_id) {
    try { await c.env.EMAIL_BUCKET.resumeMultipartUpload(row.r2_key,row.upload_id).abort(); }
    catch (error) {
      if (!/NoSuchUpload|does not exist|10024/i.test(String(error))) throw error;
    }
  }
  await c.env.EMAIL_BUCKET.delete(row.r2_key);
  await c.env.DB.prepare("DELETE FROM shared_files WHERE id=? AND lifecycle='deleting'").bind(row.id).run();
  return c.json({success:true});
});

routes.put('/:id/parts/:number', async c => {
  const row = await ownedUpload(c.env, c.req.param('id'), c.get('userId'));
  if (!row) return c.json({ success: false, error: 'Upload not found or expired; upload the file again' }, 404);
  if (!row.upload_id || row.status !== 'uploading') return c.json({ success: false, error: 'Upload is no longer accepting parts' }, 409);
  const number = Number(c.req.param('number'));
  const count = Math.ceil(row.size / row.part_size);
  if (!Number.isInteger(number) || number < 1 || number > count) return c.json({ success: false, error: 'Invalid part number' }, 400);
  const expected = Math.min(row.part_size, row.size - (number - 1) * row.part_size);
  if (Number(c.req.header('content-length')) !== expected || !c.req.raw.body) {
    return c.json({ success: false, error: `This upload part must contain exactly ${expected} bytes` }, 400);
  }
  const existing = await c.env.DB.prepare('SELECT etag FROM shared_upload_parts WHERE share_id=? AND part_number=?').bind(row.id,number).first();
  if (existing) return c.json({ success: true }); // Retry after a lost acknowledgement.
  const multipart = c.env.EMAIL_BUCKET.resumeMultipartUpload(row.r2_key,row.upload_id);
  const part = await multipart.uploadPart(number,c.req.raw.body);
  const saved = await c.env.DB.prepare(`INSERT INTO shared_upload_parts(share_id,part_number,etag)
    SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM shared_uploads u JOIN shared_files s ON s.id=u.share_id
      WHERE u.share_id=? AND u.status='uploading' AND s.lifecycle='staged')
    ON CONFLICT(share_id,part_number) DO UPDATE SET etag=excluded.etag`)
    .bind(row.id,number,part.etag,row.id).run();
  if (!saved.meta.changes) return c.json({ success: false, error: 'Upload is no longer accepting parts' }, 409);
  return c.json({ success: true });
});

routes.post('/:id/complete', async c => {
  const row = await ownedUpload(c.env,c.req.param('id'),c.get('userId'));
  if (!row) return c.json({ success: false, error: 'Upload not found or expired; upload the file again' }, 404);
  if (row.status) {
    if (!row.upload_id) return c.json({ success: false, error: 'Upload initialization did not finish; upload the file again' }, 409);
    const parts = await c.env.DB.prepare('SELECT part_number AS partNumber,etag FROM shared_upload_parts WHERE share_id=? ORDER BY part_number').bind(row.id).all<R2UploadedPart>();
    const count = Math.ceil(row.size / row.part_size);
    if (parts.results.length !== count || parts.results.some((part,i) => part.partNumber !== i+1)) {
      return c.json({ success: false, error: 'Some file parts are missing. Retry the upload.' }, 409);
    }
    const claim = await c.env.DB.prepare(`UPDATE shared_uploads SET status='completing' WHERE share_id=?
      AND EXISTS (SELECT 1 FROM shared_files WHERE id=? AND lifecycle='staged')`).bind(row.id,row.id).run();
    if (!claim.meta.changes) return c.json({success:false,error:'Upload was cancelled'},409);
    let object = await c.env.EMAIL_BUCKET.head(row.r2_key);
    if (!object) {
      try { object = await c.env.EMAIL_BUCKET.resumeMultipartUpload(row.r2_key,row.upload_id).complete(parts.results); }
      catch (error) {
        // Completion may have succeeded before a response was lost.
        object = await c.env.EMAIL_BUCKET.head(row.r2_key);
        if (!object) throw error;
      }
    }
    if (object.size !== row.size) return c.json({ success: false, error: 'Uploaded file size does not match; upload it again' }, 409);
    // Publish only after R2 has the complete file. Keep the staged lifecycle so
    // an unsaved upload remains eligible for abandoned-upload cleanup.
    await c.env.DB.prepare('DELETE FROM shared_uploads WHERE share_id=?').bind(row.id).run();
  }
  return c.json({ success: true, data: { shareId: row.id, filename: row.filename, size: row.size,
    downloadUrl: `${c.env.APP_URL}/api/shared/${row.id}` } }, 201);
});

export { routes as largeUploadRoutes };
