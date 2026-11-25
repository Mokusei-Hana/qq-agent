// Independent privacy duty used by the compatibility rollback.
// It has no publisher, model adapter, legacy activator or generic command port.
import fs from 'node:fs';
import {parentPort,workerData} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
let running=false;
async function purge(){
 if(running)return;running=true;let db,purged=0;
 try{
  if(!fs.existsSync(workerData.file))throw Error('EXISTING_DATABASE_REQUIRED');
  db=new DatabaseSync(workerData.file);db.function('pe_guard',()=>0);
  db.exec('PRAGMA foreign_keys=ON;PRAGMA recursive_triggers=ON;PRAGMA busy_timeout=10;PRAGMA synchronous=FULL;');
  const statement=db.prepare('DELETE FROM pe_text_payloads WHERE observation_id IN (SELECT observation_id FROM pe_text_payloads WHERE expires_at<=? ORDER BY expires_at LIMIT 100)');
  let count;
  do{count=statement.run(Date.now()).changes;purged+=count;if(count===100)await new Promise(r=>setImmediate(r));}while(count===100);
  parentPort.postMessage({purged,error:null,at:Date.now()});
 }catch{parentPort.postMessage({purged,error:'TEXT_RETENTION_FAILED',at:Date.now()});}
 finally{db?.close();running=false;}
}
void purge();setInterval(()=>void purge(),3600000);
