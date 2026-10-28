/**
 * Removal-only HTML hardening for inbound email bodies.
 *
 * This is DEFENCE IN DEPTH, not the security boundary. The boundary is the
 * sandboxed iframe in packages/web/src/components/EmailBody.tsx, which grants
 * neither `allow-scripts` nor `allow-same-origin` — sender JavaScript cannot
 * execute there at all, whatever survives this function.
 *
 * That distinction matters: a regex-based sanitizer can always be bypassed by
 * a sufficiently creative encoding, so nothing security-critical may depend on
 * it. Its job is to strip the obvious and reduce noise (tracking beacons,
 * layout-breaking blocks), not to make hostile HTML safe.
 */
import { replaceTags, stripBlocks } from './utils';

/** Elements that execute, load code, navigate, or reshape the frame. */
const DANGEROUS_ELEMENTS = [
  'script',
  'iframe',
  'object',
  'embed',
  'applet',
  'base',
  'meta',
  'link',
  'noscript',
  'template',
  'svg',
  'math',
];

/**
 * Elements whose tags are removed but whose text content is kept.
 *
 * `<form>` used to be stripped wholesale, which silently deleted the visible
 * text of any newsletter that wrapped its layout in a form — the content
 * vanished from the message body with no indication why.
 */
const UNWRAP_ELEMENTS = ['form', 'button', 'input', 'textarea', 'select', 'option'];

/**
 * Decode the entity forms an attacker uses to smuggle a scheme past a naive
 * check (`&#106;avascript:`, `&Tab;`, `&NewLine;`, …). Decoding before testing
 * is what makes the scheme check meaningful.
 */
