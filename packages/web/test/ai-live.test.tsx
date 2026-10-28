import { renderHook, act, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { useWebSocket } from '../src/hooks/useWebSocket';
import { useRealtimeStore } from '../src/stores';

class Socket {
  static OPEN=1;static instances:Socket[]=[];
  readyState=1;onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onmessage:((e:{data:string})=>void)|null=null;onerror=null;
  send=vi.fn();close=vi.fn();
  constructor(){Socket.instances.push(this);}
}
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();Socket.instances=[];});
it('refreshes assistant snapshots on pushes and reconnect and stops sockets on logout',()=>{
  vi.useFakeTimers();vi.stubGlobal('WebSocket',Socket);
  const cache=new QueryClient(),invalidate=vi.spyOn(cache,'invalidateQueries');
  const view=renderHook(()=>useWebSocket('employee'),{wrapper:({children})=><QueryClientProvider client={cache}>{children}</QueryClientProvider>});
  act(()=>Socket.instances[0].onopen?.());expect(useRealtimeStore.getState().connected).toBe(true);
  expect(invalidate).toHaveBeenCalledWith({queryKey:['ai-turns']});invalidate.mockClear();
  act(()=>Socket.instances[0].onmessage?.({data:JSON.stringify({type:'ai_updated'})}));expect(invalidate).toHaveBeenCalledWith({queryKey:['ai-turns','employee']});
  act(()=>Socket.instances[0].onclose?.());expect(useRealtimeStore.getState().connected).toBe(false);
  act(()=>vi.advanceTimersByTime(30000));expect(Socket.instances).toHaveLength(2);
  act(()=>Socket.instances[1].onopen?.());expect(useRealtimeStore.getState().connected).toBe(true);
  view.unmount();expect(Socket.instances[1].close).toHaveBeenCalled();expect(useRealtimeStore.getState().connected).toBe(false);cache.clear();
});
