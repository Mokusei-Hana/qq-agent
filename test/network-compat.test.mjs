// 出站连接兼容层：确保 Happy Eyeballs 的尝试窗口被放宽，
// 否则在「目标有 AAAA 记录、本机无 IPv6 路由」的机器上，
// IPv4 建连略慢于 250ms 时 undici 会抛 `TypeError: fetch failed`。
import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';

const { installNetworkCompat } = await import('../src/network-compat.js');

test('network-compat：放宽 autoSelectFamily 尝试窗口，但不动请求超时', (t) => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(before));

  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  const outcome = installNetworkCompat({});

  assert.equal(outcome.applied, true);
  assert.equal(outcome.attemptTimeoutMs, 2500);
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 2500);
});

test('network-compat：QQ_AGENT_NET_KEEP_DEFAULT 保留 Node 默认行为', (t) => {
  const before = net.getDefaultAutoSelectFamilyAttemptTimeout();
  t.after(() => net.setDefaultAutoSelectFamilyAttemptTimeout(before));

  net.setDefaultAutoSelectFamilyAttemptTimeout(250);
  const outcome = installNetworkCompat({ keepDefault: '1' });

  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'disabled-by-env');
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 250);
});

test('network-compat：运行时不支持该 API 时安全跳过', (t) => {
  const original = net.setDefaultAutoSelectFamilyAttemptTimeout;
  t.after(() => { net.setDefaultAutoSelectFamilyAttemptTimeout = original; });

  net.setDefaultAutoSelectFamilyAttemptTimeout = undefined;
  const outcome = installNetworkCompat({});

  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'unsupported-runtime');
});
