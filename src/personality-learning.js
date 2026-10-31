import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const DAY = 86400000;
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
const SCENES = ['question', 'complaint', 'sharing', 'debate', 'distress', 'chat'];
const RULES = Object.freeze({
  filler: '没有具体观点时省略空洞承接语，直接回应消息重点；不要换成另一个口头禅。',
  repetition: '减少连续重复的开场和句式，按内容组织回复；不要随机替换同义词。',
  empathy: '对低落和正式求助先认真回应具体困难，不强行玩梗或夸张情绪。',
  pacing: '根据当前意图选择直接回答、追问、认真回应或保持安静，不必每条消息都接话。'
});
const knownRule = key => Object.hasOwn(RULES, key);
const DEFAULTS = Object.freeze({ enabled: false, graduated: false, groups: [], mode: 'observe',
  injectEnabled: false, autoApply: false, retentionDays: 30, minEvidence: 20,
  minConfidence: 0.85, minWindowDays: 7, minSources: 3, maxTokens: 240,
  batchLimit: 1000, maxObservations: 10000, expiryDays: 60 });

export function personalitySettings(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('人格设置必须是对象');
  for (const key of Object.keys(raw)) if (!Object.hasOwn(DEFAULTS, key)) throw Error('未知人格设置');
  const cfg = { ...DEFAULTS, ...raw };
  for (const key of ['enabled', 'graduated', 'injectEnabled', 'autoApply']) {
    if (typeof cfg[key] !== 'boolean') throw Error('人格开关必须为布尔值');
  }
  if (!['observe', 'dynamic'].includes(cfg.mode)) throw Error('未知人格模式');
  if (!Array.isArray(cfg.groups) || cfg.groups.length > 100 || cfg.groups.some(g => !/^[1-9]\d{0,14}$/.test(String(g)))) throw Error('授权群无效');
  cfg.groups = [...new Set(cfg.groups.map(String))];
  const ranges = { retentionDays: [7, 90], minEvidence: [10, 1000], minConfidence: [0.8, 1],
    minWindowDays: [3, 30], minSources: [2, 30], maxTokens: [80, 400], batchLimit: [50, 2000],
    maxObservations: [1000, 20000], expiryDays: [7, 180] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (typeof cfg[key] !== 'number' || !Number.isFinite(cfg[key]) || cfg[key] < min || cfg[key] > max
      || (key !== 'minConfidence' && !Number.isInteger(cfg[key]))) throw Error('人格阈值无效：' + key);
  }
  if (cfg.minWindowDays >= cfg.retentionDays) throw Error('观察保留期须长于最小学习窗口');
  if (cfg.enabled && !cfg.groups.length) throw Error('启用前须指定授权群');
  if (cfg.mode === 'observe' && (cfg.injectEnabled || cfg.autoApply)) throw Error('观察模式禁止注入或自动应用');
  if (cfg.autoApply && !cfg.injectEnabled) throw Error('自动应用需要明确启用动态偏好注入');
  return cfg;
}

export function expressionScene(text = '') {
  const s = String(text).slice(0, 1000);
  if (/难过|低落|撑不住|崩溃|伤心|抑郁|绝望/.test(s)) return 'distress';
  if (/不赞同|不同意|反对|你错了|凭什么/.test(s)) return 'debate';
  if (/怎么|如何|为什么|请问|求助|[?？]/.test(s)) return 'question';
  if (/吐槽|烦死|无语|离谱|太难了/.test(s)) return 'complaint';
  if (/分享|推荐|发现|今天|给你们看/.test(s)) return 'sharing';
  return 'chat';
}

// Only fixed labels, hashes and numeric features cross the observation boundary.
// Neither user text nor a model-generated instruction can become a preference.
export function expressionFeatures(text, context = '') {
  const s = String(text || '').slice(0, 2000).trim();
  const filler = /^(这个我认|确实|不得不说|说实话|有一说一|我只能说)(?:[，,。！!\s]|$)/.exec(s)?.[1] || '';
  const normalized = s.replace(/\d+/g, '#').replace(/[\p{P}\p{Z}\s]/gu, '');
  const grams = [];
  for (let i = 0; i + 4 <= Math.min(normalized.length, 80); i += 2) grams.push(hash(normalized.slice(i, i + 4)));
  return { filler, opening: hash(normalized.slice(0, 8)), template: hash(s.replace(/[\p{L}\p{N}]+/gu, 'x').slice(0, 80)),
    grams: [...new Set(grams)].slice(0, 32), length: s.length, scene: expressionScene(context),
    responseType: !s ? 'silence' : /[?？]$/.test(s) ? 'follow_up' : /不同意|不赞同/.test(s) ? 'disagreement'
      : /难过|辛苦|陪你|理解/.test(s) ? 'empathy' : /哈哈|笑死/.test(s) ? 'joke' : 'direct_answer',
    joking: /哈哈|笑死|笑麻/.test(s), emptyFiller: !!filler && normalized.length <= filler.length + 2 };
}

