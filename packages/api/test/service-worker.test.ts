import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('service worker offline responses', () => {
  for(const mode of ['navigate','cors']) it(`returns a Response for an uncached offline ${mode} request`, async () => {
    const listeners: Record<string,(event:unknown)=>void>={};
    runInNewContext(readFileSync(join(__dirname,'../../web/public/sw.js'),'utf8'), {
      self:{location:{origin:'https://mail.example.com'},addEventListener:(type:string,fn:(event:unknown)=>void)=>{listeners[type]=fn;}},
      caches:{match:async()=>undefined},fetch:async()=>{throw new Error('offline');},Response,URL,console,
    });
    let result: Promise<Response> | undefined;
    const background:Promise<unknown>[]=[];
    listeners.fetch({request:{url:'https://mail.example.com/mail',method:'GET',mode,headers:new Headers()},
      respondWith:(promise:Promise<Response>)=>{result=promise;},waitUntil:(promise:Promise<unknown>)=>background.push(promise)});
    expect((await result)?.status).toBe(503);
    await Promise.all(background);
  });

  it('keeps one shell copy for every navigated URL, and only from an HTML 200', async () => {
    const listeners: Record<string,(event:unknown)=>void>={};
    const puts: [string,unknown][]=[];
    let reply = new Response('<!doctype html>', {headers:{'Content-Type':'text/html; charset=utf-8'}});
    runInNewContext(readFileSync(join(__dirname,'../../web/public/sw.js'),'utf8'), {
      self:{location:{origin:'https://mail.example.com'},addEventListener:(type:string,fn:(event:unknown)=>void)=>{listeners[type]=fn;}},
      caches:{open:async(name:string)=>({put:async(key:unknown)=>{puts.push([name,key]);}})},fetch:async()=>reply.clone(),Response,URL,console,
    });
    const navigate = async (path: string) => {
      const background:Promise<unknown>[]=[];
      let result: Promise<Response> | undefined;
      listeners.fetch({request:{url:'https://mail.example.com'+path,method:'GET',mode:'navigate',headers:new Headers()},
        respondWith:(promise:Promise<Response>)=>{result=promise;},waitUntil:(promise:Promise<unknown>)=>background.push(promise)});
      await result; await Promise.all(background);
    };
    await navigate('/mail?folder=f1&email=e1');
    await navigate('/mail?folder=f1&email=e2');
    expect(puts).toEqual([['unfoldmail-cache-v3','/index.html'],['unfoldmail-cache-v3','/index.html']]);
    // A directly opened non-HTML file, or an error page, must not become the offline shell.
    reply = new Response('<svg/>', {headers:{'Content-Type':'image/svg+xml'}});
    await navigate('/logo.svg');
    reply = new Response('<!doctype html>', {status:404,headers:{'Content-Type':'text/html'}});
    await navigate('/mail');
    expect(puts).toHaveLength(2);
  });
});
