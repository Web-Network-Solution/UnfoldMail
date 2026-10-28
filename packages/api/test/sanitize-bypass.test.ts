/**
 * Bypass coverage for the inbound HTML sanitizer.
 *
 * Written after an adversarial review found the original suite was partly
 * VACUOUS: the `data:text/html` case wrapped its payload in an `<iframe>`, so
 * the assertion passed because the element was stripped — the URL-scheme check
 * it claimed to test was never exercised, and was in fact broken (a shared
 * trailing `\s*:` in the alternation meant it only matched `data:text/html:`).
 *
 * Every case here targets a bypass DIRECTLY, in markup the sanitizer is
 * supposed to keep, so a regression cannot hide behind unrelated stripping.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from '../src/lib/sanitize-html';
import { extractSnippet } from '../src/lib/utils';
import { htmlText } from '../src/services/mail-filters';

describe('URL scheme check is actually reached', () => {
  // The original failing case, on an <a> that survives sanitization so the
  // scheme check is the ONLY thing that can neutralize it.
  it('neutralizes data:text/html on an anchor', () => {
    const out = sanitizeEmailHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>');
    expect(out).not.toContain('data:text/html');
    expect(out).toContain('href="#"');
  });

  it('neutralizes data:text/html without base64', () => {
    const out = sanitizeEmailHtml('<a href="data:text/html,<b>hi</b>">x</a>');
    expect(out).not.toContain('data:text/html');
  });

  it.each([
    ['unquoted', '<a href=data:text/html;base64,AA>x</a>'],
    ['single-quoted', "<a href='data:text/html;base64,AA'>x</a>"],
    ['leading whitespace', '<a href="   data:text/html;base64,AA">x</a>'],
    ['mixed case scheme', '<a href="DaTa:TeXt/HtMl;base64,AA">x</a>'],
    ['data:image/svg+xml (can script)', '<img src="data:image/svg+xml;base64,AA">'],
    ['data:application/javascript', '<a href="data:application/javascript,alert(1)">x</a>'],
  ])('rejects %s', (_label, input) => {
    expect(sanitizeEmailHtml(input)).not.toMatch(/data:(?!image\/(?:png|jpe?g|gif|webp|bmp))/i);
  });

  // The processor embeds inline images as data: URIs, so these must survive.
  it.each([
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/jpeg;base64,/9j/4AAQ',
    'data:image/gif;base64,R0lGODlh',
    'data:image/webp;base64,UklGRg==',
  ])('preserves %s', (uri) => {
    expect(sanitizeEmailHtml(`<img src="${uri}">`)).toContain(uri);
  });
});

describe('encoding bypasses', () => {
  it.each([
    ['decimal entities', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['hex entities', '<a href="&#x6a;avascript:alert(1)">x</a>'],
    ['entity colon', '<a href="javascript&colon;alert(1)">x</a>'],
    ['embedded tab', '<a href="java\tscript:alert(1)">x</a>'],
    ['embedded newline', '<a href="java\nscript:alert(1)">x</a>'],
    ['&Tab; entity', '<a href="java&Tab;script:alert(1)">x</a>'],
    ['leading control char', '<a href="javascript:alert(1)">x</a>'],
  ])('neutralizes %s', (_label, input) => {
    const out = sanitizeEmailHtml(input);
    // Whatever encoding survives, the href must have been replaced.
    expect(out).toContain('href="#"');
  });
});

describe('attribute-separator bypasses', () => {
  // HTML permits a solidus between attributes, so a whitespace-only pattern
  // walks straight past this.
  it('strips a handler separated by a solidus', () => {
    const out = sanitizeEmailHtml('<img/src=x/onerror=alert(1)>');
    expect(out).not.toMatch(/onerror/i);
  });

  it('strips a handler after multiple solidi', () => {
    const out = sanitizeEmailHtml('<img//src=x//onerror=alert(1)>');
    expect(out).not.toMatch(/onerror/i);
  });

  it('strips a handler with newline separation', () => {
    const out = sanitizeEmailHtml('<img\n  src=x\n  onerror=alert(1)>');
    expect(out).not.toMatch(/onerror/i);
  });

  // HTML also starts a new attribute right after a closing quote.
  it('strips a handler glued to the previous quoted value', () => {
    expect(sanitizeEmailHtml('<img src="x"onerror=alert(1)>')).toBe('<img src="x" >');
    expect(sanitizeEmailHtml("<img src='x'onerror='alert(1)'>")).not.toMatch(/onerror/i);
  });

  it('neutralizes a URL glued to the previous quoted value', () => {
    expect(sanitizeEmailHtml('<a title="x"href="javascript:alert(1)">c</a>')).toBe('<a title="x"href="#">c</a>');
  });
});

describe('stripped tags cannot rejoin into a dangerous one', () => {
  // A removal that left nothing behind joined its neighbours, rebuilding a tag
  // an earlier pass had already handled.
  it.each([
    '<scr<script></script>ipt>alert(1)</scr<script></script>ipt>',
    '<ifr<svg></svg>ame srcdoc="&lt;b&gt;x"></ifr<svg></svg>ame>',
    '<scr</math>ipt>alert(1)</scr</math>ipt>',
    '<fo<button>rm action="//evil"><input></fo<select>rm>',
  ])('%j', (input) => {
    expect(sanitizeEmailHtml(input)).not.toMatch(/<\/?(?:script|iframe|form)\b/i);
  });
});

describe('unclosed-tag bypasses', () => {
  // An unclosed <style> makes the browser swallow the rest of the document as
  // CSS, so the message renders blank.
  it('removes an unclosed style block and keeps the following content', () => {
    const out = sanitizeEmailHtml('<style>body{}<p>the actual message</p>');
    expect(out).not.toContain('<style');
    expect(out).toContain('the actual message');
  });

  it('removes an unclosed script and its trailing content', () => {
    expect(sanitizeEmailHtml('<script>alert(1)<p>x</p>')).not.toContain('<script');
  });
});

describe('content preservation', () => {
  // Regression: <form> was stripped WITH its contents, silently deleting the
  // visible text of any newsletter whose layout was wrapped in a form.
  it('unwraps a form but keeps the text inside it', () => {
    const out = sanitizeEmailHtml(
      '<form action="//evil"><p>Your invoice is attached.</p></form>'
    );
    expect(out).not.toContain('<form');
    expect(out).toContain('Your invoice is attached.');
  });

  it('keeps text inside a button wrapper', () => {
    const out = sanitizeEmailHtml('<button>Click through</button>');
    expect(out).toContain('Click through');
  });

  it('keeps ordinary links, images and formatting untouched', () => {
    const html =
      '<p>Hi <strong>Emma</strong></p><a href="https://ok.example/a?b=1">link</a><img src="https://cdn/x.png">';
    expect(sanitizeEmailHtml(html)).toBe(html);
  });
});

// Paired /<x\b[^>]*>[\s\S]*?<\/x\s*>/ and /<[^>]*>/ patterns rescan to the end for
// every unclosed opener: about 50 s per pass on one 1 MiB inbound body, which
// made that message a poison queue entry. Every ingest pass must stay linear.
describe('linear time on unclosed openers', () => {
  const units = ['<style>', '<head>', '<script', '<script ', '<!--', '<', '<style', '<form', '<svg>', '<iframe '];
  it.each(units)('%j repeated to 1 MiB', (unit) => {
    const html = unit.repeat(Math.ceil((1 << 20) / unit.length));
    for (const pass of [sanitizeEmailHtml, htmlText, extractSnippet]) {
      const started = performance.now(); pass(html);
      expect(performance.now() - started, pass.name).toBeLessThan(1000);
    }
  });

  // Each removal leaves one space so stripped tags cannot rejoin.
  it('keeps the regex results on closed, unclosed and mixed blocks', () => {
    expect(sanitizeEmailHtml('<p>a</p><style>b{}</style ><p>c</p><STYLE x=1>d{}</style>')).toBe('<p>a</p> <p>c</p> ');
    expect(sanitizeEmailHtml('<style>x{}</style><style>y{}<p>kept</p>')).toBe('  <p>kept</p>');
    expect(sanitizeEmailHtml('<svg><a>x</a></svg>ok<iframe src=x></iframe><svg')).toBe(' ok <svg');
    expect(sanitizeEmailHtml('<script>a</script><p>x</p><script>b')).toBe('  <p>x</p> ');
    expect(htmlText('<html><head><title>t</title></head><!--[if mso]><b>x</b><![endif]--><p>Hi</p><script>s()</script>').trim()).toBe('Hi');
    expect(htmlText('<p title="a<b">Hi</p><style>unclosed').replace(/\s+/g, ' ').trim()).toBe('Hi unclosed');
    expect(extractSnippet('<style>.a{}</style ><p>Hi&nbsp;<b>there</b></p><script>x')).toBe('Hi there x');
  });

  // The attribute passes anchor on a lookbehind that also accepts a quote.
  it.each(['"src=', '"src="', "'onx='", '"onx="', '"on', '"src="javascript:', '<!--!', '<!--->', '<!-- --!'])(
    '%j stays linear from 1 to 4 MiB',
    (unit) => {
      for (const mib of [1, 4]) {
        const html = unit.repeat(Math.ceil((mib << 20) / unit.length));
        for (const pass of [sanitizeEmailHtml, htmlText]) {
          const started = performance.now(); pass(html);
          expect(performance.now() - started, `${pass.name} ${mib} MiB`).toBeLessThan(1000 * mib);
        }
      }
    },
    20_000
  );
});

// Comment closers follow the HTML tokenizer, not /<!--[\s\S]*?-->/: text after
// <!--> or before --!> is visible in a browser, so filters must see it too.
describe('htmlText comment closers', () => {
  it.each([
    ['<!-->Hi<!-- x -->', 'Hi'],
    ['<p>x</p><!-->Invoice due<!-- x --><p>y</p>', 'x Invoice due y'],
    ['<!--->Hi<!-- x -->', 'Hi'],
    ['<p>Invoice</p><!-- a --!> due <!-- b -->', 'Invoice due'],
    ['<!--!>hidden-->shown', 'shown'],
    ['a<!---->b<!--->c<!-->d<!--!>e-->f', 'a b c d f'],
  ])('%j', (html, text) => {
    expect(htmlText(html).replace(/\s+/g, ' ').trim()).toBe(text);
  });
});

// A harmless URL candidate inside another attribute's value must not swallow the
// real attribute after it, and removing a handler must not leave a valueless one
// in front of a later `= value`.
describe('attribute passes cannot be steered past a real attribute', () => {
  it.each([
    `<a title='src="' href="javascript:alert(1)">x</a>`,
    `<a title=' src="' href="javascript:alert(1)">x</a>`,
    `<a title="src='" href='javascript:alert(1)'>x</a>`,
    `<img alt='poster="' src="javascript:alert(1)">`,
    `<a title='src=x'href="javascript:alert(1)">x</a>`,
  ])('neutralizes the real URL in %j', (html) => {
    expect(sanitizeEmailHtml(html)).not.toMatch(/javascript:/i);
  });

  it.each([
    `<img src=x onerror<svg></svg>onx=yonx = "alert(1)">`,
    `<img src=x onerror onx="y" = "alert(1)">`,
    `<img src=x onerror onx=y = 'alert(1)'>`,
  ])('leaves no live handler in %j', (html) => {
    expect(sanitizeEmailHtml(html)).not.toMatch(/(?<=[\s/"'])on[a-z-]+\s*=/i);
  });

  it('keeps harmless values and stays linear on nested candidates', () => {
    expect(sanitizeEmailHtml(`<a title='src="' href="https://x.test/">x</a>`)).toBe(`<a title='src="' href="https://x.test/">x</a>`);
    for (const unit of [' src=/', '"src="', `'src=a'`, ' src=', ' onx onx =']) {
      const html = unit.repeat(Math.ceil((1 << 20) / unit.length));
      const started = performance.now();
      sanitizeEmailHtml(html);
      expect(performance.now() - started).toBeLessThan(1500);
    }
  });
});
