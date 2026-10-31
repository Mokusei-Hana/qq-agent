'use strict';
const $ = id => document.getElementById(id);
let status = null, dirty = false, busy = false;
async function request(action, body) {
  const response = await fetch('/api/personality-learning/' + action, { method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-console-token': 'qq-agent-console' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '操作失败');
  return data;
}
const el = (tag, text, cls) => { const node = document.createElement(tag); node.textContent = text; if (cls) node.className = cls; return node; };
function failure(error) { $('error').hidden = false; $('error').textContent = error.message; }
async function run(fn) {
  if (busy) return;
  busy = true; $('error').hidden = true;
  try { await fn(); await refresh(); } catch (error) { failure(error); } finally { busy = false; }
}
function button(parent, label, action, body) {
  const node = el('button', label); node.type = 'button'; node.disabled = !status.active;
  node.onclick = () => { if (confirm(label + '？此操作只影响动态表达层。')) run(() => request(action, { ...body, expectedVersion: status.version, confirm: true })); };
  parent.append(node);
}
const date = value => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '初始';
async function refresh() {
  const [s, data] = await Promise.all([request('status'), request('data')]); status = s;
  $('status').textContent = `${s.active ? '● 运行中' : '○ 已停用'} · ${s.mode === 'observe' ? '观察模式，不改变回复' : '动态模式'} · 注入${s.injectEnabled ? '开启' : '关闭'} · 自动应用${s.autoApply ? '开启' : '关闭'} · 当前版本 ${s.version} · 模型调用 ${s.modelCalls}`;
  if (s.error) failure(Error(s.error));
  if (!dirty) {
    $('groups').value = s.groups.join(', '); $('mode').value = s.mode;
    for (const key of ['enabled', 'injectEnabled', 'autoApply']) $(key).checked = s[key];
    for (const key of ['minEvidence', 'minConfidence', 'minWindowDays', 'minSources', 'retentionDays']) $(key).value = s[key];
  }
  $('stats').replaceChildren();
  for (const row of data.observations) $('stats').append(el('p', `群 ${row.group_id}：${row.total} 条观察，${date(row.first)} 至 ${date(row.last)}`));
  for (const row of data.fillers) $('stats').append(el('p', `群 ${row.group_id} · “${row.filler}” ${row.count} 次`));
  if (!data.observations.length) $('stats').append(el('p', '暂无观察。启用后仅从授权群中已确认发送的文字回复采集。'));
  const labels = { candidate: '候选', active: '生效', disabled: '禁用', expired: '过期' };
  $('habits').replaceChildren();
  for (const row of data.habits) {
    const card = el('div', '', 'entry'); card.append(el('strong', `[${labels[row.status] || row.status}] ${row.description}`),
      el('p', `${row.scope_type === 'global' ? '全局（人工批准）' : '群 ' + row.scope_id} · 场景 ${row.usage_context} · 证据 ${row.evidence_count} · 来源 ${row.source_count} · 置信度 ${row.confidence.toFixed(2)}`, 'meta'),
      el('p', `首次 ${date(row.first_seen_at)} · 最近 ${date(row.last_seen_at)} · ${row.id}`, 'meta'));
    const actions = el('div', '', 'actions');
    if (row.status !== 'active' && row.scope_type === 'group') button(actions, '审核并激活', 'habit', { id: row.id, status: 'active' });
    if (row.status !== 'disabled') button(actions, '禁用习惯', 'habit', { id: row.id, status: 'disabled' });
    if (row.status === 'active' && row.scope_type === 'group') button(actions, '人工批准推广到全局', 'global', { id: row.id });
    card.append(actions); $('habits').append(card);
  }
  if (!data.habits.length) $('habits').append(el('p', '暂无候选。少量消息不会直接形成长期规则。'));
  $('versions').replaceChildren();
  for (const row of data.versions) {
    const previous = data.versions.find(v => v.id === row.previous_version);
    const before = new Set(previous?.content.map(r => r.id) || []), after = new Set(row.content.map(r => r.id));
    const card = el('div', '', 'entry'); card.append(el('strong', `v${row.id} · ${row.change_summary}`),
      el('p', `${date(row.created_at)} · ${row.created_by} · 前版本 ${row.previous_version ?? '无'}`, 'meta'),
      el('pre', '新增：' + [...after].filter(id => !before.has(id)).join(', ') + '\n移除：' + [...before].filter(id => !after.has(id)).join(', ')));
    if (row.id !== s.version) button(card, '回滚到此动态版本', 'rollback', { version: row.id });
    $('versions').append(card);
  }
  $('feedback-list').replaceChildren();
  for (const row of data.feedback) $('feedback-list').append(el('p', `${row.group_id} / ${row.response_id} · ${row.feedback_type} · ${row.score} · ${row.source} · ${date(row.created_at)}`));
}
$('settings').oninput = () => { dirty = true; };
$('settings').onsubmit = event => {
  event.preventDefault();
  const patch = { groups: $('groups').value.split(/[,，\s]+/).filter(Boolean), mode: $('mode').value, confirm: true };
  for (const key of ['enabled', 'injectEnabled', 'autoApply']) patch[key] = $(key).checked;
  for (const key of ['minEvidence', 'minConfidence', 'minWindowDays', 'minSources', 'retentionDays']) patch[key] = Number($(key).value);
  if (!confirm('保存人格学习设置？动态模式和自动应用可能影响后续回复。')) return;
  run(async () => { await request('settings', patch); dirty = false; });
};
$('feedback').onsubmit = event => { event.preventDefault(); run(() => request('feedback', { groupId: $('feedback-group').value.trim(), responseId: $('feedback-response').value.trim(), type: $('feedback-type').value, score: Number($('feedback-score').value), confirm: true })); };
$('refresh').onclick = () => run(async () => {});
for (const [id, label] of [['analyze', '生成统计与候选'], ['cleanup', '按保留期清理到期观察']]) $(id).onclick = () => { if (confirm(label + '？')) run(() => request(id, { confirm: true })); };
refresh().catch(failure);
