import {fail} from './integrity.js';
import {redact} from './privacy.js';
export function queryData(db,services,{kind,limit=50,offset=0,id,includeText=false}={},decodeText=()=>null,now=Date.now()){
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>10000)fail('INVALID_PAGE');
 const permitted=row=>{try{services.writer.checkScope(row.scope_id);return true;}catch{return false;}};
 const queries={
  preferences:()=>db.prepare(`SELECT p.scope_id,r.*,
   (SELECT h.action FROM pe_review_targets t JOIN pe_review_history h ON h.id=t.review_id WHERE t.preference_id=r.preference_id AND t.preference_revision=r.revision ORDER BY h.created_at DESC,h.rowid DESC LIMIT 1) AS review_action
   FROM pe_preferences p JOIN pe_preference_revisions r ON r.preference_id=p.id ORDER BY r.created_at DESC,r.rowid DESC LIMIT ? OFFSET ?`).all(limit,offset).filter(permitted).map(row=>({...row,publicationReadiness:services.reviewer.publicationReadiness(row.preference_id,row.revision)})),
  observations:()=>db.prepare('SELECT id,scope_id,subject_id,interaction_id,occurred_at,format,context_quality,features_json,injected_json,version_id FROM pe_observations ORDER BY occurred_at DESC,id LIMIT ? OFFSET ?').all(limit,offset).filter(permitted),
  jobs:()=>db.prepare('SELECT * FROM pe_jobs ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(limit,offset).filter(permitted),
  reports:()=>db.prepare('SELECT j.scope_id,r.* FROM pe_reports r JOIN pe_jobs j ON j.id=r.job_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT ? OFFSET ?').all(limit,offset).filter(permitted),
  traits:()=>db.prepare('SELECT t.scope_id,r.* FROM personality_traits t JOIN personality_trait_revisions r ON t.id=r.trait_id ORDER BY r.created_at DESC,r.rowid DESC LIMIT ? OFFSET ?').all(limit,offset).filter(permitted),
  calls:()=>db.prepare('SELECT j.scope_id,c.* FROM pe_model_calls c JOIN pe_jobs j ON j.id=c.job_id ORDER BY c.prepared_at DESC,c.rowid DESC LIMIT ? OFFSET ?').all(limit,offset).filter(permitted),
  evaluations:()=>db.prepare('SELECT j.scope_id,e.* FROM pe_evaluations e JOIN pe_jobs j ON j.id=e.job_id ORDER BY e.created_at DESC,e.rowid DESC LIMIT ? OFFSET ?').all(limit,offset).filter(permitted),
  versions:()=>db.prepare('SELECT v.*,p.snapshot_hash,p.core_fingerprint,p.review_id FROM personality_versions v LEFT JOIN pe_publications p ON p.version_id=v.id ORDER BY v.id DESC LIMIT ? OFFSET ?').all(limit,offset),
  reviews:()=>db.prepare('SELECT * FROM pe_review_history ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?').all(limit,offset),
  feedback:()=>db.prepare('SELECT o.scope_id,f.* FROM pe_feedback f JOIN pe_observations o ON o.id=f.observation_id ORDER BY f.created_at DESC,f.rowid DESC LIMIT ? OFFSET ?').all(limit,offset).filter(permitted),
  evidence:()=>{
   if(typeof id!=='string'||id.length>150)fail('INVALID_OBSERVATION_ID');
   const row=db.prepare('SELECT * FROM pe_observations WHERE id=?').get(id);if(!row)fail('OBSERVATION_MISSING',404);
   services.writer.checkScope(row.scope_id);
   const result={id:row.id,scope_id:row.scope_id,features:JSON.parse(row.features_json),occurred_at:row.occurred_at,version:row.version_id,textAvailable:false};
   const blob=db.prepare('SELECT * FROM pe_text_payloads WHERE observation_id=? AND expires_at>?').get(id,now);
   if(blob&&includeText){
    const text=decodeText(blob);if(text){result.text={reply:redact(text.reply),context:redact(text.context)};result.textAvailable=true;result.expiresAt=blob.expires_at;}
   }
   result.references=db.prepare('SELECT preference_id,preference_revision,trait_id,trait_revision,polarity,segment,explanation FROM pe_evidence WHERE observation_id=? LIMIT 100').all(id);
   return result;
  }
 };
 if(!Object.hasOwn(queries,kind))fail('INVALID_QUERY');
 return {kind,limit,offset,data:queries[kind]()};
}
