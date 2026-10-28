import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ProtocolSettings from '../src/components/ProtocolSettings';
import AdminProtocolSettings from '../src/pages/admin/ProtocolSettings';
import { protocolApi } from '../src/lib/protocol';
import { useAuthStore } from '../src/stores';
vi.mock('../src/lib/protocol', () => ({ protocolApi: { settings: vi.fn(), create: vi.fn(), revoke: vi.fn(), policy: vi.fn(), users: vi.fn(), save: vi.fn(), access: vi.fn() } }));
const clients: QueryClient[] = [];
function wrapper({ children }: {
    children: React.ReactNode;
}) { const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }); clients.push(client); return <QueryClientProvider client={client}>{children}</QueryClientProvider>; }
afterEach(() => { cleanup(); clients.splice(0).forEach(c => c.clear()); vi.clearAllMocks(); });
it('shows a device password once and clears the account password', async () => {
    vi.mocked(protocolApi.settings).mockResolvedValue({ success: true, data: { policy: { imap: true, smtp: true, pop3: false, hostname: 'protocol.example.com' }, passwords: [] } });
    vi.mocked(protocolApi.create).mockResolvedValue({ success: true, data: { password: 'mp_shown_once' } });
    render(<ProtocolSettings />, { wrapper });
    await screen.findByText('protocol.example.com');
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Laptop' } });
    fireEvent.change(screen.getByLabelText('Current account password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create device password' }));
    await screen.findByText('mp_shown_once');
    expect((screen.getByLabelText('Current account password') as HTMLInputElement).value).toBe('');
    expect(protocolApi.create).toHaveBeenCalledWith('Laptop', 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByText('mp_shown_once')).toBeNull();
});
it('does not load super-admin controls for an employee', () => {
    useAuthStore.setState({ user: { role: 'employee' } as never });
    render(<AdminProtocolSettings />, { wrapper });
    expect(screen.getByText('Super administrator access required.')).toBeTruthy();
    expect(protocolApi.policy).not.toHaveBeenCalled();
    expect(protocolApi.users).not.toHaveBeenCalled();
});

it('creates a device password without requesting the employee password during user switching', async () => {
    useAuthStore.setState({ isImpersonating: true });
    vi.mocked(protocolApi.settings).mockResolvedValue({ success: true, data: { policy: { imap: true, smtp: true, pop3: false, hostname: 'protocol.example.com' }, passwords: [] } });
    vi.mocked(protocolApi.create).mockResolvedValue({ success: true, data: { password: 'mp_admin_created' } });
    render(<ProtocolSettings />, { wrapper });
    await screen.findByText(/without their account password/);
    expect(screen.queryByLabelText('Current account password')).toBeNull();
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Outlook' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create device password' }));
    await screen.findByText('mp_admin_created');
    expect(protocolApi.create).toHaveBeenCalledWith('Outlook', undefined);
    useAuthStore.setState({ isImpersonating: false });
});
