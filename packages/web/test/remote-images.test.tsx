import type { ReactElement } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import type { Email } from '@email-service/shared';
import EmailBody, { hasRemoteContent } from '../src/components/EmailBody';
import EmailView from '../src/components/EmailView';
import ThreadView from '../src/components/ThreadView';
import { remoteImagesAllowed, setRemoteImagesAllowed } from '../src/lib/settings';
vi.mock('../src/components/AIQuickActions', () => ({ AIWriting: () => null, AIEmailActions: () => null }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

const REMOTE = '<p>Hi</p><img src="https://tracker.example/p.gif">';
const BLOCKED = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">`;
const ALLOWED = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: http: https:; style-src 'unsafe-inline'; font-src data: http: https:">`;
const frame = (c: HTMLElement) => c.querySelector('iframe')!;
const doc = (c: HTMLElement) => frame(c).getAttribute('srcdoc')!;
const bar = () => screen.queryByText('Remote images are hidden to protect your privacy.');

it('blocks remote content by CSP until this message is shown, and never widens the sandbox', () => {
  const { container, rerender } = render(<EmailBody html={REMOTE} />);
  expect(doc(container)).toContain(BLOCKED);
  expect(doc(container)).toContain('<meta name="referrer" content="no-referrer">');
  expect(doc(container)).toContain('<base target="_blank">');
  expect(bar()).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show images' }));
  expect(doc(container)).toContain(ALLOWED);
  expect(bar()).toBeNull();
  expect(frame(container).getAttribute('sandbox')).toBe('allow-popups');
  // "Show images" is for this message only: not persisted, not carried to the next body.
  expect(remoteImagesAllowed()).toBe(false);
  rerender(<EmailBody html={REMOTE + '<p>next</p>'} />);
  expect(doc(container)).toContain(BLOCKED);
  expect(bar()).not.toBeNull();
  expect(frame(container).getAttribute('sandbox')).toBe('allow-popups');
});

it('offers the bar only when the message references remote content', () => {
  render(<EmailBody html={'<p>Hi</p><img src="data:image/png;base64,AAAA"><a href="https://example.com">link</a>'} />);
  expect(bar()).toBeNull();
  for (const html of [
    '<img src=https://x.example/a.png>', '<IMG SRC = "  http://x.example/a">', "<img srcset='//cdn.example/a 2x'>",
    '<td background="https://x.example/bg.png">', '<div style="background:url(&quot;https://x.example/a&quot;)">',
    "<div style=\"background: url( 'http://x.example/a' )\">", '<img src="\\\\evil.example/x">', '<video poster="https://x.example/p.jpg">',
  ]) expect(hasRemoteContent(html), html).toBe(true);
  for (const html of ['<img src="cid:logo">', '<img src="data:image/gif;base64,R0lG">', 'Visit https://example.com today', '<a href="//x.example">x</a>', '<img src="logo.png">'])
    expect(hasRemoteContent(html), html).toBe(false);
});

it('remembers "Always show images" for this browser, and the Settings toggle turns it off', () => {
  const { container, unmount } = render(<EmailBody html={REMOTE} />);
  fireEvent.click(screen.getByRole('button', { name: 'Always show images' }));
  expect(localStorage.getItem('mail-remote-images')).toBe('always');
  expect(doc(container)).toContain(ALLOWED);
  unmount();
  const second = render(<EmailBody html={REMOTE + '<p>other</p>'} />);
  expect(doc(second.container)).toContain(ALLOWED);
  expect(bar()).toBeNull();
  // An open message follows the preference as soon as it changes.
  act(() => setRemoteImagesAllowed(false));
  expect(localStorage.getItem('mail-remote-images')).toBeNull();
  expect(doc(second.container)).toContain(BLOCKED);
});

it('keeps blocking, without throwing, when storage is unavailable', () => {
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
  vi.stubGlobal('localStorage', broken);
  expect(remoteImagesAllowed()).toBe(false);
  const { container } = render(<EmailBody html={REMOTE} />);
  fireEvent.click(screen.getByRole('button', { name: 'Always show images' }));
  expect(doc(container)).toContain(ALLOWED);
});

it('shows images in the viewer\'s own mail and the signature preview without asking', () => {
  const { container } = render(<EmailBody html={REMOTE} theme="light" trusted />);
  expect(doc(container)).toContain(ALLOWED);
  expect(bar()).toBeNull();
  expect(frame(container).getAttribute('sandbox')).toBe('allow-popups');
});

it('does not extend own-mail trust to the quoted message\'s remote content', () => {
  const quoted = render(<EmailBody html={'<p>Thanks</p><div class="gmail_quote"><blockquote><img src="https://tracker.example/p.gif"></blockquote></div>'} trusted />);
  expect(doc(quoted.container)).toContain(BLOCKED);
  expect(bar()).not.toBeNull();
  quoted.unmount();
  const own = render(<EmailBody html={REMOTE + '<div class="gmail_quote"><blockquote><p>Original</p></blockquote></div>'} trusted />);
  expect(doc(own.container)).toContain(ALLOWED);
  expect(bar()).toBeNull();
  own.unmount();
  // The signature the server appends AFTER the quote is still the user's own.
  const signed = render(<EmailBody html={'<p>Thanks</p><div class="gmail_quote"><blockquote><p>Original</p></blockquote></div><br/><div class="email-signature"><img src="https://company.example/logo.png"></div>'} trusted />);
  expect(doc(signed.container)).toContain(ALLOWED);
  expect(bar()).toBeNull();
});

it('detects remote references in linear time on 1 MiB of adversarial input', () => {
  const M = 1 << 20;
  const inputs = ['src=' + ' '.repeat(M), 'url(' + ' '.repeat(M), 'src="' + ' '.repeat(M), "url('" + ' '.repeat(M), 'src' + ' '.repeat(M),
    '<img src='.repeat(M / 9), "url('h".repeat(M / 6), 'url(&quot;' + '\t'.repeat(M)];
  const start = performance.now();
  for (const s of inputs) expect(hasRemoteContent(s)).toBe(false);
  // Linear: a few ms each. The quadratic spelling (\s*["']?\s*) takes minutes here.
  expect(performance.now() - start).toBeLessThan(1000);
});

const email = (over: Partial<Email>): Email => ({ id: 'e1', threadId: 't1', folderId: 'inbox', userId: 'u', sender: 'sender@example.com', recipientsTo: [], recipientsCc: [], recipientsBcc: [], subject: 'Hello', snippet: 'Hi', r2BodyKey: 'k', isRead: true, isStarred: false, isArchived: false, hasAttachments: false, size: 1, receivedAt: '2026-09-01T00:00:00Z', bodyHtml: REMOTE, ...over });
const stubApi = (routes: Record<string, unknown>) => vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(routes[url.replace(/^\/api/, '').split('?')[0]] ?? { success: true, data: [] }))));
const folders = { success: true, data: [{ id: 'inbox', type: 'inbox', name: 'Inbox' }, { id: 'sent', type: 'sent', name: 'Sent' }, { id: 'drafts', type: 'drafts', name: 'Drafts' }] };
const withClient = (ui: ReactElement) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;

