import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { testDatabase } from './helpers/database';
import { largeUploadRoutes, LARGE_UPLOAD_PART_SIZE as PART } from '../src/routes/large-uploads';
import { sharedFileStatements, cleanupSharedUploads } from '../src/services/shared-files';
import type { Env, HonoVariables } from '../src/types';

function fixture() {
  const f = testDatabase();
  let object: { size: number } | null = null;
  const sizes = new Map<number, number>();
  const multipart = {
    uploadId: 'multipart-id',
    abort: vi.fn(async () => undefined),
    uploadPart: vi.fn(async (number: number, body: ReadableStream) => {
      sizes.set(number, (await new Response(body).arrayBuffer()).byteLength);
      return { partNumber: number, etag: `etag-${number}` };
    }),
    complete: vi.fn(async () => { object = { size: [...sizes.values()].reduce((a,b) => a+b,0) }; return object; }),
  };
  const bucket = { createMultipartUpload: vi.fn(async () => multipart), resumeMultipartUpload: () => multipart,
    head: vi.fn(async () => object), delete: vi.fn(async () => undefined) };
  const env = { DB: f.db, EMAIL_BUCKET: bucket, APP_URL: 'https://mail.example.com' } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: HonoVariables }>();
  app.use('*', async (c,next) => { c.set('userId',c.req.header('test-user') || 'u'); await next(); });
  app.route('/uploads',largeUploadRoutes);
  const call = (path: string, options: RequestInit = {}) => app.request(`/uploads${path}`, options, env);
  async function start(size: number) {
    const response = await call('', { method:'POST', headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:'large.bin',size}) });
    expect(response.status).toBe(201);
    return (await response.json() as {data:{shareId:string}}).data.shareId;
  }
  const part = (id: string, number: number, size: number, user='u') => call(`/${id}/parts/${number}`, {
    method:'PUT',headers:{'Content-Length':String(size),'test-user':user},body:new Uint8Array(size),
  });
  return { ...f, env, bucket, multipart, call, start, part };
}

