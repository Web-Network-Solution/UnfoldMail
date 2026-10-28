import { createRef, StrictMode } from 'react';
import { cleanup, render, act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RichTextEditor, { sanitizeComposeHtml, type RichTextEditorHandle } from '../src/components/RichTextEditor';
import { setRemoteImagesAllowed } from '../src/lib/settings';
beforeEach(()=>{
  Range.prototype.getBoundingClientRect=()=>({x:0,y:0,top:0,left:0,right:0,bottom:0,width:0,height:0,toJSON:()=>({})});
  Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;
  HTMLElement.prototype.scrollIntoView=vi.fn();
});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('initializes compose safely through React Strict Mode teardown and recreation',async()=>{
  const change=vi.fn();
  render(<StrictMode><RichTextEditor initialHtml="<p>Strict mode draft</p>" onChange={change}/></StrictMode>);
  await waitFor(()=>expect(change).toHaveBeenCalledWith(expect.objectContaining({text:'Strict mode draft'})));
  expect(screen.getByRole('textbox',{name:'Message body'})).toBeTruthy();
});
it('preserves signature images, links, tables and quoted replies',()=>{
  const change=vi.fn();render(<RichTextEditor initialHtml={'<p>Hello <strong>team</strong></p><div class="email-signature" data-signature="true"><table><tr><td><img src="https://example.com/logo.png" width="80" height="80"></td><td><p style="color: red">Regards <a href="mailto:employee@example.com">Employee</a></p></td></tr></table></div><div class="gmail_quote"><blockquote><p>Original message</p></blockquote></div>'} onChange={change}/>);
  const html=change.mock.lastCall![0].html;
  expect(html).toContain('email-signature');expect(html).toContain('data-signature="true"');expect(html).toContain('gmail_quote');expect(html).toContain('<table');expect(html).toContain('https://example.com/logo.png');expect(html).toContain('mailto:employee@example.com');expect(html).toContain('Original message');expect(html).toContain('color: red');
});
it('inserts shared links before signature and quote, and supports replacement undo',()=>{
  const ref=createRef<RichTextEditorHandle>(),change=vi.fn();render(<RichTextEditor ref={ref} initialHtml={'<p>Hello</p><div class="email-signature"><p>Employee</p></div><div class="gmail_quote"><blockquote>Original</blockquote></div>'} onChange={change}/>);
  act(()=>ref.current!.appendHtml('<p><a href="https://example.com/file">Shared file</a></p>'));
  const html=change.mock.lastCall![0].html;expect(html.indexOf('Shared file')).toBeLessThan(html.indexOf('email-signature'));
  act(()=>ref.current!.replaceHtml('<p>Replacement</p>'));expect(change.mock.lastCall![0].text).toContain('Replacement');
  fireEvent.click(screen.getByRole('button',{name:'Undo'}));expect(change.mock.lastCall![0].text).toContain('Hello');expect(change.mock.lastCall![0].text).toContain('Shared file');
});
it('sanitizes hostile compose HTML before displaying or serializing it',()=>{
  const html=sanitizeComposeHtml('<p style="position:fixed; background-image:url(https://tracker.example); color:red" onclick="alert(1)">Hello<script>alert(1)</script><a href="javascript:alert(1)">bad</a><img src="x" onerror="alert(1)"></p><iframe src="https://example.com"></iframe>');
  expect(html).not.toMatch(/onclick|onerror|javascript:|<script|iframe|position:|url\(/);expect(html).toContain('color: red');
  expect(sanitizeComposeHtml('<div class="email-signature" data-signature="true"><p>Sig</p></div>')).toContain('data-signature="true"');
});
it('keeps an invalid link open with contextual validation',()=>{
  render(<RichTextEditor initialHtml="<p>Hello</p>" onChange={()=>{}}/>);fireEvent.click(screen.getByRole('button',{name:'Insert link'}));fireEvent.change(screen.getByLabelText('Link URL'),{target:{value:'javascript:alert(1)'}});fireEvent.click(screen.getByRole('button',{name:'Apply link'}));expect(screen.getByRole('alert').textContent).toContain('http');
});
it('compares link text with its target in linear time',()=>{
  // /\/+$/ backtracked from every slash in the run: seconds per call for a crafted quoted link.
  const href='https://x.com/'+'/'.repeat(100_000)+'a',change=vi.fn(),started=performance.now();
  render(<RichTextEditor initialHtml={`<p><a href="${href}">${href}</a></p>`} onChange={change}/>);
  expect(performance.now()-started).toBeLessThan(1000);
  expect(change.mock.lastCall![0].text).toBe(href);
});
it('keeps quoted remote images in the sent HTML but never fetches them in the live editor',()=>{
  // Any <img> of the app document that gets a remote src starts a fetch: the view, and getHTML's own serialization.
  const live:string[]=[],setAttribute=Element.prototype.setAttribute;
  vi.spyOn(Element.prototype,'setAttribute').mockImplementation(function(this:Element,name:string,value:string){if(this.tagName==='IMG'&&name==='src'&&this.ownerDocument===document)live.push(value);return setAttribute.call(this,name,value);});
  const change=vi.fn(),{container}=render(<RichTextEditor initialHtml={'<p>Hi</p><div class="gmail_quote"><blockquote><img src="https://tracker.example/p.gif" alt="logo" width="1"><img src="data:image/png;base64,AAAA"></blockquote></div>'} onChange={change}/>);
  const img=container.querySelector('img[data-remote-src]')!;
  expect(img.getAttribute('data-remote-src')).toBe('https://tracker.example/p.gif');
  expect(img.hasAttribute('src')).toBe(false);expect(img.getAttribute('alt')).toBe('logo');expect(img.getAttribute('width')).toBe('1');
  expect(container.querySelector('img[src^="data:"]')).not.toBeNull();
  expect(live.filter(s=>/^https?:/i.test(s))).toEqual([]);
  expect(change.mock.lastCall![0].html).toMatch(/<img [^>]*src="https:\/\/tracker\.example\/p\.gif"/);
});
it('loads remote images in the editor when the viewer allowed remote images',()=>{
  setRemoteImagesAllowed(true);
  try{const {container}=render(<RichTextEditor initialHtml={'<p><img src="https://example.com/logo.png"></p>'} onChange={()=>{}}/>);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('https://example.com/logo.png');
  }finally{setRemoteImagesAllowed(false);}
});
