import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadTask, MIB, choosePartSize, chooseConcurrency, type UploadTransport, type UploadSnapshot } from '../../web/src/lib/upload-manager';

beforeEach(()=>vi.useFakeTimers());
afterEach(()=>vi.useRealTimers());
function fixture() {
  const confirmed=new Set<number>();
  const snapshots:UploadSnapshot[]=[];
  const file=new File([new Uint8Array(21*MIB)],'test.bin');
  const session={shareId:'upload',partSize:5*MIB};
  let active=0,peak=0;
  const transport:UploadTransport={
    start:vi.fn(async()=>session),
    status:vi.fn(async()=>({...session,status:'uploading',completedParts:[...confirmed]})),
    part:vi.fn(async (_id,number,body,signal,progress)=>{
      active++;peak=Math.max(active,peak);
      try {
        await new Promise<void>((resolve,reject)=>{
          const aborted=()=>{clearTimeout(timer);reject(new Error('aborted'));};
          const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);progress(body.size);resolve();},100);
          signal.addEventListener('abort',aborted,{once:true});
        });
        confirmed.add(number);
      } finally { active--; }
    }),
    complete:vi.fn(async()=>({shareId:'upload',filename:file.name,size:file.size,downloadUrl:'/file'})),
    cancel:vi.fn(async()=>undefined),
  };
  const task=new UploadTask(file,transport,snapshot=>snapshots.push(snapshot));
  void task.result.catch(()=>undefined);
  return {task,transport,confirmed,snapshots,peak:()=>peak};
}
describe('adaptive upload manager',()=>{
  it('chooses safe fixed part sizes and adjusts concurrency for actual throughput',()=>{
    expect(choosePartSize(20*MIB)).toBe(5*MIB);
    expect(choosePartSize(127*MIB)).toBe(8*MIB);
    expect(choosePartSize(400*MIB)).toBe(16*MIB);
    expect(choosePartSize(900*MIB)).toBe(32*MIB);
    expect(choosePartSize(900*MIB,{saveData:true})).toBe(5*MIB);
    expect(chooseConcurrency(100000)).toBe(1);
    expect(chooseConcurrency(500000)).toBe(2);
    expect(chooseConcurrency(2*MIB)).toBe(3);
    expect(chooseConcurrency(10*MIB)).toBe(4);
    expect(chooseConcurrency(10*MIB,{saveData:true})).toBe(1);
  });
  it('uploads parallel chunks and completes only after all are confirmed',async()=>{
    const f=fixture();f.task.start();await vi.advanceTimersByTimeAsync(20);
    expect(f.peak()).toBe(2);expect(f.transport.complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);await f.task.result;
    expect(f.confirmed.size).toBe(5);expect(f.transport.complete).toHaveBeenCalledTimes(1);
    expect(f.snapshots.at(-1)?.phase).toBe('complete');
  });
  it('pauses without resending confirmed chunks and resumes after reconciliation',async()=>{
    const f=fixture();f.task.start();await vi.advanceTimersByTimeAsync(150);
    expect([...f.confirmed]).toEqual([1,2]);f.task.pause();await vi.advanceTimersByTimeAsync(300);
    expect(f.transport.complete).not.toHaveBeenCalled();expect(f.snapshots.at(-1)?.phase).toBe('paused');
    f.task.resume();await vi.advanceTimersByTimeAsync(1000);await f.task.result;
    expect(vi.mocked(f.transport.part).mock.calls.filter(call=>call[1]===1)).toHaveLength(1);
  });
  it('automatically recovers a reconnect but never overrides a manual pause',async()=>{
    const f=fixture();f.task.start();await vi.advanceTimersByTimeAsync(20);
    f.task.connection(false);await vi.advanceTimersByTimeAsync(50);expect(f.snapshots.at(-1)?.phase).toBe('offline');
    f.task.pause();f.task.connection(true);await vi.advanceTimersByTimeAsync(100);
    expect(f.snapshots.at(-1)?.phase).toBe('paused');
    f.task.resume();await vi.advanceTimersByTimeAsync(150);
    f.task.connection(false);await vi.advanceTimersByTimeAsync(50);f.task.connection(true);
    await vi.advanceTimersByTimeAsync(1000);await f.task.result;
    expect(f.snapshots.at(-1)?.phase).toBe('complete');
  });
  it('retries only a failed part and recognizes an acknowledgement lost after success',async()=>{
    const f=fixture();const normal=f.transport.part;let failed=false;
    f.transport.part=vi.fn(async(...args:Parameters<UploadTransport['part']>)=>{
      if(args[1]===1&&!failed){failed=true;throw Object.assign(new Error('temporarily down'),{status:503});}
      if(args[1]===2){f.confirmed.add(2);throw Object.assign(new Error('acknowledgement lost'),{status:503});}
      return normal(...args);
    });
    f.task.start();await vi.advanceTimersByTimeAsync(5000);await f.task.result;
    expect(vi.mocked(f.transport.part).mock.calls.filter(call=>call[1]===1)).toHaveLength(2);
    expect(vi.mocked(f.transport.part).mock.calls.filter(call=>call[1]===2)).toHaveLength(1);
  });
  it('cancels in-flight requests and never completes the upload',async()=>{
    const f=fixture();f.task.start();await vi.advanceTimersByTimeAsync(20);
    await f.task.cancel();await expect(f.task.result).rejects.toMatchObject({name:'AbortError'});
    expect(f.transport.cancel).toHaveBeenCalledWith('upload');expect(f.transport.complete).not.toHaveBeenCalled();
    expect(f.snapshots.at(-1)?.phase).toBe('cancelled');
  });
  it('measures transfer speed, estimates remaining time and increases concurrency',async()=>{
    const f=fixture();
    f.transport.part=vi.fn(async(_id,number,body,signal,progress)=>{
      await new Promise<void>((resolve,reject)=>{
        const half=setTimeout(()=>progress(body.size/2),500);
        const full=setTimeout(()=>{progress(body.size);f.confirmed.add(number);resolve();},1500);
        signal.addEventListener('abort',()=>{clearTimeout(half);clearTimeout(full);reject(new Error('aborted'));},{once:true});
      });
    });
    f.task.start();await vi.advanceTimersByTimeAsync(1100);
    const moving=f.snapshots.at(-1)!;
    expect(moving.bytesPerSecond).toBeGreaterThan(0);
    expect(moving.secondsRemaining).toBeGreaterThan(0);
    expect(moving.concurrency).toBe(4);
    await vi.advanceTimersByTimeAsync(10000);await f.task.result;
  });
  it('can recover completion if cancellation loses a race with finishing',async()=>{
    const f=fixture();f.task.start();await vi.advanceTimersByTimeAsync(20);
    f.transport.cancel=vi.fn(async()=>{throw Object.assign(new Error('already finishing'),{status:409});});
    await f.task.cancel();expect(f.snapshots.at(-1)?.phase).toBe('error');
    f.transport.status=vi.fn(async()=>({shareId:'upload',partSize:5*MIB,status:'complete',completedParts:[]}));
    f.task.resume();await vi.advanceTimersByTimeAsync(1000);await f.task.result;
    expect(f.snapshots.at(-1)?.phase).toBe('complete');
  });
  it('retains successful parts after a permanent error and allows an explicit retry',async()=>{
    const f=fixture();const normal=f.transport.part;
    f.transport.part=vi.fn(async(...args:Parameters<UploadTransport['part']>)=>{if(args[1]===3)throw Object.assign(new Error('session expired'),{status:401});return normal(...args);});
    f.task.start();await vi.advanceTimersByTimeAsync(1000);expect(f.snapshots.at(-1)?.phase).toBe('error');
    f.transport.part=normal;f.task.resume();await vi.advanceTimersByTimeAsync(1000);await f.task.result;
    expect(vi.mocked(normal).mock.calls.filter(call=>call[1]===1)).toHaveLength(1);
  });
});
