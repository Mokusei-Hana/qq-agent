'use strict';
(function(){
 const $=id=>document.getElementById(id),selected=new Map();
 let state=null,current=[],allPreferences=[],preview=null,csrfToken='';
 const tabs=[
  ['overview','运行总览'],
  ['review','AI 建议'],
  ['snapshot','当前规则'],
  ['reflection','复盘报告'],
  ['cognition','表达画像'],
  ['evaluation','效果评估'],
  ['history','版本历史'],
  ['module-settings','采集与预算']
 ];
 function node(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);return e;}
 function button(label,action){const e=node('button',label);e.type='button';e.onclick=()=>guard(action);return e;}
 async function request(action,body){
  const options={credentials:'same-origin',headers:{'content-type':'application/json'}};
  if(body){if(!csrfToken){csrfToken=(await request('csrf')).csrfToken;}options.method='POST';options.headers['x-pe-csrf']=csrfToken;options.body=JSON.stringify(body);}
  const response=await fetch('/api/personality-learning/v2/'+action,options),data=await response.json();
  if(!response.ok){if(data.error==='CSRF_REQUIRED')csrfToken='';throw Error(errors[data.error]||'操作未能完成，请刷新后重试。');}
  return data;
 }
 async function guard(fn){try{$('error').hidden=true;await fn();}catch(e){$('error').textContent=String(e.message||'操作失败');$('error').hidden=false;}}

 const words={
  local:'例行整理',reflection:'每日 AI 复盘',evaluation:'效果评估',trend:'每周趋势总结',
  queued:'等待执行',running:'运行中',waiting_retry:'等待重试',succeeded:'已完成',failed:'失败',skipped:'已跳过',cancelled:'已取消',timed_out:'超时',
  prepared:'准备中',dispatched:'已发出',responded:'已返回',uncertain:'状态未知',
  insufficient_data:'数据还不够',inconclusive:'暂难判断效果',
  preserve:'保持优点',improve:'改进表达',limit:'减少此类表达',
  strength:'表现不错',problem:'有待改进',uncertain_finding:'待观察',
  conciseness:'简洁程度',initiative:'主动性',humor:'幽默感',empathy:'共情能力',
  repetition:'避免重复',mechanical_expression:'减少机械感',scene_adaptation:'场景贴合度',interaction_quality:'整体互动质量',
  chat:'日常闲聊',question:'群友提问',complaint:'吐槽抱怨',sharing:'分享交流',debate:'观点讨论',distress:'情绪低落','*':'所有场景',
  reject:'已标记不采用',request_evidence:'已标记先观望',edit:'已修改措辞',
  publish:'发布新版本',add:'新增规则',remove:'停用规则',rollback:'回滚版本',
  group:'指定群聊',global:'全局',object:'特定群友',
  silence:'未回复',text:'文字回复',direct_answer:'直接回答',follow_up:'追问互动',disagreement:'表达不同意见',joke:'轻松调侃'
 };
 const errors={
  PREFERENCE_CONFLICT:'你同时勾选了同一类且场景重叠的建议，请只保留其中 1 条后再点“下一步”。',
  DUPLICATE_SELECTION:'不能重复选择同一条建议。',
  INSUFFICIENT_VERIFIED_EVIDENCE:'这条建议的聊天证据还不够充分，暂时无法采用。',
  REVISION_REQUIRES_REVIEW_UPDATE:'这条建议之前已被拒绝、修改或标记为观望，请等待新建议或选择新版本。',
  ACTIVE_USE_REMOVE_PUBLICATION:'这条规则正在生效中，如需关闭请点击“停用规则”。',
  VERSION_CONFLICT:'人格版本刚刚有变动，请刷新页面后重新操作。',
  CONFIRMATION_REQUIRED:'确认信息已过期，请重新点击“下一步”核对。',
  CONFIRMATION_MISMATCH:'确认内容与当前选择不一致，请重新核对。',
  CORE_CONTEXT_CHANGED:'基础人设刚刚发生变更，请刷新后重新预览发布。',
  INVALID_EVIDENCE_REFS:'本次 AI 报告引用异常，已自动忽略。',
  MODEL_HTTP_500:'AI 模型服务暂时报错，本次分析未完成。',
  MODEL_OUTPUT_TRUNCATED:'AI 输出过长被截断，本次报告未采纳。',
  MODEL_TIMEOUT:'AI 分析超时，下次空闲时会自动重试。',
  INSUFFICIENT_SAMPLES:'聊天记录还不够多，暂时跳过分析（正常等待中）。',
  STALE_WINDOW:'已有更新的分析任务，跳过旧任务。',
  CHAT_PRIORITY_CANCELLED:'群里正在聊天，已自动暂停本次后台分析。',
  INPUT_BUDGET:'本次整理内容超出单次上限，已自动跳过。',
  PRIVACY_KEY_REQUIRED:'尚未初始化隐私密钥，请先到「采集与预算」完成初始化。',
  MIGRATION_REQUIRED:'数据库需要维护升级，请联系管理员。',
  MODEL_PRICE_UNVERIFIED:'模型计费配置有变动，请到「采集与预算」检查。',
  MONEY_BUDGET_REQUIRED:'请先设置每日费用上限，或勾选“不设每日费用上限”。',
  MODEL_JSON_INVALID:'AI 返回格式异常，本次未采纳。',
  MODEL_SCHEMA_INVALID:'AI 返回内容不完整，本次未采纳。',
  ADMIN_AUTHENTICATION_REQUIRED:'登录状态已失效，请返回控制台重新登录。',
  CSRF_REQUIRED:'页面停留过久，请刷新后重试。'
 };
 const empty={
  jobs:'还没有后台任务记录，开启采集后会自动按计划运行。',
  calls:'还没有调用过 AI 模型进行分析。',
  observations:'还没有收集到群聊互动记录，等 Bot 正常聊天后就会出现。',
  reports:'还没有生成复盘报告，聊天样本达标后会在后台自动分析。',
  traits:'还没有生成表达画像，完成 AI 复盘后会自动总结。',
  preferences:'目前没有待审核的建议。',
  evaluations:'还没有效果评估记录，发布规则并积累一段时间聊天后会自动对比。',
  feedback:'还没有手动打分记录。',
  reviews:'还没有审核记录。',
  versions:'还没有发布过人格版本。',
  'current-snapshot':'当前还没有启用任何动态规则，Bot 仍完全按基础人设回复。'
 };
 const tr=v=>words[v]||String(v??'未知');
 const time=v=>v?new Date(Number(v)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'暂无';
 function parsed(v,fallback={}){try{return typeof v==='string'?JSON.parse(v):v??fallback;}catch{return fallback;}}
 function field(card,label,value){if(value===undefined||value===null||value==='')return;const line=node('p');line.append(node('strong',label+'：'),node('span',String(value)));card.append(line);}
 function list(card,label,items){if(Array.isArray(items)&&items.length){card.append(node('h4',label));const ul=node('ul');for(const item of items)ul.append(node('li',typeof item==='string'?item:item.conclusion||item.explanation||''));card.append(ul);}}

 function records(id,rows,extra){
  const holder=$(id);holder.replaceChildren();
  if(!rows.length){const p=node('p',empty[id]||'暂无记录');p.className='empty';holder.append(p);return;}
  for(const row of rows){
   const card=node('article');card.className='record';
   const report=parsed(row.report_json),features=parsed(row.features_json),metrics=parsed(row.metrics_json);
   const title=row.name||row.conclusion||(
    id==='jobs'?tr(row.kind):
    id==='calls'?'模型调用 · '+tr(row.state):
    id==='reports'?'AI 复盘报告':
    id==='observations'?tr(features.scene||'chat')+' · '+tr(features.responseType||'text'):
    id==='versions'?(row.id===0?'初始默认版本（v0）':'人格版本 v'+row.id):
    id==='reviews'?tr(row.operation||row.action):
    id==='feedback'?tr(row.dimension):
    id==='evaluations'?'版本效果对比':'表达规则'
   );
   card.append(node('h3',title));

   if(id==='jobs'){
    field(card,'状态',tr(row.state));
    field(card,'时间',time(row.finished_at||row.created_at));
    if(row.error_code){
     field(card,'说明',row.state==='succeeded'&&row.kind==='local'?'整理完成，等待积累更多聊天记录再分析':errors[row.error_code]||'已跳过或未完成');
    }
   }else if(id==='calls'){
    field(card,'时间',time(row.dispatched_at||row.prepared_at));
    field(card,'结果',tr(row.state));
    if(row.input_tokens!=null||row.output_tokens!=null){
     field(card,'消耗 Token','输入 '+(row.input_tokens??0)+' / 输出 '+(row.output_tokens??0));
    }
    if(row.error_code)field(card,'原因',errors[row.error_code]||'请求未成功');
   }else if(id==='observations'){
    field(card,'时间',time(row.occurred_at));
    field(card,'回复字数',features.length===undefined?null:features.length+' 字');
    field(card,'当时版本','v'+row.version_id);
    field(card,'观察 ID',row.id);
   }else if(id==='reports'){
    field(card,'完成时间',time(row.created_at));
    field(card,'总结','发现 '+(report.findings?.length??0)+' 处表现，提出 '+(report.proposals?.length??0)+' 条建议');
    for(const finding of report.findings||[]){
     field(card,tr(finding.kind)+'（'+tr(finding.dimension)+'）',finding.conclusion);
    }
    list(card,'需要注意的局限',report.limitations);
   }else if(id==='preferences'||id==='current-snapshot'){
    const dim=parsed(row.rule_json,{}).dimension||row.dimension;
    field(card,id==='preferences'?'建议做法':'生效规则',row.rule_text||row.rule);
    field(card,'提出理由',row.rationale);
    field(card,'所属维度',dim?tr(dim):'');
    field(card,'适用场景',(row.scenes||parsed(row.scenes_json,[])).map(tr).join('、'));
    if(id==='preferences'){
     const r=row.publicationReadiness||{};
     const inUse=current.some(e=>e.id===row.preference_id&&e.revision===row.revision);
     field(card,'当前状态',inUse?'正在使用中':row.review_action?tr(row.review_action):r.ready?'已达标，可勾选采用':'证据还在积累中');
     if(r.interactions!==undefined){
      const days=(r.spanMs/86400000).toFixed(1), reqDays=(r.requiredSpanMs/86400000);
      field(card,'证据进度',r.interactions+'/'+r.requiredInteractions+' 条互动 · '+r.sources+'/'+r.requiredSources+' 位群友 · 跨度 '+days+'/'+reqDays+' 天 · 把握度 '+Math.round((row.confidence||0)*100)+'%');
     }
     if(!inUse&&!r.ready&&r.reason==='INSUFFICIENT_VERIFIED_EVIDENCE'){
      const missing=[];
      if(r.interactions<r.requiredInteractions)missing.push('互动数还差 '+(r.requiredInteractions-r.interactions)+' 条');
      if(r.sources<r.requiredSources)missing.push('需至少 '+r.requiredSources+' 位不同群友');
      if(r.spanMs<r.requiredSpanMs)missing.push('时间跨度需满 '+r.requiredSpanMs/86400000+' 天');
      if(r.confidence<r.requiredConfidence)missing.push('AI 把握度需达 '+Math.round(r.requiredConfidence*100)+'%');
      if(missing.length)field(card,'暂不能采用原因',missing.join('；'));
     }
    }
    list(card,'可能带来的影响',parsed(row.risks_json,[]));
   }else if(id==='traits'){
    field(card,'AI 把握度',Math.round(row.confidence*100)+'%');
    field(card,'统计时间段',time(row.window_start)+' 至 '+time(row.window_end));
    list(card,'参考局限',parsed(row.limitations_json,[]));
   }else if(id==='versions'){
    const entries=parsed(row.content,[]);
    field(card,'状态',row.id===state.version?'当前正在使用':'历史版本');
    if(row.created_at)field(card,'发布时间',time(row.created_at));
    field(card,'说明',row.change_summary);
    field(card,'包含规则数',entries.length+' 条');
    for(const entry of entries)field(card,entry.name||'规则',entry.rule);
   }else if(id==='evaluations'){
    field(card,'评估结果',tr(row.result));
    field(card,'对比版本','v'+(row.baseline_version??0)+' → v'+row.target_version);
    field(card,'样本量','发布前 '+(metrics.before?.interactions??0)+' 条 / 发布后 '+(metrics.after?.interactions??0)+' 条');
   }else if(id==='feedback'){
    field(card,'评价',Number(row.score)>0?'好评':Number(row.score)<0?'差评':'一般');
    field(card,'备注',row.note);
    field(card,'时间',time(row.created_at));
   }else if(id==='reviews'){
    field(card,'审核说明',row.reason);
    field(card,'时间',time(row.created_at));
    if(row.result_version!=null)field(card,'版本变化','v'+row.base_version+' → v'+row.result_version);
   }
   if(extra)extra(card,row);
   holder.append(card);
  }
 }

 function metric(label,value,hint){
  const card=node('div');card.className='metric';
  card.append(node('span',label),node('strong',value??'—'),node('small',hint));
  return card;
 }

 function renderOverview(data){
  const cfg=state.settings||{},issues=[state.error,state.backgroundError,state.retentionError].filter(Boolean);
  $('status').textContent=issues.length
   ?'需要关注：'+issues.map(e=>errors[e]||'运行异常').join('；')
   :state.active?(state.running?'运行正常 · AI 正在后台复盘分析':'运行正常 · 正在持续记录群聊表现'):'已暂停采集（历史数据仍可查看）';

  const holder=$('overview-data');holder.replaceChildren();holder.className='metrics';
  const readyCount=(data.preferences||[]).filter(p=>p.publicationReadiness?.ready&&!current.some(e=>e.id===p.preference_id&&e.revision===p.revision)).length;
  holder.append(
   metric('已采集聊天记录',state.observations,'持续自动积累中'),
   metric('AI 复盘次数',state.analysisSucceeded,'已生成 '+(data.preferences?.length??0)+' 条建议'),
   metric('待你审核的达标建议',readyCount,current.length?'当前生效 '+current.length+' 条规则（v'+state.version+'）':'当前尚未发布新规则'),
   metric('最近一次采集',time(state.lastObservation),'北京时间')
  );

  const guide=$('run-explanation');guide.replaceChildren();guide.append(node('h3','当前进度'));
  field(guide,'1. 采集聊天',state.active?'正常进行中':'已暂停，可在「采集与预算」中开启');
  field(guide,'2. 后台分析',!cfg.analysisEnabled?'未开启，可在「采集与预算」中开启':state.running?'AI 正在复盘分析':'已开启，每天凌晨 03:30 后自动复盘（攒够 50 条聊天记录触发）');
  field(guide,'3. 审核发布',current.length?'已上线 '+current.length+' 条表达规则（v'+state.version+'），可在「当前规则」查看':readyCount?'已有 '+readyCount+' 条建议达标，去「AI 建议」勾选 1 条即可发布 v1！':'暂无达标建议，继续正常聊天积累样本即可。');

  const health=$('health-summary');health.replaceChildren();
  field(health,'模型调用统计','成功 '+(state.callsSucceeded??0)+' 次 / 失败 '+(state.callsFailed??0)+' 次 / 超时 '+(state.callsTimedOut??0)+' 次');
  field(health,'最近分析时间',time(state.lastAnalysis));
  field(health,'每日预算',cfg.unlimitedBudget?'不设费用上限（每日最多 '+cfg.modelDailyLimit+' 次分析）':cfg.dailyBudgetMicros===null?'未设置费用上限':(cfg.dailyBudgetMicros/1000000)+' '+(cfg.currency||'')+' / 天');
 }

 function showEvidence(id){
  return guard(async()=>{
   $('evidence-detail').hidden=false;
   const r=await request('evidence?id='+encodeURIComponent(id));
   const box=$('evidence-summary');box.replaceChildren();
   const f=r.data.features||{};
   field(box,'发生时间',time(r.data.occurred_at));
   field(box,'聊天场景',tr(f.scene||'chat'));
   field(box,'回复方式',tr(f.responseType||'text'));
   if(f.length!==undefined)field(box,'回复字数',f.length+' 字');
   field(box,'关联的建议或特征',(r.data.references?.length??0)+' 项');
   if(r.data.text){
    if(r.data.text.context)field(box,'脱敏上下文',r.data.text.context);
    if(r.data.text.reply)field(box,'脱敏回复',r.data.text.reply);
   }else{
    field(box,'原文说明','为保护隐私，本条仅保留行为特征，未展示聊天原文。');
   }
   $('evidence-detail').scrollIntoView({behavior:'smooth',block:'start'});
  });
 }

 async function makePreview(input){
  preview=null;$('publication-preview').hidden=true;
  const p=await request('preview',{expectedVersion:state.version,...input});
  preview={...p,idempotencyKey:crypto.randomUUID()};
  const summary=$('preview-summary');summary.replaceChildren();
  field(summary,'版本变化','将从 v'+state.version+' 升级为新版本（生效规则：'+current.length+' 条 → '+p.entries.length+' 条）');
  for(const entry of p.entries){
   const old=current.find(e=>e.id===entry.id&&e.revision===entry.revision);
   field(summary,(old?'保持不变':'本次新增')+' · '+(entry.name||'表达规则'),entry.rule||'');
  }
  for(const entry of current.filter(e=>!p.entries.some(n=>n.id===e.id))){
   field(summary,'本次停用 · '+(entry.name||'表达规则'),entry.rule||'');
  }
  $('publication-preview').hidden=false;
  $('publication-preview').scrollIntoView({behavior:'smooth',block:'start'});
 }

 async function decision(row,action){
  const reason=prompt(action==='edit'?'请简述修改原因：':action==='reject'?'请简述不采用的原因：':'请简述哪里证据还不够：');
  if(!reason)return;
  let patch={};
  if(action==='edit'){
   const rule=prompt('输入修改后的规则措辞（保存为新草稿，不会立即生效）：',row.rule_text);
   if(rule===null)return;
   patch={rule};
   if(!confirm('确认保存新措辞？\n原规则：'+row.rule_text+'\n新规则：'+rule))return;
  }else if(!confirm(action==='reject'?'确认不采用这条建议？':'确认先标记为观望？'))return;
  await request('decide',{confirm:true,action,id:row.preference_id,revision:row.revision,reason,patch,idempotencyKey:crypto.randomUUID()});
  await refresh();
 }

 function updateSelection(){
  $('review-selection').textContent=selected.size
   ?'已勾选 '+selected.size+' 条建议，点击右侧按钮进行发布前核对（同类别建议一次只能选 1 条）。'
   :'尚未勾选任何建议。只有「已达标」的建议可以勾选采用。';
  $('preview-selected').disabled=selected.size===0;
 }

 function preferenceBucket(row){
  if(current.some(e=>e.id===row.preference_id&&e.revision===row.revision))return 'active';
  if(row.review_action)return 'reviewed';
  return row.publicationReadiness?.ready?'ready':'pending';
 }

 function renderPreferences(){
  const q=($('pref-search')?.value||'').trim().toLocaleLowerCase();
  const statusFilter=$('pref-status-filter')?.value||'';
  const dimFilter=$('pref-dimension-filter')?.value||'';
  const filtered=allPreferences.filter(row=>{
   if(statusFilter&&preferenceBucket(row)!==statusFilter)return false;
   const dim=parsed(row.rule_json,{}).dimension||row.dimension||'';
   if(dimFilter&&dim!==dimFilter)return false;
   if(q){
    const hay=[row.name,row.rule_text,row.rationale,tr(dim)].join(' ').toLocaleLowerCase();
    if(!hay.includes(q))return false;
   }
   return true;
  });
  if($('pref-count'))$('pref-count').textContent=(q||statusFilter||dimFilter)?'显示 '+filtered.length+' / '+allPreferences.length+' 条':'共 '+allPreferences.length+' 条';
  records('preferences',filtered,(card,row)=>{
   const inUse=current.some(e=>e.id===row.preference_id&&e.revision===row.revision),eligible=row.publicationReadiness?.ready===true;
   if(!inUse){
    const label=node('label',eligible?'采用这条建议':'暂未达标，还不能采用'),box=node('input');
    box.type='checkbox';box.disabled=!eligible;
    const picked=selected.get(row.preference_id);
    box.checked=!!(picked&&picked.revision===row.revision);
    box.onchange=()=>{if(box.checked)selected.set(row.preference_id,{id:row.preference_id,revision:row.revision,contentHash:row.content_hash});else selected.delete(row.preference_id);updateSelection();};
    label.prepend(box);card.append(label);
    card.append(
     button('修改措辞',()=>decision(row,'edit')),
     button('不采用',()=>decision(row,'reject')),
     button('先观望',()=>decision(row,'request_evidence'))
    );
   }else{
    card.append(button('停用规则',()=>makePreview({operation:'remove',selections:current.filter(e=>e.id!==row.preference_id),reason:'停用规则'})));
   }
  });
 }

 async function refresh(){
  preview=null;selected.clear();updateSelection();$('publication-preview').hidden=true;
  state=await request('status');
  const kinds=['jobs','calls','observations','reports','traits','preferences','evaluations','feedback','reviews','versions'];
  const results=await Promise.all(kinds.map(k=>request(k)));
  const data=Object.fromEntries(kinds.map((k,i)=>[k,results[i].data]));
  const active=data.versions.find(v=>v.id===state.version);current=active?parsed(active.content,[]):[];
  allPreferences=data.preferences||[];
  renderOverview(data);
  for(let i=0;i<kinds.length;i++){
   const kind=kinds[i],rows=results[i].data;
   if(kind==='preferences'){renderPreferences();continue;}
   if(kind==='versions'){const active=rows.find(v=>v.id===state.version);current=active?JSON.parse(active.content):[];records('current-snapshot',current);}
   records(kind,rows,(card,row)=>{
    if(kind==='versions'&&row.id!==state.version)card.append(button('回滚到此版本',()=>makePreview({operation:'rollback',rollbackTarget:row.id,reason:'回滚到历史版本'})));
    if(kind==='observations')card.append(button('查看详情',()=>showEvidence(row.id)));
   });
  }
  const cfg=state.settings||{};
  $('capture-enabled').checked=!!cfg.enabled;
  $('capture-text').checked=!!cfg.captureText;
  $('analysis-enabled').checked=!!cfg.analysisEnabled;
  $('unlimited-budget').checked=cfg.unlimitedBudget===true;
  $('money-budget').value=cfg.dailyBudgetMicros??'';
  $('currency').value=cfg.currency||'';
  $('initialize').disabled=state.privacyKeyReady===true;
 }

 for(const [id,label] of tabs){
  const b=button(label,async()=>{
   for(const [other] of tabs)$(other).hidden=other!==id;
   for(const item of $('sections').children)item.setAttribute('aria-current',item===b?'page':'false');
  });
  b.setAttribute('aria-current',id==='overview'?'page':'false');
  $('sections').append(b);
 }
 $('refresh').onclick=()=>guard(refresh);
 $('pref-search').oninput=renderPreferences;
 $('pref-status-filter').onchange=renderPreferences;
 $('pref-dimension-filter').onchange=renderPreferences;
 $('preview-selected').onclick=()=>guard(async()=>{
  const combined=new Map(current.map(e=>[e.id,e]));for(const [id,entry] of selected)combined.set(id,entry);
  if(!selected.size)throw Error('请先勾选至少 1 条已达标的建议。');
  await makePreview({operation:'add',selections:[...combined.values()],reason:'人工审核采纳建议'});
 });
 $('publish').onclick=()=>guard(async()=>{
  if(!preview)throw Error('请先重新点击“下一步”核对。');
  if(!confirm('确认发布为新版本并立即在群聊生效？不会改动基础人设。'))return;
  const body=preview;preview=null;$('publication-preview').hidden=true;
  await request('publish',{confirm:true,confirmationId:body.confirmationId,expectedVersion:body.expectedVersion,finalSnapshotHash:body.finalSnapshotHash,requestHash:body.requestHash,idempotencyKey:body.idempotencyKey});
  await refresh();
 });
 $('cancel-preview').onclick=()=>{preview=null;$('publication-preview').hidden=true;};
 $('initialize').onclick=()=>guard(async()=>{if(confirm('确认初始化隐私密钥？')){await request('initialize',{confirm:true});await refresh();}});
 $('settings').onsubmit=e=>{e.preventDefault();return guard(async()=>{
  if(!confirm('确认保存当前采集与预算设置？'))return;
  await request('settings',{confirm:true,enabled:$('capture-enabled').checked,captureText:$('capture-text').checked,analysisEnabled:$('analysis-enabled').checked,unlimitedBudget:$('unlimited-budget').checked,dailyBudgetMicros:$('money-budget').value===''?null:Number($('money-budget').value),currency:$('currency').value.trim()||null});
  await refresh();
 });};
 $('feedback-form').onsubmit=e=>{e.preventDefault();return guard(async()=>{
  if(!confirm('确认提交这条打分反馈？'))return;
  await request('feedback',{confirm:true,observationId:$('feedback-observation').value.trim(),dimension:$('feedback-dimension').value,score:Number($('feedback-score').value),note:$('feedback-note').value.trim()});
  await refresh();
 });};
 void guard(refresh);
})();
