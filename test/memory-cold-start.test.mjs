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

  const append = (chatKey, senderId, count, { name = '群友', ts = Date.now(), eventKind = 'message' } = {}) => {
    let last = null;
    for (let i = 0; i < count; i += 1) {
      last = store.appendIncoming(chatKey, {
        mid: `${chatKey}-${senderId}-${ts}-${i}`,
        text: `第 ${i + 1} 条消息`,
        senderId: String(senderId),
        senderName: name,
        ts: ts + i,
        eventKind
      });
    }
    return last;
  };
  const appendSelf = (chatKey, count = 1) => {
    for (let i = 0; i < count; i += 1) {
      store.appendSelf(chatKey, { mid: `${chatKey}-self-${Date.now()}-${i}`, text: '机器人回复' });
    }
  };

  return { cfg, runner, store, memory, append, appendSelf };
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

function mockModelByUser(behaviors) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    const prompt = (body.messages || []).map((m) => String(m.content || '')).join('\n');
    const uid = /群友（QQ (\d+)/.exec(prompt)?.[1] || /群友 QQ：(\d+)/.exec(prompt)?.[1] || '';
    calls.push(uid);
    const behavior = behaviors[uid];
    if (behavior instanceof Error) throw behavior;
    if (typeof behavior === 'function') return behavior();
    return Response.json({
      choices: [{ message: { content: behavior ?? '{}' } }],
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

test('unreliable identity is not treated as a consolidation target', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:108', 'not-a-qq', 20, { name: '无名' });
  const calls = mockModel(NEW_IMPRESSION);

  const result = await runner.startMemoryConsolidation('group:108', { userIds: ['not-a-qq'], force: true });
  assert.equal(result.status, 'no_targets');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 0, '不可靠身份不应调用模型');
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
  assert.equal(later?.reason, 'retry-failed-members', '退避结束后重试失败成员，而不是重新冷启动');
  assert.deepEqual(later?.retryUserIds, ['5010']);
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

test('malformed impressions fields never erase or replace existing memories', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:120', '6120', 10, { name: '甲' });
  memory.append('group:120', 'memberImpression', '原有印象：喜欢猫', { userId: '6120', target: '甲' });

  for (const payload of ['{}', '{"impressions":null}', '{"impressions":"text"}', '{"impressions":[{"x":1}]}', '{"impressions":["   "]}']) {
    mockModel(payload);
    const result = await runner.startMemoryConsolidation('group:120', { userIds: ['6120'], force: true });
    assert.equal(result.status, 'failed', `payload ${payload} 必须失败`);
    assert.equal(result.ok, false);
    assert.deepEqual(
      memory.getMember('group:120', '6120').impressions.map((item) => item.content),
      ['原有印象：喜欢猫'],
      `payload ${payload} 不得清空原印象`
    );
    assert.equal(memory.consolidationState('group:120').lastConsolidatedAt, 0, '格式错误不得更新成功时间');
  }
});

test('explicit empty impressions array is allowed for existing members only', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:121', '6121', 10, { name: '乙' });
  memory.append('group:121', 'memberImpression', '可以被删除的印象', { userId: '6121', target: '乙' });

  mockModel('{"impressions":[]}');
  const result = await runner.startMemoryConsolidation('group:121', { userIds: ['6121'], force: true });
  assert.equal(result.status, 'success');
  assert.equal(memory.getMember('group:121', '6121').impressions.length, 0);
  assert.ok(memory.consolidationState('group:121').lastConsolidatedAt > 0);

  // 新建人物仍然不允许空数组：没有稳定特征就应失败，而不是创建空记忆。
  append('group:1211', '6122', 20, { name: '丙' });
  mockModel('{"impressions":[]}');
  const created = await runner.startMemoryConsolidation('group:1211', { coldStart: true });
  assert.equal(created.status, 'failed');
  assert.equal(memory.members('group:1211').length, 0);
  assert.equal(memory.consolidationState('group:1211').lastConsolidatedAt, 0);
});

test('valid non-empty impressions array still updates the member', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:1212', '6123', 10, { name: '丁' });
  memory.append('group:1212', 'memberImpression', '旧印象', { userId: '6123', target: '丁' });

  mockModel('{"impressions":["更新后的稳定印象"]}');
  const result = await runner.startMemoryConsolidation('group:1212', { userIds: ['6123'], force: true });
  assert.equal(result.status, 'success');
  assert.deepEqual(
    memory.getMember('group:1212', '6123').impressions.map((item) => item.content),
    ['更新后的稳定印象']
  );
});

