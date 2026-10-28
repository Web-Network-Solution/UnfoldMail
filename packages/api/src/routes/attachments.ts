import { Hono } from 'hono';
import { formPart, type Env, type HonoVariables } from '../types';
import { generateUUIDv7, sanitizeFilename, uploadKey, nowIso } from '../lib/utils';
import { mapAttachment, type AttachmentRow } from '../lib/mappers';
import { MAX_ATTACHMENT_SIZE, MAX_LARGE_FILE_SIZE } from '@email-service/shared';
import { bodyLimit } from 'hono/body-limit';
import { largeUploadRoutes } from './large-uploads';

const attachments = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
attachments.route('/large-uploads', largeUploadRoutes);

/**
 * Content types that a browser will happily execute in the context of our
 * origin. Downloads are always forced, but these get neutralized as well.
 */
const UNSAFE_TYPES = /^(text\/html|application\/xhtml|image\/svg|text\/xml|application\/xml)/i;

// ─── Upload Attachment (for compose) ──────────────────────────────

// Refuse before formData() buffers the request; 64 KiB covers multipart headers.
attachments.post('/upload', bodyLimit({ maxSize: MAX_ATTACHMENT_SIZE + 64 * 1024,
  onError: c => c.json({ success: false, error: `File exceeds the ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB limit` }, 413),
}), async (c) => {
  const userId = c.get('userId');

  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ success: false, error: 'Expected multipart/form-data' }, 400);

  const file = formPart(formData, 'file');
  if (!file || typeof file === 'string') {
    return c.json({ success: false, error: 'No file provided' }, 400);
  }
  if (file.size === 0) {
    return c.json({ success: false, error: 'File is empty' }, 400);
  }
  if (file.size > MAX_ATTACHMENT_SIZE) {
    return c.json(
      { success: false, error: `File exceeds the ${MAX_ATTACHMENT_SIZE / (1024 * 1024)} MB limit` },
      413
    );
  }

  const attachmentId = generateUUIDv7();
  const filename = sanitizeFilename(file.name);
  const r2Key = uploadKey(userId, attachmentId, filename);

  await c.env.EMAIL_BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { originalFilename: filename, uploadedBy: userId },
  });

  return c.json(
    {
      success: true,
      data: {
        id: attachmentId,
        filename,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        r2Key,
      },
    },
    201
  );
});

// ─── Download Attachment ──────────────────────────────────────────

attachments.get('/:id/download', async (c) => {
  const userId = c.get('userId');
  const attachmentId = c.req.param('id');

  const attachment = await c.env.DB.prepare(
    `SELECT a.id, a.filename, a.mime_type, a.size, a.r2_key
     FROM attachments a
     JOIN emails e ON e.id = a.email_id
     WHERE a.id = ? AND e.user_id = ?`
  )
    .bind(attachmentId, userId)
    .first<{ id: string; filename: string; mime_type: string; size: number; r2_key: string }>();

  if (!attachment) return c.json({ success: false, error: 'Attachment not found' }, 404);

  const object = await c.env.EMAIL_BUCKET.get(attachment.r2_key);
  if (!object) return c.json({ success: false, error: 'File not found in storage' }, 404);

  // Never serve an attachment's declared type back if it can execute in the
  // browser — an HTML or SVG attachment would otherwise run script on our origin.
  const contentType = UNSAFE_TYPES.test(attachment.mime_type || '')
    ? 'application/octet-stream'
    : attachment.mime_type || 'application/octet-stream';

  // filename* (RFC 5987) carries the UTF-8 name; the plain filename is an
  // ASCII fallback. The previous code percent-encoded into the quoted form,
  // which shows users "my%20file.pdf".
  const asciiName = attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      'Content-Length': String(attachment.size),
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});

// ─── List Attachments for an Email ────────────────────────────────

attachments.get('/email/:emailId', async (c) => {
  const userId = c.get('userId');
  const emailId = c.req.param('emailId');

  const email = await c.env.DB.prepare('SELECT id FROM emails WHERE id = ? AND user_id = ?')
    .bind(emailId, userId)
    .first();

  if (!email) return c.json({ success: false, error: 'Email not found' }, 404);

  const result = await c.env.DB.prepare(
    'SELECT * FROM attachments WHERE email_id = ? ORDER BY created_at ASC'
  )
    .bind(emailId)
    .all<AttachmentRow>();

  return c.json({ success: true, data: result.results.map(mapAttachment) });
});

// ─── Upload a file as a persistent shared download ──────────────

attachments.post('/upload-large', bodyLimit({ maxSize: 9 * 1024 * 1024,
  onError: c => c.json({ success: false, error: 'Refresh this page to use the updated large-file uploader.' }, 413),
}), async (c) => {
  const userId = c.get('userId');

  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ success: false, error: 'Expected multipart/form-data' }, 400);

  const file = formPart(formData, 'file');
  if (!file || typeof file === 'string') {
    return c.json({ success: false, error: 'No file provided' }, 400);
  }
  if (file.size === 0) {
    return c.json({ success: false, error: 'File is empty' }, 400);
  }
  if (file.size > MAX_LARGE_FILE_SIZE) {
    return c.json(
      { success: false, error: `File exceeds the ${MAX_LARGE_FILE_SIZE / (1024 * 1024 * 1024)} GB limit` },
      413
    );
  }

  const shareId = generateUUIDv7();
  const filename = sanitizeFilename(file.name);
  const r2Key = `shared-files/${shareId}/${filename}`;

  // Record staging before uploading so a failed/interrupted upload is still
  // discoverable by cleanup. Existing uploads default to retained in migration 0013.
  await c.env.DB.prepare(
    `INSERT INTO shared_files (id, user_id, filename, mime_type, size, r2_key, created_at, lifecycle)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'staged')`
  ).bind(shareId, userId, filename, file.type || 'application/octet-stream', file.size, r2Key, nowIso()).run();

  await c.env.EMAIL_BUCKET.put(r2Key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { originalFilename: filename, uploadedBy: userId },
  });

  const appUrl = c.env.APP_URL || `https://${c.req.header('host')}`;
  const downloadUrl = `${appUrl}/api/shared/${shareId}`;

  return c.json(
    {
      success: true,
      data: {
        shareId,
        filename,
        size: file.size,
        downloadUrl,
      },
    },
    201
  );
});

export { attachments as attachmentRoutes };
