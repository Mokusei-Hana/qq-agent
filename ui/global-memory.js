'use strict';

(function globalPersonMemoryConsole() {
  const MARKER = 'qq-agent-console';
  let people = [];
  let selectedKey = '';
  let loadSeq = 0;
  let loadState = 'idle';       // idle | loading | ready | error
  let loadError = '';
  let actionState = { key: '', kind: '', text: '' }; // kind: consolidating | done | error

  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const fmtTime = (ts) => {
    const n = Number(ts) || 0;
    if (!n) return '-';
    const d = new Date(n);
    const pad = (x) => String(x).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: {
        'content-type': 'application/json',
        'x-console-token': MARKER,
        ...(options.headers || {})
      },
      ...options
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    return data;
  }

  function ensureStyle() {
    if (document.getElementById('global-memory-style')) return;
    const style = document.createElement('style');
    style.id = 'global-memory-style';
    style.textContent = `
      #view-people-memory { min-width:0; }
      #global-memory-list { display:flex; flex-direction:column; }
      #global-memory-items { overflow:auto; min-height:0; }
      .gm-head { display:flex; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--border-color, rgba(128,128,128,.2)); }
      .gm-head strong { flex:1; }
      .gm-person { display:block; width:100%; border:0; border-bottom:1px solid var(--border-color, rgba(128,128,128,.15)); background:transparent; color:inherit; text-align:left; padding:11px 12px; cursor:pointer; }
      .gm-person:hover, .gm-person.active { background:var(--hover-bg, rgba(127,127,127,.10)); }
      .gm-person-title { display:flex; gap:8px; align-items:center; }
      .gm-person-title strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gm-count { margin-left:auto; font-size:12px; opacity:.7; }
      .gm-sub { margin-top:4px; font-size:12px; opacity:.65; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gm-toolbar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
      .gm-chip { display:inline-block; padding:2px 7px; margin:2px 4px 2px 0; border-radius:999px; font-size:12px; background:rgba(127,127,127,.12); }
      .gm-memory { margin:10px 0; padding:12px; border:1px solid var(--border-color, rgba(128,128,128,.2)); border-radius:10px; }
      .gm-memory-content { white-space:pre-wrap; line-height:1.55; }
      .gm-memory-meta { margin-top:7px; font-size:12px; opacity:.65; }
      .gm-section { margin:16px 0; }
      .gm-section h3 { margin:0 0 8px; }
      .gm-note { padding:10px 12px; margin:0 0 12px; border-radius:8px; background:rgba(127,127,127,.08); font-size:13px; line-height:1.5; }
      .gm-empty { padding:24px 14px; opacity:.6; }
      .gm-empty-guide { opacity:1; line-height:1.65; }
      .gm-empty-guide .gm-guide-text { max-width:520px; }
      .gm-error { opacity:1; color:#e05a5a; }
      .gm-status { font-size:12px; opacity:.75; }
      .gm-status-error { color:#e05a5a; opacity:1; }
      .gm-status-warning { color:#d49b2f; opacity:1; }
      .gm-status-running { color:var(--accent-color, #4f9cf9); opacity:1; }
    `;
    document.head.appendChild(style);
  }

  function viewParts() {
    ensureStyle();
    const view = document.getElementById('view-people-memory');
    const list = document.getElementById('global-memory-list');
    const detail = document.getElementById('global-memory-detail');
    const items = document.getElementById('global-memory-items');
    return view && list && detail && items ? { view, list, detail, items } : null;
  }

  async function mapLimit(items, limit, worker) {
    if (!items.length) return [];
    const output = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        try { output[index] = await worker(items[index], index); }
        catch { output[index] = null; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
  }

  function mergePerson(target, incoming) {
    if (!target) return structuredClone(incoming);
    const merged = { ...target };
    merged.name = incoming.name || merged.name;
    merged.updatedAt = Math.max(Number(merged.updatedAt) || 0, Number(incoming.updatedAt) || 0);
    merged.lastConsolidatedAt = Math.max(
      Number(merged.lastConsolidatedAt) || 0,
      Number(incoming.lastConsolidatedAt) || 0
    );
    merged.sourceChatKeys = [...new Set([
      ...(merged.sourceChatKeys || []),
      ...(incoming.sourceChatKeys || [])
    ].map(String).filter(Boolean))];

    const memoryMap = new Map();
    for (const item of [...(merged.impressions || []), ...(incoming.impressions || [])]) {
      const content = String(item?.content || '').trim();
      if (!content) continue;
      const old = memoryMap.get(content);
      if (!old) {
        memoryMap.set(content, structuredClone(item));
        continue;
      }
      old.createdAt = Math.min(Number(old.createdAt) || Infinity, Number(item.createdAt) || Infinity);
      if (!Number.isFinite(old.createdAt)) old.createdAt = 0;
      old.lastObservedAt = Math.max(Number(old.lastObservedAt) || 0, Number(item.lastObservedAt) || 0);
      old.sourceChatKeys = [...new Set([
        ...(old.sourceChatKeys || []),
        ...(item.sourceChatKeys || [])
      ].map(String).filter(Boolean))];
    }
    merged.impressions = [...memoryMap.values()].sort((a, b) =>
      (Number(b.lastObservedAt) || Number(b.createdAt) || 0)
      - (Number(a.lastObservedAt) || Number(a.createdAt) || 0));
    return merged;
  }

  async function fetchPeople() {
    // /api/memory-files 仍是兼容入口；每个 detail 返回的是 GlobalPersonMemoryStore
    // 在该 sourceChatKey 可见的人物。这里只按 QQ 合并，sourceChatKeys 仅保留来源。
    const summary = await api('/api/memory-files');
    const files = Array.isArray(summary.files) ? summary.files : [];
    const sourceFiles = files.filter((file) => Number(file.impressionCount) > 0);
    const details = await mapLimit(sourceFiles, 6, async (file) => {
      const path = String(file.chatKey || '').replace(':', '_');
      if (!/^(group|private)_\d+$/.test(path)) return null;
      return api(`/api/memory-files/${path}`);
    });
    // 有来源却一条都没读到 = 后端/接口故障，不能当成“没有人物记忆”。
    if (sourceFiles.length > 0 && details.every((detail) => !detail)) {
      throw new Error('人物记忆详情读取失败');
    }

    const map = new Map();
    for (const detail of details) {
      for (const member of Array.isArray(detail?.members) ? detail.members : []) {
        const userId = String(member.userId || '').trim();
        const key = userId || `name:${String(member.name || '')}`;
        if (!key || key === 'name:') continue;
        map.set(key, mergePerson(map.get(key), member));
      }
    }
    return [...map.entries()]
      .map(([key, member]) => ({ key, ...member }))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  }

  const EMPTY_GUIDE = '还没有人物长期记忆。请前往会话记忆页，选择群聊并执行一次“整理本群记忆”。';

  function goToSessionMemory() {
    // 按页签文字定位，避免人物记忆页直接依赖会话记忆页的内部 data-tab 标记。
    const tab = [...document.querySelectorAll('.tab')]
      .find((item) => item.textContent.trim() === '会话记忆');
    if (tab) tab.click();
  }

  function statusClass(kind) {
    if (kind === 'error') return 'gm-status gm-status-error';
    if (kind === 'warning') return 'gm-status gm-status-warning';
    if (kind === 'consolidating') return 'gm-status gm-status-running';
    return 'gm-status';
  }

  function renderList() {
    const box = document.getElementById('global-memory-items');
    if (!box) return;
    if (loadState === 'error') {
      box.innerHTML = `<div class="gm-empty gm-error">人物记忆加载失败：${esc(loadError || '未知错误')}
        <div class="gm-toolbar"><button type="button" class="btn btn-small" id="gm-list-retry">重试</button></div>
      </div>`;
      box.querySelector('#gm-list-retry')?.addEventListener('click', () => loadGlobalMemory(true));
      return;
    }
    if (loadState === 'loading' && !people.length) {
      box.innerHTML = '<div class="gm-empty">正在读取人物记忆…</div>';
      return;
    }
    if (!people.length) {
      box.innerHTML = `<div class="gm-empty gm-empty-guide">
        <div class="gm-guide-text">${EMPTY_GUIDE}</div>
        <div class="gm-toolbar"><button type="button" class="btn btn-small" id="gm-goto-session">前往会话记忆页</button></div>
      </div>`;
      box.querySelector('#gm-goto-session')?.addEventListener('click', goToSessionMemory);
      return;
    }
    box.innerHTML = people.map((person) => {
      const sources = person.sourceChatKeys || [];
      const title = person.name || person.userId || '未知人物';
      const subtitle = person.userId
        ? `QQ ${person.userId} · ${sources.length} 个来源会话`
        : `${sources.length} 个来源会话`;
      return `<button type="button" class="gm-person ${person.key === selectedKey ? 'active' : ''}" data-gm-key="${esc(person.key)}">
        <div class="gm-person-title"><strong>${esc(title)}</strong><span class="gm-count">${(person.impressions || []).length} 条</span></div>
        <div class="gm-sub">${esc(subtitle)}</div>
      </button>`;
    }).join('');
    box.querySelectorAll('[data-gm-key]').forEach((button) => {
      button.addEventListener('click', () => {
        selectedKey = button.dataset.gmKey || '';
        renderList();
        renderDetail();
      });
    });
  }

  function sourceFor(person) {
    return (person?.sourceChatKeys || [])
      .find((key) => /^(group|private):\d+$/.test(String(key))) || '';
  }

  async function consolidatePerson(person) {
    const chatKey = sourceFor(person);
    const userId = String(person?.userId || '').trim();
    if (!chatKey || !/^\d{1,15}$/.test(userId)) {
      throw new Error('缺少可用于整理的来源会话或 QQ 号');
    }
    await api('/api/memory-files/consolidate', {
      method: 'POST',
      body: JSON.stringify({ chatKey, userIds: [userId], force: true })
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function readConsolidationStatus(chatKey) {
    const summary = await api('/api/memory-files');
    const file = (Array.isArray(summary.files) ? summary.files : [])
      .find((item) => item.chatKey === chatKey);
    if (!file) return null;
    return {
      consolidating: file.consolidating === true,
      status: String(file.consolidation?.status || ''),
      retryCount: Math.max(0, Number(file.consolidation?.retryCount) || 0)
    };
  }

  /**
   * 轮询后端整理状态，直到任务结束或达到上限。
   * 只读取状态字段，不把内部异常或聊天内容带进页面。
   */
  async function waitForConsolidationOutcome(chatKey, { attempts = 90, intervalMs = 2500 } = {}) {
    let failures = 0;
    for (let i = 0; i < attempts; i += 1) {
      await sleep(intervalMs + (failures ? Math.min(30000, failures * 2000) : 0));
      let state;
      try {
        state = await readConsolidationStatus(chatKey);
        failures = 0;
      } catch {
        failures += 1;
        continue;
      }
      if (!state) return { status: 'unknown', text: '整理状态暂时不可用，请稍后刷新查看' };
      if (state.consolidating) continue;
      if (state.status === 'success') return { status: 'success', text: '整理完成' };
      if (state.status === 'partial_failed') {
        return {
          status: 'partial_failed',
          text: `部分完成：${state.retryCount} 位成员失败，稍后会自动重试`
        };
      }
      if (state.status === 'failed') {
        return { status: 'failed', text: '整理失败，已保留原印象，稍后会自动重试' };
      }
      if (state.status === 'no_targets') return { status: 'no_targets', text: '没有可整理的群友' };
      if (state.status === 'running') {
        return { status: 'failed', text: '上次整理未正常结束，稍后会自动重试' };
      }
      return { status: state.status || 'unknown', text: '整理已结束，但未能确认结果，请刷新查看' };
    }
    return { status: 'timeout', text: '整理仍在进行或结果未知，请稍后刷新查看' };
  }

  async function deletePerson(person) {
    const chatKey = sourceFor(person);
    const userId = String(person?.userId || '').trim();
    if (!chatKey || !/^\d{1,15}$/.test(userId)) {
      throw new Error('缺少可删除的来源会话或 QQ 号');
    }
    // 当前 MemoryStore.removeMember() 的语义是按 QQ 删除全局人物，不按 chatKey 局部删除；
    // chatKey 这里只用于兼容旧 HTTP 路由形状。
    await api(`/api/memory-files/${chatKey.replace(':', '_')}/members/${userId}`, {
      method: 'DELETE'
    });
  }

  function renderDetail() {
    const box = document.getElementById('global-memory-detail');
    if (!box) return;
    const person = people.find((item) => item.key === selectedKey);
    if (!person) {
      if (loadState === 'error') {
        box.innerHTML = `<div class="empty-hint gm-error">人物记忆加载失败：${esc(loadError || '未知错误')}</div>`;
      } else if (!people.length && loadState !== 'loading') {
        box.innerHTML = `<div class="empty-hint">${EMPTY_GUIDE}</div>`;
      } else {
        box.innerHTML = '<div class="empty-hint">← 选择人物查看全局长期记忆</div>';
      }
      return;
    }

    const sourceHtml = (person.sourceChatKeys || []).length
      ? person.sourceChatKeys.map((key) => `<span class="gm-chip">${esc(key)}</span>`).join('')
      : '<span class="muted">无来源记录</span>';
    const memories = person.impressions || [];
    const memoryHtml = memories.length
      ? memories.map((item) => {
          const sources = (item.sourceChatKeys || [])
            .map((key) => `<span class="gm-chip">${esc(key)}</span>`).join('');
          const at = Number(item.lastObservedAt) || Number(item.createdAt) || 0;
          return `<div class="gm-memory">
            <div class="gm-memory-content">${esc(item.content)}</div>
            <div class="gm-memory-meta">最近确认 ${esc(fmtTime(at))}</div>
            <div>${sources || '<span class="muted">无来源</span>'}</div>
          </div>`;
        }).join('')
      : '<div class="gm-empty">这个人目前没有长期印象。可以点上方“重新整理人物记忆”，或前往会话记忆页整理本群记忆。</div>';
    const manageable = /^\d{1,15}$/.test(String(person.userId || ''))
      && Boolean(sourceFor(person));
    const action = actionState.key === person.key ? actionState : { kind: '', text: '' };

    box.innerHTML = `
      <div class="detail-header">
        <h2>${esc(person.name || person.userId || '未知人物')}</h2>
        <div class="sub">${person.userId ? `QQ ${esc(person.userId)} · ` : ''}${memories.length} 条全局长期印象</div>
        <div class="gm-toolbar">
          <button class="btn btn-small" type="button" id="gm-consolidate" ${manageable ? '' : 'disabled'}>重新整理人物记忆</button>
          <button class="btn btn-small btn-danger" type="button" id="gm-delete" ${manageable ? '' : 'disabled'}>删除全部人物记忆</button>
          <span class="${statusClass(action.kind)}" id="gm-action-status">${esc(action.text || '')}</span>
        </div>
      </div>
      <div class="gm-note">
        人物长期记忆按 QQ 全局统一；来源会话只用于证据追溯，不限制这条记忆在哪个群可见。<br>
        群聊/私聊自己的 handoff 已独立到“会话记忆”页，并继续严格按 chatKey 隔离。
      </div>
      <div class="gm-section"><h3>来源会话</h3><div>${sourceHtml}</div></div>
      <div class="gm-section"><h3>长期印象</h3>${memoryHtml}</div>`;

    const status = box.querySelector('#gm-action-status');
    const setAction = (kind, text) => {
      actionState = { key: person.key, kind, text };
      if (!status) return;
      status.className = statusClass(kind);
      status.textContent = text;
    };
    box.querySelector('#gm-consolidate')?.addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      setAction('consolidating', '正在整理人物记忆…');
      try {
        const chatKey = sourceFor(person);
        await consolidatePerson(person);
        setAction('consolidating', '整理中，正在等待结果…');
        const outcome = await waitForConsolidationOutcome(chatKey);
        if (outcome.status === 'failed') setAction('error', outcome.text);
        else if (outcome.status === 'partial_failed' || outcome.status === 'timeout' || outcome.status === 'unknown') {
          setAction('warning', outcome.text);
        } else setAction('done', outcome.text);
        await loadGlobalMemory(true);
      } catch (error) {
        setAction('error', `整理请求失败：${error?.message || error}`);
        button.disabled = false;
      }
    });
    box.querySelector('#gm-delete')?.addEventListener('click', async (event) => {
      if (!window.confirm(`确定删除 ${person.name || person.userId} 的全部全局人物记忆？此操作不会删除聊天记录。`)) return;
      const button = event.currentTarget;
      button.disabled = true;
      setAction('consolidating', '正在删除…');
      try {
        await deletePerson(person);
        selectedKey = '';
        actionState = { key: '', kind: '', text: '' };
        await loadGlobalMemory(true);
      } catch (error) {
        setAction('error', `删除失败：${error?.message || error}`);
        button.disabled = false;
      }
    });
  }

  async function loadGlobalMemory(force = false) {
    const ui = viewParts();
    if (!ui) return;
    const seq = ++loadSeq;
    loadState = 'loading';
    loadError = '';
    if (force || !people.length) renderList();
    try {
      const next = await fetchPeople();
      if (seq !== loadSeq) return;
      people = next;
      loadState = 'ready';
      if (selectedKey && !people.some((item) => item.key === selectedKey)) selectedKey = '';
      renderList();
      renderDetail();
    } catch (error) {
      if (seq !== loadSeq) return;
      // 后端故障必须显式显示为加载错误，不能伪装成“没有人物记忆”。
      loadState = 'error';
      loadError = String(error?.message || error);
      renderList();
      renderDetail();
    }
  }

  function activateIfNeeded() {
    const view = document.getElementById('view-people-memory');
    if (!view?.classList.contains('active')) return;
    loadGlobalMemory(false);
  }

  document.getElementById('gm-refresh')?.addEventListener('click', () => loadGlobalMemory(true));
  document.querySelector('[data-tab="people-memory"]')?.addEventListener('click', () => {
    // app.js 的通用 tab handler 先完成视图切换；随后刷新人物全局视图。
    setTimeout(() => loadGlobalMemory(true), 0);
  });

  window.addEventListener('focus', activateIfNeeded);
  setInterval(() => {
    const view = document.getElementById('view-people-memory');
    if (view?.classList.contains('active')) loadGlobalMemory(false);
  }, 15000);
})();