test('partial success keeps failed members in a persisted retry queue', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:122', '6201', 20, { name: '甲' });
  append('group:122', '6202', 15, { name: '乙' });
  append('group:122', '6203', 10, { name: '丙' });

  const calls = mockModelByUser({
    '6201': JSON.stringify({ impressions: ['甲说话直接'] }),
    '6202': '这不是 JSON',
    '6203': new Error('model down')
  });
  const result = await runner.startMemoryConsolidation('group:122', { coldStart: true });

  assert.equal(result.status, 'partial_failed');
  assert.equal(result.ok, false);
  assert.equal(result.retryCount, 2);
  assert.equal(calls.length, 3);

  assert.deepEqual(memory.members('group:122').map((m) => m.userId), ['6201']);
  assert.ok(memory.getMember('group:122', '6201').lastConsolidatedAt > 0, '成功成员应更新个人整理时间');
  assert.equal(memory.getMember('group:122', '6202').lastConsolidatedAt, 0);

  const state = memory.consolidationState('group:122');
  assert.equal(state.lastResult, 'partial_failed');
  assert.equal(state.lastConsolidatedAt, 0, '部分成功不得推进整群成功时间');
  assert.deepEqual(state.retryMembers.map((m) => m.userId), ['6202', '6203']);

  // 退避期内不重试；退避结束后只重试失败成员，不重复整理 6201。
  assert.equal(runner.memoryConsolidationPlan('group:122'), null);
  const plan = runner.memoryConsolidationPlan('group:122', { now: Date.now() + 31 * MINUTE });
  assert.equal(plan?.reason, 'retry-failed-members');
  assert.deepEqual(plan?.retryUserIds, ['6202', '6203']);
  assert.equal(plan.retryUserIds.includes('6201'), false);

  const retryCalls = mockModelByUser({
    '6202': JSON.stringify({ impressions: ['乙喜欢猫'] }),
    '6203': JSON.stringify({ impressions: ['丙常发图'] })
  });
  const retried = await runner.startMemoryConsolidation('group:122', { retryUserIds: plan.retryUserIds });
  assert.equal(retried.status, 'success');
  assert.deepEqual(retryCalls, ['6202', '6203'], '重试只处理失败成员，不重复调用已成功的 6201');
  assert.deepEqual(new Set(memory.members('group:122').map((m) => m.userId)), new Set(['6201', '6202', '6203']));
  assert.equal(memory.consolidationState('group:122').retryMembers.length, 0);
  assert.ok(memory.consolidationState('group:122').lastConsolidatedAt > 0);
  assert.equal(memory.consolidationState('group:122').consecutiveFailures, 0, '成功重试后应清零失败计数');
});

test('failed retry queue survives a process restart', async (t) => {
  const { runner, append, store } = fixture(t);
  append('group:123', '6301', 20, { name: '甲' });
  mockModel('这不是 JSON');
  await runner.startMemoryConsolidation('group:123', { coldStart: true });

  // 新的 MemoryStore + 新 Orchestrator 模拟进程重启，确认状态来自磁盘而不是内存。
  const reloadedMemory = new MemoryStore();
  const restarted = new Orchestrator({
    store,
    memory: reloadedMemory,
    sessions: new SessionRegistry(),
    stickers: {},
    sender: { sendTextBatch: async () => ({ sent: [], failed: [] }) },
    onebot: { selfId: '999', selfNickname: 'bot', getGroupInfo: async () => ({ group_name: 'test' }) }
  });
  t.after(async () => { await restarted.abortAll(); });

  const plan = restarted.memoryConsolidationPlan('group:123', { now: Date.now() + 31 * MINUTE });
  assert.equal(plan?.reason, 'retry-failed-members');
  assert.deepEqual(plan?.retryUserIds, ['6301']);
  assert.equal(reloadedMemory.consolidationState('group:123').lastConsolidatedAt, 0);
});

test('all-failed consolidation has a distinct failed status and retry queue', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:124', '6401', 20, { name: '甲' });
  mockModel('这不是 JSON');
  const result = await runner.startMemoryConsolidation('group:124', { coldStart: true });
  assert.equal(result.status, 'failed');
  assert.equal(result.ok, false);
  assert.equal(result.retryCount, 1);
  const state = memory.consolidationState('group:124');
  assert.equal(state.lastResult, 'failed');
  assert.equal(state.lastConsolidatedAt, 0);
  assert.deepEqual(state.retryMembers.map((m) => m.userId), ['6401']);
});

