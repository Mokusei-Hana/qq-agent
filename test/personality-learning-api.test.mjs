import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-personality-api-'));
process.env.QQ_AGENT_DATA_DIR = root;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');

test('personality APIs reuse console authentication, preserve global config and validate mutations', async t => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server.token = 'isolated-test-console-token'; cfg.admin = { ownerUin: '12345678' };
  cfg.allow.groups = ['123']; cfg.runtime.mode = 'observe'; cfg.runtime.paused = true;
  cfg.api.baseUrl = 'http://127.0.0.1:1'; cfg.onebot.wsUrl = 'ws://127.0.0.1:1'; cfg.onebot.httpUrl = 'http://127.0.0.1:1';
  setRuntimeConfig(cfg);
  const configFile = path.join(root, 'config.json');
  const original = JSON.stringify(cfg); fs.writeFileSync(configFile, original);
  const app = createApp({ log: () => {} }); app.personalityLearning.start();
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function request(action, body, headers = { 'x-console-token': cfg.server.token }) {
    const response = await fetch(base + '/api/personality-learning/' + action, { headers: { ...headers, 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await request('status', null, {})).status, 401);
  assert.equal((await request('settings', { enabled: true }, { 'x-console-token': cfg.server.token, origin: 'https://evil.invalid' })).status, 401);
  assert.equal((await request('status')).data.databaseExists, false);
  assert.equal((await request('settings', { enabled: true, groups: ['789'] })).status, 400);
  const enabled = await request('settings', { enabled: true, groups: ['123'] });
  assert.equal(enabled.status, 200); assert.equal(enabled.data.mode, 'observe');
  assert.equal((await request('settings', { mode: 'dynamic', injectEnabled: true })).status, 400);
  assert.equal((await request('rollback', { version: 0, expectedVersion: 0 })).status, 409);
  assert.equal((await request('settings', { corePersona: 'overwrite' })).status, 400);
  assert.equal((await request('data')).status, 200);
  assert.equal((await request('analyze', { confirm: true })).status, 200);
  assert.equal((await request('settings', { enabled: false })).status, 200);
  assert.equal((await request('data')).status, 200);
  assert.equal(fs.readFileSync(configFile, 'utf8'), original);
  const html = await (await fetch(base + '/personality-learning.html')).text();
  assert.match(html, /人格自我迭代/); assert.match(html, /核心人设/);
});