export class PersonalityLearning {
  constructor({ dataDir, allowed = () => false, now = Date.now }) {
    this.dataDir = dataDir; this.allowed = allowed; this.now = now;
    this.file = path.join(dataDir, 'personality-learning.sqlite');
    this.settingsFile = path.join(dataDir, 'personality-learning.json');
    this.cfg = personalitySettings(); this.db = null; this.active = false;
    this.queue = []; this.pending = null; this.cache = []; this.error = '';
  }
  permitted(chat) {
    return /^group:[1-9]\d{0,14}$/.test(chat) && this.cfg.groups.includes(chat.slice(6)) && this.allowed(chat);
  }
  start() {
    this.stop();
    try {
      let raw = {};
      try { raw = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      this.cfg = personalitySettings(raw);
      if (this.cfg.enabled) { this.open(); this.active = true; this.reload(); }
      this.error = '';
    } catch { this.stop(); this.error = '人格设置或数据库不可用；未重置原数据，聊天继续'; }
  }
  stop() {
    this.active = false;
    if (this.pending) clearImmediate(this.pending);
    this.pending = null; this.queue = []; this.cache = [];
    this.db?.close(); this.db = null;
  }
  open() {
    if (this.db) return this.db;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    try {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (![0, 1].includes(version)) throw Error('未知人格数据库版本');
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=50;
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS personality_observations (
          id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, response_id TEXT NOT NULL, source_key TEXT NOT NULL,
          category TEXT NOT NULL, pattern_key TEXT NOT NULL, feature_data TEXT NOT NULL, created_at INTEGER NOT NULL,
          UNIQUE(group_id,response_id));
        CREATE INDEX IF NOT EXISTS personality_obs_group_time ON personality_observations(group_id,created_at);
        CREATE TABLE IF NOT EXISTS personality_habits (
          id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_id TEXT NOT NULL, category TEXT NOT NULL,
          habit_key TEXT NOT NULL, usage_context TEXT NOT NULL, confidence REAL NOT NULL, evidence_count INTEGER NOT NULL,
          source_count INTEGER NOT NULL, status TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(scope_type,scope_id,habit_key,usage_context));
        CREATE INDEX IF NOT EXISTS personality_habit_status ON personality_habits(status,scope_type,scope_id);
        CREATE TABLE IF NOT EXISTS personality_feedback (
          id INTEGER PRIMARY KEY, group_id TEXT NOT NULL, response_id TEXT NOT NULL, feedback_type TEXT NOT NULL,
          score INTEGER NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS personality_versions (
          id INTEGER PRIMARY KEY, content TEXT NOT NULL, change_summary TEXT NOT NULL, source_habit_ids TEXT NOT NULL,
          created_at INTEGER NOT NULL, created_by TEXT NOT NULL, previous_version INTEGER);
        CREATE TABLE IF NOT EXISTS personality_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
        INSERT OR IGNORE INTO personality_versions VALUES (0,'[]','初始动态层','[]',0,'initial',NULL);
        INSERT OR IGNORE INTO personality_state VALUES ('version','0');
        PRAGMA user_version=1; COMMIT;`);
      fs.chmodSync(this.file, 0o600); this.db = db; return db;
    } catch (e) { db.close(); throw e; }
  }
  read(fn, fallback) {
    if (this.db) return fn(this.db);
    if (!fs.existsSync(this.file)) return fallback;
    const db = new DatabaseSync(this.file, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  }
  configure(patch, confirm = false) {
    if (this.error && !this.active) throw Error('原人格设置不可用，须先检查文件；禁止覆盖');
    const next = personalitySettings({ ...this.cfg, ...patch });
    if ((!this.cfg.graduated && next.graduated || next.mode !== this.cfg.mode || next.autoApply !== this.cfg.autoApply) && !confirm) throw Error('此变更需要确认');
    if (next.groups.some(g => !this.allowed('group:' + g))) throw Error('授权群超出机器人访问权限');
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    // Fail before persisting an enabled setting if the existing database is invalid.
    if (next.enabled) this.open();
    const tmp = this.settingsFile + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, this.settingsFile);
    this.start();
    if (this.error) throw Error(this.error);
    return this.status();
  }
  observe({ chatKey, text, messageId, sourceId = '', context = '', sticker = false, silence = false }) {
    if (!this.active || !this.cfg.enabled || !this.permitted(chatKey) || sticker || messageId == null || (!silence && !String(text || '').trim())) return;
    if (this.queue.length >= 200) { this.error = '观察队列已满，已丢弃新观察；聊天继续'; return; }
    const features = expressionFeatures(text, context);
    this.queue.push({ group: chatKey.slice(6), id: String(messageId), source: sourceId ? hash(chatKey + ':' + sourceId) : '', features, at: this.now() });
    if (!this.pending) this.pending = setImmediate(() => {
      this.pending = null;
      try { this.flush(); } catch { this.error = '人格观察存储失败；聊天继续，未重试外部发送'; this.queue = []; }
    });
  }
  flush() {
    if (!this.active) return;
    const batch = this.queue.splice(0, 200), db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const put = db.prepare('INSERT OR IGNORE INTO personality_observations(group_id,response_id,source_key,category,pattern_key,feature_data,created_at) VALUES (?,?,?,?,?,?,?)');
      for (const row of batch) if (this.permitted('group:' + row.group)) put.run(row.group, row.id, row.source, row.features.responseType, row.features.opening, JSON.stringify(row.features), row.at);
      db.prepare('DELETE FROM personality_observations WHERE id IN (SELECT id FROM personality_observations ORDER BY id DESC LIMIT -1 OFFSET ?)').run(this.cfg.maxObservations);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  state(key) { return JSON.parse(this.db.prepare('SELECT value FROM personality_state WHERE key=?').get(key)?.value || '0'); }
  setState(key, value) { this.db.prepare('INSERT INTO personality_state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  reload() { this.cache = this.db.prepare("SELECT * FROM personality_habits WHERE status='active'").all(); this.version = this.state('version'); }
  maintenance() {
    if (!this.active) return;
    try {
      const now = this.now();
      if (now - this.state('lastStats') >= 1800000) { this.analyze(); this.setState('lastStats', now); }
      if (now - this.state('lastCleanup') >= DAY) { this.cleanup(); this.setState('lastCleanup', now); }
      if (this.cfg.mode === 'dynamic' && this.cfg.autoApply && now - this.state('lastOptimize') >= 7 * DAY) {
        for (const row of this.db.prepare("SELECT * FROM personality_habits WHERE status='candidate' ORDER BY id LIMIT 20").all()) {
          if (this.eligible(row)) this.change(row.id, 'active', this.state('version'), 'automatic');
        }
        this.setState('lastOptimize', now);
      }
    } catch { this.error = '人格后台任务失败；保留数据，聊天继续'; }
  }
  analyze() {
    if (!this.active) throw Error('人格学习未启用');
    this.flush();
    const rows = this.db.prepare('SELECT * FROM personality_observations WHERE created_at>=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(this.now() - this.cfg.retentionDays * DAY, this.cfg.batchLimit).reverse();
    const groups = new Map();
    for (const row of rows) {
      if (!this.permitted('group:' + row.group_id)) continue;
      row.features = JSON.parse(row.feature_data);
      const list = groups.get(row.group_id) || []; list.push(row); groups.set(row.group_id, list);
    }
    for (const [group, list] of groups) {
      const repeated = new Set();
      const counts = new Map();
      for (const row of list) {
        if (row.category === 'silence') continue;
        for (const key of ['opening:' + row.features.opening, 'template:' + row.features.template, ...row.features.grams.map(g => 'gram:' + g)]) counts.set(key, (counts.get(key) || 0) + 1);
      }
      for (const row of list) if (row.category !== 'silence' && ((counts.get('opening:' + row.features.opening) || 0) >= 3
        || row.features.grams.some(g => (counts.get('gram:' + g) || 0) >= 5))) repeated.add(row.id);
      const categories = {
        filler: list.filter(r => r.features.filler), repetition: list.filter(r => repeated.has(r.id)),
        empathy: list.filter(r => r.features.scene === 'distress' && r.features.joking),
        pacing: list.filter(r => r.features.emptyFiller)
      };
      for (const [key, evidence] of Object.entries(categories)) {
        if (evidence.length < 3 || evidence.length / list.length < 0.2) continue;
        const scene = key === 'empathy' ? 'distress' : '*';
        const id = 'ph_' + hash([group, key, scene].join(':'));
        const times = evidence.map(r => r.created_at), sources = new Set(evidence.map(r => r.source_key).filter(Boolean));
        this.db.prepare(`INSERT INTO personality_habits VALUES (?, 'group', ?, 'self_correction', ?, ?, ?, ?, ?, 'candidate', ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET confidence=excluded.confidence,evidence_count=excluded.evidence_count,
          source_count=excluded.source_count,first_seen_at=excluded.first_seen_at,last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`)
          .run(id, group, key, scene, evidence.length / (evidence.length + 3), evidence.length, sources.size, Math.min(...times), Math.max(...times), this.now());
      }
    }
    return this.snapshot();
  }
  eligible(row) {
    return row.scope_type === 'group' && this.permitted('group:' + row.scope_id)
      && knownRule(row.habit_key) && row.evidence_count >= this.cfg.minEvidence
      && row.confidence >= this.cfg.minConfidence && row.source_count >= this.cfg.minSources
      && row.last_seen_at - row.first_seen_at >= this.cfg.minWindowDays * DAY
      && row.last_seen_at >= this.now() - this.cfg.retentionDays * DAY;
  }
  transaction(expected, actor, summary, fn) {
    if (!this.active) throw Error('请先启用人格学习');
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.state('version');
      if (!Number.isInteger(expected) || previous !== expected) throw Error('版本已变化，请刷新');
      fn();
      const content = db.prepare("SELECT * FROM personality_habits WHERE status='active' ORDER BY id").all();
      const version = Number(db.prepare('INSERT INTO personality_versions(content,change_summary,source_habit_ids,created_at,created_by,previous_version) VALUES (?,?,?,?,?,?)')
        .run(JSON.stringify(content), summary, JSON.stringify(content.map(r => r.id)), this.now(), String(actor), previous).lastInsertRowid);
      this.setState('version', version); db.exec('COMMIT'); this.reload(); return version;
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  change(id, status, expected, actor = 'administrator') {
    if (!['active', 'disabled'].includes(status)) throw Error('不支持的习惯状态');
    return this.transaction(expected, actor, status === 'active' ? '激活已验证的表达偏好' : '禁用表达偏好', () => {
      const row = this.db.prepare('SELECT * FROM personality_habits WHERE id=?').get(String(id));
      if (!row || (row.scope_type !== 'global' && !this.permitted('group:' + row.scope_id))) throw Error('习惯不存在或未授权');
      if (status === 'active' && (!this.eligible(row) || row.status === 'active')) throw Error('证据、来源或观察窗口不足');
      this.db.prepare('UPDATE personality_habits SET status=?,updated_at=? WHERE id=?').run(status, this.now(), id);
    });
  }
  promoteGlobal(id, expected) {
    return this.transaction(expected, 'administrator', '人工批准跨群通用表达偏好', () => {
      const row = this.db.prepare('SELECT * FROM personality_habits WHERE id=?').get(String(id));
      if (!row || !this.eligible(row) || row.status !== 'active') throw Error('只能推广已验证的生效习惯');
      this.db.prepare(`INSERT INTO personality_habits VALUES (?, 'global', '', 'self_correction', ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(scope_type,scope_id,habit_key,usage_context) DO UPDATE SET status='active',updated_at=excluded.updated_at`)
        .run('pg_' + hash(row.habit_key + ':' + row.usage_context), row.habit_key, row.usage_context, row.confidence, row.evidence_count, row.source_count, row.first_seen_at, row.last_seen_at, this.now());
    });
  }
  rollback(version, expected) {
    return this.transaction(expected, 'administrator', '回滚动态层到版本 ' + version, () => {
      const row = this.db.prepare('SELECT content FROM personality_versions WHERE id=?').get(Number(version));
      if (!row) throw Error('版本不存在');
      const target = JSON.parse(row.content);
      this.db.prepare("UPDATE personality_habits SET status='disabled' WHERE status='active'").run();
      for (const item of target) {
        if (!knownRule(item.habit_key)) throw Error('版本包含未知偏好');
        this.db.prepare("UPDATE personality_habits SET status='active',updated_at=? WHERE id=?").run(this.now(), item.id);
      }
    });
  }
  feedback(body) {
    if (!this.active || !this.permitted('group:' + body.groupId)) throw Error('该群未授权学习');
    if (!['relevance', 'naturalness', 'repetition', 'filler', 'emotion', 'agreement', 'interruption', 'persona', 'weak_reply', 'weak_like'].includes(body.type)
      || ![-1, 0, 1].includes(body.score) || typeof body.responseId !== 'string' || body.responseId.length > 100) throw Error('反馈参数无效');
    const observation = this.db.prepare('SELECT 1 FROM personality_observations WHERE group_id=? AND response_id=?').get(body.groupId, body.responseId);
    if (!observation) throw Error('找不到该回复观察');
    this.db.prepare('INSERT INTO personality_feedback(group_id,response_id,feedback_type,score,source,created_at) VALUES (?,?,?,?,?,?)')
      .run(body.groupId, body.responseId, body.type, body.score, body.type.startsWith('weak_') ? 'weak' : 'administrator', this.now());
    this.db.prepare('DELETE FROM personality_feedback WHERE id IN (SELECT id FROM personality_feedback ORDER BY id DESC LIMIT -1 OFFSET ?)').run(this.cfg.maxObservations);
    return { ok: true };
  }
  cleanup() {
    if (!this.active) throw Error('人格学习未启用');
    const cutoff = this.now() - this.cfg.retentionDays * DAY;
    this.db.prepare('DELETE FROM personality_observations WHERE created_at<?').run(cutoff);
    this.db.prepare('DELETE FROM personality_feedback WHERE created_at<?').run(cutoff);
    const expired = this.db.prepare("SELECT id FROM personality_habits WHERE status IN ('candidate','active') AND last_seen_at<?").all(this.now() - this.cfg.expiryDays * DAY);
    if (expired.length) this.transaction(this.state('version'), 'expiry', '过期长期未观察到的表达偏好', () => {
      for (const row of expired) this.db.prepare("UPDATE personality_habits SET status='expired',updated_at=? WHERE id=?").run(this.now(), row.id);
    });
    this.reload();
  }
  preferences(chat, context = '') {
    if (!this.active || !this.cfg.enabled || this.cfg.mode !== 'dynamic' || !this.cfg.injectEnabled || !this.permitted(chat)) return '';
    const scene = expressionScene(context);
    const rows = this.cache.filter(r => knownRule(r.habit_key) && (r.scope_type === 'global' || r.scope_id === chat.slice(6))
      && (r.usage_context === '*' || r.usage_context === scene) && r.last_seen_at >= this.now() - this.cfg.expiryDays * DAY);
    if (!rows.length) return '';
    const header = '【动态表达偏好】可选策略；核心人格、安全权限、当前要求和上下文优先。\n';
    // UTF-8 bytes are a conservative token upper bound, including Chinese.
    let result = header;
    for (const rule of [...new Set(rows.map(r => RULES[r.habit_key]))].slice(0, 4)) {
      const line = '- ' + rule + '\n';
      if (Buffer.byteLength(result + line) <= this.cfg.maxTokens) result += line;
    }
    return result === header ? '' : result;
  }
  fingerprint(chat, context = '') {
    if (!this.active || this.cfg.mode !== 'dynamic' || !this.cfg.injectEnabled || !this.permitted(chat)) return '';
    return '\0personality:' + this.version + ':' + expressionScene(context) + ':' + this.cfg.maxTokens;
  }
  status() {
    return { ...this.cfg, active: this.active, databaseExists: fs.existsSync(this.file), error: this.error,
      queued: this.queue.length, version: this.read(db => JSON.parse(db.prepare("SELECT value FROM personality_state WHERE key='version'").get()?.value || '0'), 0),
      modelCalls: 0, evaluation: '本地统计；语义相关性、事实正确性与核心人格符合度需人工评价' };
  }
  snapshot() {
    return this.read(db => ({
      habits: db.prepare('SELECT * FROM personality_habits ORDER BY updated_at DESC,id LIMIT 500').all().map(r => ({ ...r, description: knownRule(r.habit_key) ? RULES[r.habit_key] : '未知偏好（不注入）' })),
      versions: db.prepare('SELECT * FROM personality_versions ORDER BY id DESC LIMIT 100').all().map(r => ({ ...r, content: JSON.parse(r.content), source_habit_ids: JSON.parse(r.source_habit_ids) })),
      feedback: db.prepare('SELECT * FROM personality_feedback ORDER BY id DESC LIMIT 100').all(),
      observations: db.prepare('SELECT group_id,count(*) AS total,min(created_at) AS first,max(created_at) AS last FROM personality_observations GROUP BY group_id LIMIT 100').all(),
      fillers: db.prepare("SELECT group_id,json_extract(feature_data,'$.filler') AS filler,count(*) AS count FROM personality_observations WHERE json_extract(feature_data,'$.filler')<>'' GROUP BY group_id,filler ORDER BY count DESC LIMIT 100").all()
    }), { habits: [], versions: [], feedback: [], observations: [], fillers: [] });
  }
}
