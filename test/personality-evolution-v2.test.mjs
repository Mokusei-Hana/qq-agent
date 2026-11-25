import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersonalityLearning } from '../src/personality-learning.js';
import { migrate } from '../src/personality-evolution/migration.js';
import { createServices } from '../src/personality-evolution/store.js';
import { EvolutionQueue } from '../src/personality-evolution/queue.js';
import { parseAnalysis } from '../src/personality-evolution/analysis.js';
import { digest } from '../src/personality-evolution/integrity.js';

const DAY = 86400000;

function makeEnv(t, nowFn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-v2-opt-'));
  const legacy = new PersonalityLearning({ dataDir: dir, allowed: () => true });
  legacy.open();
  legacy.stop();
  const file = path.join(dir, 'personality-learning.sqlite');
  migrate(file, { now: nowFn() });
  const scopeId = 'g_111111111111111111111111';
  const db = new DatabaseSync(file);
  const services = createServices(file, {
    database: db,
    now: nowFn,
    coreFingerprint: () => 'a'.repeat(64),
    allowed: (id) => id === scopeId || /^o_[a-f0-9]{24}$/.test(id),
    authenticate: (auth) => auth?.principal || null
  });
  services.writer.scope({ id: scopeId });
  t.after(() => {
    try { db.close(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, db, services, scopeId };
}

test('parseAnalysis tolerates fenced JSON, string schemaVersion and omitted empty arrays while keeping safety guards', () => {
  const scopeId = 'g_111111111111111111111111';
  const existingId = 'pref_1234567890abcdef12345678';
  const fenced = '```json\n' + JSON.stringify({
    schemaVersion: '2',
    scopeId,
    findings: [{ kind: 'strength', dimension: 'conciseness', conclusion: '回复简明直接', confidence: 0.82, supports: [{ observationId: 'obs_1', segment: 'features' }] }],
    proposals: [{
      preferenceId: existingId,
      dimension: 'conciseness',
      conclusion: '保持短句直答',
      confidence: 0.8,
      supports: [{ observationId: 'obs_1', segment: 'features' }],
      name: '保持短句直答',
      rule: '日常问答保持短句直答',
      intent: 'preserve',
      scenes: ['question']
    }]
  }) + '\n```';

  const parsed = parseAnalysis(fenced, {
    scopeId,
    sampleIds: ['obs_1'],
    existingProposalIds: new Set([existingId])
  });
  assert.equal(parsed.schemaVersion, 2);
  assert.deepEqual(parsed.limitations, []);
  assert.deepEqual(parsed.traits, []);
  assert.equal(parsed.proposals[0].preferenceId, existingId);
  assert.deepEqual(parsed.proposals[0].counters, []);

  // Unknown preferenceId is safely ignored rather than failing the whole report.
  const unknownPref = parseAnalysis(JSON.stringify({
    schemaVersion: 2,
    scopeId,
    proposals: [{
      preferenceId: 'pref_nonexistent',
      dimension: 'conciseness',
      conclusion: '测试',
      confidence: 0.8,
      supports: [{ observationId: 'obs_1', segment: 'features' }],
      name: '短句直答',
      rule: '保持简洁',
      intent: 'preserve',
      scenes: ['question']
    }]
  }), { scopeId, sampleIds: ['obs_1'], existingProposalIds: new Set([existingId]) });
  assert.equal(unknownPref.proposals[0].preferenceId, undefined);

  // Safety guard: verbatim conversational quote is still rejected.
  assert.throws(() => parseAnalysis(JSON.stringify({
    schemaVersion: 2,
    scopeId,
    findings: [{ kind: 'problem', dimension: 'conciseness', conclusion: '直接复述了用户说的这段很长的原始对话内容', confidence: 0.8, supports: [{ observationId: 'obs_1', segment: 'reply' }] }]
  }), {
    scopeId,
    sampleIds: ['obs_1'],
    textSegments: new Map([['obs_1', ['直接复述了用户说的这段很长的原始对话内容']]])
  }), /OUTPUT_REPEATS_CONVERSATION/);
});

test('eligible accumulates support evidence across revisions, respects configurable thresholds, and allows publishing v1', (t) => {
  const baseNow = 1795000000000;
  let clock = baseNow;
  const { db, services, scopeId } = makeEnv(t, () => clock);

  // Create 12 observations spanning 4 days across 3 distinct subjects.
  const obsIds = [];
  for (let i = 0; i < 12; i++) {
    const subj = `o_${String(i % 3).padStart(24, '0')}`;
    services.writer.scope({ id: subj, kind: 'object', parentId: scopeId });
    clock = baseNow - (4 - Math.floor(i / 3)) * DAY + i * 1000;
    const obsId = services.writer.observe({
      id: `obs_${i}`,
      scopeId,
      subjectId: subj,
      interactionId: `msg_${i}`,
      at: clock,
      features: { scene: 'question', length: 20, responseType: 'direct_answer' }
    });
    obsIds.push(obsId);
  }
  clock = baseNow;

  const job1 = services.writer.job({ id: 'job_1', scopeId, observationIds: obsIds.slice(0, 6) });
  const job2 = services.writer.job({ id: 'job_2', scopeId, observationIds: obsIds.slice(6, 12) });
  const prefId = 'pref_' + digest({ scope: scopeId, dimension: 'conciseness', name: '保持短句直答' }).slice(0, 24);

  // Revision 1 alone has only 6 interactions -> not ready yet.
  services.writer.candidate({
    id: prefId, scopeId, name: '保持短句直答', rule: '问答场景优先短句直答',
    scenes: ['question'], confidence: 0.8, intent: 'preserve', dimension: 'conciseness',
    jobId: job1, evidenceIds: obsIds.slice(0, 6), revision: 1
  });
  const r1 = services.reviewer.publicationReadiness(prefId, 1);
  assert.equal(r1.ready, false);
  assert.equal(r1.interactions, 6);
  assert.equal(r1.requiredInteractions, 10);

  // Revision 2 adds 6 more interactions -> cumulative 12 interactions >= 10, span >= 3d -> ready!
  services.writer.candidate({
    id: prefId, scopeId, name: '保持短句直答', rule: '问答场景优先短句直答并避免冗余',
    scenes: ['question'], confidence: 0.8, intent: 'preserve', dimension: 'conciseness',
    jobId: job2, evidenceIds: obsIds.slice(6, 12), revision: 2, supersedes: 1
  });
  const r2 = services.reviewer.publicationReadiness(prefId, 2);
  assert.equal(r2.ready, true);
  assert.equal(r2.interactions, 12);
  assert.equal(r2.sources, 3);

  // Preview + publish produces version 1.
  const auth = { principal: 'console-owner:test' };
  const preview = services.reviewer.preview(auth, {
    expectedVersion: 0,
    operation: 'add',
    selections: [{ id: prefId, revision: 2 }],
    reason: '验证跨版本累计证据后发布 v1'
  });
  const pub = services.reviewer.publish(auth, {
    confirmationId: preview.confirmationId,
    idempotencyKey: 'idem-key-v1-test',
    expectedVersion: 0,
    finalSnapshotHash: preview.finalSnapshotHash,
    requestHash: preview.requestHash
  });
  assert.equal(pub.version, 1);
  assert.equal(db.prepare('SELECT count(*) AS c FROM pe_publications').get().c, 1);
});

test('queue passes existingProposals to model and reuses preferenceId across analyses', async (t) => {
  const baseNow = 1795000000000;
  let clock = baseNow;
  const { db, services, scopeId } = makeEnv(t, () => clock);

  const obsIds = [];
  for (let i = 0; i < 6; i++) {
    const subj = `o_${String(i % 3).padStart(24, '0')}`;
    services.writer.scope({ id: subj, kind: 'object', parentId: scopeId });
    clock = baseNow - (2 - Math.floor(i / 2)) * DAY + i * 1000;
    obsIds.push(services.writer.observe({
      id: `q_obs_${i}`,
      scopeId, subjectId: subj, interactionId: `q_msg_${i}`, at: clock,
      features: { scene: 'question', length: 18, responseType: 'direct_answer' }
    }));
  }
  clock = baseNow;

  const job0 = services.writer.job({ id: 'job_seed', scopeId, observationIds: obsIds.slice(0, 3) });
  const existingPrefId = 'pref_' + digest({ scope: scopeId, dimension: 'conciseness', name: '保持短句直答' }).slice(0, 24);
  services.writer.candidate({
    id: existingPrefId, scopeId, name: '保持短句直答', rule: '简短直答',
    scenes: ['question'], confidence: 0.78, intent: 'preserve', dimension: 'conciseness',
    jobId: job0, evidenceIds: obsIds.slice(0, 3), revision: 1
  });

  let seenUserPayload = null;
  const queue = new EvolutionQueue(db, services, {
    now: () => clock,
    chatBusy: () => false,
    apiInfo: () => ({ providerId: 'test', model: 'test-model', fingerprint: 'fp1' }),
    model: async (req) => {
      seenUserPayload = JSON.parse(req.messages[1].content);
      await req.onPrepareDispatch?.();
      await req.onDispatch();
      await req.onResponse({ status: 200, requestId: 'req_1' });
      const sampleId = seenUserPayload.samples[0].observationId;
      return {
        finishReason: 'stop',
        model: 'test-model',
        usage: { prompt_tokens: 100, completion_tokens: 80 },
        message: {
          content: '```json\n' + JSON.stringify({
            schemaVersion: 2,
            scopeId,
            proposals: [{
              preferenceId: existingPrefId,
              dimension: 'conciseness',
              conclusion: '继续保持短句直答',
              confidence: 0.82,
              supports: [{ observationId: sampleId, segment: 'features' }],
              name: '问答短句直答',
              rule: '问答场景优先短句直答',
              intent: 'preserve',
              scenes: ['question']
            }]
          }) + '\n```'
        }
      };
    }
  });

  queue.settingsPatch({ enabled: true, analysisEnabled: true, unlimitedBudget: true, currency: 'CNY', minEvidence: 8 }, 'console-owner:test');
  assert.equal(queue.settings().minEvidence, 8);

  // Enqueue a reflection job with enough samples manually linked.
  const runJobId = 'job_reflect_reuse';
  db.prepare(`INSERT INTO pe_jobs(id,job_key,kind,scope_id,window_start,window_end,analyzer_version,prompt_version,redaction_version,dataset_hash,state,next_run_at,created_by,created_at)
    VALUES(?,?,'reflection',?,?,?,'s1','s1','s1',?,'queued',?,'test',?)`)
    .run(runJobId, 'jk_reuse', scopeId, baseNow - 7 * DAY, baseNow, 'dh_1', baseNow - 1000, baseNow);
  obsIds.slice(3, 6).forEach((obsId, idx) => {
    const row = db.prepare('SELECT features_json,content_fingerprint FROM pe_observations WHERE id=?').get(obsId);
    db.prepare("INSERT INTO pe_job_samples VALUES(?,?,'analysis',?,?,?)").run(runJobId, obsId, idx, row.features_json, row.content_fingerprint);
  });

  const outcome = await queue.runOne();
  assert.equal(outcome.state, 'succeeded');
  assert.ok(Array.isArray(seenUserPayload.existingProposals));
  assert.equal(seenUserPayload.existingProposals[0].preferenceId, existingPrefId);

  // Proposal reused existingPrefId as revision 2 instead of creating a duplicate preference row.
  const prefCount = db.prepare('SELECT count(*) AS c FROM pe_preferences').get().c;
  assert.equal(prefCount, 1);
  const revs = db.prepare('SELECT revision, name FROM pe_preference_revisions WHERE preference_id=? ORDER BY revision').all(existingPrefId);
  assert.equal(revs.length, 2);
  assert.equal(revs[1].revision, 2);
});
