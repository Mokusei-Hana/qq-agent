// Exa 自定义搜索（type = 'exa'）的请求构造、响应解析与失败处理。
// 全部使用假的 fetch，不触网、不需要真实 API Key。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-exa-search-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { DEFAULT_CONFIG, setRuntimeConfig } = await import('../src/config.js');
const { customSearch, bingSearch } = await import('../src/web-search.js');
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** 给定 webSearch 片段，装一份配置，并把 fetch 换成记录请求的假实现。 */
function setup(t, webSearchPatch, responder) {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.api.model = 'mock';
  cfg.api.baseUrl = 'https://model.invalid';
  cfg.runtime.mode = 'active';
  cfg.allow.groups = ['1'];
  cfg.allow.private = ['2'];
  cfg.memory.consolidateEnabled = false;
  cfg.sticker.enabled = false;
  cfg.timeControl = { enabled: false, schedule: { mode: 'custom', windows: [] }, overrides: {} };
  cfg.webSearch = {
    ...cfg.webSearch,
    provider: 'custom:exa1',
    maxResults: 6,
    providers: [{
      id: 'exa1',
      name: 'Exa',
      type: 'exa',
      baseUrl: 'https://api.exa.ai/search',
      apiKey: 'test-exa-key',
      model: '',
      count: 6,
      timeoutMs: 20000
    }],
    ...webSearchPatch
  };
  setRuntimeConfig(cfg);

  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return responder(String(url), options);
  };
  t.after(() => { globalThis.fetch = original; });
  return { cfg, calls };
}

const exaPayload = {
  requestId: 'req-1',
  results: [
    {
      title: 'Transformer latency',
      url: 'https://example.com/latency',
      highlights: ['Inference providers cut latency 40%.', 'Batching helps.'],
      summary: 'summary fallback'
    }
  ]
};

test('exa：POST 到配置的端点，认证用 x-api-key，请求体符合官方结构', async (t) => {
  const { calls } = setup(t, {}, () => Response.json(exaPayload));

  const out = await customSearch('transformer latency', 'custom:exa1');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.exa.ai/search');
  assert.equal(calls[0].options.method, 'POST');

  const headers = calls[0].options.headers;
  assert.equal(headers['x-api-key'], 'test-exa-key');
  assert.equal(headers['content-type'], 'application/json');
  // 关键回归点：绝对不能退回 Bearer 认证
  assert.equal(headers.authorization, undefined);

  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.query, 'transformer latency');
  assert.equal(body.type, 'auto');
  assert.equal(body.numResults, 6);
  assert.deepEqual(body.contents, { highlights: true });
  // 不该混入其他提供方的字段
  assert.equal(body.q, undefined);
  assert.equal(body.model, undefined);
  assert.equal(body.messages, undefined);

  assert.equal(out.query, 'transformer latency');
  assert.deepEqual(out.results, [{
    title: 'Transformer latency',
    url: 'https://example.com/latency',
    snippet: 'Inference providers cut latency 40%. … Batching helps.'
  }]);
});

test('exa：highlights 为空时回退 summary，再回退 text', async (t) => {
  setup(t, {}, () => Response.json({
    results: [
      { title: 'A', url: 'https://a.example.com/1', highlights: [], summary: 'from summary' },
      { title: 'B', url: 'https://b.example.com/2', highlights: [], text: 'from text' },
      { title: 'C', url: 'https://c.example.com/3', highlights: [] }
    ]
  }));

  const out = await customSearch('q', 'custom:exa1');
  assert.equal(out.results[0].snippet, 'from summary');
  assert.equal(out.results[1].snippet, 'from text');
  // 没有摘要也不报错，只是空串
  assert.equal(out.results[2].snippet, '');
});

test('exa：标题缺失用默认值，非字符串/空白高亮被安全丢弃', async (t) => {
  setup(t, {}, () => Response.json({
    results: [
      { url: 'https://x.example.com/1', highlights: ['   ', '', null, 42, '有效片段'] }
    ]
  }));

  const out = await customSearch('q', 'custom:exa1');
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, '（无标题）');
  assert.equal(out.results[0].snippet, '有效片段');
});

