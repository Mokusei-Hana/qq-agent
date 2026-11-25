import crypto from 'node:crypto';
import { canonical } from './integrity.js';
export function evaluateWindows(db,job,now) {
 const target=job.target_version;
 const version=db.prepare('SELECT previous_version FROM personality_versions WHERE id=?').get(target);
 const baseline=version?.previous_version??null;
 const rows=db.prepare('SELECT version_id,occurred_at,features_json FROM pe_observations WHERE scope_id=? AND occurred_at>=?').all(job.scope_id,job.window_start);
 const measure=items=>{
  const data=items.map(r=>JSON.parse(r.features_json));
  const lengths=data.map(r=>r.length).filter(Number.isFinite);
  return {interactions:items.length,meanLength:lengths.length?lengths.reduce((a,b)=>a+b,0)/lengths.length:null,
   silenceRate:data.length?data.filter(r=>r.responseType==='silence').length/data.length:null,
   jokingRate:data.length?data.filter(r=>r.joking).length/data.length:null};
 };
 const before=measure(rows.filter(r=>r.version_id===baseline)),after=measure(rows.filter(r=>r.version_id===target));
 const enough=baseline!==null&&before.interactions>=30&&after.interactions>=30;
 const metrics={before,after,modelSelfEvaluation:false,causalEffectProven:false};
 db.prepare('INSERT INTO pe_evaluations(id,job_id,baseline_version,target_version,result,metrics_json,limitations_json,redaction_version,created_at) VALUES(?,?,?,?,?,?,?,\'v2\',?)')
  .run(crypto.randomUUID(),job.id,baseline,target,enough?'inconclusive':'insufficient_data',canonical(metrics),canonical(['Observational comparison only; model, scene and concurrent preference changes may confound results']),now);
 return {enough,metrics};
}
