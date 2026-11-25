// Offline importer. Deliberately has no dependency on config, OneBot, DSH or application boot.
import fs from 'node:fs';
import path from 'node:path';
import { digest, readTerms, writeTerms, SlangLearningStore, chatKey, termKey } from './slang-learning-store.js';
import { importRecentContext, importBridgeReceipts } from './return-context.js';

export function importBridgeBundle({ input, output, identityMap = {} }) {
  input = fs.realpathSync(input); output = path.resolve(output);
  let ancestor=output;
  while (!fs.existsSync(ancestor)) ancestor=path.dirname(ancestor);
  if (fs.realpathSync(ancestor)!==ancestor) throw Error('迁移输出路径不能经过符号链接');
  if (output === input || output.startsWith(input + path.sep)
      || output.replaceAll('\\','/').startsWith('/mnt/data/qq-agent/data')) throw Error('仅允许独立迁移输出目录');
  const manifest = JSON.parse(fs.readFileSync(path.join(input,'manifest.json'),'utf8'));
  if (manifest.verified !== true || !manifest.snapshot || !Array.isArray(manifest.files)) throw Error('输入必须来自验证通过的快照');
  const bytes = (name) => {
    const record = manifest.files.find(f => f.name === name);
    const bytes = fs.readFileSync(path.join(input,name));
    if (!record || digest(bytes) !== record.sha256) throw Error('输入哈希不匹配');
    return bytes;
  };
  const read = (name) => JSON.parse(bytes(name));
  const slang = read('slang.json'), social = read('social-v2.json');
  if (!Array.isArray(slang) || !social?.conversations) throw Error('未知源格式');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  for (const name of ['slang.json','slang-learning.sqlite','messages.sqlite','bridge-receipts.sqlite','memory','memory/people']) {
    const target=path.join(output,name);
    if (fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink()) throw Error('迁移目标不能是符号链接');
  }
  const lock = path.join(output,'.return-import.lock');
  const fd = fs.openSync(lock,'wx',0o600);
  const store = new SlangLearningStore(output);
  const report = { snapshot:manifest.snapshot, sourceSlang:slang.length, sourceStatuses:{}, sources:0,
    importedCandidates:0, importedConfirmed:0, repeated:0, conflicts:[], unresolvedMemories:[], memoriesAdded:0,
    temporaryState:[], role:'separate reviewed native role card', dsh:'archived and inventoried; historical tools never executed' };
  try {
    const terms=readTerms(output);
    const db=store.open();
    for (const raw of slang) {
      if (!raw.id || !raw.content || !['candidate','confirmed','rejected'].includes(raw.status)) throw Error('无效源黑话词条');
      report.sourceStatuses[raw.status]=(report.sourceStatuses[raw.status]||0)+1;
      report.sources+=(raw.sources||[]).length;
      const hash=digest(raw);
      const prior=db.prepare('SELECT 1 FROM imports WHERE source=? AND source_id=? AND hash=?').get(manifest.snapshot,raw.id,hash);
      if (prior) { report.repeated++; continue; }
      const previous=db.prepare('SELECT hash FROM imports WHERE source_id=? AND hash<>?').all(raw.id,hash);
      if (previous.length) { report.conflicts.push({ kind:'source_revision',id:raw.id }); continue; }
      const scopes=[...new Set((raw.evidence||[]).map(e=>e.key).filter(k=>/^(group|private):[1-9]\d{0,14}$/.test(k)))];
      // Lack of scope is explicit quarantine, never a promotion to global-safe.
      const scope=scopes.length===1?scopes[0]:'';
      if (raw.status==='confirmed') {
        const existing=terms.find(e=>e.id===raw.id || (termKey(e.content)===termKey(raw.content) && e.scopeChatKey===scope));
        if (existing && digest(existing.migrationRaw || existing)!==hash) {
          report.conflicts.push({ kind:'formal_entry',id:raw.id });continue;
        }
        if (!existing) terms.push({ ...raw, scope:'chat-private',scopeChatKey:scope,
          confidence:raw.confidence??null,migrationRaw:raw, migrationSource:manifest.snapshot,
          migrationScopeReview:scopes.length!==1 });
        report.importedConfirmed++;
      } else {
        const existing=db.prepare('SELECT id FROM discoveries WHERE chat=? AND term_key=?').get(scope,termKey(raw.content));
        if (existing && existing.id!==raw.id) { report.conflicts.push({kind:'candidate_entry',id:raw.id});continue; }
        db.prepare('INSERT OR IGNORE INTO discoveries VALUES (?,?,?,?,?,?,?)').run(raw.id,scope,termKey(raw.content),
          raw.status==='rejected'?'rejected':'candidate',JSON.stringify(raw),'{}',Date.parse(raw.updatedAt)||0);
        for (const ev of raw.evidence||[]) db.prepare('INSERT OR IGNORE INTO observations VALUES (?,?,?)').run(raw.id,digest(ev),JSON.stringify(ev));
        store.audit(raw.id,'import','offline',{snapshot:manifest.snapshot,hash,scopeReview:scopes.length!==1});
        report.importedCandidates++;
      }
      // Commit formal JSON before recording the import receipt, so crash recovery cannot skip data.
      if (raw.status==='confirmed') writeTerms(output,terms);
      db.prepare('INSERT INTO imports VALUES (?,?,?,?)').run(manifest.snapshot,raw.id,hash,JSON.stringify(raw));
    }
    for (const [chat, state] of Object.entries(social.conversations)) {
      chatKey(chat);
      report.temporaryState.push({ chat, activeTopics:state.activeTopics||[], pendingThoughts:state.pendingThoughts||[],
        recentMessages:(state.recentMessages||[]).length, policy:'preserve raw; do not replay unread/actions/tokens or revive expired state' });
      for (const [name, impression] of Object.entries(state.memberImpressions||{})) {
        const mapped=identityMap[chat]?.[name];
        const uid=String(impression.userId||mapped?.userId||'');
        if (!/^[1-9]\d{0,14}$/.test(uid) || (!impression.userId && !mapped?.evidence)) {
          report.unresolvedMemories.push({ chat,name,raw:impression,reason:'missing reliable person ID; explicit identity mapping with evidence required' });continue;
        }
        const at=Number(impression.lastSeenAt);
        if (!Number.isFinite(at)||at<=0||!Array.isArray(impression.traits)) throw Error('人物时间或印象格式无效');
        const sourceId=`memory:${chat}:${name}`;
        const memoryHash=digest({userId:uid,impression,identityEvidence:mapped?.evidence||'source.userId'});
        const prior=db.prepare('SELECT hash FROM imports WHERE source_id=?').all(sourceId);
        if (prior.some(r=>r.hash===memoryHash)) continue;
        if (prior.length) {report.conflicts.push({kind:'memory_source_revision',chat,name});continue;}
        const file=path.join(output,'memory','people',uid+'.json');
        if (fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink()) throw Error('人物文件不能是符号链接');
        let person;
        try {person=JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
        person ||= {version:2,userId:uid,name,impressions:[],sourceChatKeys:[],updatedAt:at,lastConsolidatedAt:0};
        if (String(person.userId)!==uid || !Array.isArray(person.impressions))throw Error('目标人物格式错误');
        for (const content of impression.traits) {
          if (typeof content!=='string'||!content.trim()||content.length>300)throw Error('印象无法无损映射到现有格式');
          if (person.impressions.some(e=>e.content===content))continue;
          if (person.impressions.length)report.conflicts.push({kind:'possible_memory_conflict',chat,userId:uid,sourceName:name,policy:'append with provenance; retain existing impressions'});
          person.impressions.push({content,createdAt:at,lastObservedAt:at,sourceChatKeys:[chat]});report.memoriesAdded++;
        }
        person.sourceChatKeys=[...new Set([...person.sourceChatKeys,chat])];person.updatedAt=Math.max(person.updatedAt,at);
        fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
        const tmp=file+`.return.${process.pid}.${Date.now()}.tmp`;fs.writeFileSync(tmp,JSON.stringify(person,null,1),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);
        store.audit(uid,'memory_import','offline',{chat,name,source:digest(impression),confidence:impression.confidence??null,identityEvidence:mapped?.evidence||'source.userId',snapshot:manifest.snapshot});
        db.prepare('INSERT INTO imports VALUES (?,?,?,?)').run(manifest.snapshot,sourceId,memoryHash,JSON.stringify({userId:uid,impression,identityEvidence:mapped?.evidence||'source.userId'}));
      }
    }
    if (db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('迁移库校验失败');
    report.resultCounts={formal:terms.length, discoveries:db.prepare('SELECT count(*) AS n FROM discoveries').get().n,
      imports:db.prepare('SELECT count(*) AS n FROM imports').get().n};
    report.recentContext=importRecentContext(path.join(output,'messages.sqlite'),social.conversations);
    if(manifest.files.some(f=>f.name==='receipts.sqlite')) {
      bytes('receipts.sqlite');
      report.receipts=importBridgeReceipts(path.join(input,'receipts.sqlite'),path.join(output,'bridge-receipts.sqlite'));
    }
    const out=path.join(output,'return-migration-report.json');
    fs.writeFileSync(out,JSON.stringify(report,null,2),{mode:0o600});
    return report;
  } finally { store.close();fs.closeSync(fd);fs.unlinkSync(lock); }
}
