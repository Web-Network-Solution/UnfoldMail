import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension, Node, mergeAttributes, type Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { DOMSerializer } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import { TextStyleKit } from '@tiptap/extension-text-style';
import TextAlign from '@tiptap/extension-text-align';
import DOMPurify from 'dompurify';
import { remoteImagesAllowed } from '../lib/settings';

interface RichTextEditorProps {
  initialHtml:string;
  onChange:(value:{html:string;text:string})=>void;
  placeholder?:string;
  autoFocus?:boolean;
}
export interface RichTextEditorHandle {appendHtml:(html:string)=>void;replaceHtml:(html:string)=>void;}

export function sanitizeComposeHtml(html:string):string {
  const clean=DOMPurify.sanitize(html,{USE_PROFILES:{html:true},FORBID_TAGS:['style','form','input','button','textarea','select','video','audio'],FORBID_ATTR:['id','name','srcset','background']});
  const doc=new DOMParser().parseFromString(clean,'text/html');
  // Preserve email typography without allowing CSS overlays or external CSS URLs.
  const styles=['color','background-color','font-family','font-size','font-weight','font-style','text-decoration','text-align','border','border-left','border-collapse','padding','padding-left','margin','margin-left','width','height','max-width'];
  for(const el of doc.body.querySelectorAll<HTMLElement>('*')){
    const kept=styles.map(k=>[k,el.style.getPropertyValue(k)]).filter(([,v])=>v&&!/url\s*\(|expression|var\s*\(/i.test(v));
    el.removeAttribute('style');for(const [k,v]of kept)el.style.setProperty(k,v);
    if(el.tagName==='A'&&!/^(https?:|mailto:)/i.test(el.getAttribute('href')||''))el.removeAttribute('href');
    if(el.tagName==='IMG'&&!/^(https?:|cid:|data:image\/(png|jpeg|gif|webp);base64,)/i.test(el.getAttribute('src')||''))el.removeAttribute('src');
  }
  return doc.body.innerHTML;
}
const EmailSection=Node.create({name:'emailSection',group:'block',content:'block+',defining:true,
  // data-signature tells the server the signature is already in the body; dropping it made every message carry two signatures.
  addAttributes(){return {class:{default:null,parseHTML:el=>el.classList.contains('email-signature')?'email-signature':'gmail_quote'},'data-signature':{default:null,parseHTML:el=>el.getAttribute('data-signature')}};},
  parseHTML(){return [{tag:'div.email-signature'},{tag:'div.gmail_quote'}];},
  renderHTML({HTMLAttributes}){return ['div',mergeAttributes(HTMLAttributes),0];}
});
// A reply keeps the quoted images in the model and the sent HTML, but the live editor is the app document:
// no CSP, no sandbox. Unless remote images are allowed, a remote image is drawn without src (URL in data-remote-src).
const isRemote=(src:unknown)=>{try{return typeof src==='string'&&/^https?:$/.test(new URL(src,location.href).protocol);}catch{return false;}};
const MailImage=Image.extend({addNodeView(){return ({HTMLAttributes})=>{
  const dom=document.createElement('img'),attrs=mergeAttributes(this.options.HTMLAttributes,HTMLAttributes);
  if(isRemote(attrs.src)&&!remoteImagesAllowed()){attrs['data-remote-src']=attrs.src;delete attrs.src;}
  for(const [k,v] of Object.entries(attrs))if(v!=null)dom.setAttribute(k,String(v));
  return {dom};
};}});
const EmailStyles=Extension.create({name:'emailStyles',addGlobalAttributes(){return [{types:['paragraph','heading','blockquote','image','table','tableRow','tableCell','tableHeader','emailSection'],attributes:{style:{default:null,parseHTML:el=>el.getAttribute('style'),renderHTML:a=>a.style?{style:a.style}:{}},width:{default:null},height:{default:null}}}];}});

// text/plain keeps link targets as "text <url>", so a shared-file download link reaches plain-text readers.
// Not when the text already is the target: "a@b.c" for mailto:a@b.c, "https://x.com" for https://x.com/.
// A loop, not /\/+$/: that regex backtracks from every slash in a run, O(n²) on a crafted quoted link.
const bare=(s:string)=>{s=s.replace(/^mailto:/i,'');let e=s.length;while(e&&s[e-1]==='/')e--;return s.slice(0,e);};
// editor.getHTML() builds each <img> in the app document first, and setting src there can start a fetch:
// same serializer, but into an inert document.
const inertHtml=(editor:Editor)=>{const d=document.implementation.createHTMLDocument(''),div=d.createElement('div');div.append(DOMSerializer.fromSchema(editor.schema).serializeFragment(editor.state.doc.content,{document:d}));return div.innerHTML;};
const bodyValue=(editor:Editor)=>({html:inertHtml(editor),text:editor.getText({textSerializers:{text:({node,parent,index})=>{const link=node.marks.find(m=>m.type.name==='link'),next=parent.maybeChild(index+1);return link&&bare(link.attrs.href)!==bare(node.text||'')&&!(next&&link.isInSet(next.marks))?`${node.text} <${link.attrs.href}>`:node.text||'';}}})});

const RichTextEditor=forwardRef<RichTextEditorHandle,RichTextEditorProps>(function RichTextEditor({initialHtml,onChange,placeholder,autoFocus},ref){
  const onChangeRef=useRef(onChange);onChangeRef.current=onChange;
  const [linkOpen,setLinkOpen]=useState(false),[url,setUrl]=useState(''),[error,setError]=useState('');
  const editor=useEditor({shouldRerenderOnTransaction:true,extensions:[StarterKit.configure({link:{openOnClick:false,protocols:['mailto'],autolink:false}}),MailImage.configure({allowBase64:true}),TableKit,TextStyleKit,TextAlign.configure({types:['heading','paragraph']}),EmailSection,EmailStyles],
    content:sanitizeComposeHtml(initialHtml),autofocus:autoFocus?'start':false,
    editorProps:{attributes:{class:'rich-editor-surface',role:'textbox','aria-label':'Message body','aria-multiline':'true','data-placeholder':placeholder||''},
      handlePaste(view,event){const text=event.clipboardData?.getData('text/plain');if(text===undefined)return false;event.preventDefault();view.dispatch(view.state.tr.insertText(text));return true;}},
    onCreate:({editor})=>onChangeRef.current(bodyValue(editor)),
    onUpdate:({editor})=>onChangeRef.current(bodyValue(editor))
  });
  // Synchronize normalized HTML before the first send, including signatures and quotes.
  useEffect(()=>{if(editor&&!editor.isDestroyed)onChangeRef.current(bodyValue(editor));},[editor]);
  useImperativeHandle(ref,()=>({replaceHtml(html){if(!editor)return;editor.view.dispatch(closeHistory(editor.state.tr));editor.chain().selectAll().insertContent(sanitizeComposeHtml(html)).run();editor.view.dispatch(closeHistory(editor.state.tr));},appendHtml(html){if(!editor)return;let position=editor.state.doc.content.size;editor.state.doc.descendants((node,pos)=>{if(node.type.name==='emailSection'){position=Math.min(position,pos);return false;}});editor.commands.insertContentAt(position,sanitizeComposeHtml(html));}}),[editor]);
  if(!editor)return <div className="rich-editor" aria-busy="true">Loading editor…</div>;
  const actions=[
    {label:'B',name:'Bold',active:editor.isActive('bold'),run:()=>editor.chain().focus().toggleBold().run()},
    {label:'I',name:'Italic',active:editor.isActive('italic'),run:()=>editor.chain().focus().toggleItalic().run()},
    {label:'U',name:'Underline',active:editor.isActive('underline'),run:()=>editor.chain().focus().toggleUnderline().run()},
    {label:'• List',name:'Bulleted list',active:editor.isActive('bulletList'),run:()=>editor.chain().focus().toggleBulletList().run()},
    {label:'1. List',name:'Numbered list',active:editor.isActive('orderedList'),run:()=>editor.chain().focus().toggleOrderedList().run()},
    {label:'Quote',name:'Block quote',active:editor.isActive('blockquote'),run:()=>editor.chain().focus().toggleBlockquote().run()},
  ];
  return <div className="rich-editor"><div className="rich-editor-toolbar" role="toolbar" aria-label="Formatting">{actions.map(a=><button key={a.name} type="button" aria-label={a.name} aria-pressed={a.active} title={a.name} onMouseDown={e=>e.preventDefault()} onClick={a.run}>{a.label}</button>)}<button type="button" aria-label="Insert link" onClick={()=>{setUrl(editor.getAttributes('link').href||'');setError('');setLinkOpen(!linkOpen);}}>Link</button><button type="button" aria-label="Remove link" disabled={!editor.isActive('link')} onClick={()=>editor.chain().focus().unsetLink().run()}>Unlink</button><button type="button" aria-label="Undo" disabled={!editor.can().undo()} onClick={()=>editor.chain().focus().undo().run()}>Undo</button><button type="button" aria-label="Redo" disabled={!editor.can().redo()} onClick={()=>editor.chain().focus().redo().run()}>Redo</button><button type="button" aria-label="Remove formatting" onClick={()=>editor.chain().focus().unsetAllMarks().clearNodes().run()}>Clear format</button></div>
  {linkOpen&&<div className="editor-link-form"><label>Link URL<input autoFocus type="url" value={url} onChange={e=>{setUrl(e.target.value);setError('');}} aria-invalid={!!error} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setLinkOpen(false);editor.commands.focus();}if(e.key==='Enter')e.preventDefault();}}/></label><button type="button" className="btn btn-secondary" onClick={()=>{if(!/^(https?:\/\/|mailto:)[^\s]+$/i.test(url.trim())){setError('Enter an http, https or mailto link.');return;}editor.chain().focus().extendMarkRange('link').setLink({href:url.trim()}).run();setLinkOpen(false);}}>Apply link</button><button type="button" className="btn btn-secondary" onClick={()=>setLinkOpen(false)}>Cancel</button>{error&&<p role="alert">{error}</p>}</div>}
  <EditorContent editor={editor}/></div>;
});
export default RichTextEditor;
