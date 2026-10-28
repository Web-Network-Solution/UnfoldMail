import { useEffect } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType, type InitialEntry } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { User } from '@email-service/shared';
import App from '../src/App';
import MailLayout from '../src/pages/MailLayout';
import { useAuthStore, useMailStore } from '../src/stores';

vi.mock('../src/components/EmailView', () => ({ default: ({ emailId, onClose, onDone }: { emailId: string; onClose: () => void; onDone?: () => void }) => <div data-testid="detail">{emailId}<button onClick={onClose}>Close message</button><button onClick={onDone}>Delete message</button></div> }));
vi.mock('../src/components/ThreadView', () => ({ default: ({ threadId }: { threadId: string }) => <div data-testid="detail">{threadId}</div> }));
vi.mock('../src/components/ComposeModal', () => ({ default: () => <div>composer</div> }));
vi.mock('../src/pages/Calendar', () => ({ default: () => <div>calendar page</div> }));
vi.mock('../src/components/AIAssistant', () => ({ default: () => null }));
vi.mock('../src/hooks/useWebSocket', () => ({ useWebSocket: () => {} }));

const me = { id: 'u', email: 'me@example.com', displayName: 'Me', role: 'employee' } as User;
const folder = (id: string, type: string, name: string) => ({ id, userId: 'u', name, type, createdAt: '' });
const folders = { success: true, data: [folder('f-in', 'inbox', 'Inbox'), folder('f-sent', 'sent', 'Sent'), folder('f-lab', 'custom', 'Work')] };
const emails = { success: true, data: [{ id: 'e1', sender: 'a@example.com', subject: 'Hello', snippet: '', receivedAt: new Date().toISOString(), isRead: true, recipientsTo: [] }], pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 } };
let foldersReady: Promise<unknown>;
let fetched: string[];
const seen: { search: string; type: string }[] = [];