describe('multipart shared uploads', () => {
  it('persists chosen chunk sizes, exposes confirmed parts and rejects unsupported sizes', async () => {
    const f=fixture();
    const response=await f.call('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:'file.bin',size:5*1024*1024+1,partSize:5*1024*1024})});
    expect(response.status).toBe(201);
    const {data:{shareId:id}}=await response.json() as {data:{shareId:string}};
    expect((await f.part(id,1,5*1024*1024)).status).toBe(200);
    const status=await f.call(`/${id}`);
    expect((await status.json() as {data:{completedParts:number[];partSize:number}}).data).toMatchObject({completedParts:[1],partSize:5*1024*1024});
    expect((await f.call(`/${id}`,{headers:{'test-user':'other'}})).status).toBe(404);
    const invalid=await f.call('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:'file',size:1,partSize:1024})});
    expect(invalid.status).toBe(400);
    f.sqlite.close();
  });
  it('cancels only owned unfinished uploads and preserves sent/completing files', async () => {
    const f=fixture();const id=await f.start(1);
    await f.part(id,1,1);
    expect((await f.call(`/${id}`,{method:'DELETE',headers:{'test-user':'other'}})).status).toBe(200);
    expect(f.multipart.abort).not.toHaveBeenCalled();
    expect((await f.call(`/${id}`,{method:'DELETE'})).status).toBe(200);
    expect(f.multipart.abort).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT * FROM shared_files').all()).toEqual([]);
    expect(f.sqlite.prepare('SELECT * FROM shared_upload_parts').all()).toEqual([]);
    expect((await f.call(`/${id}`,{method:'DELETE'})).status).toBe(200);
    const finishing=await f.start(1);
    f.sqlite.prepare("UPDATE shared_uploads SET status='completing' WHERE share_id=?").run(finishing);
    expect((await f.call(`/${finishing}`,{method:'DELETE'})).status).toBe(409);
    f.sqlite.exec("INSERT INTO shared_files(id,user_id,filename,size,r2_key,lifecycle) VALUES ('sent-link','u','file',1,'key','retained')");
    expect((await f.call('/sent-link',{method:'DELETE'})).status).toBe(409);
    f.sqlite.close();
  });
  it('keeps a cancellation tombstone when storage fails so scheduled cleanup can retry', async () => {
    const f=fixture();const id=await f.start(1);
    f.multipart.abort.mockRejectedValueOnce(new Error('R2 temporarily unavailable'));
    expect((await f.call(`/${id}`,{method:'DELETE'})).status).toBe(500);
    expect((await f.part(id,1,1)).status).toBe(404);
    expect(await cleanupSharedUploads(f.env)).toBe(1);
    expect(f.sqlite.prepare('SELECT * FROM shared_uploads').all()).toEqual([]);
    f.sqlite.close();
  });
  it('accepts a 127 MiB file in bounded chunks and completes idempotently', async () => {
    const f = fixture(); const size = 127 * 1024 * 1024; const id = await f.start(size);
    for(let offset=0,number=1;offset<size;offset+=PART,number++) {
      expect((await f.part(id,number,Math.min(PART,size-offset))).status).toBe(200);
    }
    const completed = await f.call(`/${id}/complete`,{method:'POST'});
    expect(completed.status).toBe(201);
    expect((await completed.json() as {data:{size:number}}).data.size).toBe(size);
    expect(f.sqlite.prepare('SELECT * FROM shared_uploads').all()).toEqual([]);
    expect(f.sqlite.prepare('SELECT * FROM shared_upload_parts').all()).toEqual([]);
    expect((await f.call(`/${id}/complete`,{method:'POST'})).status).toBe(201);
    expect(f.multipart.complete).toHaveBeenCalledTimes(1);
    expect(f.sqlite.prepare('SELECT lifecycle FROM shared_files').get()).toEqual({lifecycle:'staged'});
    f.sqlite.close();
  });
  it('blocks other users, incorrect part lengths, missing parts and premature sends', async () => {
    const f=fixture(); const id=await f.start(PART+1); f.email('mail');
    expect((await f.part(id,1,PART,'other')).status).toBe(404);
    expect((await f.part(id,1,1)).status).toBe(400);
    expect((await f.part(id,3,1)).status).toBe(400);
    expect((await f.call(`/${id}/complete`,{method:'POST'})).status).toBe(409);
    await expect(sharedFileStatements(f.env,'mail','u',`/api/shared/${id}`,'')).rejects.toThrow('no longer available');
    expect(() => f.sqlite.prepare('INSERT INTO email_shared_files VALUES (?,?)').run('mail',id)).toThrow('wait for the upload');
    expect(f.multipart.uploadPart).not.toHaveBeenCalled();
    f.sqlite.close();
  });
  it('retries acknowledged parts without reuploading, and recovers a lost completion response', async () => {
    const f=fixture(); const id=await f.start(1);
    expect((await f.part(id,1,1)).status).toBe(200);
    expect((await f.part(id,1,1)).status).toBe(200);
    expect(f.multipart.uploadPart).toHaveBeenCalledTimes(1);
    f.bucket.head.mockResolvedValue({size:1});
    expect((await f.call(`/${id}/complete`,{method:'POST'})).status).toBe(201);
    expect(f.multipart.complete).not.toHaveBeenCalled();
    f.sqlite.close();
  });
  it('cleans abandoned upload metadata and parts without retaining unfinished links', async () => {
    const f=fixture(); const id=await f.start(1); await f.part(id,1,1);
    f.sqlite.prepare("UPDATE shared_files SET created_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(id);
    expect(await cleanupSharedUploads(f.env)).toBe(1);
    expect(f.sqlite.prepare('SELECT * FROM shared_upload_parts').all()).toEqual([]);
    expect(f.sqlite.prepare('SELECT * FROM shared_uploads').all()).toEqual([]);
    f.sqlite.close();
  });
  it('rejects files beyond the advertised limit before creating any storage upload', async () => {
    const f=fixture();
    const response=await f.call('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filename:'huge.bin',size:1024**3+1})});
    expect(response.status).toBe(413);
    expect(f.bucket.createMultipartUpload).not.toHaveBeenCalled();
    f.sqlite.close();
  });
});