it('EmailView blocks received mail but not a sent message', async () => {
  stubApi({ '/emails/e1': { success: true, data: email({}) }, '/folders': folders });
  const inbound = render(withClient(<EmailView emailId="e1" onClose={() => {}} />));
  await waitFor(() => expect(inbound.container.querySelector('iframe')).not.toBeNull());
  expect(doc(inbound.container)).toContain(BLOCKED);
  expect(bar()).not.toBeNull();
  inbound.unmount();
  // A sent copy predating the outbox has no deliveryStatus: its folder decides.
  stubApi({ '/emails/e1': { success: true, data: email({ folderId: 'sent' }) }, '/folders': folders });
  const sent = render(withClient(<EmailView emailId="e1" onClose={() => {}} />));
  await waitFor(() => expect(sent.container.querySelector('iframe')).not.toBeNull());
  await waitFor(() => expect(doc(sent.container)).toContain(ALLOWED));
  expect(bar()).toBeNull();
});

it('ThreadView shows images in a draft or delivered message and blocks the received one', async () => {
  const thread = [email({ id: 'in', folderId: 'inbox' }), email({ id: 'out', folderId: 'inbox', deliveryStatus: 'sent' }), email({ id: 'draft', folderId: 'drafts' })];
  stubApi({ '/emails/threads/t1': { success: true, data: { id: 't1', emails: thread } }, '/folders': folders, ...Object.fromEntries(thread.map(e => [`/emails/${e.id}`, { success: true, data: e }])) });
  const { container } = render(withClient(<ThreadView threadId="t1" onClose={() => {}} />));
  await screen.findAllByText('sender');
  for (const header of container.querySelectorAll('.thread-message.collapsed .thread-message-header')) fireEvent.click(header);
  await waitFor(() => expect(container.querySelectorAll('iframe')).toHaveLength(3));
  await waitFor(() => expect([...container.querySelectorAll('iframe')].map(f => f.getAttribute('srcdoc')!.includes(ALLOWED))).toEqual([false, true, true]));
  expect(screen.getAllByText('Remote images are hidden to protect your privacy.')).toHaveLength(1);
});
