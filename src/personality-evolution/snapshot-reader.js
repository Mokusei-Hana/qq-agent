import { DatabaseSync } from 'node:sqlite';
import { canonical, digest, frozen, fail } from './integrity.js';
import { safeText } from './privacy.js';
export class SnapshotReader {
 #file; #scopeAllowed; #snapshot = null;
 constructor(file, { allowed = () => false } = {}) { this.#file = file; this.#scopeAllowed = allowed; this.error = ''; }
 refresh() {
  let db;
  try {
   db = new DatabaseSync(this.#file, { readOnly: true }); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=10; BEGIN;');
   const raw = db.prepare("SELECT value FROM personality_state WHERE key='version'").get()?.value;
   if (!/^(0|[1-9]\d*)$/.test(raw || '')) fail('INVALID_PUBLISHED_POINTER');
   const version = Number(raw), row = db.prepare('SELECT * FROM personality_versions WHERE id=?').get(version);
   if (!row) fail('MISSING_PUBLISHED_VERSION');
   let entries = JSON.parse(row.content), hash = digest(row.content);
   if (!Array.isArray(entries)) fail('INVALID_SNAPSHOT');
   if (version === 0) {
    if (row.content !== '[]' || row.created_by !== 'initial') fail('INVALID_INITIAL_VERSION');
   } else {
    const pub = db.prepare('SELECT p.*,r.principal,r.action,r.result_version,r.final_snapshot_hash FROM pe_publications p JOIN pe_review_history r ON r.id=p.review_id WHERE p.version_id=?').get(version);
    if (!pub || pub.action !== 'publish' || pub.result_version !== version || pub.snapshot_hash !== hash || pub.final_snapshot_hash !== hash || row.created_by !== pub.principal || pub.format_version !== 2 || row.previous_version !== pub.previous_version) fail('UNVERIFIED_PUBLICATION');
    for (const entry of entries) {
     if (!entry.id || !Number.isInteger(entry.revision) || !entry.scope?.id || !['group','object','global'].includes(entry.scope.kind) ||
       !Array.isArray(entry.scenes) || !entry.scenes.every(x => ['*','chat','question','complaint','sharing','debate','distress'].includes(x))) fail('INVALID_SNAPSHOT_ENTRY');
     safeText(entry.rule); safeText(entry.name, 100);
    }
   }
   db.exec('COMMIT');
   this.#snapshot = frozen({ version, hash, entries: structuredClone(entries) }); this.error = ''; return this.snapshot();
  } catch (e) { this.#snapshot = null; this.error = e.code || 'SNAPSHOT_UNAVAILABLE'; throw e; }
  finally { db?.close(); }
 }
 snapshot() { return this.#snapshot ? structuredClone(this.#snapshot) : null; }
 render({ scopeId, subjectId = null, scene = 'chat', maxBytes = 240, now = Date.now() } = {}) {
  if (!this.#snapshot || !this.#scopeAllowed(scopeId) || !Number.isInteger(maxBytes) || maxBytes < 0) return '';
  return renderSnapshot(this.#snapshot, {scopeId,subjectId,scene,maxBytes,now}).text;
 }

 fingerprint(context) { return this.#snapshot ? digest(canonical({ hash: this.#snapshot.hash, context })) : ''; }
}

// Pure in-memory runtime path; main chat thread performs no SQLite work.
export function renderSnapshot(snapshot,{scopeId,subjectId=null,scene='chat',maxBytes=240,now=Date.now()}={}) {
 if(!snapshot||!scopeId||!Number.isInteger(maxBytes)||maxBytes<0)return {text:'',injected:[]};
 const rank={object:3,group:2,global:1};
 const rows=snapshot.entries.filter(e=>
  (e.scope.kind==='group'&&e.scope.id===scopeId||e.scope.kind==='object'&&e.scope.id===subjectId&&e.scope.parent_id===scopeId||e.scope.kind==='global')&&
  (e.scenes.includes('*')||e.scenes.includes(scene))&&(e.validUntil==null||e.validUntil>now))
  .sort((a,b)=>rank[b.scope.kind]-rank[a.scope.kind]||a.id.localeCompare(b.id));
 const dimensions=new Set(),injected=[];
 let text='【动态表达偏好】核心人格、安全权限和当前要求优先。\n';const header=text;
 for(const row of rows){
  if(dimensions.has(row.dimension))continue;
  dimensions.add(row.dimension);
  const line='- '+row.rule+'\n';
  if(Buffer.byteLength(text+line)<=maxBytes){text+=line;injected.push({id:row.id,revision:row.revision,contentHash:row.contentHash});}
 }
 return {text:text===header?'':text,injected};
}
