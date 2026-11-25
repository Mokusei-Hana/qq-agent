'use strict';
(function () {
  const headers = { 'content-type': 'application/json', 'x-console-token': 'qq-agent-console' };
  async function update(body) {
    const response = await fetch('/api/personality-learning/settings', { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw Error(data.error); return data;
  }
  function install() {
    const section = document.querySelector('#settings-experiments')?.parentElement;
    if (!section || section.querySelector('#personality-learning-controls')) return;
    const row = document.createElement('div'); row.id = 'personality-learning-controls';
    row.innerHTML = '<b>人格自我迭代</b> <label><input type="checkbox"> 启用</label> <button type="button">固化</button> <a href="/personality-learning.html">打开独立页面</a> <span role="status"></span>';
    section.append(row);
    fetch('/api/personality-learning/status', { headers }).then(r => r.json()).then(s => {
      row.querySelector('input').checked = s.enabled; row.querySelector('button').disabled = s.graduated;
      row.querySelector('span').textContent = s.active ? s.mode === 'observe' ? '观察中' : '动态模式' : '已停用';
    }).catch(() => { row.querySelector('span').textContent = '状态不可用'; });
    row.querySelector('input').onchange = async event => {
      try { await update({ enabled: event.target.checked }); location.reload(); }
      catch (error) { event.target.checked = !event.target.checked; row.querySelector('span').textContent = error.message; }
    };
    row.querySelector('button').onclick = async () => {
      if (!confirm('固化人格学习的独立导航入口？运行开关仍独立控制。')) return;
      try { await update({ graduated: true, confirm: true }); location.reload(); }
      catch (error) { row.querySelector('span').textContent = error.message; }
    };
  }
  const old = window.renderSettings;
  if (typeof old === 'function') window.renderSettings = function (...args) { const value = old.apply(this, args); install(); return value; };
  fetch('/api/personality-learning/status', { headers }).then(r => r.json()).then(s => {
    if (!s.graduated || document.querySelector('#personality-learning-nav')) return;
    const link = document.createElement('a'); link.id = 'personality-learning-nav'; link.href = '/personality-learning.html'; link.textContent = '人格自我迭代'; document.querySelector('#tabs')?.append(link);
  }).catch(() => {});
  install();
})();
