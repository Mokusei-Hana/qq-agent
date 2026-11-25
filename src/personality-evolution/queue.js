import crypto from 'node:crypto';
import { canonical,digest,fail } from './integrity.js';
import { safeText,redact } from './privacy.js';
import { analysisInstruction,parseAnalysis } from './analysis.js';
import { evaluateWindows } from './evaluation.js';
const DAY=86400000;
export const defaults=Object.freeze({enabled:false,captureText:false,analysisEnabled:false,modelDailyLimit:8,dailyTokenLimit:128000,
 dailyBudgetMicros:null,unlimitedBudget:false,currency:null,priceInputPerM:null,priceOutputPerM:null,priceCachedPerM:null,retentionDays:14,
 minEvidence:10,minSources:2,minWindowDays:3,minConfidence:0.75});
const day=now=>new Date(now+8*3600000).toISOString().slice(0,10);
export class EvolutionQueue {
 constructor(db,services,{now=Date.now,model=async()=>{throw Error('MODEL_UNAVAILABLE');},apiInfo=()=>({}),chatBusy=()=>true,decodeText=()=>null}={}) {
  this.db=db;this.services=services;this.now=now;this.model=model;this.apiInfo=apiInfo;this.chatBusy=chatBusy;this.decodeText=decodeText;this.running=false;this.cancelled=false;
 }
 settings(){return {...defaults,...JSON.parse(this.db.prepare('SELECT settings_json FROM pe_settings WHERE id=1').get()?.settings_json||'{}')};}
 settingsPatch(patch,principal,reason='Administrator settings') {
  safeText(reason);
  if(!principal?.startsWith('console-owner:'))fail('AUTHENTICATION_REQUIRED',401);
  if(Object.keys(patch).some(k=>!Object.hasOwn(defaults,k)))fail('INVALID_SETTINGS');
  const next={...this.settings(),...patch};
  for(const k of ['enabled','captureText','analysisEnabled','unlimitedBudget'])if(typeof next[k]!=='boolean')fail('INVALID_SETTINGS');
  if(next.modelDailyLimit!==8||next.dailyTokenLimit!==128000||next.retentionDays!==14)fail('RESOURCE_POLICY_FIXED');
  if(!Number.isInteger(next.minEvidence)||next.minEvidence<5||next.minEvidence>100||
   !Number.isInteger(next.minSources)||next.minSources<1||next.minSources>20||
   !Number.isInteger(next.minWindowDays)||next.minWindowDays<1||next.minWindowDays>30||
   !Number.isFinite(next.minConfidence)||next.minConfidence<0.65||next.minConfidence>0.99)fail('INVALID_SETTINGS');
  for(const k of ['dailyBudgetMicros','priceInputPerM','priceOutputPerM','priceCachedPerM'])
   if(next[k]!==null&&(!Number.isFinite(next[k])||next[k]<0))fail('INVALID_BUDGET');
  if(next.dailyBudgetMicros!==null&&!Number.isSafeInteger(next.dailyBudgetMicros))fail('INVALID_BUDGET');
  if(next.analysisEnabled&&((!next.unlimitedBudget&&(next.dailyBudgetMicros===null||next.dailyBudgetMicros<=0))||typeof next.currency!=='string'||!next.currency||
   (!next.unlimitedBudget&&(next.priceInputPerM===null||next.priceOutputPerM===null))))fail('MONEY_BUDGET_REQUIRED');
  const revision=(this.db.prepare('SELECT revision FROM pe_settings WHERE id=1').get()?.revision||0)+1;
  const json=canonical(next),at=this.now();
  this.db.exec('BEGIN IMMEDIATE');
  try {
   this.db.prepare('INSERT INTO pe_settings VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,updated_at=excluded.updated_at,principal=excluded.principal').run(revision,json,at,principal);
   this.db.prepare('INSERT INTO pe_settings_history VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),revision,json,principal,reason,at);
   this.db.exec('COMMIT');return next;
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 enqueue({scopeId,kind='reflection'}) {
  if(!['reflection','evaluation','trend','local'].includes(kind))fail('INVALID_JOB_KIND');
  const scope=this.services.writer.checkScope(scopeId);
  if(!scope||scope.kind!=='group')fail('UNAUTHORIZED_ANALYSIS_SCOPE');
  const at=this.now(),windowStart=at-(kind==='trend'?30:14)*DAY;
  const rows=this.db.prepare('SELECT * FROM pe_observations WHERE scope_id=? AND occurred_at>=? ORDER BY occurred_at,id').all(scopeId,windowStart);
  const ids=rows.map(r=>r.id), period=kind==='local'?String(Math.floor(at/1800000)):kind==='trend'?day(at-Math.floor((new Date(at+8*3600000).getUTCDay()+6)%7)*DAY):day(at);
  const key=digest({scopeId,kind,period,datasetHash:digest(ids),targetVersion:this.db.prepare("SELECT value FROM personality_state WHERE key='version'").get().value,analyzer:'v2',prompt:digest(analysisInstruction)});
  const existing=this.db.prepare('SELECT id FROM pe_jobs WHERE job_key=?').get(key);if(existing)return {id:existing.id,deduplicated:true};
  const id=crypto.randomUUID(), latest=this.db.prepare("SELECT max(finished_at) AS at FROM pe_jobs WHERE scope_id=? AND kind='reflection' AND state='succeeded'").get(scopeId).at;
  const newCount=rows.filter(r=>latest===null||r.created_at>latest).length;
  let enough=rows.length>=50&&new Set(rows.map(r=>r.interaction_id)).size>=50&&
   Math.max(...rows.map(r=>r.occurred_at))-Math.min(...rows.map(r=>r.occurred_at))>=DAY;
  if(kind==='reflection'&&newCount<20)enough=false;
  if(kind==='trend'&&(Math.max(...rows.map(r=>r.occurred_at))-Math.min(...rows.map(r=>r.occurred_at))<14*DAY||rows.filter(r=>r.occurred_at>=at-14*DAY&&r.occurred_at<at-7*DAY).length<50||rows.filter(r=>r.occurred_at>=at-7*DAY).length<50))enough=false;
  const state=kind==='local'?'succeeded':kind==='evaluation'?'skipped':enough?'queued':'skipped';
  const sampled=this.sample(rows,kind==='trend'?80:50);
  this.db.exec('BEGIN IMMEDIATE');
  try {
   this.db.prepare(`INSERT INTO pe_jobs(id,job_key,kind,scope_id,window_start,window_end,target_version,analyzer_version,prompt_version,redaction_version,
    dataset_hash,state,next_run_at,error_code,created_by,created_at,finished_at) VALUES(?,?,?,?,?,? ,?,'v2','v2','v2',?,?,?,?,'scheduler',?,?)`)
    .run(id,key,kind,scopeId,windowStart,at+1,Number(this.db.prepare("SELECT value FROM personality_state WHERE key='version'").get().value),
      digest(sampled.map(r=>r.id)),state,at,enough?null:'INSUFFICIENT_SAMPLES',at,state==='queued'?null:at);
   sampled.forEach((row,i)=>this.db.prepare("INSERT INTO pe_job_samples VALUES(?,?,'analysis',?,?,?)").run(id,row.id,i,row.features_json,row.content_fingerprint));
   if(kind==='evaluation'){const job=this.db.prepare('SELECT * FROM pe_jobs WHERE id=?').get(id);evaluateWindows(this.db,job,at);}
   this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  return {id,deduplicated:false,state};
 }
 schedule() {
  if(!this.settings().enabled)return {disabled:true};
  const at=this.now(),local=new Date(at+8*3600000),minute=local.getUTCHours()*60+local.getUTCMinutes(),weekday=local.getUTCDay();
  const kinds=[['local',String(Math.floor(at/1800000)),true],['reflection',day(at),minute>=210],['evaluation',day(at),minute>=270],['trend',day(at),weekday===1&&minute>=300]];
  const created=[];
  for(const scope of this.db.prepare("SELECT id FROM pe_scopes WHERE kind='group'").all()) {
   try{this.services.writer.checkScope(scope.id);}catch{continue;}
   for(const [kind,period,due] of kinds) {
    if(!due)continue;const key='schedule:'+scope.id+':'+kind;
    const mark=kind==='local'?Number(period):Number(period.replaceAll('-',''));
    if((this.db.prepare('SELECT value FROM pe_counters WHERE key=?').get(key)?.value||0)>=mark)continue;
    created.push(this.enqueue({scopeId:scope.id,kind}));
    this.db.prepare('INSERT INTO pe_counters VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key,mark,at);
   }
  }
  return {created};
 }
 sample(rows,max) {
  if(rows.length<=max)return rows;
  const buckets=new Map();for(const r of rows){const k=day(r.occurred_at)+':'+JSON.parse(r.features_json).scene;const a=buckets.get(k)||[];a.push(r);buckets.set(k,a);}
  const out=[];while(out.length<max&&[...buckets.values()].some(a=>a.length))for(const a of buckets.values()){if(a.length&&out.length<max)out.push(a.shift());}
  return out;
 }
 event(callId,event,data={}) {
  const seq=this.db.prepare('SELECT count(*) AS n FROM pe_call_events WHERE call_id=?').get(callId).n;
  this.db.prepare('INSERT INTO pe_call_events VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(),callId,seq,event,canonical(data),this.now());
 }
 recover() {
  for(const job of this.db.prepare("SELECT * FROM pe_jobs WHERE state='running'").all()) {
   const call=this.db.prepare('SELECT * FROM pe_model_calls WHERE job_id=? ORDER BY attempt_no DESC LIMIT 1').get(job.id);
   const received=!!call?.responded_at;
   const uncertain=!received&&!!call&&(!!call.dispatched_at||call.outcome==='uncertain');
   this.db.prepare("UPDATE pe_jobs SET state=?,lease_owner=NULL,lease_until=NULL,error_code=? WHERE id=?").run(received?'failed':uncertain?'unknown':'queued',received?'RESULT_NOT_PERSISTED':uncertain?'INTERRUPTED_UNKNOWN':'INTERRUPTED_BEFORE_DISPATCH',job.id);
   if(call){this.db.prepare('UPDATE pe_model_calls SET state=?,outcome=?,finished_at=? WHERE id=?').run(received?'failed':uncertain?'unknown':'cancelled',received?'response_received':uncertain?'uncertain':'not_dispatched',this.now(),call.id);this.event(call.id,received?'failed':uncertain?'unknown':'cancelled',{reason:'restart'});}
  }
 }
 async runOne() {
  const cfg=this.settings();
  if(this.running||!cfg.enabled||!cfg.analysisEnabled||this.chatBusy())return {blocked:'DISABLED_OR_CHAT_BUSY'};
  if(!cfg.unlimitedBudget&&(cfg.dailyBudgetMicros===null||cfg.priceInputPerM===null||cfg.priceOutputPerM===null))return {blocked:'MONEY_BUDGET_REQUIRED'};
  this.db.prepare("UPDATE pe_jobs SET state='skipped',error_code='STALE_WINDOW',finished_at=? WHERE state IN ('queued','waiting_retry') AND id NOT IN (SELECT id FROM pe_jobs j WHERE j.state IN ('queued','waiting_retry') AND j.id=(SELECT k.id FROM pe_jobs k WHERE k.scope_id=j.scope_id AND k.kind=j.kind AND k.state IN ('queued','waiting_retry') ORDER BY k.window_end DESC,k.id DESC LIMIT 1))").run(this.now());
  const job=this.db.prepare("SELECT * FROM pe_jobs WHERE state IN ('queued','waiting_retry') AND next_run_at<=? ORDER BY created_at,id LIMIT 1").get(this.now());
  if(!job)return {idle:true};
  const rows=this.db.prepare('SELECT o.* FROM pe_job_samples s JOIN pe_observations o ON o.id=s.observation_id WHERE s.job_id=? ORDER BY s.ordinal').all(job.id);
  const textSegments=new Map();
  let samples;
  try { samples=rows.map((r,index)=>{
   const payload=this.db.prepare('SELECT * FROM pe_text_payloads WHERE observation_id=? AND expires_at>?').get(r.id,this.now());
   const text=payload?this.decodeText(payload):null;
   const clip=s=>{const v=redact(s);let out='';for(const c of v){if(Buffer.byteLength(out+c)>64)break;out+=c;}return out;};
   const cleaned=text&&index<8?{reply:clip(text.reply),context:clip(text.context)}:null;
   if(cleaned)textSegments.set(r.id,[cleaned.reply,cleaned.context].filter(Boolean));
   const f=JSON.parse(r.features_json),features={length:f.length||0,scene:f.scene||'chat',type:f.responseType||'direct_answer',joking:!!f.joking,filler:!!f.emptyFiller};
   return {observationId:r.id,availableSegments:['features',...(features.type==='silence'?['silence']:[]),...(cleaned?.reply?['reply']:[]),...(cleaned?.context?['context']:[])],features,...(cleaned?{text:cleaned}:{})};
  });
  } catch {
   this.db.prepare("UPDATE pe_jobs SET state='failed',error_code='INPUT_MATERIAL_INVALID',finished_at=? WHERE id=?").run(this.now(),job.id);
   return {jobId:job.id,state:'failed',code:'INPUT_MATERIAL_INVALID'};
  }
  const existingProposals=this.db.prepare(`SELECT r.preference_id AS preferenceId,r.name,r.intent,r.rule_json,r.scenes_json
   FROM pe_preferences p
   JOIN pe_preference_revisions r ON r.preference_id=p.id
   WHERE p.scope_id=?
     AND r.revision=(SELECT max(r2.revision) FROM pe_preference_revisions r2 WHERE r2.preference_id=p.id)
     AND NOT EXISTS (
       SELECT 1 FROM pe_review_targets t JOIN pe_review_history h ON h.id=t.review_id
       WHERE t.preference_id=r.preference_id AND t.preference_revision=r.revision AND h.action='reject'
     )
   ORDER BY r.created_at DESC LIMIT 20`).all(job.scope_id).map(r=>{
    let dimension='scene_adaptation',scenes=['*'];
    try{dimension=JSON.parse(r.rule_json).dimension||dimension;}catch{}
    try{scenes=JSON.parse(r.scenes_json);}catch{}
    return {preferenceId:r.preferenceId,name:r.name,dimension,intent:r.intent,scenes};
   });
  const existingProposalIds=new Set(existingProposals.map(p=>p.preferenceId));
  const maxInput=job.kind==='trend'?20000:16000,maxOutput=12000;
  let userPayload={scopeId:job.scope_id,kind:job.kind,samples,...(existingProposals.length?{existingProposals}:{})};
  let messages=[{role:'system',content:analysisInstruction},{role:'user',content:canonical(userPayload)}];
  // UTF-8 byte upper-bound estimate with framing reserve; exact usage is reported separately.
  let reservedInput=Buffer.byteLength(canonical(messages))+1024;
  if(reservedInput>maxInput&&existingProposals.length){
   userPayload={scopeId:job.scope_id,kind:job.kind,samples};
   messages=[{role:'system',content:analysisInstruction},{role:'user',content:canonical(userPayload)}];
   reservedInput=Buffer.byteLength(canonical(messages))+1024;
  }
  if(reservedInput>maxInput){this.db.prepare("UPDATE pe_jobs SET state='skipped',error_code='INPUT_BUDGET',finished_at=? WHERE id=?").run(this.now(),job.id);return {skipped:'INPUT_BUDGET'};}
  const budget=this.db.prepare('SELECT count(*) AS attempts,coalesce(sum(reserved_input_tokens+reserved_output_tokens),0) AS tokens,coalesce(sum(coalesce(cost_micros,reserved_cost_micros)),0) AS money FROM pe_model_calls WHERE budget_day=?').get(day(this.now()));
  const hasPrice=cfg.priceInputPerM!==null&&cfg.priceOutputPerM!==null;
  const reserveCost=hasPrice?Math.ceil(reservedInput*cfg.priceInputPerM+maxOutput*cfg.priceOutputPerM):null;
  if(budget.attempts>=8||budget.tokens+reservedInput+maxOutput>128000||(!cfg.unlimitedBudget&&budget.money+reserveCost>cfg.dailyBudgetMicros))return {blocked:'DAILY_BUDGET'};
  const previous=this.db.prepare('SELECT max(prepared_at) AS at FROM pe_model_calls').get().at;
  if(previous!==null&&this.now()-previous<60000)return {blocked:'CALL_INTERVAL'};
  const info=this.apiInfo();
  if(!info.model||!info.providerId)return {blocked:'MODEL_NOT_CONFIGURED'};
  if(Object.hasOwn(info,'price')&&(info.price ? info.price.in!==cfg.priceInputPerM||info.price.out!==cfg.priceOutputPerM||(info.price.cached??info.price.in)!==(cfg.priceCachedPerM??cfg.priceInputPerM) : hasPrice))return {blocked:'MODEL_PRICE_CHANGED'};
  const callId=crypto.randomUUID(),attempt=job.attempt_count+1,at=this.now();
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const locked=this.db.prepare('SELECT count(*) AS attempts,coalesce(sum(reserved_input_tokens+reserved_output_tokens),0) AS tokens,coalesce(sum(coalesce(cost_micros,reserved_cost_micros)),0) AS money FROM pe_model_calls WHERE budget_day=?').get(day(at));
   if(locked.attempts>=8||locked.tokens+reservedInput+maxOutput>128000||(!cfg.unlimitedBudget&&locked.money+reserveCost>cfg.dailyBudgetMicros))fail('DAILY_BUDGET');
   if(canonical(this.settings())!==canonical(cfg))fail('SETTINGS_CHANGED');
   const changed=this.db.prepare("UPDATE pe_jobs SET state='running',started_at=?,lease_owner='writer',lease_until=?,attempt_count=? WHERE id=? AND state IN ('queued','waiting_retry')").run(at,at+240000,attempt,job.id);
   if(changed.changes!==1)fail('JOB_LEASE_CONFLICT');
   this.db.prepare(`INSERT INTO pe_model_calls(id,job_id,attempt_no,budget_day,state,outcome,provider_id,requested_model,config_fingerprint,request_hash,
    reserved_input_tokens,reserved_output_tokens,reserved_cost_micros,currency,price_json,prepared_at)
    VALUES(?,?,?,?,'prepared','not_dispatched',?,?,?,?,?,?,?,?,?,?)`).run(callId,job.id,attempt,day(at),info.providerId,info.model,info.fingerprint||digest(info),
     digest(messages),reservedInput,maxOutput,reserveCost,cfg.currency,canonical({in:cfg.priceInputPerM,out:cfg.priceOutputPerM,cached:cfg.priceCachedPerM}),at);
   this.event(callId,'prepared');this.db.exec('COMMIT');
  }catch(e){this.db.exec('ROLLBACK');throw e;}
  this.running=true;let responded=false,dispatched=false,intent=false;
  try {
   const result=await this.model({callId,jobId:job.id,scopeId:job.scope_id,expectedApi:info,messages,maxTokens:maxOutput,completeDuringChat:['reflection','trend'].includes(job.kind),
    onPrepareDispatch:async()=>{this.db.prepare("UPDATE pe_model_calls SET state='dispatching',outcome='uncertain' WHERE id=?").run(callId);this.event(callId,'dispatching',{phase:'intent'});intent=true;},
    onDispatch:async()=>{this.db.prepare("UPDATE pe_model_calls SET state='dispatching',outcome='uncertain',dispatched_at=? WHERE id=?").run(this.now(),callId);this.event(callId,'dispatching');dispatched=true;},
    onResponse:async({status,requestId=null})=>{this.db.prepare("UPDATE pe_model_calls SET state='responded',outcome='response_received',responded_at=?,http_status=?,provider_request_id=? WHERE id=?").run(this.now(),status,requestId,callId);this.event(callId,'responded',{status});responded=true;}
   });
   if(!dispatched||!responded)fail('MISSING_REAL_CALL_EVENTS');
   const usage=result.usage||null;
   if(usage) {
    const input=Number(usage.prompt_tokens),output=Number(usage.completion_tokens),cached=Number(usage.prompt_tokens_details?.cached_tokens||usage.prompt_cache_hit_tokens||0);
    if(![input,output,cached].every(n=>Number.isSafeInteger(n)&&n>=0)||cached>input)fail('INVALID_USAGE');
    const cost=hasPrice?Math.ceil((input-cached)*cfg.priceInputPerM+output*cfg.priceOutputPerM+cached*(cfg.priceCachedPerM??cfg.priceInputPerM)):null;
    this.db.prepare('UPDATE pe_model_calls SET input_tokens=?,output_tokens=?,cached_tokens=?,usage_json=?,cost_micros=?,actual_model=? WHERE id=?').run(input,output,cached,canonical(usage),cost,result.model||info.model,callId);
    this.event(callId,'usage',{input,output,cached});
   }
   if(result.finishReason==='length')fail('MODEL_OUTPUT_TRUNCATED');
   if(!result.message?.content?.trim())fail('MODEL_EMPTY_RESPONSE');
   const report=parseAnalysis(result.message?.content,{scopeId:job.scope_id,sampleIds:rows.map(r=>r.id),textSegments,existingProposalIds});
   this.persistReport(job,report,callId);
   return {jobId:job.id,callId,state:'succeeded'};
  }catch(e) {
   const code=String(e.code||'ANALYSIS_FAILED').replace(/[^A-Z0-9_]/g,'').slice(0,80)||'ANALYSIS_FAILED';
   const state=code.includes('TIMEOUT')?'timed_out':code.includes('CANCEL')||code==='ABORT_ERR'?'cancelled':(intent||dispatched)&&!responded?'unknown':'failed';
   const outcome=responded?'response_received':intent||dispatched?'uncertain':'not_dispatched';
   this.db.prepare('UPDATE pe_model_calls SET state=?,outcome=?,error_code=?,finished_at=? WHERE id=?').run(state,outcome,code,this.now(),callId);
   this.event(callId,state,{code});
   const retry=responded&&e.httpStatus===429&&attempt<2;
   this.db.prepare('UPDATE pe_jobs SET state=?,error_code=?,finished_at=?,next_run_at=?,lease_owner=NULL,lease_until=NULL WHERE id=?').run(retry?'waiting_retry':outcome==='uncertain'?'unknown':'failed',code,retry?null:this.now(),this.now()+60000,job.id);
   return {jobId:job.id,callId,state,outcome,code};
  }finally{this.running=false;}
 }
 persistReport(job,report,callId) {
  const reportId=crypto.randomUUID(),at=this.now();
  // All result writes are one transaction: candidates never become active here.
  return this.services.writer.batch(()=>{
   this.db.prepare('INSERT INTO pe_reports VALUES(?,?,?,?,?,?,?,?)').run(reportId,job.id,2,'v2',canonical(report),canonical({samples:this.db.prepare('SELECT count(*) AS n FROM pe_job_samples WHERE job_id=?').get(job.id).n}),digest(report),at);
   for(const item of report.traits) {
    const id='trait_'+digest({scope:job.scope_id,dimension:item.dimension}).slice(0,24);
    if(!this.db.prepare('SELECT 1 FROM personality_traits WHERE id=?').get(id))
     this.db.prepare('INSERT INTO personality_traits VALUES(?,?,?,?,?)').run(id,job.scope_id,item.dimension,item.dimension,at);
    const rev=(this.db.prepare('SELECT max(revision) AS n FROM personality_trait_revisions WHERE trait_id=?').get(id).n||0)+1;
    this.db.prepare(`INSERT INTO personality_trait_revisions(trait_id,revision,conclusion,confidence,window_start,window_end,limitations_json,coverage_json,source_job_id,source_report_id,supersedes_revision,created_by,redaction_version,content_hash,created_at)
      VALUES(?,?,?,?,?,? ,?,'{}',?,?,?,'analyzer','v2',?,?)`).run(id,rev,item.conclusion,item.confidence,job.window_start,job.window_end,canonical(report.limitations),job.id,reportId,rev>1?rev-1:null,digest(item),at);
    for(const [polarity,list] of [['support',item.supports],['counter',item.counters]])for(const ref of list)
     this.db.prepare(`INSERT INTO pe_evidence(id,trait_id,trait_revision,job_id,observation_id,sample_role,segment,polarity,explanation,redaction_version)
      VALUES(?,?,?,?,?,'analysis',?,?,?,'v2')`).run(crypto.randomUUID(),id,rev,job.id,ref.observationId,ref.segment,polarity,'Abstract behavior evidence');
   }
   for(const item of report.proposals) {
    const reuse=item.preferenceId&&this.db.prepare('SELECT 1 FROM pe_preferences WHERE id=? AND scope_id=?').get(item.preferenceId,job.scope_id);
    const id=reuse?item.preferenceId:'pref_'+digest({scope:job.scope_id,dimension:item.dimension,name:item.name}).slice(0,24);
    const revision=(this.db.prepare('SELECT max(revision) AS n FROM pe_preference_revisions WHERE preference_id=?').get(id).n||0)+1;
    this.services.writer.candidate({id,scopeId:job.scope_id,name:item.name,rule:item.rule,intent:item.intent,dimension:item.dimension,risks:item.risks,rationale:item.conclusion,scenes:item.scenes,confidence:item.confidence,jobId:job.id,evidenceIds:item.supports.map(r=>r.observationId),revision,supersedes:revision>1?revision-1:null});
    for(const ref of item.counters) this.db.prepare(`INSERT INTO pe_evidence(id,preference_id,preference_revision,job_id,observation_id,sample_role,segment,polarity,explanation,redaction_version) VALUES(?,?,?,?,?,'analysis',?,'counter','Abstract counter evidence','v2')`).run(crypto.randomUUID(),id,revision,job.id,ref.observationId,ref.segment);
   }
   this.db.prepare("UPDATE pe_model_calls SET state='succeeded',outcome='response_received',finished_at=? WHERE id=?").run(at,callId);
   this.event(callId,'succeeded');
   this.db.prepare("UPDATE pe_jobs SET state='succeeded',finished_at=?,lease_owner=NULL,lease_until=NULL,error_code=NULL WHERE id=?").run(at,job.id);
   return reportId;
  });
 }
 cleanupText(){return this.db.prepare('DELETE FROM pe_text_payloads WHERE expires_at<=?').run(this.now()).changes;}
 stats() {
  const totals=this.db.prepare(`SELECT count(*) AS attempts,sum(dispatched_at IS NOT NULL) AS modelCalls,
    sum(state='succeeded') AS callsSucceeded,sum(state='failed') AS callsFailed,sum(state='timed_out') AS callsTimedOut,
    sum(state='cancelled') AS callsCancelled,sum(outcome='uncertain') AS callsUnknown FROM pe_model_calls`).get();
  const jobs=this.db.prepare(`SELECT sum(state='succeeded' AND kind IN ('reflection','trend')) AS analysisSucceeded,sum(state='failed') AS analysisFailed,
    max(CASE WHEN state='succeeded' AND kind<>'local' THEN finished_at END) AS lastAnalysis FROM pe_jobs`).get();
  return {...Object.fromEntries(Object.entries({...totals,...jobs}).map(([k,v])=>[k,v??0])),
   historicalExisting:this.db.prepare('SELECT count(*) AS n FROM personality_observations').get().n,
   observations:this.db.prepare('SELECT count(*) AS n FROM pe_observations').get().n,
   lastObservation:this.db.prepare('SELECT max(occurred_at) AS at FROM pe_observations').get().at,
   traits:this.db.prepare('SELECT count(*) AS n FROM personality_traits').get().n,
   reports:this.db.prepare('SELECT count(*) AS n FROM pe_reports').get().n};
 }
}
