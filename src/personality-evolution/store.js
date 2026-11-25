import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonical, digest, fail } from './integrity.js';
import { safeText } from './privacy.js';
import { configure } from './migration.js';

const DAY = 86400000;
export function createServices(file, { authenticate = () => null, allowed = () => false, now = Date.now, fault = () => {}, database = null, coreFingerprint = () => null, allowObject = false, allowGlobal = false } = {}) {
 const db = database || new DatabaseSync(file); configure(db);
 if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='pe_schema'").get()) { db.close(); fail('MIGRATION_REQUIRED'); }
 let expected = null;
 db.function('pe_guard', (op, key, payload) => {
  if (!expected) return 0;
  const token = canonical([op,key,JSON.parse(payload)]);
  const count = expected.get(token) || 0;
  if (!count) return 0;
  expected.set(token,count-1); return 1;
 });
 function tx(fn, capabilities = [], join = false) {
  if (expected) { if (join && !capabilities.length) return fn(); fail('NESTED_TRANSACTION'); }
  db.exec('BEGIN IMMEDIATE');
  expected = new Map();
  for (const cap of capabilities) { const k=canonical(cap); expected.set(k,(expected.get(k)||0)+1); }
  try {
   const result=fn();
   if ([...expected.values()].some(n=>n!==0)) fail('UNCONSUMED_REVIEW_CAPABILITY');
   db.exec('COMMIT'); return result;
  } catch(e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
  finally { expected=null; }
 }
 function principal(auth) {
  const p=authenticate(auth);
  if (typeof p!=='string' || !p.startsWith('console-owner:')) fail('AUTHENTICATION_REQUIRED',401);
  return p;
 }
 function scope(id) {
  const s=db.prepare('SELECT * FROM pe_scopes WHERE id=?').get(id);
  if (!s || !allowed(id) || s.kind==='object'&&!allowed(s.parent_id)) fail('SCOPE_DENIED',403);
  return s;
 }
 const writer = Object.freeze({
  batch(fn) { return tx(fn); },
  checkScope(id) { return scope(id); },
  scope({id,kind='group',parentId=null,key=id}) {
   if (!['group','object','global'].includes(kind) || !id || !key || !allowed(id)) fail('SCOPE_DENIED',403);
   const existing=db.prepare('SELECT * FROM pe_scopes WHERE id=?').get(id);
   if(existing) { if(existing.kind!==kind || existing.parent_id!==parentId || existing.scope_key!==key) fail('SCOPE_CONFLICT'); return id; }
   db.prepare('INSERT INTO pe_scopes VALUES (?,?,?,?,?)').run(id,kind,key,parentId,now()); return id;
  },
  observe({id,scopeId,subjectId=null,interactionId=id,at=now(),features={},version=0,textPayload=null,injected=[]}) {
   scope(scopeId);
   const keys=['length','scene','responseType','joking','emptyFiller'];
   if(Object.keys(features).some(k=>!keys.includes(k))||
    features.scene!==undefined&&!['question','complaint','sharing','debate','distress','chat'].includes(features.scene)||
    features.responseType!==undefined&&!['silence','follow_up','disagreement','empathy','joke','direct_answer'].includes(features.responseType)||
    features.length!==undefined&&(!Number.isSafeInteger(features.length)||features.length<0||features.length>2000)||
    ['joking','emptyFiller'].some(k=>features[k]!==undefined&&typeof features[k]!=='boolean'))fail('INVALID_FEATURES');
   if(!Array.isArray(injected)||injected.length>50||injected.some(e=>typeof e.id!=='string'||!Number.isInteger(e.revision)||!/^[a-f0-9]{64}$/.test(e.contentHash)))fail('INVALID_ATTRIBUTION');
   if(subjectId){const subject=scope(subjectId);if(subject.kind!=='object'||subject.parent_id!==scopeId)fail('SUBJECT_SCOPE_MISMATCH');}
   const data=JSON.stringify(features);
   if(data.length>8192||!Number.isSafeInteger(at)||at>now())fail('INVALID_OBSERVATION');
   const prior=db.prepare('SELECT scope_id,features_json FROM pe_observations WHERE id=?').get(id);
   if(prior){if(prior.scope_id!==scopeId||prior.features_json!==data)fail('OBSERVATION_CONFLICT');return id;}
   if(textPayload&&(!textPayload.ciphertext||textPayload.ciphertext.length<28||textPayload.ciphertext.length>32768||!/^[a-f0-9]{16}$/.test(textPayload.keyId)))fail('INVALID_TEXT_PAYLOAD');
   const created=now(),fingerprint=digest({scopeId,interactionId,features});
   return tx(()=>{
    db.prepare(`INSERT INTO pe_observations(
     id,event_key,scope_id,subject_id,interaction_id,occurred_at,format,context_quality,
     features_json,attribution_json,injected_json,version_id,consent_revision,redaction_version,content_fingerprint,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,'{}',?,?,0,'v2',?,?)`)
     .run(id,digest({id,scopeId}),scopeId,subjectId,interactionId,at,textPayload?'redacted_text':'features_only',textPayload?'linked':'missing',data,canonical(injected),version,fingerprint,created);
    if(textPayload)db.prepare('INSERT INTO pe_text_payloads VALUES(?,?,?,?,?,?)').run(id,Buffer.from(textPayload.ciphertext),textPayload.keyId,'v2',created,created+14*DAY);
    db.prepare("INSERT INTO pe_counters VALUES('observationsAccepted',1,?) ON CONFLICT(key) DO UPDATE SET value=value+1,updated_at=excluded.updated_at").run(created);
    return id;
   },[],true);
  },
  job({id,scopeId,observationIds}) {
   scope(scopeId);
   if (!Array.isArray(observationIds) || !observationIds.length || observationIds.length>2000) fail('INVALID_SAMPLES');
   return tx(()=>{
    const rows=observationIds.map(id=>db.prepare('SELECT * FROM pe_observations WHERE id=?').get(id));
    if(rows.some(r=>!r || r.scope_id!==scopeId)) fail('SAMPLE_SCOPE_MISMATCH');
    db.prepare(`INSERT INTO pe_jobs(
      id,job_key,kind,scope_id,window_start,window_end,analyzer_version,prompt_version,redaction_version,
      dataset_hash,state,next_run_at,created_by,created_at)
      VALUES (?,?,'reflection',?,?,?,'s1','s1','s1',?,'succeeded',?,'isolated-analyzer',?)`)
     .run(id,digest({id,observationIds}),scopeId,Math.min(...rows.map(r=>r.occurred_at)),now()+1,digest(observationIds),now(),now());
    rows.forEach((row,i)=>db.prepare("INSERT INTO pe_job_samples VALUES (?,?,'analysis',?,?,?)")
     .run(id,row.id,i,row.features_json,row.content_fingerprint));
    return id;
   });
  },
  candidate({id,scopeId,name,rule,scenes=['*'],confidence=.9,intent='improve',dimension='scene_adaptation',risks=[],rationale='Evidence-linked expression proposal',jobId,evidenceIds,revision=1,supersedes=null}) {
   scope(scopeId); name=safeText(name,100); rule=safeText(rule);rationale=safeText(rationale);
   if(!['preserve','improve','limit'].includes(intent)||!['conciseness','initiative','humor','empathy','repetition','mechanical_expression','scene_adaptation','interaction_quality'].includes(dimension)||!Array.isArray(risks)||risks.length>8)fail('INVALID_CANDIDATE');
   risks=risks.map(r=>safeText(r));
   if(!Number.isInteger(revision)||revision<1 || !Number.isFinite(confidence)||confidence<0||confidence>1||
    !Array.isArray(scenes)||!scenes.length||scenes.some(s=>!['*','chat','question','complaint','sharing','debate','distress'].includes(s))||
    !Array.isArray(evidenceIds)) fail('INVALID_CANDIDATE');
   return tx(()=>{
    const found=db.prepare('SELECT * FROM pe_preferences WHERE id=?').get(id);
    if(found && found.scope_id!==scopeId) fail('SCOPE_CONFLICT');
    if(!found) db.prepare('INSERT INTO pe_preferences VALUES (?,?,?,?)').run(id,scopeId,digest({scopeId,name}),now());
    const body={id,revision,name,rule,scenes,confidence,scopeId,intent,dimension,risks,rationale};
    const hash=digest(body);
    db.prepare(`INSERT INTO pe_preference_revisions(
      preference_id,revision,name,intent,rule_text,rule_json,scenes_json,rationale,
      confidence,priority,risks_json,evidence_summary_json,first_seen_at,
      source_job_id,supersedes_revision,created_by,redaction_version,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,50,?,'{}',?,?,?,'analyzer','v2',?,?)`)
     .run(id,revision,name,intent,rule,canonical({strategy:rule,dimension,intent}),canonical(scenes),rationale,confidence,canonical(risks),now(),jobId,supersedes,hash,now());
    for(const obsId of [...new Set(evidenceIds)]) {
     const sample=db.prepare("SELECT 1 FROM pe_job_samples WHERE job_id=? AND observation_id=? AND role='analysis'").get(jobId,obsId);
     if(!sample) fail('EVIDENCE_NOT_IN_JOB');
     db.prepare(`INSERT INTO pe_evidence(
      id,preference_id,preference_revision,job_id,observation_id,sample_role,segment,polarity,explanation,redaction_version)
      VALUES (?,?,?,?,?,'analysis','features','support','Feature-linked supporting interaction','s1')`)
      .run(crypto.randomUUID(),id,revision,jobId,obsId);
    }
    return {id,revision,contentHash:hash};
   }, [], true);
  },
  close() { db.close(); }
 });
 function adoptionPolicy(kind) {
  let raw={};
  try{raw=JSON.parse(db.prepare('SELECT settings_json FROM pe_settings WHERE id=1').get()?.settings_json||'{}');}catch{}
  const minEvidence=Number.isInteger(raw.minEvidence)?Math.min(100,Math.max(5,raw.minEvidence)):10;
  const minSources=kind==='object'?1:(Number.isInteger(raw.minSources)?Math.min(20,Math.max(1,raw.minSources)):2);
  const minWindowDays=Number.isInteger(raw.minWindowDays)?Math.min(30,Math.max(1,raw.minWindowDays)):3;
  const minConfidence=Number.isFinite(raw.minConfidence)?Math.min(0.99,Math.max(0.65,raw.minConfidence)):0.75;
  return {minEvidence,minSources,minWindowMs:minWindowDays*DAY,minConfidence};
 }
 function eligible(id,revision,details=null) {
  const row=db.prepare('SELECT * FROM pe_preference_revisions WHERE preference_id=? AND revision=?').get(id,revision);
  if(!row) fail('REVISION_MISSING');
  const p=db.prepare('SELECT * FROM pe_preferences WHERE id=?').get(id), s=scope(p.scope_id);
  const decision=db.prepare('SELECT h.action FROM pe_review_targets t JOIN pe_review_history h ON h.id=t.review_id WHERE t.preference_id=? AND t.preference_revision=? ORDER BY h.created_at DESC,h.rowid DESC LIMIT 1').get(id,revision);
  if(decision&&['reject','request_evidence','edit'].includes(decision.action))fail('REVISION_REQUIRES_REVIEW_UPDATE');

  // Cross-group and object-level proposals require their separately approved policy (S2).
  if(s.kind==='object'&&!(typeof allowObject==='function'?allowObject():allowObject)||s.kind==='global'&&!(typeof allowGlobal==='function'?allowGlobal():allowGlobal)) fail('ADDITIONAL_SCOPE_POLICY_REQUIRED');
  const evidence=db.prepare(`SELECT DISTINCT o.* FROM pe_evidence e JOIN pe_observations o ON o.id=e.observation_id
    WHERE e.preference_id=? AND e.preference_revision<=? AND e.polarity='support'
      AND NOT EXISTS (
        SELECT 1 FROM pe_review_targets t JOIN pe_review_history h ON h.id=t.review_id
        WHERE t.preference_id=e.preference_id AND t.preference_revision=e.preference_revision AND h.action='reject'
      )`).all(id,revision);
  const count=new Set(evidence.map(r=>r.interaction_id)).size;
  const sources=new Set(evidence.map(r=>r.subject_id).filter(Boolean)).size;
  const times=evidence.map(r=>r.occurred_at);
  const wrongScope=evidence.some(r=>s.kind==='group'?r.scope_id!==s.id:s.kind==='object'?r.scope_id!==s.parent_id||r.subject_id!==s.id:!allowed(r.scope_id));
  const groupCount=new Set(evidence.map(r=>r.scope_id)).size;
  const sceneCount=new Set(evidence.map(r=>JSON.parse(r.features_json).scene).filter(Boolean)).size;
  const policy=adoptionPolicy(s.kind);
  const spanMs=times.length?Math.max(...times)-Math.min(...times):0;
  if(details)Object.assign(details,{interactions:count,sources,spanMs,confidence:row.confidence,requiredInteractions:policy.minEvidence,requiredSources:policy.minSources,requiredSpanMs:policy.minWindowMs,requiredConfidence:policy.minConfidence});
  if(wrongScope||count<policy.minEvidence||sources<policy.minSources||s.kind==='global'&&groupCount<3||s.kind==='object'&&sceneCount<2||row.confidence<policy.minConfidence||
   spanMs<policy.minWindowMs||!times.length||Math.max(...times)<now()-30*DAY) fail('INSUFFICIENT_VERIFIED_EVIDENCE');
  safeText(row.name,100); safeText(row.rule_text);
  return {id,revision,name:row.name,rule:row.rule_text,dimension:JSON.parse(row.rule_json).dimension||'scene_adaptation',scenes:JSON.parse(row.scenes_json),
   scope:{id:s.id,kind:s.kind,parent_id:s.parent_id},contentHash:row.content_hash,validUntil:null};
 }
 function readVersion() {
  const row=db.prepare("SELECT value FROM personality_state WHERE key='version'").get();
  if(!row || !/^(0|[1-9]\d*)$/.test(row.value)) fail('INVALID_PUBLISHED_POINTER');
  const version=Number(row.value), r=db.prepare('SELECT * FROM personality_versions WHERE id=?').get(version);
  if(!r) fail('MISSING_PUBLISHED_VERSION');
  return {version,entries:JSON.parse(r.content)};
 }
 const previews=new Map();
 const reviewer = Object.freeze({
  publicationReadiness(id,revision){const details={};try{eligible(id,revision,details);return {ready:true,...details};}catch(e){return {ready:false,reason:e.code||'REVIEW_UNAVAILABLE',...details};}},
  feedback(auth,{observationId,dimension,score,note='',supersedesId=null}) {
   const actor=principal(auth),row=db.prepare('SELECT scope_id FROM pe_observations WHERE id=?').get(observationId);
   if(!row)fail('OBSERVATION_MISSING');scope(row.scope_id);
   if(!['conciseness','initiative','humor','empathy','repetition','mechanical_expression','scene_adaptation','interaction_quality'].includes(dimension)||![-1,0,1].includes(score))fail('INVALID_FEEDBACK');
   if(note)note=safeText(note,500);
   if(supersedesId){const old=db.prepare('SELECT * FROM pe_feedback WHERE id=?').get(supersedesId);if(!old||old.observation_id!==observationId||old.principal!==actor)fail('INVALID_FEEDBACK_SUPERSESSION');}
   const id=crypto.randomUUID();db.prepare('INSERT INTO pe_feedback VALUES(?,?,?,?,?,?,?,?,?)').run(id,observationId,actor,dimension,score,note,'v2',supersedesId,now());return {id};
  },
  decide(auth,{action,id,revision,reason,idempotencyKey,patch={}}) {
   const actor=principal(auth);safeText(reason,500);
   if(!['reject','request_evidence','edit'].includes(action))fail('INVALID_REVIEW_ACTION');
   if(typeof idempotencyKey!=='string'||idempotencyKey.length<8||idempotencyKey.length>100)fail('IDEMPOTENCY_REQUIRED');
   const current=readVersion();
   if(current.entries.some(e=>e.id===id&&e.revision===revision))fail('ACTIVE_USE_REMOVE_PUBLICATION');
   const old=db.prepare('SELECT r.*,p.scope_id FROM pe_preference_revisions r JOIN pe_preferences p ON p.id=r.preference_id WHERE r.preference_id=? AND r.revision=?').get(id,revision);
   if(!old)fail('REVISION_MISSING');scope(old.scope_id);
   const requestHash=digest({action,id,revision,reason,patch});
   const replay=db.prepare('SELECT * FROM pe_review_history WHERE idempotency_key=?').get(idempotencyKey);
   if(replay){if(replay.principal!==actor||replay.request_hash!==requestHash)fail('IDEMPOTENCY_CONFLICT',409);return JSON.parse(replay.detail_json);}
   if(Object.keys(patch).some(k=>!['name','rule','scenes','rationale','risks'].includes(k))||action!=='edit'&&Object.keys(patch).length)fail('INVALID_REVISION_PATCH');
   const reviewId=crypto.randomUUID(),at=now(),next=action==='edit'?(db.prepare('SELECT max(revision) n FROM pe_preference_revisions WHERE preference_id=?').get(id).n+1):null;
   const detail={id,revision,action,newRevision:next};
   const header={idempotency_key:idempotencyKey,principal:actor,action,operation:null,base_version:current.version,result_version:null,request_hash:requestHash,final_snapshot_hash:null,reason,detail_json:canonical(detail),redaction_version:'v2',created_at:at};
   const target={id:crypto.randomUUID(),review_id:reviewId,target_kind:'preference',preference_id:id,preference_revision:revision,trait_id:null,trait_revision:null,disposition:action,content_hash:old.content_hash};
   const {id:targetId,...targetBody}=target;
   return tx(()=>{
    if(action==='edit'){
     const name=safeText(patch.name??old.name,100),rule=safeText(patch.rule??old.rule_text),rationale=safeText(patch.rationale??old.rationale);
     const scenes=patch.scenes??JSON.parse(old.scenes_json),risks=patch.risks??JSON.parse(old.risks_json);
     if(!Array.isArray(scenes)||!scenes.length||scenes.some(v=>!['*','chat','question','complaint','sharing','debate','distress'].includes(v))||!Array.isArray(risks)||risks.length>8)fail('INVALID_REVISION_PATCH');
     risks.forEach(v=>safeText(v));
     const dimension=JSON.parse(old.rule_json).dimension,hash=digest({id,revision:next,name,rule,scenes,confidence:old.confidence,scopeId:old.scope_id,intent:old.intent,dimension,risks,rationale});
     db.prepare(`INSERT INTO pe_preference_revisions(preference_id,revision,name,intent,rule_text,rule_json,scenes_json,rationale,confidence,priority,risks_json,evidence_summary_json,first_seen_at,source_job_id,supersedes_revision,created_by,redaction_version,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,next,name,old.intent,rule,canonical({strategy:rule,dimension,intent:old.intent}),canonical(scenes),rationale,old.confidence,old.priority,canonical(risks),old.evidence_summary_json,old.first_seen_at,old.source_job_id,revision,actor,'v2',hash,at);
     for(const e of db.prepare('SELECT * FROM pe_evidence WHERE preference_id=? AND preference_revision=?').all(id,revision))
      db.prepare(`INSERT INTO pe_evidence(id,preference_id,preference_revision,job_id,observation_id,sample_role,segment,polarity,explanation,redaction_version) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(),id,next,e.job_id,e.observation_id,e.sample_role,e.segment,e.polarity,e.explanation,e.redaction_version);
    }
    db.prepare(`INSERT INTO pe_review_history(id,idempotency_key,principal,action,operation,base_version,result_version,request_hash,final_snapshot_hash,reason,detail_json,redaction_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(reviewId,...Object.values(header));
    db.prepare('INSERT INTO pe_review_targets VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(target));
    return detail;
   },[['review.insert',reviewId,header],['review.target.insert',targetId,targetBody]]);
  },

  preview(auth, {expectedVersion, selections, operation='replace',reason='Administrator review',rollbackTarget=null}) {
   const actor=principal(auth), current=readVersion();safeText(reason,500);
   if(current.version!==expectedVersion) fail('VERSION_CONFLICT',409);
   if(!['add','remove','replace','rollback'].includes(operation)) fail('INVALID_OPERATION');
   let entries;
   if(operation==='rollback') {
    const target=db.prepare('SELECT content FROM personality_versions WHERE id=?').get(rollbackTarget);
    if(!target) fail('ROLLBACK_TARGET_MISSING');
    entries=JSON.parse(target.content);
    for(const entry of entries){scope(entry.scope.id);safeText(entry.rule);safeText(entry.name,100);}
   } else {
    if(!Array.isArray(selections)||selections.length>50) fail('INVALID_SELECTIONS');
    if(new Set(selections.map(s=>s.id)).size!==selections.length) fail('DUPLICATE_SELECTION');
    entries=selections.map(s=>{
     const existing=current.entries.find(e=>e.id===s.id && e.revision===s.revision && e.contentHash===s.contentHash);
     return existing ? (scope(existing.scope.id),structuredClone(existing)) : eligible(s.id,s.revision);
    });
   }
   for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){const a=entries[i],b=entries[j];if(a.scope.id===b.scope.id&&a.dimension===b.dimension&&a.scenes.some(x=>x==='*'||b.scenes.includes('*')||b.scenes.includes(x))&&a.rule!==b.rule)fail('PREFERENCE_CONFLICT');}
   const content=canonical(entries.sort((a,b)=>a.id.localeCompare(b.id)));
   if(Buffer.byteLength(content)>65536) fail('SNAPSHOT_TOO_LARGE');
   const coreHash=coreFingerprint();if(typeof coreHash!=='string'||!/^[a-f0-9]{64}$/.test(coreHash))fail('CORE_FINGERPRINT_REQUIRED');
   const requestHash=digest({expectedVersion,content,operation,reason,rollbackTarget,coreHash});
   for(const [key,value] of previews)if(value.expires<now())previews.delete(key);
   if(previews.size>=100)fail('TOO_MANY_PREVIEWS',429);
   const id=crypto.randomUUID();
   previews.set(id,{coreHash,actor,expectedVersion,entries,content,hash:digest(content),requestHash,operation,reason,rollbackTarget,expires:now()+300000});
   return {confirmationId:id,expectedVersion,finalSnapshotHash:digest(content),requestHash,entries:structuredClone(entries)};
  },
  publish(auth,{confirmationId,idempotencyKey,expectedVersion,finalSnapshotHash,requestHash}) {
   const actor=principal(auth);
   if(typeof idempotencyKey!=='string'||idempotencyKey.length<8||idempotencyKey.length>100) fail('IDEMPOTENCY_REQUIRED');
   const replay=db.prepare('SELECT * FROM pe_review_history WHERE idempotency_key=?').get(idempotencyKey);
   if(replay) {
    if(replay.principal!==actor||replay.request_hash!==requestHash||replay.final_snapshot_hash!==finalSnapshotHash) fail('IDEMPOTENCY_CONFLICT',409);
    return {version:replay.result_version,replayed:true};
   }
   const preview=previews.get(confirmationId);
   if(!preview||preview.actor!==actor||preview.expires<now()) fail('CONFIRMATION_REQUIRED',409);
   if(preview.expectedVersion!==expectedVersion||preview.hash!==finalSnapshotHash||preview.requestHash!==requestHash) fail('CONFIRMATION_MISMATCH',409);
   if(preview.coreHash!==coreFingerprint())fail('CORE_CONTEXT_CHANGED',409);
   previews.delete(confirmationId);
   const current=readVersion();
   if(current.version!==expectedVersion) fail('VERSION_CONFLICT',409);
   // Re-read exact immutable revisions and scope authorization at commit time.
   for(const entry of preview.entries) {
    scope(entry.scope.id);
    const revision=db.prepare('SELECT content_hash FROM pe_preference_revisions WHERE preference_id=? AND revision=?').get(entry.id,entry.revision);
    if(!revision||revision.content_hash!==entry.contentHash) fail('REVISION_CHANGED',409);
    if(preview.operation!=='rollback'&&!current.entries.some(e=>e.id===entry.id&&e.revision===entry.revision))eligible(entry.id,entry.revision);
   }
   const version=Number(db.prepare('SELECT max(id)+1 AS next FROM personality_versions').get().next);
   const reviewId=crypto.randomUUID(), at=now();
   const header={idempotency_key:idempotencyKey,principal:actor,action:'publish',operation:preview.operation,
    base_version:expectedVersion,result_version:version,request_hash:requestHash,final_snapshot_hash:preview.hash,
    reason:preview.reason,detail_json:canonical({confirmationId}),redaction_version:'s1',created_at:at};
   const targets=preview.entries.map(e=>({id:crypto.randomUUID(),review_id:reviewId,target_kind:'preference',preference_id:e.id,
    preference_revision:e.revision,trait_id:null,trait_revision:null,disposition:current.entries.some(x=>x.id===e.id&&x.revision===e.revision)?'retain':'add',content_hash:e.contentHash}));
   for(const e of current.entries.filter(x=>!preview.entries.some(y=>y.id===x.id&&y.revision===x.revision)))
    targets.push({id:crypto.randomUUID(),review_id:reviewId,target_kind:'preference',preference_id:e.id,preference_revision:e.revision,
     trait_id:null,trait_revision:null,disposition:'remove',content_hash:e.contentHash});
   const publication={review_id:reviewId,format_version:2,previous_version:expectedVersion,rollback_target:preview.rollbackTarget,
    snapshot_hash:preview.hash,core_fingerprint:preview.coreHash,created_at:at};
   const row={content:preview.content,change_summary:preview.reason,source_habit_ids:canonical(preview.entries.map(e=>e.id)),
    created_at:at,created_by:actor,previous_version:expectedVersion};
   const caps=[['review.insert',reviewId,header],
    ...targets.map(t=>{const {id,...body}=t;return ['review.target.insert',id,body];}),
    ['publication.insert',String(version),publication],['version.insert',String(version),row],
    ['pointer.update','version',{previous:String(expectedVersion),next:String(version)}]];
   return tx(()=>{
    if(readVersion().version!==expectedVersion) fail('VERSION_CONFLICT',409);
    db.prepare(`INSERT INTO pe_review_history(id,idempotency_key,principal,action,operation,base_version,result_version,request_hash,
     final_snapshot_hash,reason,detail_json,redaction_version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
     .run(reviewId,...Object.values(header));fault('review');
    for(const t of targets) db.prepare('INSERT INTO pe_review_targets VALUES (?,?,?,?,?,?,?,?,?)').run(...Object.values(t));
    fault('targets');
    db.prepare('INSERT INTO pe_publications VALUES (?,?,?,?,?,?,?,?)').run(version,...Object.values(publication));fault('publication');
    db.prepare('INSERT INTO personality_versions VALUES (?,?,?,?,?,?,?)').run(version,...Object.values(row));fault('version');
    db.prepare("UPDATE personality_state SET value=? WHERE key='version'").run(String(version));fault('pointer');
    return {version,replayed:false};
   },caps);
  }
 });
 return Object.freeze({writer,reviewer});
}
