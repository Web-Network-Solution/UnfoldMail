import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
export default function AIResponse({text}:{text:string}){return <div className="ai-response ai-markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{img:()=>null,a:({href,children})=><a href={href} target="_blank" rel="noopener noreferrer">{children}</a>}}>{text}</Markdown></div>;}