test('cold start message threshold ignores bot messages and non-chat events', async (t) => {
  const { runner, store, append, appendSelf } = fixture(t);
  append('group:130', '6130', 19, { name: '甲' });
  append('group:130', '6130', 5, { name: '甲', eventKind: 'poke' });
  appendSelf('group:130', 10);

  const meta = store.getChatMeta('group:130');
  assert.equal(meta.total, 34);
  assert.equal(meta.incomingCount, 19, '只统计真人普通聊天消息');
  assert.equal(runner.memoryConsolidationPlan('group:130'), null);

  append('group:130', '6130', 1, { name: '甲' });
  assert.equal(store.getChatMeta('group:130').incomingCount, 20);
  assert.equal(runner.memoryConsolidationPlan('group:130')?.reason, 'cold-start');

  append('group:1302', '6131', 20, { name: '乙', eventKind: 'poke' });
  appendSelf('group:1302', 5);
  assert.equal(store.lastIncomingTs('group:1302'), 0, '只有拍一拍和机器人消息时不算真人聊天');
  assert.equal(runner.memoryConsolidationPlan('group:1302'), null);
});

test('discovery ignores pokes and anonymous sender ids', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:132', '6141', 20, { name: '正常群友' });
  append('group:132', '6142', 5, { name: '拍一拍', eventKind: 'poke' });
  append('group:132', '80000000', 8, { name: '匿名' });
  append('group:132', '0', 4, { name: '匿名 0' });

  const calls = mockModelByUser({ '6141': NEW_IMPRESSION });
  const result = await runner.startMemoryConsolidation('group:132', { coldStart: true });
  assert.equal(result.status, 'success');
  assert.deepEqual(calls, ['6141']);
  assert.deepEqual(memory.members('group:132').map((m) => m.userId), ['6141']);
});

test('zero-impression private manual consolidation keeps the original discovery floor', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('private:1', '6150', 5, { name: '私聊对象' });
  const privateCalls = mockModel(NEW_IMPRESSION);
  const privateResult = await runner.startMemoryConsolidation('private:1', { force: true });
  assert.equal(privateResult.status, 'no_targets');
  assert.equal(privateCalls.length, 0);
  assert.equal(memory.members('private:1').length, 0);

  append('group:133', '6151', 5, { name: '群友' });
  const groupCalls = mockModel(NEW_IMPRESSION);
  const groupResult = await runner.startMemoryConsolidation('group:133', { force: true });
  assert.equal(groupResult.status, 'success');
  assert.equal(groupCalls.length, 1);
});

test('a recent failed retry is not blocked by an older successful cooldown', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:125', '6501', 10, { name: '甲' });
  memory.append('group:125', 'memberImpression', '旧印象', { userId: '6501', target: '甲' });
  // 模拟两小时前成功整理过；随后手动整理失败，不能被 6 小时成功冷却压住。
  memory.markConsolidated('group:125', Date.now() - 2 * 60 * 60 * 1000, []);
  mockModel('这不是 JSON');
  const result = await runner.startMemoryConsolidation('group:125', { userIds: ['6501'], force: true });
  assert.equal(result.status, 'failed');
  assert.equal(memory.consolidationState('group:125').retryMembers.length, 1);

  assert.equal(runner.memoryConsolidationPlan('group:125'), null, '失败退避期内仍不得重试');
  const plan = runner.memoryConsolidationPlan('group:125', { now: Date.now() + 31 * MINUTE });
  assert.equal(plan?.reason, 'retry-failed-members');
  assert.deepEqual(plan?.retryUserIds, ['6501']);
});

test('a failure is persisted before the batch finishes (crash-safe retry queue)', async (t) => {
  const { runner, memory, append } = fixture(t);
  append('group:126', '6601', 20, { name: '甲' });
  append('group:126', '6602', 10, { name: '乙' });

  let releaseSecond = null;
  mockModelByUser({
    '6601': '这不是 JSON',
    '6602': () => new Promise((resolve) => {
      releaseSecond = () => resolve(Response.json({
        choices: [{ message: { content: JSON.stringify({ impressions: ['乙喜欢猫'] }) } }],
        usage: { total_tokens: 12 }
      }));
    })
  });

  const task = runner.startMemoryConsolidation('group:126', { coldStart: true });
  const startedAt = Date.now();
  while (!releaseSecond) {
    if (Date.now() - startedAt > 5000) throw new Error('等待第二个成员模型调用超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // 第一个成员已失败、第二个还在调用模型：此时队列必须已经落盘。
  const during = memory.consolidationState('group:126');
  assert.equal(during.lastResult, 'running');
  assert.deepEqual(during.retryMembers.map((m) => m.userId), ['6601']);

  releaseSecond();
  const result = await task;
  assert.equal(result.status, 'partial_failed');
  assert.equal(memory.consolidationState('group:126').lastResult, 'partial_failed');
});
