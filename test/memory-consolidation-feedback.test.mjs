import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-feedback-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { buildConsolidationUpdate, emitConsolidationResult, safeConsolidationError } =
  await import('../src/app.js');
await import('../ui/consolidation-status.js');

const helper = globalThis.QQAgentConsolidationStatus;
const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(testRoot, file), 'utf8');

test('all-failed result is emitted as an error without leaking raw reasons', () => {
  const events = [];
  emitConsolidationResult((type, payload) => events.push({ type, payload }), 'group:1', {
    status: 'failed',
    ok: false,
    retryCount: 2,
    results: [],
    failed: [
      { userId: '1', reason: '模型 API HTTP 401：Authorization: Bearer sk-secret' },
      { userId: '2', reason: '/srv/app/data/messages.sqlite 写入失败' }
    ]
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'memory-update');
  assert.equal(events[0].payload.chatKey, 'group:1');
  assert.equal(events[0].payload.phase, 'consolidate-error');
  assert.equal(events[0].payload.status, 'failed');
  assert.equal(events[0].payload.ok, false);
  assert.match(events[0].payload.error, /稍后会自动重试/);
  const serialized = JSON.stringify(events[0].payload);
  assert.doesNotMatch(serialized, /sk-secret|Bearer|\/srv\/app/);
});

test('partial success and no-target results keep distinct feedback semantics', () => {
  const partial = buildConsolidationUpdate({
    status: 'partial_failed',
    ok: false,
    retryCount: 2,
    results: [{ userId: '1' }],
    failed: [{ userId: '2', reason: 'raw-error' }, { userId: '3', reason: 'raw-error' }]
  });
  assert.equal(partial.phase, 'consolidate-done');
  assert.equal(partial.ok, false);
  assert.match(partial.note, /部分完成/);
  assert.match(partial.note, /1 位已更新/);
  assert.match(partial.note, /2 位失败/);
  assert.match(partial.note, /自动重试/);
  assert.doesNotMatch(JSON.stringify(partial), /raw-error/);

  const noTargets = buildConsolidationUpdate({
    status: 'no_targets',
    ok: true,
    note: '没有可整理的群友'
  });
  assert.equal(noTargets.phase, 'consolidate-done');
  assert.equal(noTargets.ok, true);
  assert.equal(noTargets.note, '没有可整理的群友');

  const success = buildConsolidationUpdate({ status: 'success', ok: true, note: '已整理 3 位' });
  assert.equal(success.phase, 'consolidate-done');
  assert.equal(success.ok, true);
  assert.equal(success.note, '已整理 3 位');
});

test('safeConsolidationError hides credentials, paths and stacks', () => {
  const raw = new Error('模型 API HTTP 401：Authorization: Bearer sk-secret /srv/app/config.json\n    at foo');
  const text = safeConsolidationError(raw);
  assert.equal(text, '模型服务暂时不可用，请稍后重试');
  assert.doesNotMatch(text, /sk-secret|Bearer|\/srv\/app/);
  assert.equal(safeConsolidationError(new Error('模型未配置，无法整理记忆')), '模型未配置，无法整理记忆');
  assert.equal(safeConsolidationError(new Error('请求超时')), '模型请求超时，请稍后重试');
  assert.equal(safeConsolidationError(new Error('random failure')), '整理过程中发生错误，请稍后重试');
});

test('reconcile keeps running state while backend is still busy', () => {
  const state = { consolidating: {}, consolidateResult: {} };
  const outcome = helper.reconcileConsolidationState(state, [
    { chatKey: 'group:1', consolidating: true, consolidation: { status: 'running' } }
  ], 1000);
  assert.equal(state.consolidating['group:1'].startedAt, 1000);
  assert.deepEqual(state.consolidateResult, {});
  assert.equal(outcome.completed, false);
  assert.equal(outcome.activeCount, 1);
});

test('reconcile recovers a lost SSE completion and reports partial/failure truthfully', () => {
  const state = { consolidating: { 'group:1': { startedAt: 1000 } }, consolidateResult: {} };
  const outcome = helper.reconcileConsolidationState(state, [
    {
      chatKey: 'group:1',
      consolidating: false,
      consolidation: { status: 'partial_failed', retryCount: 2, lastAttemptedAt: 2000 }
    }
  ], 3000);
  assert.equal(state.consolidating['group:1'], undefined);
  assert.equal(state.consolidateResult['group:1'].status, 'partial_failed');
  assert.equal(state.consolidateResult['group:1'].failed, true);
  assert.match(state.consolidateResult['group:1'].note, /自动重试/);
  assert.equal(outcome.completed, true);

  const failed = { consolidating: { 'group:2': { startedAt: 1000 } }, consolidateResult: {} };
  helper.reconcileConsolidationState(failed, [
    {
      chatKey: 'group:2',
      consolidating: false,
      consolidation: { status: 'failed', retryCount: 1, lastAttemptedAt: 2000 }
    }
  ], 3000);
  assert.equal(failed.consolidateResult['group:2'].failed, true);
  assert.match(failed.consolidateResult['group:2'].note, /整理失败/);
});

test('reconcile does not invent completion for a missing chatKey', () => {
  const state = { consolidating: { 'group:9': { startedAt: 1000 } }, consolidateResult: {} };
  const outcome = helper.reconcileConsolidationState(state, [
    { chatKey: 'group:1', consolidating: false, consolidation: { status: 'success' } }
  ], 2000);
  assert.equal(state.consolidating['group:9'].startedAt, 1000);
  assert.equal(outcome.activeCount, 1);
  assert.equal(outcome.completed, false);
});

test('reconcile does not claim success when the backend has no recorded outcome', () => {
  const state = { consolidating: { 'group:3': { startedAt: 1000 } }, consolidateResult: {} };
  helper.reconcileConsolidationState(state, [
    { chatKey: 'group:3', consolidating: false, consolidation: { status: '' } }
  ], 2000);
  assert.equal(state.consolidateResult['group:3'].status, '');
  assert.equal(state.consolidateResult['group:3'].failed, true);
  assert.match(state.consolidateResult['group:3'].note, /未能确认结果/);
});

test('reconcile does not reuse an older successful status for a newer task', () => {
  const startedAt = 1_700_000_000_000;
  const state = { consolidating: { 'group:4': { startedAt } }, consolidateResult: {} };
  helper.reconcileConsolidationState(state, [
    {
      chatKey: 'group:4',
      consolidating: false,
      consolidation: { status: 'success', lastAttemptedAt: startedAt - 10 * 60 * 1000 }
    }
  ], startedAt + 60 * 1000);
  assert.equal(state.consolidateResult['group:4'].failed, true);
  assert.match(state.consolidateResult['group:4'].note, /未能确认结果/);
});

test('poll backoff grows and caps', () => {
  assert.equal(helper.nextPollDelay(0), 12000);
  assert.equal(helper.nextPollDelay(1), 24000);
  assert.equal(helper.nextPollDelay(2), 48000);
  assert.equal(helper.nextPollDelay(3), 60000);
  assert.equal(helper.nextPollDelay(10), 60000);
});

test('session memory page wires low-frequency reconciliation into the ticker', () => {
  const ui = read('ui/app.js');
  const index = read('ui/index.html');
  const app = read('src/app.js');
  assert.match(index, /src="\/consolidation-status\.js"[\s\S]*src="\/app\.js"/);
  assert.match(ui, /async function syncConsolidationState/);
  assert.match(ui, /nextPollDelay/);
  assert.match(ui, /document\.hidden/);
  assert.match(ui, /state\.tab !== 'memory'/);
  assert.match(ui, /reconcileConsolidationState/);
  assert.match(app, /emitConsolidationResult\(emit, chatKey, result\)/);
  assert.match(app, /consolidation: consolidationView\(chatKey\)/);
});