function decodeEntities(value: string): string {
  // Out-of-range references decode to U+FFFD, as in browsers; fromCodePoint
  // would throw and fail delivery of the whole message.
  const char = (code: number) => String.fromCodePoint(code <= 0x10ffff ? code : 0xfffd);
  return value
    .replace(/&#x([0-9a-f]+);?/gi, (_m, hex: string) => char(parseInt(hex, 16) || 0))
    .replace(/&#(\d+);?/g, (_m, dec: string) => char(parseInt(dec, 10) || 0))
    .replace(/&tab;/gi, '\t')
    .replace(/&newline;/gi, '\n')
    .replace(/&colon;/gi, ':')
    .replace(/&amp;/gi, '&');
}

/**
 * True for a URL that executes rather than fetches.
 *
 * `data:` is handled by allowlist, not blocklist: anything that is not a plain
 * raster image is rejected. An earlier version blocklisted `data:text/html`
 * inside a shared alternation whose trailing `\s*:` bound to every branch, so
 * it only ever matched the nonsense `data:text/html:` and let real
 * `data:text/html;base64,…` straight through. Its test passed only because the
 * probe wrapped the payload in an `<iframe>` that was element-stripped for an
 * unrelated reason — the assertion never exercised the scheme check at all.
 */
function isDangerousUrl(rawValue: string): boolean {
  // Strip whitespace and control characters anywhere in the value; browsers
  // ignore them inside a scheme, naive checks do not. Done with a code-point
  // filter so no literal control bytes appear in this source file.
  let value = '';
  for (const ch of decodeEntities(rawValue)) {
    const code = ch.codePointAt(0) as number;
    if (code > 0x20 && code !== 0x7f) value += ch;
  }

  if (/^(?:javascript|vbscript|livescript|mocha|file):/i.test(value)) return true;
  // Any data: URI that is not a plain raster image is treated as executable.
  if (/^data:/i.test(value)) {
    return !/^data:image\/(?:png|jpe?g|gif|webp|bmp|x-icon)[;,]/i.test(value);
  }
  return false;
}

// Paired and tag patterns go through stripBlocks/replaceTags: as plain regexes they
// are O(openers x length) on unclosed openers, which one inbound body can supply.
// Every removal leaves a space: removing to '' let `<scr<svg></svg>ipt>` rejoin into a
// `<script>` after the script pass had already run.
function stripElement(html: string, tag: string): string {
  return unwrapElement(stripBlocks(html, [tag], ' '), tag);
}

function unwrapElement(html: string, tag: string): string {
  return replaceTags(html, new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi'), ' ');
}

/**
 * Strip inline event handlers.
 *
 * The separator is `[\s/"']` rather than `\s`: HTML allows a solidus between
 * attributes (`<img/src=x/onerror=alert(1)>`) and starts a new attribute right
 * after a closing quote (`<img src="x"onerror=alert(1)>`), both of which a
 * whitespace-only pattern walks straight past. It is a lookbehind so the
 * previous value's closing quote stays in place.
 */
function stripEventHandlers(html: string): string {
  return html
    .replace(/(?<=[\s/"'])on[a-z-]+\s*=\s*"[^"]*"/gi, ' ')
    .replace(/(?<=[\s/"'])on[a-z-]+\s*=\s*'[^']*'/gi, ' ')
    .replace(/(?<=[\s/"'])on[a-z-]+\s*=\s*[^\s>]+/gi, ' ')
    // A removal above can leave a valueless handler name right before a later
    // `= value` (`onerror onx=y = "…"`); rename it so that value binds to a dead name.
    .replace(/(?<=[\s/"'])on[a-z-]+(?=\s*=)/gi, 'x');
}

/**
 * Neutralize href/src/action/formaction pointing at an executable scheme.
 *
 * A harmless match must not swallow what follows it: a candidate can sit inside
 * another attribute's value (`<a title='src="' href="javascript:…">`), and its
 * quoted "value" then runs over the real attribute. So after a harmless quoted
 * match the scan resumes just inside its opening quote (each stretch between
 * quotes is rescanned at most once, so this stays linear). Unquoted values stop
 * at a quote: no attribute can start inside a real unquoted value, and a scheme
 * containing a quote is not a scheme, so the danger check loses nothing.
 */
function stripDangerousUrls(html: string): string {
  const re = /(?<=[\s/"'])(href|src|srcset|action|formaction|xlink:href|poster|background|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))/gi;
  let out = '', from = 0, m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (isDangerousUrl(m[3] ?? m[4] ?? m[5] ?? '')) { out += html.slice(from, m.index) + `${m[1]}="#"`; from = re.lastIndex; }
    else if (m[5] === undefined) re.lastIndex = m.index + m[0].length - m[2].length + 1;
  }
  return out + html.slice(from);
}

/**
 * `<style>` can exfiltrate via url() and cover the page for clickjacking.
 *
 * An UNCLOSED `<style>` must also be handled: the paired pattern misses it, and
 * leaving the opening tag makes the browser swallow the remainder of the
 * document as CSS, rendering the message blank.
 */
function stripStyleBlocks(html: string): string {
  // Properly closed block: remove tags and contents.
  const closed = stripBlocks(html, ['style'], ' ');
  // Unclosed block: remove the tag and the CSS that follows it, but stop at
  // the next tag. Consuming to end-of-string instead would delete the whole
  // rest of the message — the same data-loss shape as stripping <form>
  // with its contents. CSS cannot contain '<', so this is a safe boundary.
  return replaceTags(replaceTags(closed, /<style\b[^>]*>[^<]*/gi, ' '), /<\/?style\b[^>]*>/gi, ' ');
}

/**
 * An unclosed `<script>` leaves its JavaScript as visible text once the tag is
 * gone. Harmless but confusing, so the code up to the next tag goes too —
 * bounded the same way as the style case.
 */
function stripUnclosedScript(html: string): string {
  return replaceTags(html, /<script\b[^>]*>[^<]*/gi, ' ');
}

export function sanitizeEmailHtml(html: string): string {
  if (!html) return '';

  let out = stripStyleBlocks(html);
  out = stripUnclosedScript(out);
  for (const tag of DANGEROUS_ELEMENTS) out = stripElement(out, tag);
  for (const tag of UNWRAP_ELEMENTS) out = unwrapElement(out, tag);
  out = stripEventHandlers(out);
  out = stripDangerousUrls(out);

  return out;
}
