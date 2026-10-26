// 出站连接兼容层：修正 Happy Eyeballs 在本机无 IPv6 路由时的过度激进回退。
//
// 背景：Node 22 默认开启 autoSelectFamily（Happy Eyeballs）。当目标域名同时有
// A 和 AAAA 记录、但本机没有任何 IPv6 默认路由时，IPv6 尝试会立刻以
// ENETUNREACH 失败；Node 随后在 250ms 后并行发起另一地址族，若 IPv4 建连
// 略慢于 250ms，两个族都在窗口内失败，undici 抛出 `TypeError: fetch failed`。
//
// 实测（api.exa.ai，直连 RTT 约 300ms，本机无 IPv6 路由）：
//   - Node 默认（250ms）：连续 6 次 fetch 仅 1 次成功，其余 ETIMEDOUT
//   - attemptTimeout 放宽到 2500ms：连续 8 次 fetch 全部成功
//
// 放宽该窗口对真正具备 IPv6 的机器没有负面影响（只是 IPv6 回退更晚），
// 因为 IPv6 一旦可用会正常建连，不会走到回退分支。
import net from 'node:net';

// 高于常见跨境 RTT，又远低于常规请求超时，避免把慢网络当成失败。
const ATTEMPT_TIMEOUT_MS = 2500;

/** 只放宽尝试窗口，不放宽请求本身超时（请求超时仍由各调用点的 AbortSignal 控制）。 */
export function installNetworkCompat({ keepDefault = process.env.QQ_AGENT_NET_KEEP_DEFAULT } = {}) {
  if (keepDefault) return { applied: false, reason: 'disabled-by-env' };
  if (typeof net.setDefaultAutoSelectFamilyAttemptTimeout !== 'function') {
    return { applied: false, reason: 'unsupported-runtime' };
  }
  net.setDefaultAutoSelectFamilyAttemptTimeout(ATTEMPT_TIMEOUT_MS);
  return { applied: true, attemptTimeoutMs: ATTEMPT_TIMEOUT_MS };
}
