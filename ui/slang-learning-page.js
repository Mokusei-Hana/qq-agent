'use strict';
const $ = s => document.querySelector(s);
const labels = {candidate:'刚发现',queued:'排队查证',researching:'查证中',pending_review:'待审核',approved:'已收录',failed:'查证失败',interrupted:'已中断',rejected:'已驳回',expired:'已过期'};
let rows = [], page = 1, busy = false, settingsDirty = false, loaded = false;
const pageSize = 20;
const settingFields = [
  ['min','extractMinMessages',1],['threshold','researchThreshold',1],
  ['extract-interval','cooldownMs',60000],['extract-messages','extractMessageLimit',1],
  ['extract-candidates','extractCandidateLimit',1],['extract-daily','dailyExtractionLimit',1],
  ['research-interval','researchIntervalMs',60000],['research-batch','researchBatchSize',1],
  ['research-daily','dailyResearchLimit',1],['task-timeout','taskTimeoutMs',1000]
];
function element(tag, className, text) {
  const node = document.createElement(tag); if (className) node.className = className;
  if (text != null) node.textContent = String(text); return node;
}
function date(value) { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', {hour12:false}) : '暂无时间'; }
function badge(status, text) {
  const node = element('span','sl-badge',text || labels[status] || status);
  node.dataset.tone = ['approved','active'].includes(status) ? 'good' : ['failed','interrupted'].includes(status) ? 'bad' : status === 'pending_review' ? 'warn' : ['queued','researching'].includes(status) ? 'info' : '';
  return node;
}
function message(selector, text) { $(selector).textContent = text; $(selector).hidden = !text; }
async function request(action, body) {
  const r = await fetch('/api/slang-learning/' + action, {method:body ? 'POST' : 'GET',
    headers:{'content-type':'application/json','x-console-token':'qq-agent-console'},
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(20000)});
  if (r.status === 401) throw Error('登录已失效，请返回控制台重新登录后再试。');
  const data = await r.json(); if (!r.ok) throw Error(data.error || '操作失败，请稍后重试。'); return data;
}
function renderRows() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  const matches = rows.filter(r => [r.payload.content,r.result.meaning,r.payload.meaning,r.id,r.chat].some(v=>String(v || '').toLocaleLowerCase().includes(query)));
  const pages = Math.max(1,Math.ceil(matches.length/pageSize)); page = Math.min(page,pages);
  $('#result-count').textContent = query ? `找到 ${matches.length} / ${rows.length} 条` : `共 ${rows.length} 条`;
  $('#page-info').textContent = matches.length ? `第 ${page} / ${pages} 页 · 共 ${matches.length} 条` : '共 0 条';
  $('#previous').disabled = busy || page === 1; $('#next').disabled = busy || page === pages;
  const container = $('#rows'); container.replaceChildren();
  if (!matches.length) {
    const empty = element('div','sl-empty'); empty.append(element('strong','',query ? '没有找到匹配的词条' : '当前分类下暂无词条'),element('p','',query ? '换个关键词试试，或切换到「全部状态」。' : '群里聊出新梗后，会自动出现在这里。'));container.append(empty);return;
  }
  for (const row of matches.slice((page-1)*pageSize,page*pageSize)) {
    const card = element('article','sl-entry'); const top = element('div','sl-entry-top'); const heading = element('div');
    heading.append(element('h3','sl-term',row.payload.content));
    const meta = element('div','sl-meta');
    meta.append(element('span','',row.chat ? row.chat.replace(/^group:/,'群聊 ').replace(/^private:/,'私聊 ') : '未知来源'));
    heading.append(meta);top.append(heading,badge(row.status));card.append(top);
    card.append(element('p','sl-meaning',row.result.meaning || row.payload.meaning || '暂未查到释义，等待后台联网查证。'));
    const sources = row.result.sources || row.payload.sources || []; const evidence = row.payload.evidence || [];
    const bottom = element('div','sl-entry-bottom');
    bottom.append(element('span','sl-muted',`${Array.isArray(sources)?sources.length:0} 个参考来源 · 更新于 ${date(row.updated_at)}`));
    const actions = element('div','sl-actions');
    const choices = row.status === 'pending_review' ? ['approve','reject'] : ['failed','interrupted','candidate'].includes(row.status) ? ['retry','reject'] : row.status === 'expired' ? ['retry'] : [];
    for (const decision of choices) {
      const title = {approve:'收录',reject:'驳回',retry:row.status==='candidate'?'立即查证':'重新查证'}[decision];
      const button = element('button',decision==='approve'?'sl-primary':decision==='reject'?'sl-danger':'',title);button.type='button';button.disabled=busy;
      button.onclick = () => execute(async()=>{
        if (!confirm(`确认${title}「${row.payload.content}」？`)) return;
        await request('review',{id:row.id,decision,confirm:true});await refresh();
        message('#notice',`「${row.payload.content}」已${decision==='approve'?'收录到黑话库':decision==='reject'?'驳回':'加入查证队列'}。`);
      });actions.append(button);
    }
    bottom.append(actions);card.append(bottom);
    if ((Array.isArray(sources)&&sources.length) || (Array.isArray(evidence)&&evidence.length)) {
      const details = element('details','sl-evidence');details.append(element('summary','',`查看查证来源与群聊语境${evidence.length ? `（${evidence.length} 条）` : ''}`));
      for (const source of (Array.isArray(sources)?sources:[])) {
        const block = element('div','sl-source'); const raw = typeof source==='string' ? {url:source} : source || {};
        let url;try{const candidate=new URL(raw.url);if(['https:','http:'].includes(candidate.protocol)&&!candidate.username&&!candidate.password)url=candidate;}catch{}
        if(url){const link=element('a','',raw.title || url.hostname);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';block.append(link);}
        else block.append(element('span','sl-muted',raw.title || '无可用链接'));
        if(raw.quote||raw.snippet)block.append(element('p','',raw.quote||raw.snippet));details.append(block);
      }
      for (const item of (Array.isArray(evidence)?evidence:[]).slice(0,8)) {
        const block=element('div','sl-source');
        const from = String(item.key || item.chat || '群聊记录').replace(/^group:/,'群聊 ').replace(/^private:/,'私聊 ');
        block.append(element('span','sl-muted',from),element('p','',item.text || item.plain || '（原文已脱敏隐藏）'));details.append(block);
      }
      if(evidence.length>8)details.append(element('p','sl-muted',`仅显示前 8 条，共 ${evidence.length} 条记录。`));
      card.append(details);
    }
    container.append(card);
  }
}
async function refresh() {
  const [status, discoveries, feedback] = await Promise.all([request('status'),request('discoveries?limit=500&status='+encodeURIComponent($('#filter').value)),request('feedback')]);
  rows = discoveries; loaded = true;
  const node=badge(status.active?'active':'disabled',status.active?'● 运行中':'○ 已暂停');$('#status').replaceWith(node);node.id='status';node.setAttribute('role','status');
  const counts=status.counts || {};
  $('#stat-candidate').textContent=counts.candidate || 0;$('#stat-review').textContent=counts.pending_review || 0;
  $('#stat-queue').textContent=(counts.queued || 0)+(counts.researching || 0);
  $('#queue-note').textContent=status.running?'正在后台查证词条':'当前空闲';
  $('#stat-attention').textContent=(counts.failed || 0)+(counts.interrupted || 0);
  if(!settingsDirty){
    $('#groups').value=status.groups.join(', ');
    for(const [id,key,scale] of settingFields)$('#'+id).value=status[key]/scale;
    $('#schedule-start').value=status.researchStart;$('#schedule-end').value=status.researchEnd;
  }
  const schedule=status.schedule;
  if(schedule){
    const unlimited=n=>n||'不限';
    const waiting=!status.active?'当前已暂停':!schedule.inWindow?'当前不在运行时间段内':schedule.researchQuotaReached?'今日查证次数已达上限':schedule.researchIntervalUntil>Date.now()?'等待下一批查证间隔':'正常运行中';
    $('#schedule-note').textContent=`${waiting} · 今日已提取 ${schedule.usage.extractions}/${unlimited(status.dailyExtractionLimit)} 次 · 已查证 ${schedule.usage.researches}/${unlimited(status.dailyResearchLimit)} 次`;
  }
  const failure=status.lastFailure;
  $('#failure-detail').textContent=failure
    ? `${date(failure.at)} · ${failure.stage==='extract'?'提取新词':failure.stage==='research'?'联网查证':'后台任务'}出错：${failure.reason}`
    : '暂无异常记录，运行正常。';
  $('#updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
  if(status.error)message('#error',status.error);
  $('#feedback-count').textContent=feedback.length+' 条';$('#feedback').replaceChildren();
  if(!feedback.length)$('#feedback').append(element('p','sl-muted','暂无纠错反馈。'));
  for(const row of feedback){
    const item=element('div','sl-feedback-item');
    item.append(element('span','sl-muted',date(row.at)),element('p','',row.details?.note || row.details?.feedback || '已记录反馈'));
    $('#feedback').append(item);
  }
  renderRows();
}
async function execute(fn) {
  if(busy)return;busy=true;message('#error','');message('#notice','');$('#rows').setAttribute('aria-busy','true');
  document.querySelectorAll('button, #filter, .sl-form input').forEach(n=>n.disabled=true);
  try{await fn();}catch(e){message('#error',e.name==='TimeoutError'?'请求超时，请刷新后重试。':e.message);if(!loaded){$('#rows').replaceChildren(element('div','sl-empty','暂时无法读取数据，请确认已登录并刷新页面。'));$('#result-count').textContent='加载失败';}}
  finally{busy=false;document.querySelectorAll('button, #filter, .sl-form input').forEach(n=>n.disabled=false);$('#rows').setAttribute('aria-busy','false');if(loaded)renderRows();}
}
$('#refresh').onclick=()=>execute(refresh);
$('#filter').onchange=()=>{page=1;execute(refresh);};
$('#search').oninput=()=>{page=1;renderRows();};
$('#previous').onclick=()=>{page--;renderRows();};$('#next').onclick=()=>{page++;renderRows();};
$('#settings').oninput=()=>{settingsDirty=true;};
$('#settings').onsubmit=event=>{event.preventDefault();execute(async()=>{
  const patch={groups:$('#groups').value.split(/[,，\s]+/).filter(Boolean),researchStart:$('#schedule-start').value,researchEnd:$('#schedule-end').value};
  for(const [id,key,scale] of settingFields)patch[key]=Math.round(Number($('#'+id).value)*scale);
  await request('settings',patch);
  settingsDirty=false;await refresh();message('#notice','学习计划已保存并生效。');
});};
$('#withdraw').onsubmit=event=>{event.preventDefault();execute(async()=>{
  if(!confirm('确认撤回该词条并重新查证？'))return;
  await request('withdraw',{chat:$('#chat').value.trim(),id:$('#term-id').value.trim(),confirm:true});await refresh();message('#notice','已撤回词条，将重新查证。');
});};
execute(refresh);
