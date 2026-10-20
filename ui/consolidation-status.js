'use strict';

/**
 * 会话记忆页的整理状态校正工具。
 *
 * SSE 事件可能因为断线丢失；这里提供纯函数，用 /api/memory-files 的
 * consolidating / consolidation 字段校正前端状态，并给出有限轮询间隔。
 * 不依赖 DOM，便于在 Node 测试中直接验证。
 */
(function (root) {
  const POLL_MS = 12000;
  const MAX_POLL_MS = 60000;

  function consolidationNote(file) {
    const status = String(file?.consolidation?.status || '');
    const retryCount = Math.max(0, Number(file?.consolidation?.retryCount) || 0);
    if (status === 'success') return { kind: 'success', text: '整理完成' };
    if (status === 'partial_failed') {
      return {
        kind: 'partial',
        text: `部分完成：${retryCount} 位成员失败${retryCount ? '，稍后会自动重试' : ''}`
      };
    }
    if (status === 'failed') return { kind: 'failed', text: '整理失败，已保留原印象，稍后会自动重试' };
    if (status === 'no_targets') return { kind: 'done', text: '没有可整理的群友' };
    if (status === 'running') return { kind: 'failed', text: '上次整理未正常结束，稍后会自动重试' };
    return { kind: 'unknown', text: '整理已结束，但未能确认结果，请刷新查看' };
  }

  function resultEntry(file, now = Date.now()) {
    const note = consolidationNote(file);
    return {
      note: note.text,
      at: Number(file?.consolidation?.lastAttemptedAt) || now,
      failed: note.kind !== 'success' && note.kind !== 'done',
      status: String(file?.consolidation?.status || '')
    };
  }

  /**
   * 用后端文件列表校正前端 state：
   * - 后端仍在整理 → 保持/补上 "整理中"；
   * - 后端已结束 → 删除 "整理中"，写入真实结果；
   * - 列表里不存在的 chatKey 不做任何假设。
   */
  function reconcileConsolidationState(state, files, now = Date.now()) {
    const consolidating = state && state.consolidating ? state.consolidating : {};
    const results = state && state.consolidateResult ? state.consolidateResult : {};
    if (state && !state.consolidating) state.consolidating = consolidating;
    if (state && !state.consolidateResult) state.consolidateResult = results;
    const map = new Map();
    for (const file of Array.isArray(files) ? files : []) {
      if (file?.chatKey) map.set(String(file.chatKey), file);
    }
    let completed = false;
    let changed = false;
    for (const [chatKey, file] of map) {
      if (file.consolidating === true) {
        if (!consolidating[chatKey]) {
          // 页面刷新后发现的进行中任务：用后端尝试时间作为起点，避免后续被误判为旧结果。
          consolidating[chatKey] = {
            startedAt: Number(file?.consolidation?.lastAttemptedAt) || now
          };
          changed = true;
        }
        continue;
      }
      if (!consolidating[chatKey]) continue;
      const startedAt = Number(consolidating[chatKey]?.startedAt) || 0;
      const attemptedAt = Number(file?.consolidation?.lastAttemptedAt) || 0;
      delete consolidating[chatKey];
      // 后端本次没有留下尝试记录，或最新记录明显早于本轮任务：
      // 不能拿上一轮的成功/失败状态冒充本轮结果。
      const stale = startedAt > 0 && (!attemptedAt || attemptedAt < startedAt - 300000);
      results[chatKey] = stale
        ? { note: '整理已结束，但未能确认结果，请刷新查看', at: now, failed: true, status: '' }
        : resultEntry(file, now);
      completed = true;
      changed = true;
    }
    return { changed, completed, activeCount: Object.keys(consolidating).length };
  }

  /** 正常 12 秒；请求失败时 24/48/96 秒退避，封顶 60 秒。 */
  function nextPollDelay(failures = 0) {
    const n = Math.max(0, Number(failures) || 0);
    if (!n) return POLL_MS;
    return Math.min(MAX_POLL_MS, POLL_MS * (2 ** Math.min(3, n)));
  }

  root.QQAgentConsolidationStatus = { reconcileConsolidationState, nextPollDelay, consolidationNote };
})(typeof window !== 'undefined' ? window : globalThis);
