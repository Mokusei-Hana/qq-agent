import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULTS = Object.freeze({
  enabled: false,
  dataDir: '',
  dbPath: '',
  allowedGroupIds: [],
  searchQueries: ['中文互联网 热梗 含义 最近', '网络流行语 梗 来源 用法'],
  intervalMs: 6 * 60 * 60 * 1000,
  maxSourcesPerRun: 12,
  minConfidence: 0.8,
  minDomains: 2,
  ttlDays: 45,
  maxCandidateChars: 180
});

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function cleanText(value, max = 500) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sourceDomain(url) {
  try {
    const parsed = new URL(String(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

/**
 * 独立的自主学梗模块。所有网络能力和模型分析均通过依赖注入，
 * 由宿主传入现有 web-search / safe-fetch / llm 适配器。
 *
 * 默认关闭；关闭时 start() 不创建数据库、不启动定时器、不观察消息。
 */
export class MemeLearningManager {
  constructor(config = {}, deps = {}) {
    this.config = {
      ...DEFAULTS,
      ...config,
      allowedGroupIds: Array.isArray(config.allowedGroupIds) ? config.allowedGroupIds.map(String) : [],
      searchQueries: Array.isArray(config.searchQueries) ? config.searchQueries.map((q) => cleanText(q, 120)).filter(Boolean) : DEFAULTS.searchQueries
    };
    this.deps = deps;
    this.db = null;
    this.timer = null;
    this.running = false;
    this.lastError = '';
    this.lastRunAt = 0;
    this.stats = { researched: 0, admitted: 0, rejected: 0, observed: 0, expired: 0 };
  }

  #db() {
    if (this.db) return this.db;
    const filename = this.config.dbPath || path.join(this.config.dataDir || process.cwd(), 'meme-learning.sqlite');
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meme_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phrase TEXT NOT NULL,
        group_id TEXT NOT NULL,
        occurrences INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        UNIQUE(phrase, group_id)
      );
      CREATE TABLE IF NOT EXISTS memes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        meaning TEXT NOT NULL,
        usage TEXT NOT NULL DEFAULT '',
        tone TEXT NOT NULL DEFAULT '',
        confidence REAL NOT NULL,
        scope TEXT NOT NULL DEFAULT 'global',
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        correction_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS meme_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meme_id INTEGER NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
        url TEXT NOT NULL,
        domain TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        excerpt TEXT NOT NULL DEFAULT '',
        fetched_at INTEGER NOT NULL,
        UNIQUE(meme_id, url)
      );
      CREATE TABLE IF NOT EXISTS meme_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meme_id INTEGER NOT NULL REFERENCES memes(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS meme_status_expiry ON memes(status, expires_at);
      CREATE INDEX IF NOT EXISTS meme_candidate_queue ON meme_candidates(status, last_seen_at);
    `);
    return this.db;
  }

  status() {
    return {
      enabled: this.config.enabled === true,
      active: Boolean(this.timer),
      databaseOpened: Boolean(this.db),
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      stats: { ...this.stats }
    };
  }

  async start() {
    if (this.config.enabled !== true) return this.status();
    this.#db();
    if (this.timer) return this.status();
    const interval = clamp(this.config.intervalMs, 60_000, 7 * 24 * 60 * 60 * 1000, DEFAULTS.intervalMs);
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => { this.lastError = String(error?.message ?? error); });
    }, interval);
    this.timer.unref?.();
    return this.status();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    this.db?.close();
    this.db = null;
  }

  observeMessage({ groupId, text, isSelf = false, isPrivate = false } = {}) {
    if (this.config.enabled !== true || isSelf || isPrivate) return false;
    const group = String(groupId ?? '');
    if (!group || !this.config.allowedGroupIds.includes(group)) return false;
    const phrase = cleanText(text, clamp(this.config.maxCandidateChars, 30, 300, DEFAULTS.maxCandidateChars));
    if (phrase.length < 3 || /https?:\/\/|\[CQ:|(?:\d{5,15})/.test(phrase)) return false;
    const now = Date.now();
    const db = this.#db();
    db.prepare(`
      INSERT INTO meme_candidates(phrase, group_id, first_seen_at, last_seen_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(phrase, group_id) DO UPDATE SET
        occurrences = occurrences + 1, last_seen_at = excluded.last_seen_at
    `).run(phrase, group, now, now);
    this.stats.observed += 1;
    return true;
  }

  async runOnce() {
    if (this.config.enabled !== true) return this.status();
    if (this.running) return this.status();
    if (typeof this.deps.searchWeb !== 'function' || typeof this.deps.analyze !== 'function') {
      throw new Error('学梗模块缺少 searchWeb / analyze 依赖');
    }
    this.#db();
    this.running = true;
    this.lastError = '';
    const now = Date.now();
    try {
      const seen = new Set();
      for (const query of this.config.searchQueries) {
        const response = await this.deps.searchWeb(query);
        const results = Array.isArray(response?.results) ? response.results : [];
        for (const item of results.slice(0, clamp(this.config.maxSourcesPerRun, 2, 30, DEFAULTS.maxSourcesPerRun))) {
          const url = cleanText(item?.url, 2000);
          const domain = sourceDomain(url);
          if (!domain || seen.has(url)) continue;
          seen.add(url);
          let excerpt = cleanText(item?.snippet, 1200);
          if (typeof this.deps.fetchSource === 'function') {
            try {
              const page = await this.deps.fetchSource(url);
              excerpt = cleanText(page?.text || page?.content || excerpt, 3000);
            } catch { /* Search snippets remain usable evidence; failures are not retried here. */ }
          }
          if (excerpt.length < 20) continue;
          const source = { url, domain, title: cleanText(item?.title, 300), excerpt };
          const analysis = await this.deps.analyze({ query, sources: [source] });
          if (!analysis || typeof analysis !== 'object') continue;
          const term = cleanText(analysis.term, 100);
          const meaning = cleanText(analysis.meaning, 1000);
          if (!term || !meaning || analysis.sensitive === true) continue;

          // A single page is not enough to graduate a claim into the active knowledge base.
          // Collect same-term evidence from different domains before admission.
          const peers = await this.#collectEvidence(term, source);
          const domains = new Set(peers.map((s) => s.domain).filter(Boolean));
          const confidence = clamp(analysis.confidence, 0, 1, 0);
          const minDomains = clamp(this.config.minDomains, 2, 5, DEFAULTS.minDomains);
          const threshold = clamp(this.config.minConfidence, 0.5, 0.99, DEFAULTS.minConfidence);
          const admitted = domains.size >= minDomains && confidence >= threshold && analysis.verified === true;
          this.#saveProposal({ analysis: { ...analysis, term, meaning, confidence }, sources: peers, admitted, now });
          this.stats.researched += 1;
          if (admitted) this.stats.admitted += 1;
          else this.stats.rejected += 1;
        }
      }
      await this.#processGroupCandidates(now);
      this.expireOldEntries(now);
      this.lastRunAt = now;
      return this.status();
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      throw error;
    } finally {
      this.running = false;
    }
  }

  async #processGroupCandidates(now) {
    const db = this.#db();
    const rows = db.prepare(`
      SELECT phrase, group_id, occurrences FROM meme_candidates
      WHERE status = 'queued'
      ORDER BY occurrences DESC, last_seen_at DESC LIMIT 10
    `).all();
    for (const candidate of rows) {
      try {
        const response = await this.deps.searchWeb(`“${candidate.phrase}” 网络梗 含义 用法`);
        const sources = [];
        for (const item of (Array.isArray(response?.results) ? response.results : []).slice(0, 10)) {
          const url = cleanText(item?.url, 2000);
          const domain = sourceDomain(url);
          if (!domain || sources.some((source) => source.url === url)) continue;
          let excerpt = cleanText(item?.snippet, 1200);
          if (typeof this.deps.fetchSource === 'function') {
            try {
              const page = await this.deps.fetchSource(url);
              excerpt = cleanText(page?.text || page?.content || excerpt, 3000);
            } catch { /* Search snippets are retained as fallback evidence. */ }
          }
          if (excerpt.length >= 20) sources.push({
            url, domain, title: cleanText(item?.title, 300), excerpt
          });
        }
        const analysis = await this.deps.analyze({
          query: candidate.phrase,
          candidatePhrase: candidate.phrase,
          sourceType: 'qq-group-candidate',
          groupId: candidate.group_id,
          occurrences: Number(candidate.occurrences) || 1,
          sources
        });
        const term = cleanText(analysis?.term || candidate.phrase, 100);
        const meaning = cleanText(analysis?.meaning, 1000);
        const domains = new Set(sources.map((source) => source.domain));
        const confidence = clamp(analysis?.confidence, 0, 1, 0);
        const verified = analysis?.verified === true
          && analysis?.sensitive !== true
          && Boolean(meaning)
          && domains.size >= clamp(this.config.minDomains, 2, 5, DEFAULTS.minDomains)
          && confidence >= clamp(this.config.minConfidence, 0.5, 0.99, DEFAULTS.minConfidence);
        if (meaning && analysis?.sensitive !== true) {
          this.#saveProposal({
            analysis: { ...analysis, term, meaning, confidence },
            sources,
            admitted: verified,
            now
          });
        }
        db.prepare("UPDATE meme_candidates SET status = ? WHERE phrase = ? AND group_id = ?")
          .run(verified ? 'researched' : 'needs_review', candidate.phrase, candidate.group_id);
        this.stats.researched += 1;
        if (verified) this.stats.admitted += 1;
        else this.stats.rejected += 1;
      } catch (error) {
        db.prepare("UPDATE meme_candidates SET status = 'queued' WHERE phrase = ? AND group_id = ?")
          .run(candidate.phrase, candidate.group_id);
        this.lastError = String(error?.message ?? error);
      }
    }
  }

  async #collectEvidence(term, firstSource) {
    const collected = [firstSource];
    if (typeof this.deps.searchWeb !== 'function') return collected;
    try {
      const response = await this.deps.searchWeb(`“${term}” 网络梗 含义 用法`);
      for (const item of (Array.isArray(response?.results) ? response.results : []).slice(0, 10)) {
        const url = cleanText(item?.url, 2000);
        const domain = sourceDomain(url);
        if (!domain || collected.some((s) => s.url === url)) continue;
        let excerpt = cleanText(item?.snippet, 1200);
        if (typeof this.deps.fetchSource === 'function') {
          try {
            const page = await this.deps.fetchSource(url);
            excerpt = cleanText(page?.text || page?.content || excerpt, 3000);
          } catch { /* Keep the search snippet. */ }
        }
        if (excerpt.length >= 20) collected.push({ url, domain, title: cleanText(item?.title, 300), excerpt });
      }
    } catch { /* A failed corroboration query must not admit the term. */ }
    return collected;
  }

  #saveProposal({ analysis, sources, admitted, now }) {
    const db = this.#db();
    const term = analysis.term;
    const old = db.prepare('SELECT id FROM memes WHERE term = ?').get(term);
    if (old) {
      const update = db.prepare(`
        UPDATE memes SET aliases_json = ?, meaning = ?, usage = ?, tone = ?, confidence = ?,
          status = ?, updated_at = ?, expires_at = ?
        WHERE id = ?
      `);
      update.run(JSON.stringify(Array.isArray(analysis.aliases) ? analysis.aliases.map((x) => cleanText(x, 80)).filter(Boolean) : []),
        analysis.meaning, cleanText(analysis.usage, 600), cleanText(analysis.tone, 200), analysis.confidence,
        admitted ? 'active' : 'pending', now, now + clamp(this.config.ttlDays, 7, 365, DEFAULTS.ttlDays) * 86400000, old.id);
      const addSource = db.prepare('INSERT OR IGNORE INTO meme_sources(meme_id, url, domain, title, excerpt, fetched_at) VALUES(?, ?, ?, ?, ?, ?)');
      for (const source of sources) addSource.run(old.id, source.url, source.domain, source.title, source.excerpt, now);
      return;
    }
    const result = db.prepare(`
      INSERT INTO memes(term, aliases_json, meaning, usage, tone, confidence, scope, status, created_at, updated_at, expires_at)
      VALUES(?, ?, ?, ?, ?, ?, 'global', ?, ?, ?, ?)
    `).run(term,
      JSON.stringify(Array.isArray(analysis.aliases) ? analysis.aliases.map((x) => cleanText(x, 80)).filter(Boolean) : []),
      analysis.meaning, cleanText(analysis.usage, 600), cleanText(analysis.tone, 200), analysis.confidence,
      admitted ? 'active' : 'pending', now, now, now + clamp(this.config.ttlDays, 7, 365, DEFAULTS.ttlDays) * 86400000);
    const id = Number(result.lastInsertRowid);
    const addSource = db.prepare('INSERT OR IGNORE INTO meme_sources(meme_id, url, domain, title, excerpt, fetched_at) VALUES(?, ?, ?, ?, ?, ?)');
    for (const source of sources) addSource.run(id, source.url, source.domain, source.title, source.excerpt, now);
  }

  lookup(query, { limit = 5 } = {}) {
    const clean = cleanText(query, 300);
    if (!clean || !this.db) return [];
    const terms = [...new Set(clean.split(/[\s，。！？、,.!?;；:：]+/).filter((x) => x.length >= 2))].slice(0, 8);
    if (!terms.length) return [];
    const where = terms.map(() => '(term LIKE ? OR meaning LIKE ? OR aliases_json LIKE ?)').join(' OR ');
    const params = terms.flatMap((term) => {
      const pattern = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
      return [pattern, pattern, pattern];
    });
    const rows = this.db.prepare(`SELECT * FROM memes WHERE status = 'active' AND expires_at > ? AND (${where}) ORDER BY confidence DESC, updated_at DESC LIMIT ?`)
      .all(Date.now(), ...params, clamp(limit, 1, 10, 5));
    return rows.map((row) => ({
      id: Number(row.id), term: row.term, aliases: parseJson(row.aliases_json, []),
      meaning: row.meaning, usage: row.usage, tone: row.tone,
      confidence: Number(row.confidence), scope: row.scope,
      sources: this.db.prepare('SELECT url, domain, title FROM meme_sources WHERE meme_id = ? ORDER BY fetched_at DESC').all(row.id)
    }));
  }

  feedback({ term, kind, note = '', correctedMeaning = '' } = {}) {
    if (!this.db) throw new Error('学梗知识库尚未初始化');
    const safeTerm = cleanText(term, 100);
    if (!['correct', 'incorrect', 'outdated'].includes(kind)) throw new Error('反馈类型无效');
    const row = this.db.prepare('SELECT * FROM memes WHERE term = ?').get(safeTerm);
    if (!row) throw new Error('没有找到对应梗词条');
    const now = Date.now();
    this.db.prepare('INSERT INTO meme_feedback(meme_id, kind, note, created_at) VALUES(?, ?, ?, ?)')
      .run(row.id, kind, cleanText(note, 500), now);
    if (kind === 'incorrect') {
      const corrected = cleanText(correctedMeaning, 1000);
      this.db.prepare('UPDATE memes SET status = ?, meaning = ?, correction_count = correction_count + 1, updated_at = ? WHERE id = ?')
        .run(corrected ? 'pending' : 'disabled', corrected || row.meaning, now, row.id);
    } else if (kind === 'outdated') {
      this.db.prepare('UPDATE memes SET status = ?, updated_at = ? WHERE id = ?').run('expired', now, row.id);
    } else {
      this.db.prepare('UPDATE memes SET correction_count = MAX(0, correction_count - 1), updated_at = ? WHERE id = ?').run(now, row.id);
    }
    return { ok: true, term: safeTerm, kind };
  }

  expireOldEntries(now = Date.now()) {
    if (!this.db) return 0;
    const result = this.db.prepare(`UPDATE memes SET status = 'expired' WHERE status = 'active' AND expires_at <= ?`).run(now);
    this.stats.expired += Number(result.changes || 0);
    return Number(result.changes || 0);
  }

  close() {
    return this.stop();
  }
}

export const memeLearningDefaults = DEFAULTS;
