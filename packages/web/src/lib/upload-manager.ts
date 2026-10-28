export const MIB = 1024 * 1024;
export interface NetworkHint { downlink?: number; effectiveType?: string; saveData?: boolean }
export function choosePartSize(size: number, network: NetworkHint = {}): number {
  if (network.saveData || /(^|-)2g$/.test(network.effectiveType || '') || (network.downlink !== undefined && network.downlink < 2)) return 5*MIB;
  if (size <= 32*MIB) return 5*MIB;
  if (size <= 256*MIB) return 8*MIB;
  if (size <= 512*MIB) return 16*MIB;
  return 32*MIB;
}
export function chooseConcurrency(bytesPerSecond: number, network: NetworkHint = {}): number {
  if (network.saveData || /(^|-)2g$/.test(network.effectiveType || '')) return 1;
  if (!bytesPerSecond) return network.downlink !== undefined && network.downlink < 2 ? 1 : 2;
  return bytesPerSecond < 256*1024 ? 1 : bytesPerSecond < MIB ? 2 : bytesPerSecond < 5*MIB ? 3 : 4;
}
export type UploadPhase = 'preparing' | 'uploading' | 'paused' | 'offline' | 'error' | 'finishing' | 'cancelling' | 'cancelled' | 'complete';
export interface UploadSnapshot {
  phase: UploadPhase; percent: number; bytesPerSecond: number; secondsRemaining?: number;
  partSize: number; concurrency: number; retrying: boolean; error?: string;
}
export interface UploadResult { shareId: string; filename: string; size: number; downloadUrl: string }
export interface UploadSession { shareId: string; partSize: number }
export interface UploadStatus extends UploadSession { status: string; completedParts: number[] }
export interface UploadTransport {
  start(file: File, partSize: number): Promise<UploadSession>;
  status(id: string): Promise<UploadStatus>;
  part(id: string, number: number, body: Blob, signal: AbortSignal, progress: (bytes: number) => void): Promise<void>;
  complete(id: string): Promise<UploadResult>;
  cancel(id: string): Promise<void>;
}
function abortError() { return Object.assign(new Error('Upload cancelled or paused'),{name:'AbortError'}); }
function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve,reject) => {
    if (signal.aborted) { reject(abortError()); return; }
    const aborted = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort',aborted); resolve(); },ms);
    signal.addEventListener('abort',aborted,{once:true});
  });
}
function retryable(error: unknown) {
  const status=(error as {status?:number})?.status;
  return !status || status===408 || status===429 || status>=500;
}

/** In-memory File ownership avoids mixing a different file into a resumed upload.
 * Browser refresh/close requires selecting the file again; network reconnections do not. */
