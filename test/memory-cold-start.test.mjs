import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-cold-start-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { Orchestrator } = await import('../src/orchestrator.js');
const { ChatStore } = await import('../src/store.js');
const { SessionRegistry } = await import('../src/sessions.js');
const { MemoryStore } = await import('../src/memory.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
});

const DAY = 24 * 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function fixture(t, { consolidateEnabled = true } = {}) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.groups = [];
  cfg.allow.private = [];
  cfg.allowAllWhenEmpty = true;
  cfg.api.model = 'mock';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.api.apiKey = 'test-key';
  cfg.memory.consolidateEnabled = consolidateEnabled;
  cfg.memory.consolidateMinIntervalMs = 6 * 60 * 60 * 1000;
  cfg.memory.consolidateMinImpressions = 4;
  cfg.memory.maxImpressionsPerMember = 5;
  cfg.memory.handoffEnabled = true;
  cfg.timeControl.enabled = false;
  cfg.wakeDelayMs = 30;
  cfg.wakeDelayMinMs = 30;
  cfg.wakeDelayMaxMs = 30;
  cfg.maxBatchWaitMs = 120;
  cfg.drainDelayMs = 200;
  setRuntimeConfig(cfg);

  const dir = fs.mkdtempSync(path.join(root, 'store-'));
  const store = new ChatStore(0, { dataDir: dir });
  const memory = new MemoryStore();
  const sessions = new SessionRegistry();
  const sender = {
    sendTextBatch: async (_chatKey, messages) => ({
      sent: messages.map((text, i) => ({ text, at: Date.now(), messageId: i + 1 })),
      failed: []
    })
  };
  const runner = new Orchestrator({
    store,
    sessions,
    memory,
    stickers: {},
    sender,
    onebot: {
      selfId: '999',
      selfNickname: 'bot',
      getGroupInfo: async () => ({ group_name: 'test' })
    }
  });

  const originalFetch = globalThis.fetch;
  t.after(async () => {
    await runner.abortAll();
    store.close();
    globalThis.fetch = originalFetch;
  });

  const append = (chatKey, senderId, count, { name = '群友', ts = Date.now() } = {}) => {
    let last = null;
    for (let i = 0; i < count; i += 1) {
      last = store.appendIncoming(chatKey, {
        mid: `${chatKey}-${senderId}-${ts}-${i}`,
        text: `第 ${i + 1} 条消息`,
        senderId: String(senderId),
        senderName: name,
        ts: ts + i
      });
    }
    return last;
  };

  return { cfg, runner, store, memory, append };
}

function mockModel(reply) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body });
    if (typeof reply === 'function') return reply(calls.length);
    return Response.json({
      choices: [{ message: { content: reply } }],
      usage: { total_tokens: 12 }
    });
  };
  return calls;
}

const NEW_IMPRESSION = JSON.stringify({ impressions: ['说话直接，喜欢猫'] });

test('cold start triggers the first consolidation for a group with no impressions', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:101', '5001', 20, { name: '甲' });
  const calls = mockModel(NEW_IMPRESSION);

  const plan = runner.memoryConsolidationPlan('group:101');
  assert.equal(plan?.reason, 'cold-start');
  assert.equal(plan?.coldStart, true);

  const result = await runner.startMemoryConsolidation('group:101', { coldStart: true });
  assert.equal(result.ok, true);
  assert.equal(result.changed, 1);
  assert.equal(calls.length, 1, '第一次整理应只调用一次模型');

  const members = memory.members('group:101');
  assert.deepEqual(members.map((m) => m.userId), ['5001']);
  assert.deepEqual(members[0].impressions.map((impression) => impression.content), ['说话直接，喜欢猫']);

  const state = memory.consolidationState('group:101');
  assert.ok(state.lastConsolidatedAt > 0, '成功整理后应记录成功时间');
  assert.equal(state.lastResult, 'success');
  assert.equal(state.consecutiveFailures, 0);
  assert.equal(runner.consolidating.has('group:101'), false, '任务结束后必须释放锁');
});