test('exa：过滤非 http(s) 链接与无链接结果', async (t) => {
  setup(t, {}, () => Response.json({
    results: [
      { title: 'mailto', url: 'mailto:a@b.com', highlights: ['x'] },
      { title: 'js', url: 'javascript:alert(1)', highlights: ['x'] },
      { title: 'bad', url: 'not a url', highlights: ['x'] },
      { title: 'empty', url: '', highlights: ['x'] },
      { title: 'no url', highlights: ['x'] },
      { title: 'ok', url: 'https://ok.example.com/p', highlights: ['x'] }
    ]
  }));

  const out = await customSearch('q', 'custom:exa1');
  assert.deepEqual(out.results.map((r) => r.title), ['ok']);
});

test('exa：请求条数受 cfg.count 限制（默认 6，上限 10），输出受 maxResults 限制', async (t) => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    title: `t${i}`, url: `https://e.example.com/${i}`, highlights: ['h']
  }));

  // 未设 count → 默认 6
  const first = setup(t, {}, () => Response.json({ results: many }));
  await customSearch('q', 'custom:exa1');
  assert.equal(JSON.parse(first.calls[0].options.body).numResults, 6);

  // count 超过 10 → 收敛到 10
  const second = setup(t, {
    providers: [{
      id: 'exa1', name: 'Exa', type: 'exa', baseUrl: 'https://api.exa.ai/search',
      apiKey: 'test-exa-key', count: 50, timeoutMs: 20000
    }]
  }, () => Response.json({ results: many }));
  await customSearch('q', 'custom:exa1');
  assert.equal(JSON.parse(second.calls[0].options.body).numResults, 10);

  // 最终输出看 webSearch.maxResults
  const third = setup(t, {
    maxResults: 3,
    providers: [{
      id: 'exa1', name: 'Exa', type: 'exa', baseUrl: 'https://api.exa.ai/search',
      apiKey: 'test-exa-key', count: 10, timeoutMs: 20000
    }]
  }, () => Response.json({ results: many }));
  const out = await customSearch('q', 'custom:exa1');
  assert.equal(out.results.length, 3);
});

test('exa：缺少 API Key 时给出明确错误，且不发请求', async (t) => {
  const { calls } = setup(t, {
    providers: [{
      id: 'exa1', name: 'Exa', type: 'exa', baseUrl: 'https://api.exa.ai/search',
      apiKey: '', model: '', count: 6, timeoutMs: 20000
    }]
  }, () => Response.json(exaPayload));

  const saved = process.env.EXA_API_KEY;
  delete process.env.EXA_API_KEY;
  t.after(() => { if (saved !== undefined) process.env.EXA_API_KEY = saved; });

  await assert.rejects(customSearch('q', 'custom:exa1'), /Exa 搜索需要 API Key/);
  assert.equal(calls.length, 0);
});

