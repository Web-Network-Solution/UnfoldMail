import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen,waitFor } from '@testing-library/react';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import AdminReports from '../src/pages/admin/Reports';
import { adminApi } from '../src/lib/api';
vi.mock('../src/lib/api',()=>({adminApi:{getReports:vi.fn()}}));
const clients:QueryClient[]=[];
afterEach(()=>{cleanup();clients.forEach(c=>c.clear());clients.length=0;vi.resetAllMocks();});
function mount(){const client=new QueryClient();clients.push(client);return render(<QueryClientProvider client={client}><AdminReports/></QueryClientProvider>);}
const result={success:true,data:{startDate:'2026-10-01',endDate:'2026-10-21',summary:{totalEmails:2,totalSent:1,totalReceived:1,totalStorageBytes:100,totalAttachments:0,totalSharedFiles:0,attachmentBytes:0,sharedFilesBytes:0,emailBytes:100,activeUsers:1},daily:[],users:[],freshness:{updatedAt:'2026-10-21T00:00:00Z',missingMailboxes:1,staleMailboxes:2,historicalBaselineIncomplete:true}}};
it('waits for Apply dates and passes an abort signal',async()=>{
  vi.mocked(adminApi.getReports).mockResolvedValue(result);mount();
  await waitFor(()=>expect(adminApi.getReports).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText('Start date'),{target:{value:'2026-10-01'}});
  fireEvent.change(screen.getByLabelText('End date'),{target:{value:'2026-10-20'}});
  expect(adminApi.getReports).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Apply dates'}));
  await waitFor(()=>expect(adminApi.getReports).toHaveBeenCalledTimes(2));
  expect(adminApi.getReports).toHaveBeenLastCalledWith({startDate:'2026-10-01',endDate:'2026-10-20'},expect.any(AbortSignal));
  expect(screen.getByRole('status').textContent).toContain('1 mailboxes awaiting reports');
});
it('cancels an obsolete request when the selected range changes',async()=>{
  vi.mocked(adminApi.getReports).mockImplementation(()=>new Promise(()=>{}));mount();
  await waitFor(()=>expect(adminApi.getReports).toHaveBeenCalledTimes(1));
  const signal=vi.mocked(adminApi.getReports).mock.calls[0][1]!;
  fireEvent.click(screen.getByRole('button',{name:'Today'}));
  await waitFor(()=>expect(signal.aborted).toBe(true));
});
it('disables invalid custom ranges and shows a failed request without retrying',async()=>{
  vi.mocked(adminApi.getReports).mockRejectedValue(new Error('Reporting unavailable'));mount();
  await screen.findByText('Reporting unavailable');
  fireEvent.change(screen.getByLabelText('Start date'),{target:{value:'2026-10-22'}});
  fireEvent.change(screen.getByLabelText('End date'),{target:{value:'2026-10-01'}});
  expect((screen.getByRole('button',{name:'Apply dates'}) as HTMLButtonElement).disabled).toBe(true);
  expect(adminApi.getReports).toHaveBeenCalledTimes(1);
});