test('does not consolidate while the group is below the message threshold', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:102', '5002', 5, { name: '乙' });
  const calls = mockModel('No reply needed');

  assert.equal(runner.memoryConsolidationPlan('group:102'), null);
  await runner.wake('group:102');
  assert.equal(memory.members('group:102').length, 0);
  assert.equal(calls.length, 1, '只应有普通聊天调用，没有整理调用');
});

test('does not auto-consolidate when the last human message is older than 24 hours', async (t) => {
  const { runner, append } = fixture(t);
  append('group:103', '5003', 20, { name: '丙', ts: Date.now() - 25 * 60 * MINUTE });

  assert.equal(runner.memoryConsolidationPlan('group:103'), null);
});

test('keeps the existing impression thresholds once memories exist', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:104', '5004', 20, { name: '丁' });
  memory.append('group:104', 'memberImpression', '喜欢熬夜', { userId: '5004', target: '丁' });

  // 只有 1 条印象：不满足阈值，也不能再走冷启动。
  assert.equal(runner.memoryConsolidationPlan('group:104'), null);

  for (const content of ['爱用表情包', '正在学吉他', '周末常出门', '说话简短']) {
    memory.append('group:104', 'memberImpression', content, { userId: '5004', target: '丁' });
  }
  const plan = runner.memoryConsolidationPlan('group:104');
  assert.equal(plan?.reason, 'impressions');
  assert.equal(plan?.coldStart, false);
});

test('records no_targets without calling the model when nobody is eligible', async (t) => {
  const { runner, memory, append } = fixture(t);
  // 20 条消息，但每位成员都不到单人整理门槛，凑不出目标。
  for (let i = 0; i < 10; i += 1) {
    append('group:105', String(5100 + i), 2, { name: `路人${i}` });
  }
  const calls = mockModel(NEW_IMPRESSION);

  assert.equal(runner.memoryConsolidationPlan('group:105')?.reason, 'cold-start');
  const result = await runner.startMemoryConsolidation('group:105', { coldStart: true });
  assert.equal(result.reason, 'no_targets');
  assert.equal(calls.length, 0, '空目标不得调用模型');

  const state = memory.consolidationState('group:105');
  assert.equal(state.lastResult, 'no_targets');
  assert.ok(state.lastAttemptedAt > 0);
  assert.equal(state.lastConsolidatedAt, 0, '空目标不能算成功整理');
  assert.equal(runner.memoryConsolidationPlan('group:105'), null, '冷却期内不得重复触发');
  assert.equal(runner.memoryConsolidationPlan('group:105', { now: Date.now() + 61 * MINUTE })?.reason, 'cold-start');
});

test('metadata write failure still bounds retries through the in-memory guard', async (t) => {
  const { runner, memory, append } = fixture(t);
  for (let i = 0; i < 10; i += 1) {
    append('group:1051', String(5200 + i), 2, { name: `路人${i}` });
  }
  const calls = mockModel(NEW_IMPRESSION);
  memory.markConsolidationAttempt = () => { throw new Error('_meta.json 写入失败'); };

  const result = await runner.startMemoryConsolidation('group:1051', { coldStart: true });
  assert.equal(result.reason, 'no_targets');
  assert.equal(calls.length, 0);
  // 持久化失败时靠内存兜底：立即触发和短时间后的新消息都不能重复整理。
  assert.equal(runner.memoryConsolidationPlan('group:1051'), null);
  assert.equal(runner.memoryConsolidationPlan('group:1051', { now: Date.now() + 2 * MINUTE }), null);
});

test('model timeout is recorded as a failure and never marks success', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:106', '5006', 20, { name: '戊' });
  globalThis.fetch = async () => { throw new Error('connect ETIMEDOUT'); };

  const result = await runner.startMemoryConsolidation('group:106', { coldStart: true });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.equal(memory.members('group:106').length, 0);

  const state = memory.consolidationState('group:106');
  assert.equal(state.lastResult, 'failed');
  assert.match(state.lastError, /模型请求失败|超时/);
  assert.ok(state.lastAttemptedAt > 0);
  assert.equal(state.lastConsolidatedAt, 0, '失败不得更新成功时间');
  assert.ok(state.consecutiveFailures >= 1);
});