test('exa：环境变量 EXA_API_KEY 可作为 Key 兜底', async (t) => {
  const { calls } = setup(t, {
    providers: [{
      id: 'exa1', name: 'Exa', type: 'exa', baseUrl: 'https://api.exa.ai/search',
      apiKey: '', count: 6, timeoutMs: 20000
    }]
  }, () => Response.json(exaPayload));

  const saved = process.env.EXA_API_KEY;
  process.env.EXA_API_KEY = 'env-exa-key';
  t.after(() => {
    if (saved === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = saved;
  });

  await customSearch('q', 'custom:exa1');
  assert.equal(calls[0].options.headers['x-api-key'], 'env-exa-key');
});

for (const status of [401, 403, 429, 500]) {
  test(`exa：HTTP ${status} 不会被伪装成成功结果`, async (t) => {
    setup(t, {}, () => new Response(JSON.stringify({ error: 'nope' }), {
      status,
      headers: { 'content-type': 'application/json' }
    }));

    await assert.rejects(customSearch('q', 'custom:exa1'), (error) => {
      assert.match(error.message, new RegExp(`Exa 搜索 HTTP ${status}`));
      // 错误文本里不能出现 Key
      assert.ok(!error.message.includes('test-exa-key'));
      return true;
    });
  });
}

test('exa：异常响应结构（缺 results / 非 JSON / 空结果）明确报错', async (t) => {
  setup(t, {}, () => Response.json({ requestId: 'x', noResults: true }));
  await assert.rejects(customSearch('q', 'custom:exa1'), /结构异常/);

  setup(t, {}, () => new Response('<html>not json</html>', { status: 200 }));
  await assert.rejects(customSearch('q', 'custom:exa1'), /无法解析的 JSON/);

  setup(t, {}, () => Response.json({ results: [] }));
  await assert.rejects(customSearch('q', 'custom:exa1'), /没有返回有效结果/);

  // 有 results 但全被 URL 过滤掉，也算没有有效结果
  setup(t, {}, () => Response.json({ results: [{ title: 'x', url: 'ftp://f/x' }] }));
  await assert.rejects(customSearch('q', 'custom:exa1'), /没有返回有效结果/);
});

test('exa：查询词仍然经过 sanitizeQuery 清洗', async (t) => {
  const { calls } = setup(t, {}, () => Response.json(exaPayload));
  await customSearch('[CQ:face,id=1]  ab\n\ncd  ', 'custom:exa1');
  assert.equal(JSON.parse(calls[0].options.body).query, 'ab cd');
});

test('exa：非活跃时间下仍被 time-gate 拦下，不发请求', async (t) => {
  const { cfg, calls } = setup(t, {}, () => Response.json(exaPayload));
  setRuntimeConfig({
    ...cfg,
    timeControl: { enabled: true, schedule: { mode: 'custom', windows: [] }, overrides: {} }
  });

  await assert.rejects(customSearch('q', 'custom:exa1'), { code: 'TIME_CONTROL_INACTIVE' });
  assert.equal(calls.length, 0);
});

test('exa：超时使用 signal 中断（不会被当成空结果）', async (t) => {
  let signal;
  setup(t, {
    providers: [{
      id: 'exa1', name: 'Exa', type: 'exa', baseUrl: 'https://api.exa.ai/search',
      apiKey: 'test-exa-key', count: 6, timeoutMs: 5000
    }]
  }, (_url, options) => new Promise((_resolve, reject) => {
    // 只认 abort，模拟请求悬挂后被超时打断
    signal = options?.signal;
    assert.ok(signal, '必须把 AbortSignal 传给 fetch');
    assert.equal(signal.aborted, false);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));

  // AbortSignal.timeout 用的是 unref 定时器，不会自己撑住事件循环；
  // 这里用一个 ref'd 定时器把循环留到超时点，保证 Windows/Linux 行为一致。
  const pending = customSearch('q', 'custom:exa1');
  const keepAlive = new Promise((resolve) => setTimeout(resolve, 5600));
  const [outcome] = await Promise.all([pending.then(() => 'resolved', (e) => e), keepAlive]);

  assert.notEqual(outcome, 'resolved', '超时不能返回结果');
  assert.equal(signal.aborted, true, '超时后 signal 必须已 abort');
  assert.equal(outcome?.name, 'TimeoutError');
}, { timeout: 30000 });

test('其他提供方不受影响：openai 类型仍用 Bearer，bing 类型仍走页面解析', async (t) => {
  // openai 自定义：保持原有 Bearer + query/q/top_k 结构
  const openai = setup(t, {
    providers: [{
      id: 'oa1', name: 'SearXNG', type: 'openai', baseUrl: 'https://search.example.com/api',
      apiKey: 'oa-key', count: 6, timeoutMs: 20000
    }]
  }, () => Response.json({ results: [{ title: 'T', url: 'https://t.example.com', content: 'C' }] }));

  const out = await customSearch('q', 'custom:oa1');
  assert.equal(openai.calls[0].options.headers.authorization, 'Bearer oa-key');
  assert.equal(openai.calls[0].options.headers['x-api-key'], undefined);
  assert.equal(JSON.parse(openai.calls[0].options.body).q, 'q');
  assert.equal(out.results[0].snippet, 'C');

  // bing 类型：GET 页面 + b_algo 解析，完全不走 exa 分支
  const bingProv = setup(t, {
    searchUrl: 'https://cn.bing.com/search',
    providers: [{
      id: 'bg1', name: 'Bing', type: 'bing', baseUrl: 'https://cn.bing.com/search',
      count: 6, timeoutMs: 20000
    }]
  }, () => new Response(
    '<li class="b_algo"><h2><a href="https://r.example.com/x">R</a></h2><p>desc</p></li>',
    { status: 200 }
  ));

  const bingOut = await customSearch('q', 'custom:bg1');
  assert.match(bingProv.calls[0].url, /cn\.bing\.com/);
  assert.equal(bingProv.calls[0].options.method, undefined); // GET
  assert.equal(bingOut.results[0].title, 'R');

  // 内置 bingSearch 也照旧
  const plain = setup(t, {}, () => new Response(
    '<li class="b_algo"><h2><a href="https://r.example.com/y">Y</a></h2><p>d</p></li>',
    { status: 200 }
  ));
  const plainOut = await bingSearch('q');
  assert.equal(plainOut.results[0].url, 'https://r.example.com/y');
  assert.equal(plain.calls[0].options.headers['x-api-key'], undefined);
});
