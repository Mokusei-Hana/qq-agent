import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

// Incoming receipts only: even a held receipt must never re-dispatch an unknown old operation.
export class BridgeReceiptGuard {
  constructor(file) { this.file=file;this.db=null; }
  has(account,chat,messageId) {
    if(!account||messageId==null||!fs.existsSync(this.file))return false;
    this.db ||= new DatabaseSync(this.file,{readOnly:true});
    return !!this.db.prepare('SELECT 1 FROM receipts WHERE account=? AND chat=? AND message_id=?')
      .get(String(account),String(chat),String(messageId));
  }
  close(){this.db?.close();this.db=null;}
}

export function importBridgeReceipts(input,output) {
  const source=new DatabaseSync(input,{readOnly:true});const target=new DatabaseSync(output);
  const report={added:0,repeated:0,held:0,conflicts:0};
  try {
    if(source.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('回执数据库损坏');
    target.exec(`CREATE TABLE IF NOT EXISTS receipts(account TEXT NOT NULL,chat TEXT NOT NULL,message_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('held','handled')),seen_at INTEGER NOT NULL,PRIMARY KEY(account,chat,message_id)); BEGIN IMMEDIATE;`);
    for(const row of source.prepare('SELECT * FROM receipts').iterate()){
      if(!/^\d+$/.test(row.account)||!/^(group|private):\d+$/.test(row.chat)||!row.message_id||!['held','handled'].includes(row.state))throw Error('回执格式无效');
      if(row.state==='held')report.held++;
      const prior=target.prepare('SELECT state FROM receipts WHERE account=? AND chat=? AND message_id=?').get(row.account,row.chat,row.message_id);
      if(prior){report.repeated++;if(prior.state!==row.state)report.conflicts++;continue;}
      target.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)').run(row.account,row.chat,row.message_id,row.state,row.seen_at);report.added++;
    }
    target.exec('COMMIT');fs.chmodSync(output,0o600);return report;
  }catch(e){try{target.exec('ROLLBACK');}catch{}throw e;}finally{source.close();target.close();}
}

// Reuse the native schema, preserving every existing row and queue state.
export function importRecentContext(file,conversations) {
  if(!fs.existsSync(file))return {added:0,repeated:0,unmapped:0,reason:'native message database not present; raw source retained'};
  const db=new DatabaseSync(file);const report={added:0,repeated:0,unmapped:0,nullMessageIds:0,unmappedRecords:[]};
  try{
    db.exec(`CREATE TABLE IF NOT EXISTS return_context_imports (
      fingerprint TEXT PRIMARY KEY, chat_key TEXT NOT NULL, local_id INTEGER NOT NULL, source_json TEXT NOT NULL);`);
    db.exec('BEGIN IMMEDIATE');
    for(const [chat,state]of Object.entries(conversations)){
      if(!/^(group|private):[1-9]\d{0,14}$/.test(chat))throw Error('无效上下文会话');
      for(const [index,m] of (state.recentMessages||[]).entries()){
        const source=JSON.stringify(m);
        const fingerprint=createHash('sha256').update(JSON.stringify([chat,m])).digest('hex');
        const sender=/^[1-9]\d*$/.test(String(m.userId)) ? String(m.userId) : m.isSelf===true ? 'self' : '';
        if(!sender||!Number.isFinite(m.time)||m.time<1e11){report.unmapped++;report.unmappedRecords.push({chat,index,sourceHash:fingerprint,reason:'missing reliable identity or timestamp'});continue;}
        if(db.prepare('SELECT 1 FROM return_context_imports WHERE fingerprint=?').get(fingerprint)){report.repeated++;continue;}
        const mid=m.messageId==null||String(m.messageId)==='' ? null : String(m.messageId);
        const existing=mid==null ? null : db.prepare('SELECT id FROM messages WHERE chat_key=? AND mid=?').get(chat,mid);
        if(existing){
          db.prepare('INSERT INTO return_context_imports VALUES (?,?,?,?)').run(fingerprint,chat,existing.id,source);
          report.repeated++;continue;
        }
        db.prepare('INSERT OR IGNORE INTO chats(chat_key,next_id) VALUES (?,1)').run(chat);
        const next=db.prepare('SELECT next_id FROM chats WHERE chat_key=?').get(chat).next_id;
        const max=db.prepare('SELECT coalesce(max(id),0)+1 AS n FROM messages WHERE chat_key=?').get(chat).n;
        const id=Math.max(next,max);
        db.prepare(`INSERT INTO messages(chat_key,id,mid,ts,sender_id,sender_name,text,self,media,state,event_kind)
          VALUES (?,?,?,?,?,?,?,?,?,'acked','message')`).run(chat,id,mid,m.time,sender,String(m.sender||''),String(m.plain||m.text||''),m.isSelf===true?1:0,'[]');
        db.prepare('INSERT INTO return_context_imports VALUES (?,?,?,?)').run(fingerprint,chat,id,source);
        if(mid==null)report.nullMessageIds++;
        db.prepare('UPDATE chats SET next_id=? WHERE chat_key=?').run(id+1,chat);report.added++;
      }
    }
    db.exec('COMMIT');return report;
  }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
}