beforeEach(() => {
  foldersReady = Promise.resolve(); fetched = []; seen.length = 0;
  useAuthStore.setState({ user: me });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetched.push(url);
    const path = url.replace(/^\/api/, '').split('?')[0];
    if (path === '/folders') await foldersReady;
    return new Response(JSON.stringify(path === '/folders' ? folders : path === '/emails' ? emails : { success: true, data: [] }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useMailStore.setState(useMailStore.getInitialState()); });

function Spy() {
  const location = useLocation(), type = useNavigationType(), navigate = useNavigate();
  useEffect(() => { seen.push({ search: location.search, type }); }, [location, type]);
  return <><output data-testid="url">{location.pathname + location.search}</output><button onClick={() => navigate(-1)}>history back</button>
    {/* What AIAssistant's "Messages consulted" links do. */}
    <button onClick={() => { useMailStore.getState().setSelectedEmail('e1'); navigate('/mail'); }}>ai link</button></>;
}
const mount = (entry: InitialEntry) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter initialEntries={[entry]}><Routes><Route path="/mail/*" element={<MailLayout />} /></Routes><Spy /></MemoryRouter>
  </QueryClientProvider>);
const url = () => screen.getByTestId('url').textContent;
const tick = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
/** Waits for the URL, then checks it stays put: a sync loop would keep navigating. */
const settled = async (expected: string) => {
  const before = seen.length;
  await waitFor(() => expect(url()).toBe(expected));
  await tick(20);
  const n = seen.length;
  await tick(50);
  expect(seen.length).toBe(n);
  expect(n - before).toBeLessThanOrEqual(3);
};

it('replaces the bare /mail entry with the auto-selected inbox', async () => {
  mount('/mail');
  await settled('/mail?folder=f-in');
  expect(seen.at(-1)!.type).toBe('REPLACE');
  expect(seen.some((s) => s.type === 'PUSH')).toBe(false);
});

it('pushes on select so Back closes the message, and pushes folder changes and closes', async () => {
  mount('/mail');
  await settled('/mail?folder=f-in');
  fireEvent.click(await screen.findByText('Hello'));
  await settled('/mail?folder=f-in&email=e1');
  expect(seen.at(-1)!.type).toBe('PUSH');
  expect(screen.getByTestId('detail').textContent).toContain('e1');

  fireEvent.click(screen.getByText('history back'));
  await settled('/mail?folder=f-in');
  expect(seen.at(-1)!.type).toBe('POP');
  expect(useMailStore.getState().selectedEmailId).toBeNull();
  expect(screen.queryByTestId('detail')).toBeNull();

  // Anything that sets the store (search results, AI links) goes through the same path.
  act(() => useMailStore.getState().setSelectedThread('t1'));
  await settled('/mail?folder=f-in&thread=t1');
  expect(seen.at(-1)!.type).toBe('PUSH');
  fireEvent.click(screen.getAllByRole('button', { name: 'Sent' })[0]);
  await settled('/mail?folder=f-sent');
  expect(seen.at(-1)!.type).toBe('PUSH');
  act(() => useMailStore.getState().setSelectedEmail('e1'));
  await settled('/mail?folder=f-sent&email=e1');
  fireEvent.click(screen.getByText('Close message'));
  await settled('/mail?folder=f-sent');
  expect(seen.at(-1)!.type).toBe('PUSH');
  fireEvent.click(screen.getByText('history back'));
  await settled('/mail?folder=f-sent&email=e1');
  expect(useMailStore.getState().selectedEmailId).toBe('e1');
});

it('turns an AI link (store + navigate to a bare /mail) into one entry that Back closes', async () => {
  mount('/mail');
  await settled('/mail?folder=f-in');
  fireEvent.click(screen.getByText('ai link'));
  await settled('/mail?folder=f-in&email=e1');
  expect(seen.slice(-2).map((s) => s.type)).toEqual(['PUSH', 'REPLACE']);
  fireEvent.click(screen.getByText('history back'));
  await settled('/mail?folder=f-in');
  expect(screen.queryByTestId('detail')).toBeNull();
});

it('restores a deep link: the message at once, the folder once folders load', async () => {
  let release!: () => void;
  foldersReady = new Promise<void>((r) => { release = r; });
  mount('/mail?folder=f-lab&email=e1');
  await waitFor(() => expect(useMailStore.getState().selectedEmailId).toBe('e1'));
  expect(useMailStore.getState().activeFolderId).toBeNull();
  expect(url()).toBe('/mail?folder=f-lab&email=e1');
  release();
  await waitFor(() => expect(useMailStore.getState().activeFolderId).toBe('f-lab'));
  await settled('/mail?folder=f-lab&email=e1');
  expect(useMailStore.getState().selectedEmailId).toBe('e1');
  expect(seen.some((s) => s.type === 'PUSH')).toBe(false);

  cleanup(); useMailStore.setState(useMailStore.getInitialState());
  mount('/mail?folder=starred&thread=t9');
  await waitFor(() => expect(useMailStore.getState()).toMatchObject({ starredView: true, selectedThreadId: 't9', activeFolderId: 'f-in' }));
});

it('replaces invalid params and never puts a raw id into an API path', async () => {
  mount('/mail?folder=nope&email=..%2F..%2Fadmin%2Fusers');
  await settled('/mail?folder=f-in');
  expect(useMailStore.getState().selectedEmailId).toBeNull();
  expect(seen.some((s) => s.type === 'PUSH')).toBe(false);
  expect(fetched.some((u) => u.includes('admin'))).toBe(false);
});

it('opens compose from ?action=compose once and drops the parameter', async () => {
  mount('/mail?action=compose');
  await settled('/mail?folder=f-in');
  expect(useMailStore.getState()).toMatchObject({ isComposeOpen: true, composeSession: 1 });
  expect(screen.getByText('composer')).toBeTruthy();
});

it('leaves /mail/calendar alone and restores the mail view from its breadcrumb', async () => {
  mount('/mail/calendar');
  await screen.findByText('calendar page');
  await settled('/mail/calendar');
  fireEvent.click(screen.getByRole('link', { name: 'Mail' }));
  await settled('/mail?folder=f-in');
});

it('does not reopen a previous user\'s message from the URL', async () => {
  // An entry written for another user (Back, or a reload after a switch in another tab).
  mount({ pathname: '/mail', search: '?folder=f-lab&email=e1', state: { mailUser: 'someone-else' } });
  await settled('/mail?folder=f-in');
  expect(useMailStore.getState().selectedEmailId).toBeNull();
  cleanup(); useMailStore.setState(useMailStore.getInitialState());

  // An identity change while mounted: main.tsx resets the store, the old URL stays put.
  mount('/mail?folder=f-lab&email=e1');
  await settled('/mail?folder=f-lab&email=e1');
  act(() => { useAuthStore.setState({ user: { ...me, id: 'v' } }); useMailStore.setState(useMailStore.getInitialState()); });
  await settled('/mail?folder=f-in');
  expect(useMailStore.getState().selectedEmailId).toBeNull();
  expect(seen.at(-1)!.type).toBe('REPLACE');
});

it('closes by replacing after Delete, Move or Mark unread, so Back does not reopen the message', async () => {
  mount('/mail');
  await settled('/mail?folder=f-in');
  fireEvent.click(await screen.findByText('Hello'));
  await settled('/mail?folder=f-in&email=e1');
  fireEvent.click(screen.getByText('Delete message'));
  await settled('/mail?folder=f-in');
  expect(seen.at(-1)!.type).toBe('REPLACE');
  fireEvent.click(screen.getByText('history back'));
  await settled('/mail?folder=f-in');
  expect(useMailStore.getState().selectedEmailId).toBeNull();
  expect(screen.queryByTestId('detail')).toBeNull();
  // The next pick is a normal push again.
  fireEvent.click(await screen.findByText('Hello'));
  await settled('/mail?folder=f-in&email=e1');
  expect(seen.at(-1)!.type).toBe('PUSH');
});

it('returns to a message link after sign-in, and only to a mail view on this origin', async () => {
  const api = globalThis.fetch as (url: string) => Promise<Response>;
  vi.stubGlobal('fetch', vi.fn(async (u: string) => u === '/api/auth/me' ? new Response('{}', { status: 401 })
    : u === '/api/auth/login' ? new Response(JSON.stringify({ success: true, data: { user: me } })) : api(u)));
  const signIn = async (entry: InitialEntry) => {
    cleanup(); useAuthStore.setState({ user: null, isLoading: true }); useMailStore.setState(useMailStore.getInitialState());
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}><App /><Spy /></MemoryRouter></QueryClientProvider>);
    await waitFor(() => expect(url()).toBe('/login'));
    fireEvent.change(screen.getByPlaceholderText('you@company.com'), { target: { value: 'me@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign In' }));
  };
  await signIn('/mail?folder=f-lab&email=e1');
  await settled('/mail?folder=f-lab&email=e1');
  expect(useMailStore.getState().selectedEmailId).toBe('e1');
  expect(seen.some((s) => s.search.includes('folder=f-in'))).toBe(false);
  for (const from of ['https://evil.example/mail', '//evil.example/mail', '/mail/../settings', '/settings']) {
    await signIn({ pathname: '/login', state: { from } });
    await settled('/mail?folder=f-in');
  }
  // After a sign-out the link is the previous user's: only they go back to it.
  await signIn({ pathname: '/login', state: { from: '/mail?folder=f-lab&email=e1', mailUser: 'someone-else' } });
  await settled('/mail?folder=f-in');
  expect(useMailStore.getState().selectedEmailId).toBeNull();
  await signIn({ pathname: '/login', state: { from: '/mail?folder=f-lab&email=e1', mailUser: 'u' } });
  await settled('/mail?folder=f-lab&email=e1');
});
