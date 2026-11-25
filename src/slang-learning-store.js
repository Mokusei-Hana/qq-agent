import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const digest = (v) => crypto.createHash('sha256').update(typeof v === 'string' || v instanceof Uint8Array ? v : JSON.stringify(v)).digest('hex');
export const termKey = (v) => String(v ?? '').normalize('NFKC').trim().toLowerCase();
export const chatKey = (v) => {
  const key = String(v ?? '');
  if (!/^(group|private):[1-9]\d{0,14}$/.test(key)) throw Error('无效会话');
  return key;
};
export function readTerms(dataDir) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(dataDir, 'slang.json'), 'utf8'));
    if (!Array.isArray(v)) throw Error('黑话库必须是数组');
    return v;
  } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
export function writeTerms(dataDir, terms) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, 'slang.json');
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(terms, null, 2), { flag: 'wx', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Candidate/research state is separate from the existing, administrator-owned asset library.
export class SlangLearningStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'slang-learning.sqlite');
    this.db = null;
  }
  open() {
    if (this.db) return this.db;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    try {
    fs.chmodSync(this.file, 0o600);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (![0, 1].includes(version)) throw Error('未知黑话学习库版本');
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS discoveries (
        id TEXT PRIMARY KEY, chat TEXT NOT NULL, term_key TEXT NOT NULL,
        status TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL, UNIQUE(chat,term_key));
      CREATE TABLE IF NOT EXISTS observations (
        discovery_id TEXT NOT NULL, event_key TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY(discovery_id,event_key));
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY, discovery_id TEXT NOT NULL, action TEXT NOT NULL,
        actor TEXT NOT NULL, at INTEGER NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS imports (
        source TEXT NOT NULL, source_id TEXT NOT NULL, hash TEXT NOT NULL, raw TEXT NOT NULL,
        PRIMARY KEY(source,source_id,hash));
      CREATE TABLE IF NOT EXISTS learning_usage (
        day TEXT PRIMARY KEY, extractions INTEGER NOT NULL DEFAULT 0, researches INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS learning_worker_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    this.db = db;
    return db;
    } catch (error) { db.close(); throw error; }
  }
  close() { this.db?.close(); this.db = null; }
  usage(day) {
    return this.open().prepare('SELECT extractions,researches FROM learning_usage WHERE day=?').get(day) || {extractions:0,researches:0};
  }
  reserve(day,kind) {
    if(!['extractions','researches'].includes(kind))throw Error('无效后台任务类型');
    this.open().prepare(`INSERT INTO learning_usage(day,${kind}) VALUES (?,1)
      ON CONFLICT(day) DO UPDATE SET ${kind}=${kind}+1`).run(day);
  }
  workerState(key) {
    const row=this.open().prepare('SELECT value FROM learning_worker_state WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  setWorkerState(key,value) {
    this.open().prepare('INSERT INTO learning_worker_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));
  }
  counts() {
    if (!this.db && !fs.existsSync(this.file)) return {};
    return Object.fromEntries(this.open().prepare('SELECT status,count(*) AS n FROM discoveries GROUP BY status').all().map(r => [r.status,r.n]));
  }
  audit(id, action, actor, details = {}) {
    this.open().prepare('INSERT INTO audit(discovery_id,action,actor,at,details) VALUES (?,?,?,?,?)')
      .run(id, action, String(actor), Date.now(), JSON.stringify(details));
  }
  list({ chat = '', status = '', limit = 100 } = {}) {
    if (!this.db && !fs.existsSync(this.file)) return [];
    return this.open().prepare(`SELECT * FROM discoveries WHERE (?='' OR chat=?) AND (?='' OR status=?)
      ORDER BY updated_at DESC,id LIMIT ?`).all(chat, chat, status, status, Math.min(500, Math.max(1, Number(limit) || 100)))
      .map(r => ({ ...r, payload: JSON.parse(r.payload), result: JSON.parse(r.result) }));
  }
  get(id) {
    if (!this.db && !fs.existsSync(this.file)) return null;
    const r = this.open().prepare('SELECT * FROM discoveries WHERE id=?').get(String(id));
    return r ? { ...r, payload: JSON.parse(r.payload), result: JSON.parse(r.result) } : null;
  }
  observe(chat, term, evidence) {
    chatKey(chat);
    const content = String(term ?? '').trim();
    if (content.length < 2 || content.length > 30 || !String(evidence.text).includes(content)) throw Error('候选必须在来源消息中原样出现');
    const db = this.open();
    const id = db.prepare('SELECT id FROM discoveries WHERE chat=? AND term_key=?').get(chat, termKey(content))?.id
      || `sl_${digest([chat, termKey(content)]).slice(0, 24)}`;
    const count = db.prepare("SELECT count(*) AS n FROM discoveries WHERE status NOT IN ('approved','rejected','expired')").get().n;
    if (count >= 500 && !db.prepare('SELECT 1 FROM discoveries WHERE id=?').get(id)) return null;
    db.prepare("INSERT OR IGNORE INTO discoveries VALUES (?,?,?,'candidate',?,'{}',?)")
      .run(id, chat, termKey(content), JSON.stringify({ content, createdAt: Date.now(), confidence: null }), Date.now());
    const added = db.prepare('INSERT OR IGNORE INTO observations VALUES (?,?,?)')
      .run(id, String(evidence.key), JSON.stringify(evidence)).changes;
    if (added) this.audit(id, 'observe', 'extractor', { event: evidence.key });
    return this.get(id);
  }
  evidence(id) {
    return this.open().prepare('SELECT payload FROM observations WHERE discovery_id=? ORDER BY rowid DESC LIMIT 20')
      .all(id).map(r => JSON.parse(r.payload));
  }
  transition(id, from, to, actor, result = null) {
    const db = this.open();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.get(id);
      if (!row || !from.includes(row.status)) throw Error('状态已变化，请刷新');
      db.prepare('UPDATE discoveries SET status=?,result=?,updated_at=? WHERE id=?')
        .run(to, JSON.stringify(result ?? row.result), Date.now(), id);
      this.audit(id, to, actor);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return this.get(id);
  }
  recover() {
    for (const row of this.list({ status: 'researching', limit: 500 }))
      this.transition(row.id, ['researching'], 'interrupted', 'restart');
  }
  cleanup(before) {
    for (const row of this.list({ status: 'candidate', limit: 500 })) {
      if (row.updated_at < before) this.transition(row.id, ['candidate'], 'expired', 'cleanup');
    }
  }
}
