import { Worker,MessageChannel } from 'node:worker_threads';
import crypto from 'node:crypto';
import { canonical,digest,fail,frozen } from './integrity.js';
export class EvolutionHost {
 #worker;#reviewPort;#secret=crypto.randomBytes(32).toString('hex');#pending=new Map();#reviewPending=new Map();#authenticate;#model;
 #snapshot=null;#controllers=new Set();#options;
 constructor({file,allowedScopes,coreHash,apiInfo,privacyKey=null,authenticate=()=>null,model=async()=>{throw Error('MODEL_UNAVAILABLE');}}) {
  this.#options={file,allowedScopes,coreHash,apiInfo,privacyKey};this.#authenticate=authenticate;this.#model=model;this.status={};this.ready=null;this.failure=null;
 }
 async start() {
  if(this.#worker)return this.ready;
  const channel=new MessageChannel();this.#reviewPort=channel.port1;
  this.#worker=new Worker(new URL('./writer-worker.js',import.meta.url),{workerData:{...this.#options,reviewSecret:this.#secret,reviewPort:channel.port2},transferList:[channel.port2],resourceLimits:{maxOldGenerationSizeMb:96}});
  this.#reviewPort.on('message',m=>this.#reply(m,this.#reviewPending));
  this.ready=new Promise((resolve,reject)=>{
   this.#worker.on('message',m=>{
    try {
     if(m.event==='ready'){this.status=m.status;this.#adopt(m.snapshot);resolve(this.status);}
     else if(m.event==='model-request')void this.#invokeModel(m);
     else this.#reply(m,this.#pending);
    } catch(e){this.failure='WORKER_MESSAGE_INVALID';reject(e);this.#rejectPending();}
   });
   this.#worker.on('error',e=>{this.failure='WORKER_UNAVAILABLE';reject(e);this.#rejectPending();});
   this.#worker.on('exit',code=>{if(code!==0)this.failure='WORKER_EXIT';this.#rejectPending();});
  });
  return this.ready;
 }
 #adopt(snapshot) {
  if(!snapshot||!Array.isArray(snapshot.entries)||digest(canonical(snapshot.entries))!==snapshot.hash)fail('INVALID_WORKER_SNAPSHOT');
  this.#snapshot=frozen(structuredClone(snapshot));
 }
 #reply(m,pending) {
  const item=pending.get(m.id);if(!item)return;
  clearTimeout(item.timer);pending.delete(m.id);
  if(m.error){const e=Error(m.error.code);e.code=m.error.code;e.status=m.error.status;item.reject(e);}else item.resolve(m.result);
 }
 #rejectPending() {
  for(const map of [this.#pending,this.#reviewPending]){for(const item of map.values()){clearTimeout(item.timer);item.reject(Error('WORKER_UNAVAILABLE'));}map.clear();}
  this.#snapshot=null;
 }
 #request(port,pending,command,payload,timeout=5000) {
  if(!port||this.failure)return Promise.reject(Error('WORKER_UNAVAILABLE'));
  const id=crypto.randomUUID();
  return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{pending.delete(id);reject(Error('WORKER_RPC_TIMEOUT'));},timeout);timer.unref?.();
   pending.set(id,{resolve,reject,timer});port.postMessage({id,command,payload});
  });
 }
 data(command,payload={}){return this.#request(this.#worker,this.#pending,command,payload,command==='pump'?250000:5000);}
 async review(command,auth,body) {
  const principal=this.#authenticate(auth);
  if(typeof principal!=='string'||!principal.startsWith('console-owner:'))fail('AUTHENTICATION_REQUIRED',401);
  const result=await this.#request(this.#reviewPort,this.#reviewPending,command,{auth:{secret:this.#secret,principal},body});
  if(command==='publish')await this.refresh();
  return result;
 }
 async refresh(){this.status=await this.data('status');this.#adopt(await this.data('snapshot'));return this.status;}
 snapshot(){return this.#snapshot?structuredClone(this.#snapshot):null;}
 async #invokeModel(m) {
  const controller=new AbortController();controller.completeDuringChat=m.payload.completeDuringChat===true;this.#controllers.add(controller);
  try {
   const result=await this.#model({...m.payload,signal:controller.signal,
    onPrepareDispatch:()=>this.data('modelEvent',{id:m.id,event:'prepare'}),
    onDispatch:()=>this.data('modelEvent',{id:m.id,event:'dispatch'}),
    onResponse:data=>this.data('modelEvent',{id:m.id,event:'response',data})});
   await this.data('modelResult',{id:m.id,result});
  }catch(e){try{await this.data('modelResult',{id:m.id,error:{code:e.code||'MODEL_FAILED',httpStatus:e.httpStatus}});}catch{}}
  finally{this.#controllers.delete(controller);}
 }
 async setBusy(busy){if(busy)for(const controller of this.#controllers){if(controller.completeDuringChat)continue;const e=Error('CHAT_PRIORITY_CANCELLED');e.code='CHAT_PRIORITY_CANCELLED';controller.abort(e);}return this.data('pressure',{busy});}
 async stop(){for(const c of this.#controllers)c.abort();this.#reviewPort?.close();const w=this.#worker;this.#worker=null;if(w)await w.terminate();this.#rejectPending();}
}
