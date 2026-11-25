import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-api-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { DEFAULT_CONFIG, updateConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('manual consolidation API keeps the shared lock and exposes coarse status', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: '' };
  cfg.runtime.mode = 'active';
  cfg.runtime.paused = false;
  cfg.allow.groups = ['1'];
  cfg.allow.private = [];
  cfg.allowAllWhenEmpty = false;
  cfg.timeControl.enabled = false;
  cfg.memory.consolidateEnabled = false;
  cfg.api.model = 'mock';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  updateConfig(cfg);

  const app = createApp({ log: () => {} });
  t.after(async () => {
    await app.stop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 可能暂时占用 */ }
  });
  await app.start();

  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };

  // 自动整理和手动 API 共用 orchestrator.consolidating：已有任务时路由必须拒绝。
  app.orchestrator.consolidating.add('group:1');
  const busy = await request('/api/memory-files/consolidate', {
    method: 'POST',
    body: { chatKey: 'group:1' }
  });
  assert.equal(busy.status, 409);
  assert.match(busy.body.error, /已在整理中/);
  app.orchestrator.consolidating.delete('group:1');

  const invalid = await request('/api/memory-files/consolidate', {
    method: 'POST',
    body: { chatKey: 'group:not-a-number' }
  });
  assert.equal(invalid.status, 400);

  const files = await request('/api/memory-files');
  assert.equal(files.status, 200);
  const file = files.body.files.find((item) => item.chatKey === 'group:1');
  assert.ok(file);
  assert.equal(typeof file.consolidation?.status, 'string');
  assert.equal(typeof file.consolidation?.retryCount, 'number');
  assert.equal(file.consolidating, false);

  app.memory.markConsolidationAttempt('group:1', {
    result: 'partial_failed',
    error: '模型 API HTTP 401：Bearer sk-secret',
    retryMembers: [{ userId: '42', name: '甲', reason: '/srv/app 写入失败' }]
  });
  const after = await request('/api/memory-files');
  const partial = after.body.files.find((item) => item.chatKey === 'group:1');
  assert.equal(partial.consolidation.status, 'partial_failed');
  assert.equal(partial.consolidation.retryCount, 1);
  assert.equal('lastError' in partial.consolidation, false);
  assert.doesNotMatch(JSON.stringify(partial), /sk-secret|\/srv\/app/);
});
