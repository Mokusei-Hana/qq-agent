'use strict';
const $ = s => document.querySelector(s);
const labels = {candidate:'候选',queued:'排队中',researching:'研究中',pending_review:'待审核',approved:'已通过',failed:'研究失败',interrupted:'已中断',rejected:'已驳回',expired:'已过期'};
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
function date(value) { const d = new Date(value); return value && Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', {hour12:false}) : '时间未记录'; }
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
  if (r.status === 401) throw Error('登录已失效，请返回控制台登录后重新打开此页。');
  const data = await r.json(); if (!r.ok) throw Error(data.error || '请求失败，请稍后重试。'); return data;
}
function renderRows() {
  const query = $('#search').value.trim().toLocaleLowerCase();
  const matches = rows.filter(r => [r.payload.content,r.result.meaning,r.payload.meaning,r.id,r.chat].some(v=>String(v || '').toLocaleLowerCase().includes(query)));
  const pages = Math.max(1,Math.ceil(matches.length/pageSize)); page = Math.min(page,pages);
  $('#result-count').textContent = query ? `${matches.length} / ${rows.length} 条` : `${rows.length} 条${rows.length===500?'（最多展示 500 条）':''}`;
  $('#page-info').textContent = matches.length ? `第 ${page} / ${pages} 页 · 共 ${matches.length} 条` : '共 0 条';
  $('#previous').disabled = busy || page === 1; $('#next').disabled = busy || page === pages;
  const container = $('#rows'); container.replaceChildren();
  if (!matches.length) {
    const empty = element('div','sl-empty'); empty.append(element('strong','',query ? '没有匹配的词条' : '当前状态下暂无词条'),element('p','',query ? '试试其他关键词，或切换状态筛选。' : '可以切换其他状态查看；新候选会在收到足够群聊消息后出现。'));container.append(empty);return;
  }
  for (const row of matches.slice((page-1)*pageSize,page*pageSize)) {
    const card = element('article','sl-entry'); const top = element('div','sl-entry-top'); const heading = element('div');
    heading.append(element('h3','sl-term',row.payload.content));
    const meta = element('div','sl-meta');meta.append(element('span','',row.chat ? row.chat.replace(/^group:/,'群聊 · ').replace(/^private:/,'私聊 · ') : '来源会话待核对'),element('code','',row.id));heading.append(meta);top.append(heading,badge(row.status));card.append(top);
    card.append(element('p','sl-meaning',row.result.meaning || row.payload.meaning || '尚未形成已验证释义，等待研究或补充证据。'));
    const sources = row.result.sources || row.payload.sources || []; const evidence = row.payload.evidence || [];
    const bottom = element('div','sl-entry-bottom');bottom.append(element('span','sl-muted',`${Array.isArray(sources)?sources.length:0} 个来源 · ${date(row.updated_at)}`));
    const actions = element('div','sl-actions');
    const choices = row.status === 'pending_review' ? ['approve','reject'] : ['failed','interrupted','candidate'].includes(row.status) ? ['retry','reject'] : row.status === 'expired' ? ['retry'] : [];
    for (const decision of choices) {
      const title = {approve:'通过审核',reject:'驳回',retry:row.status==='candidate'?'开始研究':'重新研究'}[decision];
      const button = element('button',decision==='approve'?'sl-primary':decision==='reject'?'sl-danger':'',title);button.type='button';button.disabled=busy;
      button.onclick = () => execute(async()=>{
        if (!confirm(`确认${title}“${row.payload.content}”？`)) return;
        await request('review',{id:row.id,decision,confirm:true});await refresh();message('#notice',`“${row.payload.content}”已${decision==='approve'?'通过审核':decision==='reject'?'驳回':'提交后台研究'}。`);
      });actions.append(button);
    }
    bottom.append(actions);card.append(bottom);
    if ((Array.isArray(sources)&&sources.length) || (Array.isArray(evidence)&&evidence.length)) {
      const details = element('details','sl-evidence');details.append(element('summary','',`查看来源与语境${evidence.length ? ` · ${evidence.length} 条观察` : ''}`));
      for (const source of (Array.isArray(sources)?sources:[])) {
        const block = element('div','sl-source'); const raw = typeof source==='string' ? {url:source} : source || {};
        let url;try{const candidate=new URL(raw.url);if(['https:','http:'].includes(candidate.protocol)&&!candidate.username&&!candidate.password)url=candidate;}catch{}
        if(url){const link=element('a','',raw.title || url.hostname);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';block.append(link,element('span','sl-muted',url.href));}
        else block.append(element('span','sl-muted',raw.title || '来源链接未记录或不可用'));
        if(raw.quote||raw.snippet)block.append(element('p','',raw.quote||raw.snippet));details.append(block);
      }
      for (const item of (Array.isArray(evidence)?evidence:[]).slice(0,8)) {
        const block=element('div','sl-source');block.append(element('span','sl-muted',item.key || item.chat || '群聊观察'),element('p','',item.text || item.plain || '原始语境已保留，未提供可展示文本。'));details.append(block);
      }
      if(evidence.length>8)details.append(element('p','sl-muted','仅展示前 8 条语境，全部记录仍保留。'));card.append(details);
    }
    container.append(card);
  }
}
async function refresh() {
  const [status, discoveries, feedback] = await Promise.all([request('status'),request('discoveries?limit=500&status='+encodeURIComponent($('#filter').value)),request('feedback')]);
  rows = discoveries; loaded = true;
  const node=badge(status.active?'active':'disabled',status.active?'● 学习运行中':'○ 学习已停用');$('#status').replaceWith(node);node.id='status';node.setAttribute('role','status');
  const counts=status.counts || {};
  $('#stat-candidate').textContent=counts.candidate || 0;$('#stat-review').textContent=counts.pending_review || 0;
  $('#stat-queue').textContent=(counts.queued || 0)+(counts.researching || 0);$('#queue-note').textContent=`${status.running?'正在处理后台任务':'当前无在途任务'} · 并发 ${status.concurrency}`;
  $('#stat-attention').textContent=(counts.failed || 0)+(counts.interrupted || 0);
    if(!settingsDirty){
    $('#groups').value=status.groups.join(', ');
    for(const [id,key,scale] of settingFields)$('#'+id).value=status[key]/scale;
    $('#schedule-start').value=status.researchStart;$('#schedule-end').value=status.researchEnd;
  }
  const schedule=status.schedule;
  if(schedule){
    const unlimited=n=>n||'不限';
    const waiting=!status.active?'学习已停用':!schedule.inWindow?'当前不在允许时段':schedule.researchQuotaReached?'今日研究额度已用完':schedule.researchIntervalUntil>Date.now()?'等待研究批次间隔':'按计划等待消息或处理排队词条';
    $('#schedule-note').textContent=`${waiting} · 今日提取 ${schedule.usage.extractions} / ${unlimited(status.dailyExtractionLimit)} 次 · 研究 ${schedule.usage.researches} / ${unlimited(status.dailyResearchLimit)} 次（北京时间）${schedule.extractionQuotaReached?' · 今日提取额度已用完':''}`;
  }
  const failure=status.lastFailure;
  $('#failure-detail').textContent=failure ? `${date(failure.at)} · ${failure.stage==='extract'?'候选提取':failure.stage==='research'?'词条研究':'后台任务'}：${failure.reason}（${failure.code}）。历史失败记录不代表当前仍在失败；词条失败后需手动核对重试。` : '尚无可用的详细失败记录。旧版仅保留通用错误提示，无法还原当时的具体原因。';
  $('#updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour12:false});
  if(status.error)message('#error',status.error);
  $('#feedback-count').textContent=feedback.length+' 条';$('#feedback').replaceChildren();
  if(!feedback.length)$('#feedback').append(element('p','sl-muted','暂无纠错反馈。后续反馈会在这里显示。'));
  for(const row of feedback){const item=element('div','sl-feedback-item');item.append(element('span','sl-muted',date(row.at)),element('p','',row.details?.note || row.details?.feedback || JSON.stringify(row.details)),element('span','sl-muted',row.discovery_id));$('#feedback').append(item);}
  renderRows();
}
async function execute(fn) {
  if(busy)return;busy=true;message('#error','');message('#notice','');$('#rows').setAttribute('aria-busy','true');
  document.querySelectorAll('button, #filter, .sl-form input').forEach(n=>n.disabled=true);
  try{await fn();}catch(e){message('#error',e.name==='TimeoutError'?'请求超时，请重试；操作结果不明时请先刷新核对。':e.message);if(!loaded){$('#rows').replaceChildren(element('div','sl-empty','暂时无法读取数据，请检查登录状态并刷新。'));$('#result-count').textContent='未能加载';}}
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
  settingsDirty=false;await refresh();message('#notice','学习计划已保存并立即应用。');
});};
$('#withdraw').onsubmit=event=>{event.preventDefault();execute(async()=>{
  if(!confirm('确认撤回词条？旧版本与审计记录将保留，并等待重新研究。'))return;
  await request('withdraw',{chat:$('#chat').value.trim(),id:$('#term-id').value.trim(),confirm:true});await refresh();message('#notice','词条已撤回，旧版本已保留。');
});};
execute(refresh);