export class UploadTask {
  readonly result: Promise<UploadResult>;
  private resolve!: (value:UploadResult)=>void;
  private reject!: (error:unknown)=>void;
  private session?:UploadSession;
  private completed=new Set<number>();
  private active=new Map<number,{controller:AbortController;loaded:number}>();
  private phase:UploadPhase='preparing';
  private manualPause=false;
  private online=true;
  private cancelled=false;
  private work?:Promise<void>;
  private rerun=false;
  private error?:string;
  private partSize:number;
  private concurrency:number;
  private speed=0;
  private wireBytes=0;
  private sampledBytes=0;
  private sampledAt=Date.now();
  private cautiousUntil=0;
  private retries=0;
  private timer?:ReturnType<typeof setInterval>;
  constructor(private file:File,private transport:UploadTransport,private changed:(snapshot:UploadSnapshot)=>void,
    private network:()=>NetworkHint=()=>({})) {
    this.partSize=choosePartSize(file.size,network());
    this.concurrency=chooseConcurrency(0,network());
    this.result=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject;});
  }
  start() {
    this.timer=setInterval(()=>{this.sample();this.emit();},500);
    this.kick(); return this;
  }
  pause() {
    if (['finishing','complete','cancelling','cancelled'].includes(this.phase)) return;
    this.manualPause=true;this.phase='paused';this.abortActive();this.emit();
  }
  resume() {
    if (this.cancelled || ['finishing','complete'].includes(this.phase)) return;
    this.manualPause=false;this.error=undefined;
    this.speed=0;this.sampledAt=Date.now();this.sampledBytes=this.wireBytes;
    this.kick();
  }
  connection(online:boolean) {
    this.online=online;
    if (this.cancelled) { if (online && this.phase==='cancelling') void this.cancel(); return; }
    if (['complete','finishing'].includes(this.phase)) return;
    if (!online) { this.abortActive();if(!this.manualPause)this.phase='offline';this.emit(); }
    else if (!this.manualPause && this.phase==='offline') this.resume();
  }
  async cancel() {
    if (this.phase==='complete' || this.phase==='finishing') return;
    this.cancelled=true;this.phase='cancelling';this.error=undefined;this.abortActive();this.emit();
    await this.work;
    try {
      if (this.session) await this.transport.cancel(this.session.shareId);
      this.phase='cancelled';clearInterval(this.timer);this.emit();this.reject(abortError());
    } catch (error) {
      if((error as {status?:number})?.status===409 && this.session) {
        // Completion won the race (for example its acknowledgement was lost).
        // Recover the link instead of leaving an uncancellable task stuck.
        this.cancelled=false;this.phase='error';this.error='The upload is already finishing. Press Retry to recover its link.';this.emit();return;
      }
      this.error='Transfer stopped. Cancellation will retry when you reconnect, or press Cancel again.';
      this.emit(); // Server tombstone/abandoned cleanup also retries storage failures.
    }
  }
  private canRun() { return !this.manualPause && this.online && !this.cancelled; }
  private abortActive() { for(const value of this.active.values())value.controller.abort(); }
  private kick() {
    if(!this.canRun()){if(!this.online&&!this.manualPause&&!this.cancelled)this.phase='offline';this.emit();return;}
    if(this.work){this.rerun=true;return;}
    this.work=this.run().finally(()=>{this.work=undefined;if(this.rerun){this.rerun=false;this.kick();}});
  }
  private sample() {
    const now=Date.now(),elapsed=(now-this.sampledAt)/1000;
    if(elapsed<1)return;
    const rate=(this.wireBytes-this.sampledBytes)/elapsed;
    this.sampledAt=now;this.sampledBytes=this.wireBytes;
    this.speed=this.phase==='uploading'?(this.speed?this.speed*0.65+rate*0.35:rate):0;
    if(this.speed && now>this.cautiousUntil)this.concurrency=chooseConcurrency(this.speed,this.network());
  }
  private emit() {
    let bytes=0;
    for(const number of this.completed)bytes+=Math.min(this.partSize,this.file.size-(number-1)*this.partSize);
    for(const [number,value] of this.active)if(!this.completed.has(number))bytes+=value.loaded;
    bytes=Math.min(bytes,this.file.size);
    const moving=this.phase==='uploading';
    this.changed({phase:this.phase,percent:this.phase==='complete'?100:Math.min(99,Math.floor(bytes/this.file.size*100)),
      bytesPerSecond:moving?this.speed:0,secondsRemaining:moving&&this.speed>0?(this.file.size-bytes)/this.speed:undefined,
      partSize:this.partSize,concurrency:this.concurrency,retrying:this.retries>0,error:this.error});
  }
  private async uploadPart(number:number) {
    const chunk=this.file.slice((number-1)*this.partSize,Math.min(number*this.partSize,this.file.size));
    const record={controller:new AbortController(),loaded:0};this.active.set(number,record);
    try {
      for(let attempt=0;;attempt++) {
        if(!this.canRun())throw abortError();
        try {
          await this.transport.part(this.session!.shareId,number,chunk,record.controller.signal,loaded=>{
            this.wireBytes+=Math.max(0,loaded-record.loaded);record.loaded=loaded;this.emit();
          });
          this.completed.add(number);return;
        } catch(error) {
          if(!this.canRun() || record.controller.signal.aborted || !retryable(error) || attempt>=4)throw error;
          this.concurrency=Math.max(1,this.concurrency-1);this.cautiousUntil=Date.now()+15000;
          this.retries++;record.loaded=0;this.emit();
          try {
            await delay(Math.min(8000,500*2**attempt)+Math.random()*250,record.controller.signal);
            // An acknowledgement may have been lost after R2 and D1 succeeded.
            const status=await this.transport.status(this.session!.shareId);
            if(status.completedParts.includes(number)){this.completed.add(number);return;}
          } catch(error) { if(!this.canRun() || record.controller.signal.aborted)throw error; }
          finally { this.retries--; }
        }
      }
    } finally { this.active.delete(number);this.emit(); }
  }
  private async run() {
    try {
      this.phase='preparing';this.emit();
      if(!this.session){this.session=await this.transport.start(this.file,this.partSize);this.partSize=this.session.partSize;}
      if(!this.canRun())return;
      const status=await this.transport.status(this.session.shareId);
      if(!this.canRun())return;
      this.completed=new Set(status.completedParts);
      this.phase='uploading';this.emit();
      if(status.status==='uploading') {
        const pending=Array.from({length:Math.ceil(this.file.size/this.partSize)},(_,i)=>i+1).filter(n=>!this.completed.has(n));
        const running=new Map<number,Promise<void>>();let failure:unknown;
        while((pending.length||running.size)&&this.canRun()&&!failure){
          while(pending.length&&running.size<this.concurrency&&!failure){
            const number=pending.shift()!;
            const promise=this.uploadPart(number).catch(error=>{failure=error;this.abortActive();}).finally(()=>running.delete(number));
            running.set(number,promise);
          }
          await Promise.race(running.values());
        }
        await Promise.all(running.values());
        if(failure)throw failure;
      }
      if(!this.canRun())return;
      this.phase='finishing';this.emit();
      let result:UploadResult|undefined;
      for(let attempt=0;!result;attempt++) {
        try { result=await this.transport.complete(this.session.shareId); }
        catch(error){if(!retryable(error)||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,500*2**attempt));}
      }
      this.phase='complete';clearInterval(this.timer);this.emit();this.resolve(result);
    } catch(error) {
      if(this.cancelled||this.manualPause||!this.online)return;
      this.phase='error';this.error=error instanceof Error?error.message:'Upload interrupted. Press Retry to continue.';this.emit();
    } finally {
      if(!this.canRun()&&!this.cancelled){this.phase=this.manualPause?'paused':'offline';this.emit();}
    }
  }
}
