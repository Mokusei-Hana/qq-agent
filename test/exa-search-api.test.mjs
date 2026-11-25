// 管理后台「添加自定义搜索服务」的 API 契约：type=exa 必须原样落盘，
// 不能被旧的白名单逻辑改写成 openai（否则前端选了 Exa 也搜不出来）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-exa-api-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { DEFAULT_CONFIG, getConfig, updateConfig } = await import('../src/config.js');
const { createApp } = await import('../src/app.js');
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('搜索服务 API：exa 类型被保留，未知类型回落 openai，Key 不回传明文', async (t) => {
  const port = await freePort();
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.server = { ...cfg.server, host: '127.0.0.1', port, token: 'exa-console-token' };
  cfg.onebot.wsUrl = 'ws://127.0.0.1:1';
  cfg.allow.private = [];
  cfg.allow.groups = [];
  cfg.memory.consolidateEnabled = false;
  cfg.sticker.enabled = false;
  cfg.webSearch = { ...cfg.webSearch, providers: [], provider: 'bing' };
  updateConfig(cfg);

  const app = createApp({ log: () => {} });
  await app.start();
  t.after(async () => { await app.stop(); });

  const request = async (route, method = 'GET', body = null) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-console-token': cfg.server.token
      },
      body: body ? JSON.stringify(body) : undefined
    });
    return { response, body: await response.json() };
  };

  // 1) 选中 Exa provider
  const selected = await request('/api/config', 'POST', {
    webSearch: { provider: 'custom:exa1' }
  });
  assert.equal(selected.response.status, 200);

  // 2) 新增 Exa 服务：type 必须原样保存
  const added = await request('/api/search-providers', 'POST', {
    name: 'Exa',
    type: 'exa',
    baseUrl: 'https://api.exa.ai/search',
    apiKey: 'exa-secret-key',
    model: ''
  });
  assert.equal(added.response.status, 200);
  assert.equal(added.body.provider.type, 'exa');
  assert.equal(added.body.provider.hasApiKey, true);
  // 响应里不能出现明文 Key
  assert.equal(JSON.stringify(added.body).includes('exa-secret-key'), false);

  const saved = (getConfig().webSearch.providers || []).find((p) => p.type === 'exa');
  assert.ok(saved, 'Exa provider 应该写进 webSearch.providers');
  assert.equal(saved.baseUrl, 'https://api.exa.ai/search');
  assert.equal(saved.apiKey, 'exa-secret-key');

  // 3) 列表接口不泄 Key，但报告存在性
  const list = await request('/api/search-providers');
  assert.equal(list.response.status, 200);
  const entry = list.body.providers.find((p) => p.type === 'exa');
  assert.ok(entry);
  assert.equal(entry.apiKey, undefined);
  assert.equal(entry.hasApiKey, true);
  assert.equal(JSON.stringify(list.body).includes('exa-secret-key'), false);

  // 4) 再提交一次同 baseUrl+type 且 apiKey 留空 → 保持原 Key（幂等更新）
  const updated = await request('/api/search-providers', 'POST', {
    name: 'Exa 搜索',
    type: 'exa',
    baseUrl: 'https://api.exa.ai/search',
    apiKey: '',
    model: ''
  });
  assert.equal(updated.response.status, 200);
  const keptEntries = (getConfig().webSearch.providers || []).filter((p) => p.type === 'exa');
  assert.equal(keptEntries.length, 1, '同 baseUrl+type 不应重复新增');
  assert.equal(keptEntries[0].apiKey, 'exa-secret-key');
  assert.equal(keptEntries[0].name, 'Exa 搜索');

  // 5) bing / openai 类型不受影响
  const bingAdd = await request('/api/search-providers', 'POST', {
    name: 'Bing', type: 'bing', baseUrl: 'https://cn.bing.com/search'
  });
  assert.equal(bingAdd.body.provider.type, 'bing');

  const oaAdd = await request('/api/search-providers', 'POST', {
    name: 'SearXNG', type: 'openai', baseUrl: 'https://searx.example.com/api',
    apiKey: 'oa-key'
  });
  assert.equal(oaAdd.body.provider.type, 'openai');

  // 6) 未知类型必须回落 openai，脏值不入库
  const junkAdd = await request('/api/search-providers', 'POST', {
    name: 'Junk', type: 'definitely-not-a-type', baseUrl: 'https://junk.example.com/api'
  });
  assert.equal(junkAdd.response.status, 200);
  assert.equal(junkAdd.body.provider.type, 'openai');
  assert.equal(
    (getConfig().webSearch.providers || []).some((p) => p.type === 'definitely-not-a-type'),
    false
  );

  // 7) 删除 Exa 后选中项回落 bing（原有行为保持）
  const exaId = saved.id;
  const del = await request('/api/search-providers', 'DELETE', { id: exaId });
  assert.equal(del.response.status, 200);
  assert.equal(
    (getConfig().webSearch.providers || []).some((p) => p.id === exaId),
    false
  );

  // 8) 空 baseUrl 依旧拒绝
  const bad = await request('/api/search-providers', 'POST', { type: 'exa', baseUrl: '' });
  assert.equal(bad.response.status, 400);
});
