/**
 * Renders an email body.
 *
 * Inbound HTML is attacker-controlled: anyone on the internet can send mail to
 * an employee. It used to go through `dangerouslySetInnerHTML`, so a crafted
 * message ran script on our origin with the session cookie in reach.
 *
 * It renders in a sandboxed iframe with NO `allow-scripts`, so sender-supplied
 * JavaScript never executes at all, and no `allow-same-origin`, so the frame
 * has an opaque origin and cannot reach our cookies, storage or DOM.
 *
 * ponytail: an earlier version granted `allow-scripts` purely so the frame
 * could postMessage its own height and auto-size. That traded a hard security
 * property ("email script is inert") for a cosmetic one, and left a regex
 * sanitizer as the only thing standing between hostile mail and code
 * execution — a regex is not a security boundary. The frame is a fixed height
 * with internal scrolling instead. Restore auto-sizing only via a mechanism
 * that does not require running the sender's page: e.g. measuring a sanitized
 * copy in a detached same-origin element.
 *
 * Never add `allow-scripts` or `allow-same-origin` here.
 *
 * Remote content (images, CSS url(), fonts) is blocked by a CSP <meta> in the
 * document itself, so a tracking pixel cannot report when and where a message
 * was opened. The CSP is the enforcement; the remote-reference check below only
 * decides whether to offer the "Show images" bar, so a reference it misses
 * stays blocked rather than leaking.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import type { Email, FolderType } from '@email-service/shared';
import { useThemeStore } from '../stores';
import { onRemoteImagesChange, remoteImagesAllowed, setRemoteImagesAllowed } from '../lib/settings';

interface EmailBodyProps {
  html?: string;
  text?: string;
  fallback?: string;
  /** Overrides the app theme, e.g. for a preview drawn on white. */
  theme?: 'light' | 'dark';
  /** The viewer's own mail or preview: load remote content without asking. */
  trusted?: boolean;
}

/**
 * Mail the viewer wrote (sent or draft), judged from server-set state only.
 * ponytail: a From header matching the viewer's address is deliberately not
 * enough: anyone can forge it, and it would switch tracking pixels back on.
 */
export const isOwnMail = (email: Pick<Email, 'deliveryStatus'>, folderType?: FolderType) =>
  !!email.deliveryStatus || folderType === 'sent' || folderType === 'drafts';

/**
 * A src/srcset/background/poster attribute or CSS url() whose value starts with
 * http(s): or a scheme-relative `//` (URL parsing treats `\\` the same).
 * Linear: no two adjacent quantifiers can trade the same characters, so a failed
 * attempt backtracks over one whitespace run once. Keep it that way:
 * `\s*["']?\s*` looks equivalent and is quadratic on `src=` plus a long run of spaces.
 */
const REMOTE_REF = /(?:\b(?:src|srcset|background|poster)\s*=|url\()\s*(?:(?:["']|&quot;|&#39;)\s*)?(?:https?:|[/\\]{2})/i;
export const hasRemoteContent = (html: string) => REMOTE_REF.test(html);

/**
 * Remote references inside the quoted message(s) only: a signature the server
 * appends after the quote is still the user's own. DOMParser documents are
 * inert, so parsing here never fetches anything.
 */
const quoteHasRemote = (html: string) =>
  html.includes('gmail_quote') &&
  [...new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.gmail_quote')].some((q) => hasRemoteContent(q.outerHTML));

const csp = (remote: boolean) => {
  const r = remote ? ' http: https:' : '';
  return `default-src 'none'; img-src data:${r}; style-src 'unsafe-inline'; font-src data:${r}`;
};

/** Wrap the message so it inherits readable typography without inheriting our CSS. */
function buildDocument(html: string, theme: 'light' | 'dark', remote: boolean): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(remote)}">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; }
  body {
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #202124;
    background: transparent;
    padding: 4px 2px;
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  img, video, table { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  a { color: #1a73e8; }
  /* Gmail-style quoted text */
  blockquote {
    margin: 12px 0 12px 0;
    padding: 0 0 0 12px;
    border-left: 3px solid #dadce0;
    color: #5f6368;
  }
  /* Nested blockquotes get progressively lighter */
  blockquote blockquote { border-color: #9aa0a6; }
  pre { white-space: pre-wrap; font-size: 13px; }
  /* Mail is authored for a light canvas: Outlook and template HTML set dark
     text inline, which recoloring left dark on dark. Like Gmail, the dark app
     theme draws the message on an opaque white card instead. */
  ${theme === 'dark' ? 'html { background: #fff; }' : ''}
</style>
</head>
<body>${html}</body>
</html>`;
}

export default function EmailBody({ html, text, fallback, theme, trusted }: EmailBodyProps) {
  const appTheme = useThemeStore((s) => s.theme);
  const always = useSyncExternalStore(onRemoteImagesChange, remoteImagesAllowed);
  // Keyed by body: a "Show images" for one message never carries over to the
  // next message this same component instance renders.
  const [shownFor, setShownFor] = useState<string>();
  // Own mail is trusted, but not the received message quoted in it (its tracker came along into the reply).
  const quotedRemote = useMemo(() => !!html && !!trusted && quoteHasRemote(html), [html, trusted]);
  if (html) {
    const own = !!trusted && !quotedRemote;
    const remote = own || always || shownFor === html;
    return (
      <>
        {!remote && hasRemoteContent(html) && (
          <div className="remote-images-bar">
            <span>Remote images are hidden to protect your privacy.</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShownFor(html)}>Show images</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setShownFor(html); setRemoteImagesAllowed(true); }}>Always show images</button>
          </div>
        )}
        <iframe
          className="email-body-frame"
          title="Message content"
          // No allow-scripts: sender JavaScript is inert.
          // No allow-same-origin: opaque origin, no access to our cookies/DOM.
          // No allow-popups-to-escape-sandbox: a link opened from the message
          // stays sandboxed rather than becoming a fully privileged tab.
          // Remote content is gated by the CSP in the document, never here.
          sandbox="allow-popups"
          referrerPolicy="no-referrer"
          srcDoc={buildDocument(html, theme || appTheme, remote)}
        />
      </>
    );
  }

  return (
    <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-family)', margin: 0 }}>
      {text || fallback || ''}
    </pre>
  );
}
