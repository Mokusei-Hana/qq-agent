'use strict';
(function(){
 const $=id=>document.getElementById(id),selected=new Map();
 let state=null,current=[],preview=null,csrfToken='';
 const tabs=[['overview','运行总览'],['reflection','AI 反思报告'],['cognition','表达特征'],['review','AI 建议'],['snapshot','当前人格'],['evaluation','效果评估'],['history','发布历史'],['module-settings','采集与预算']];
 function node(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);return e;}
 function button(label,action){const e=node('button',label);e.type='button';e.onclick=()=>guard(action);return e;}
 async function request(action,body){
  const options={credentials:'same-origin',headers:{'content-type':'application/json'}};
  if(body){if(!csrfToken){csrfToken=(await request('csrf')).csrfToken;}options.method='POST';options.headers['x-pe-csrf']=csrfToken;options.body=JSON.stringify(body);}
  const response=await fetch('/api/personality-learning/v2/'+action,options),data=await response.json();
  if(!response.ok){if(data.error==='CSRF_REQUIRED')csrfToken='';throw Error(errors[data.error]||data.error||'请求失败');}return data;
 }
 async function guard(fn){try{$('error').hidden=true;await fn();}catch(e){$('error').textContent=String(e.message||'操作失败');$('error').hidden=false;}}

 const words={local:'本地整理',reflection:'每日 AI 反思',evaluation:'每日效果评估',trend:'每周趋势分析',queued:'等待分析',running:'分析中',waiting_retry:'等待重试',succeeded:'已完成',failed:'失败',skipped:'已跳过',cancelled:'已取消',timed_out:'超时',prepared:'准备请求',dispatched:'已发送请求',responded:'已收到响应',uncertain:'结果未知',insufficient_data:'数据不足',inconclusive:'暂不能得出结论',preserve:'保留优点',improve:'改善表达',limit:'限制表达',strength:'表达优点',problem:'待改善问题',conciseness:'简洁程度',initiative:'主动性',humor:'幽默',empathy:'共情',repetition:'重复表达',mechanical_expression:'机械化表达',scene_adaptation:'场景适应',interaction_quality:'互动质量',chat:'闲聊',question:'提问',complaint:'抱怨',sharing:'分享',debate:'讨论',distress:'情绪低落','*':'所有场景',reject:'已拒绝',request_evidence:'需补充证据',edit:'已编辑',publish:'正式发布',add:'新增偏好',remove:'撤销偏好',rollback:'回滚',group:'授权群',global:'全局',object:'互动对象',silence:'不回复',text:'文字回复'};
 const errors={INSUFFICIENT_VERIFIED_EVIDENCE:'这条建议的支持证据还没达标，目前不能正式采用。请查看卡片中“现在还差什么”。',REVISION_REQUIRES_REVIEW_UPDATE:'这份稿子已经被拒绝、要求补证或修改，请等待新的分析或选择新稿。',ACTIVE_USE_REMOVE_PUBLICATION:'这条规则已经在用；如要停用，请选择“停用这条规则”并确认。',VERSION_CONFLICT:'其他操作已更新人格，请刷新后重新选择。',INVALID_EVIDENCE_REFS:'模型的证据引用格式不正确，报告未被采纳；没有发布任何人格修改。',MODEL_HTTP_500:'模型服务返回 HTTP 500，本次分析失败，未生成报告；请检查当前模型或代理状态。',MODEL_OUTPUT_TRUNCATED:'模型输出达到上限，报告不完整，本次未采纳。',INSUFFICIENT_SAMPLES:'当次采样条件未满足：可能是观察条数、不同互动次数或采集时间跨度不足。历史任务保留当时的判断，不会按新门槛重算。',STALE_WINDOW:'已有更新的分析窗口，本次旧任务已跳过。',CHAT_PRIORITY_CANCELLED:'优先处理聊天，本次分析已取消。',INPUT_BUDGET:'输入材料超过 Token 上限，本次跳过。',PRIVACY_KEY_REQUIRED:'尚未初始化隐私密钥，请到模块设置检查。',MIGRATION_REQUIRED:'数据库需要升级，请联系维护人员。',MODEL_PRICE_UNVERIFIED:'模型价格尚未确认，请检查预算设置。',MONEY_BUDGET_REQUIRED:'分析预算尚未完整设置。',MODEL_JSON_INVALID:'模型返回内容不是有效 JSON。',MODEL_SCHEMA_INVALID:'模型返回内容不符合报告格式。',CSRF_REQUIRED:'页面验证已过期，请刷新后重试。'};
 const empty={jobs:'尚无任务。观察开启后，系统会按计划整理和分析。',calls:'尚未请求模型。先查看任务是否因样本不足而跳过。',observations:'尚无 V2 观察。请检查授权群及采集开关，并等待机器人正常互动。',reports:'尚无 AI 反思报告。满足样本条件并完成分析后会显示在这里。',traits:'尚无人格认知。AI 分析完成后才会生成，不会直接改变回复。',preferences:'暂无候选需要审核。AI 分析可能不提出任何修改，这是正常结果。',evaluations:'尚无效果评估。发布前后均有足够互动后，才有条件比较。',feedback:'尚未记录人工评价。可从观察记录复制 ID 后在上方填写。',reviews:'尚无人工审核记录。',versions:'尚无版本记录。','current-snapshot':'尚未发布任何动态偏好，当前仍沿用原有人格。'};
 const tr=v=>words[v]||String(v??'未提供');
 const time=v=>v?new Date(Number(v)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚无';
 function parsed(v,fallback={}){try{return typeof v==='string'?JSON.parse(v):v??fallback;}catch{return fallback;}}
 function field(card,label,value){if(value===undefined||value===null||value==='')return;const line=node('p');line.append(node('strong',label+'：'),node('span',String(value)));card.append(line);}
 function list(card,label,items){if(Array.isArray(items)&&items.length){card.append(node('h4',label));const ul=node('ul');for(const item of items)ul.append(node('li',typeof item==='string'?item:item.conclusion||item.explanation||item.observationId||'参见技术详情'));card.append(ul);}}
 function raw(card,row){const details=node('details');details.append(node('summary','技术详情（原始记录）'),node('pre',JSON.stringify(row,null,2)));card.append(details);}
 function records(id,rows,extra){
  const holder=$(id);holder.replaceChildren();
  if(!rows.length){const p=node('p',empty[id]||'暂无记录');p.className='empty';holder.append(p);return;}
  for(const row of rows){
   const card=node('article');card.className='record';
   const report=parsed(row.report_json),features=parsed(row.features_json),metrics=parsed(row.metrics_json);
   const title=row.name||row.conclusion||(id==='jobs'?tr(row.kind):id==='calls'?'模型请求 · '+tr(row.state):id==='reports'?'AI 反思报告':id==='observations'?'互动观察 · '+tr(features.scene||'chat'):id==='versions'?'人格版本 v'+row.id:id==='reviews'?tr(row.action):id==='feedback'?tr(row.dimension):id==='evaluations'?'版本效果比较':'动态表达偏好');
   card.append(node('h3',title));
   if(id==='jobs'){
    field(card,'结果',tr(row.state));field(card,'时间',time(row.finished_at||row.created_at));
    if(row.error_code)field(card,row.state==='succeeded'?'采样提示':'原因',row.state==='succeeded'&&row.kind==='local'?'本地整理已完成；当时 AI 采样条件未满足（条数、不同互动次数或时间跨度）。这不是整理失败，历史结果不会按新门槛重算。':errors[row.error_code]||row.error_code);
    field(card,'分析窗口',time(row.window_start)+' 至 '+time(row.window_end));field(card,'请求尝试次数',row.attempt_count??0);
   }else if(id==='calls'){
    field(card,'时间',time(row.dispatched_at||row.prepared_at));field(card,'模型',row.actual_model||row.requested_model);field(card,'结果',tr(row.state));field(card,'输入 / 输出 Token',(row.input_tokens??'未知')+' / '+(row.output_tokens??'未知'));if(row.error_code)field(card,'原因',errors[row.error_code]||row.error_code);
   }else if(id==='observations'){
    field(card,'发生时间',time(row.occurred_at));field(card,'回复类型',tr(features.responseType));field(card,'回复长度',features.length===undefined?null:features.length+' 字符');field(card,'当时人格版本','v'+row.version_id);field(card,'观察 ID（人工反馈时使用）',row.id);
   }else if(id==='reports'){
    field(card,'完成时间',time(row.created_at));field(card,'发现 / 候选',(report.findings?.length??0)+' 项发现 / '+(report.proposals?.length??0)+' 项候选');
    for(const finding of report.findings||[]){field(card,tr(finding.kind)+' · '+tr(finding.dimension),finding.conclusion);field(card,'置信度',Math.round(finding.confidence*100)+'%');}
    list(card,'分析局限',report.limitations);
   }else if(id==='preferences'||id==='current-snapshot'){
    field(card,id==='preferences'?'以后让 Bot 怎么做':'正在使用的规则',row.rule_text||row.rule);field(card,'AI 为什么这么建议',row.rationale);field(card,'什么时候用',(row.scenes||parsed(row.scenes_json,[])).map(tr).join('、'));
    if(id==='preferences'){const r=row.publicationReadiness||{};field(card,'AI 自己有多大把握',row.confidence===undefined?'未知':Math.round(row.confidence*100)+'%（不等于已证明有效）');if(r.interactions!==undefined){field(card,'支持这条建议的互动',r.interactions+' / 至少 '+r.requiredInteractions+' 次');field(card,'来自多少个不同对象',r.sources+' / 至少 '+r.requiredSources+' 个');field(card,'证据跨了多久',(r.spanMs/86400000).toFixed(1)+' / 至少 '+(r.requiredSpanMs/86400000)+' 天');}if(!r.ready&&r.reason==='INSUFFICIENT_VERIFIED_EVIDENCE'){const missing=[];if(r.interactions<r.requiredInteractions)missing.push('支持互动至少 '+r.requiredInteractions+' 次');if(r.sources<r.requiredSources)missing.push('至少 '+r.requiredSources+' 个不同对象');if(r.spanMs<r.requiredSpanMs)missing.push('证据跨度至少 '+r.requiredSpanMs/86400000+' 天');if(r.confidence<r.requiredConfidence)missing.push('AI 把握至少 '+Math.round(r.requiredConfidence*100)+'%');field(card,'现在还差什么',missing.join('；')||'证据范围、时效或其他条件不符合要求');}}
    if(id==='preferences')field(card,'现在的状态',current.some(e=>e.id===row.preference_id&&e.revision===row.revision)?'Bot 已经在用':row.review_action?tr(row.review_action):row.publicationReadiness?.ready?'可以由你决定是否采用，当前尚未生效':'先留作建议，证据还不够，当前不能采用');
    list(card,'潜在影响',parsed(row.risks_json,[]));
   }else if(id==='traits'){
    field(card,'置信度',Math.round(row.confidence*100)+'%');field(card,'观察窗口',time(row.window_start)+' 至 '+time(row.window_end));list(card,'判断局限',parsed(row.limitations_json,[]));
   }else if(id==='versions'){
    const entries=parsed(row.content,[]);field(card,'状态',row.id===state.version?'当前正式版本':'历史版本');field(card,'发布时间',time(row.created_at));field(card,'变更说明',row.change_summary);field(card,'动态偏好数',entries.length);
    for(const entry of entries)field(card,entry.name||'表达规则',entry.rule);
   }else if(id==='evaluations'){
    field(card,'结论',tr(row.result));field(card,'比较版本','v'+(row.baseline_version??'无')+' → v'+row.target_version);field(card,'发布前 / 后样本',(metrics.before?.interactions??0)+' / '+(metrics.after?.interactions??0));field(card,'解释','仅为观察性比较，不能证明人格修改造成了变化。');
   }else if(id==='feedback'){
    field(card,'评价',Number(row.score)>0?'正面':Number(row.score)<0?'负面':'中性 / 待判断');field(card,'说明',row.note);field(card,'时间',time(row.created_at));
   }else if(id==='reviews'){
    field(card,'操作',tr(row.operation||row.action));field(card,'审核说明',row.reason);field(card,'时间',time(row.created_at));field(card,'版本变更','v'+row.base_version+' → v'+(row.result_version??'未发布'));
   }
   if(extra)extra(card,row);raw(card,row);holder.append(card);
  }
 }
 function metric(label,value,hint){const card=node('div');card.className='metric';card.append(node('span',label),node('strong',value??'未知'),node('small',hint));return card;}
 function renderOverview(data){
  const cfg=state.settings||{},issues=[state.error,state.backgroundError,state.retentionError].filter(Boolean);
  $('status').textContent=issues.length?'需要检查 · '+issues.map(e=>errors[e]||e).join('；'):state.active?'观察采集中 · '+(state.running?'AI 正在分析':'后台等待计划任务'):'观察已暂停 · 历史记录仍可查看';
  const holder=$('overview-data');holder.replaceChildren();holder.className='metrics';
  holder.append(metric('已采集观察',state.observations,'V2 记录；旧版 '+(state.historicalExisting??0)+' 条另计'),metric('AI 分析完成',state.analysisSucceeded,'真实模型请求 '+(state.modelCalls??0)+' 次'),metric('当前已发布偏好',current.length,'人格版本 v'+state.version),metric('最近一次观察',time(state.lastObservation),'北京时间'));
  const guide=$('run-explanation');guide.replaceChildren();guide.append(node('h3','现在运行到哪一步？'));
  field(guide,'1 · 采集互动',state.active?'正在接纳授权群内已确认的互动':'未运行，请检查模块及采集开关');
  field(guide,'2 · AI 反思',!cfg.analysisEnabled?'后台模型分析已关闭':state.running?'正在分析':state.modelCalls?'已有模型调用，结果请看反思报告和任务记录':'尚无模型调用，先检查下方任务的跳过原因');
  const skipped=data.jobs.find(j=>j.kind==='reflection'&&j.state==='skipped');
  if(skipped&&!state.modelCalls)field(guide,'最近每日反思',errors[skipped.error_code]||tr(skipped.state));
  field(guide,'分析条件','每日 AI 反思按授权群分别检查最近 14 天的累计观察：至少 50 条观察、50 次不同互动，最早与最近观察相隔至少 1 天（24 小时）；距上次成功反思还需至少 20 条新观察。每次整理不会重新计时。满足后等待下一次每日 03:30 后的计划检查，不会立即触发。');
  field(guide,'每周趋势条件','每周一 05:00 后检查；样本仍需跨越至少 14 天，最近两周各至少 50 条观察。本次仅缩短每日反思的基础采样跨度。');
  field(guide,'3 · 人工审核',current.length?'已发布 '+current.length+' 条动态偏好；可到“当前人格”检查':'当前没有已采用的动态表达规则；AI 的建议要由你确认采用，才可能影响回复。');
  field(guide,'下一步',data.preferences.length?'打开“AI 建议”，先看建议内容和还差什么。证据达标后，勾选想采用的建议，再核对确认。':!cfg.analysisEnabled?'如需 AI 反思，可到“采集与预算”检查设置。':'保持正常互动即可。暂无候选时无需操作，也无需重新初始化。');
  const health=$('health-summary');health.replaceChildren();
  field(health,'观察队列','待处理 '+(state.observationQueue?.pending??0)+' / 丢弃 '+(state.observationQueue?.dropped??0)+' / 失败 '+(state.observationQueue?.failed??0));
  field(health,'模型结果','成功 '+(state.callsSucceeded??0)+' / 失败 '+(state.callsFailed??0)+' / 超时 '+(state.callsTimedOut??0)+' / 取消 '+(state.callsCancelled??0)+' / 未知 '+(state.callsUnknown??0));
  field(health,'最近完成的分析或评估',time(state.lastAnalysis));
  field(health,'预算',cfg.unlimitedBudget?'不设金额上限；每日仍限制 '+cfg.modelDailyLimit+' 次请求、'+cfg.dailyTokenLimit+' Token':cfg.dailyBudgetMicros===null?'尚未设置金额预算':(cfg.dailyBudgetMicros/1000000)+' '+(cfg.currency||'')+' / 日');
 }
 function showEvidence(id){return guard(async()=>{$('evidence-detail').hidden=false;const r=await request('evidence?id='+encodeURIComponent(id));const box=$('evidence-summary');box.replaceChildren();field(box,'观察时间',time(r.data.occurred_at));field(box,'关联候选与认知',r.data.references?.length??0);field(box,'说明','证据引用保留观察 ID，聊天原文默认不展示。原始特征可在下方技术详情查看。');$('evidence-data').textContent=JSON.stringify(r.data,null,2);$('evidence-detail').scrollIntoView({behavior:'smooth',block:'start'});});}
 async function makePreview(input){
  preview=null;$('publication-preview').hidden=true;
  const p=await request('preview',{expectedVersion:state.version,...input});preview={...p,idempotencyKey:crypto.randomUUID()};
  $('preview-diff').textContent=JSON.stringify({previous:current,final:p.entries},null,2);
  $('preview-hash').textContent='基础版本 '+p.expectedVersion+'\n最终快照 SHA-256 '+p.finalSnapshotHash+'\n请求 SHA-256 '+p.requestHash;
  const summary=$('preview-summary');summary.replaceChildren();field(summary,'保存方式','确认后保存为新的正式版本');field(summary,'现在的规则数 / 确认后的规则数',current.length+' / '+p.entries.length);for(const entry of p.entries){const old=current.find(e=>e.id===entry.id&&e.revision===entry.revision);field(summary,(old?'保留':'新增或修改')+' · '+(entry.name||'表达偏好'),entry.rule||entry.id);}for(const entry of current.filter(e=>!p.entries.some(n=>n.id===e.id)))field(summary,'撤销 · '+(entry.name||'表达偏好'),entry.rule||entry.id);
  $('publication-preview').hidden=false;$('publication-preview').scrollIntoView({behavior:'smooth',block:'start'});
 }
 async function decision(row,action){
  const reason=prompt(action==='edit'?'为什么要改？请简单说明，不要填写隐私信息。':action==='reject'?'为什么不采用？请简单说明，不要填写隐私信息。':'哪里证据不够？请简单说明。此操作不会立即调用 AI。');if(!reason)return;
  let patch={};
  if(action==='edit'){const rule=prompt('把这条建议改成你想要的说法（保存后仍需另行确认采用）',row.rule_text);if(rule===null)return;patch={rule};if(!confirm('确认保存这份新稿？原来的说法：'+row.rule_text+'\n新规则：'+rule+'\n此操作不会发布。'))return;}
  else if(!confirm(action==='reject'?'确认不采用这条建议？Bot 的现有规则不会改变。':'确认标记为需要更多证据？不会立即调用 AI，也不会改变 Bot。'))return;
  await request('decide',{confirm:true,action,id:row.preference_id,revision:row.revision,reason,patch,idempotencyKey:crypto.randomUUID()});await refresh();
 }
 function updateSelection(){$('review-selection').textContent=selected.size?'已选 '+selected.size+' 条，下一步只核对内容，还不会生效。':'尚未选择建议。只有证据达标的建议才可勾选；也可以先不处理。';$('preview-selected').disabled=selected.size===0;}
 async function refresh(){
  preview=null;selected.clear();updateSelection();$('publication-preview').hidden=true;
  state=await request('status');
  const kinds=['jobs','calls','observations','reports','traits','preferences','evaluations','feedback','reviews','versions'];
  const results=await Promise.all(kinds.map(k=>request(k)));
  const data=Object.fromEntries(kinds.map((k,i)=>[k,results[i].data]));
  const active=data.versions.find(v=>v.id===state.version);current=active?parsed(active.content,[]):[];
  renderOverview(data);
  for(let i=0;i<kinds.length;i++){
   const kind=kinds[i],rows=results[i].data;
   if(kind==='versions'){const active=rows.find(v=>v.id===state.version);current=active?JSON.parse(active.content):[];records('current-snapshot',current);}
   records(kind,rows,(card,row)=>{
    if(kind==='preferences'){
     const inUse=current.some(e=>e.id===row.preference_id&&e.revision===row.revision),eligible=row.publicationReadiness?.ready===true;
     if(!inUse){const label=node('label',eligible?'我想采用这条':'暂时不能采用：先积累证据或等待新稿'),box=node('input');box.type='checkbox';box.disabled=!eligible;
      box.onchange=()=>{if(box.checked)selected.set(row.preference_id,{id:row.preference_id,revision:row.revision,contentHash:row.content_hash});else selected.delete(row.preference_id);updateSelection();};label.prepend(box);card.append(label);
      card.append(button('修改措辞（不会立即生效）',()=>decision(row,'edit')),button('不采用这条建议',()=>decision(row,'reject')),button('证据还不够，先留待观察',()=>decision(row,'request_evidence')));
     }else card.append(button('停用这条规则，先核对',()=>makePreview({operation:'remove',selections:current.filter(e=>e.id!==row.preference_id),reason:'Administrator removal'})));
    }
    if(kind==='versions')card.append(button('预览回滚到此快照',()=>makePreview({operation:'rollback',rollbackTarget:row.id,reason:'Administrator rollback'})));
    if(kind==='observations')card.append(button('查看证据与引用',()=>showEvidence(row.id)));
   });
  }
  const cfg=state.settings||{};$('capture-enabled').checked=!!cfg.enabled;$('capture-text').checked=!!cfg.captureText;$('analysis-enabled').checked=!!cfg.analysisEnabled;
  $('unlimited-budget').checked=cfg.unlimitedBudget===true;$('money-budget').value=cfg.dailyBudgetMicros??'';$('currency').value=cfg.currency||'';$('initialize').disabled=state.privacyKeyReady===true;
 }
 for(const [id,label] of tabs){const b=button(label,async()=>{for(const [other] of tabs)$(other).hidden=other!==id;for(const item of $('sections').children)item.setAttribute('aria-current',item===b?'page':'false');});b.setAttribute('aria-current',id==='overview'?'page':'false');$('sections').append(b);}
 $('refresh').onclick=()=>guard(refresh);
 $('preview-selected').onclick=()=>guard(async()=>{
  const combined=new Map(current.map(e=>[e.id,e]));for(const [id,entry] of selected)combined.set(id,entry);
  if(!selected.size)throw Error('先勾选你想采用且证据达标的建议。没有合适的可以先不操作。');await makePreview({operation:'add',selections:[...combined.values()],reason:'Administrator reviewed candidate batch'});
 });
 $('publish').onclick=()=>guard(async()=>{
  if(!preview)throw Error('请重新预览');if(!confirm('确认让 Bot 采用上面列出的全部动态表达规则？核心人设不变。'))return;
  const body=preview;preview=null;$('publication-preview').hidden=true;
  await request('publish',{confirm:true,confirmationId:body.confirmationId,expectedVersion:body.expectedVersion,finalSnapshotHash:body.finalSnapshotHash,requestHash:body.requestHash,idempotencyKey:body.idempotencyKey});await refresh();
 });
 $('cancel-preview').onclick=()=>{preview=null;$('publication-preview').hidden=true;};
 $('initialize').onclick=()=>guard(async()=>{if(confirm('确认创建人格域专用隐私密钥？此操作不会启用文本采集或模型分析。')){await request('initialize',{confirm:true});await refresh();}});
 $('settings').onsubmit=e=>{e.preventDefault();return guard(async()=>{
  if(!confirm('确认保存人格域采集与预算设置？'))return;
  await request('settings',{confirm:true,enabled:$('capture-enabled').checked,captureText:$('capture-text').checked,analysisEnabled:$('analysis-enabled').checked,unlimitedBudget:$('unlimited-budget').checked,dailyBudgetMicros:$('money-budget').value===''?null:Number($('money-budget').value),currency:$('currency').value.trim()||null});await refresh();
 });};
 $('feedback-form').onsubmit=e=>{e.preventDefault();return guard(async()=>{
  if(!confirm('确认记录本次人工评价？'))return;
  await request('feedback',{confirm:true,observationId:$('feedback-observation').value.trim(),dimension:$('feedback-dimension').value,score:Number($('feedback-score').value),note:$('feedback-note').value.trim()});await refresh();
 });};
 void guard(refresh);
})();
