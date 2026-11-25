import { parentPort,workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { createServices } from './store.js';
import { SnapshotReader } from './snapshot-reader.js';
import { EvolutionQueue } from './queue.js';
import { fail } from './integrity.js';
import { decryptPayload } from './observer.js';
import {queryData} from './queries.js';
const db=new DatabaseSync(workerData.file);
const allowed=new Set(workerData.allowedScopes);
const services=createServices(workerData.file,{database:db,now:()=>Date.now(),coreFingerprint:()=>workerData.coreHash,
 allowed:id=>allowed.has(id)||/^o_[a-f0-9]{24}$/.test(id),
 authenticate:a=>a?.secret===workerData.reviewSecret&&a.principal?.startsWith('console-owner:')?a.principal:null});
const reader=new SnapshotReader(workerData.file,{allowed:id=>allowed.has(id)});
const models=new Map();let api=workerData.apiInfo,chatBusy=true;
function model(request) {
 const id=crypto.randomUUID();
 return new Promise((resolve,reject)=>{models.set(id,{request,resolve,reject});parentPort.postMessage({event:'model-request',id,payload:{callId:request.callId,jobId:request.jobId,scopeId:request.scopeId,expectedApi:request.expectedApi,messages:request.messages,maxTokens:request.maxTokens,completeDuringChat:request.completeDuringChat===true}});});
}
const queue=new EvolutionQueue(db,services,{model,apiInfo:()=>api,chatBusy:()=>chatBusy,decodeText:p=>workerData.privacyKey?decryptPayload(p,Buffer.from(workerData.privacyKey)):null});
queue.recover();
function status(){return {...queue.stats(),running:queue.running,settings:queue.settings()};}
function snapshot(){reader.refresh();return reader.snapshot();}
const dataCommands={
 status:()=>status(),
 query:p=>queryData(db,services,p,x=>workerData.privacyKey?decryptPayload(x,Buffer.from(workerData.privacyKey)):null),
 core:p=>{if(!/^[a-f0-9]{64}$/.test(p.hash))fail('INVALID_CORE_HASH');workerData.coreHash=p.hash;return true;},
 observe:payload=>{const cfg=queue.settings();if(!cfg.enabled)fail('LEARNING_DISABLED');if(payload.textPayload&&!cfg.captureText)fail('TEXT_CAPTURE_NOT_AUTHORIZED');return services.writer.observe(payload);},
 observeBatch:payload=>{
  const cfg=queue.settings(),rows=payload.observations;
  if(!cfg.enabled)fail('LEARNING_DISABLED');
  if(!Array.isArray(rows)||!rows.length||rows.length>16)fail('INVALID_OBSERVATION_BATCH');
  if(rows.some(r=>r.textPayload&&!cfg.captureText))fail('TEXT_CAPTURE_NOT_AUTHORIZED');
  return services.writer.batch(()=>{
   for(const row of rows){services.writer.scope({id:row.scopeId});if(row.subjectId)services.writer.scope({id:row.subjectId,kind:'object',parentId:row.scopeId});services.writer.observe(row);}
   return {accepted:rows.length};
  });
 },
 scope:payload=>services.writer.scope(payload),
 enqueue:payload=>queue.enqueue(payload),
 schedule:()=>queue.schedule(),
 pump:()=>queue.runOne(),
 pressure:payload=>{chatBusy=payload.busy===true;return {busy:chatBusy};},
 api:payload=>{if(payload.apiInfo?.model&&payload.apiInfo?.providerId)api=payload.apiInfo;return true;},
 snapshot:()=>snapshot(),
 modelEvent:async payload=>{
  const task=models.get(payload.id);if(!task)fail('MODEL_REQUEST_MISSING');
  if(payload.event==='prepare')await task.request.onPrepareDispatch();
  else if(payload.event==='dispatch')await task.request.onDispatch();
  else if(payload.event==='response')await task.request.onResponse(payload.data);
  else fail('MODEL_EVENT_DENIED');
  return true;
 },
 modelResult:payload=>{
  const task=models.get(payload.id);if(!task)fail('MODEL_REQUEST_MISSING');
  models.delete(payload.id);
  if(payload.error){const e=Error(payload.error.code||'MODEL_FAILED');e.code=payload.error.code;e.httpStatus=payload.error.httpStatus;task.reject(e);}
  else task.resolve(payload.result);
  return true;
 },
 cleanupText:()=>queue.cleanupText()
};
async function respond(port,message,commands) {
 const {id,command,payload={}}=message||{};
 try {
  if(!Object.hasOwn(commands,command))fail('COMMAND_DENIED',403);
  const result=await commands[command](payload);port.postMessage({id,result});
 }catch(e){port.postMessage({id,error:{code:e.code||'WORKER_OPERATION_FAILED',status:e.status||400}});}
}
parentPort.on('message',m=>respond(parentPort,m,dataCommands));
workerData.reviewPort.on('message',m=>respond(workerData.reviewPort,m,{
 preview:p=>services.reviewer.preview(p.auth,p.body),
 decide:p=>services.reviewer.decide(p.auth,p.body),
 feedback:p=>services.reviewer.feedback(p.auth,p.body),
 publish:p=>services.reviewer.publish(p.auth,p.body),
 settings:p=>{
  const principal=p.auth?.secret===workerData.reviewSecret?p.auth.principal:null;
  return queue.settingsPatch(p.body,principal);
 }
}));
parentPort.postMessage({event:'ready',status:status(),snapshot:snapshot()});