test('unparsable model output is recorded as a failure', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:107', '5007', 20, { name: '己' });
  mockModel('这不是 JSON');

  const result = await runner.startMemoryConsolidation('group:107', { coldStart: true });
  assert.equal(result.ok, false);
  assert.equal(memory.members('group:107').length, 0);
  assert.equal(memory.consolidationState('group:107').lastConsolidatedAt, 0);
  assert.equal(memory.consolidationState('group:107').lastResult, 'failed');
});

test('identity validation failure does not call the model or mark success', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:108', 'not-a-qq', 20, { name: '无名' });
  const calls = mockModel(NEW_IMPRESSION);

  const result = await runner.startMemoryConsolidation('group:108', { userIds: ['not-a-qq'], force: true });
  assert.equal(result.ok, false);
  assert.match(result.failed[0].reason, /身份校验失败/);
  assert.equal(calls.length, 0, '身份校验失败不应调用模型');
  assert.equal(memory.consolidationState('group:108').lastConsolidatedAt, 0);
});

test('storage write failure is not reported as a successful consolidation', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:109', '5009', 20, { name: '庚' });
  mockModel(NEW_IMPRESSION);
  memory.replaceMember = () => { throw new Error('磁盘写入失败'); };

  const result = await runner.startMemoryConsolidation('group:109', { coldStart: true });
  assert.equal(result.ok, false);
  const state = memory.consolidationState('group:109');
  assert.equal(state.lastResult, 'failed');
  assert.match(state.lastError, /磁盘写入失败/);
  assert.equal(state.lastConsolidatedAt, 0);
});

test('failed consolidation backs off instead of retrying on every message', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:110', '5010', 20, { name: '辛' });
  const calls = mockModel('这不是 JSON');

  await runner.startMemoryConsolidation('group:110', { coldStart: true });
  assert.equal(calls.length, 1);

  append('group:110', '5010', 1, { name: '辛' });
  assert.equal(runner.memoryConsolidationPlan('group:110'), null, '失败后立刻的新消息不得再次触发');
  assert.equal(runner.memoryConsolidationPlan('group:110', { now: Date.now() + 5 * MINUTE }), null);
  assert.equal(calls.length, 1);

  const later = runner.memoryConsolidationPlan('group:110', { now: Date.now() + 31 * MINUTE });
  assert.equal(later?.reason, 'cold-start', '退避结束后才允许重试');
  assert.equal(memory.consolidationState('group:110').lastConsolidatedAt, 0);
});

test('concurrent consolidation of the same chat runs only once and releases the lock', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:111', '5011', 20, { name: '壬' });

  let release = null;
  const calls = [];
  globalThis.fetch = async () => {
    calls.push(1);
    return new Promise((resolve) => {
      release = () => resolve(Response.json({
        choices: [{ message: { content: NEW_IMPRESSION } }],
        usage: { total_tokens: 12 }
      }));
    });
  };

  const first = runner.startMemoryConsolidation('group:111', { coldStart: true });
  const second = runner.startMemoryConsolidation('group:111', { coldStart: true });
  assert.ok(first, '首个任务应启动');
  assert.equal(second, null, '同群第二个任务应被任务锁拒绝');
  assert.equal(runner.consolidating.has('group:111'), true);

  const startedAt = Date.now();
  while (!release) {
    if (Date.now() - startedAt > 5000) throw new Error('并发测试等待模型请求超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  release();
  const result = await first;
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(runner.consolidating.has('group:111'), false);
  assert.equal(memory.members('group:111').length, 1);
});

test('the task lock is released even when consolidation throws early', async (t) => {
  const { cfg, runner, append } = fixture(t);
  append('group:112', '5012', 20, { name: '癸' });
  setRuntimeConfig({ ...cfg, api: { ...cfg.api, model: '', baseUrl: '' } });

  await assert.rejects(runner.startMemoryConsolidation('group:112', { coldStart: true }), /模型未配置/);
  assert.equal(runner.consolidating.has('group:112'), false);
});
