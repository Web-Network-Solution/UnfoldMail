import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SearchBar from '../src/components/SearchBar';
import { useMailStore } from '../src/stores';
vi.mock('../src/lib/api', () => ({ searchApi: { search: vi.fn(async () => ({ data: [{ id: 'result', subject: 'Quarterly review', sender: 'colleague@example.com', receivedAt: Date.now() }] })) } }));
let client: QueryClient;
afterEach(() => { cleanup(); client.clear(); useMailStore.setState({ activeFolder: null }); });
it('keeps results open when tabbing into them and supports keyboard activation', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SearchBar/></QueryClientProvider>);
  const input = screen.getByRole('searchbox'); input.focus(); fireEvent.change(input, { target: { value: 'review' } });
  const result = await screen.findByRole('button', { name: /Quarterly review/ });
  result.focus(); expect(screen.getByRole('button', { name: /Quarterly review/ })).toBe(result);
  fireEvent.click(result); expect(useMailStore.getState().selectedEmailId).toBe('result');
  await waitFor(() => expect(screen.queryByRole('button', { name: /Quarterly review/ })).toBeNull());
});
it('closes results on Escape and returns focus to search', async () => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SearchBar/></QueryClientProvider>);
  const input = screen.getByRole('searchbox'); input.focus(); fireEvent.change(input, { target: { value: 'review' } });
  const result = await screen.findByRole('button', { name: /Quarterly review/ }); result.focus();
  fireEvent.keyDown(result, { key: 'Escape' });
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole('button', { name: /Quarterly review/ })).toBeNull();
});
it('excludes Trash by default and refetches with it when the toggle is ticked', async () => {
  const { searchApi } = await import('../src/lib/api');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SearchBar/></QueryClientProvider>);
  const input = screen.getByRole('searchbox'); input.focus(); fireEvent.change(input, { target: { value: 'review' } });
  await waitFor(() => expect(searchApi.search).toHaveBeenLastCalledWith({ q: 'review', includeArchived: true, includeTrash: false }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Include Trash' }));
  await waitFor(() => expect(searchApi.search).toHaveBeenLastCalledWith({ q: 'review', includeArchived: true, includeTrash: true }));
});
it('searches Trash when the open folder is Trash and shows the toggle ticked', async () => {
  const { searchApi } = await import('../src/lib/api');
  useMailStore.setState({ activeFolder: { id: 'trash-folder', name: 'Trash', type: 'trash' } as never });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SearchBar/></QueryClientProvider>);
  const input = screen.getByRole('searchbox'); input.focus(); fireEvent.change(input, { target: { value: 'binned' } });
  await waitFor(() => expect(searchApi.search).toHaveBeenLastCalledWith({ q: 'binned', includeArchived: true, includeTrash: true }));
  expect((screen.getByRole('checkbox', { name: 'Include Trash' }) as HTMLInputElement).checked).toBe(true);
});
