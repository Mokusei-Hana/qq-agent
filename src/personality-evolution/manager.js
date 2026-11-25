import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {EvolutionHost} from './host.js';
import {Observer} from './observer.js';
import {Scheduler,PrivacyRetentionService} from './scheduler.js';
import {renderSnapshot} from './snapshot-reader.js';
import {canonical,digest,fail} from './integrity.js';
import {currentModelInfo,createBackgroundModel} from './model-adapter.js';
import {buildSystemPrompt} from '../prompt.js';
import {getConfig} from '../config.js';
import {resolveModelPrice,priceAt} from '../model-prices.js';

export class EvolutionManager {
 constructor({dataDir,allowed=()=>false,authenticate=()=>null,busy=()=>true,now=Date.now,log=()=>{}}){
  this.dataDir=dataDir;this.allowed=allowed;this.authenticate=authenticate;this.busy=busy;this.now=now;this.log=log;
  this.file=path.join(dataDir,'personality-learning.sqlite');this.keyFile=path.join(dataDir,'personality-evolution.key');
  this.host=null;this.observer=null;this.active=false;this.error='';this.cfg={};this.generation=0;this.ready=Promise.resolve();
 }
 start(cfg){
  const generation=++this.generation;this.cfg=cfg;this.active=false;
  this.ready=this.#start(generation).catch(()=>{if(generation===this.generation){this.error='EVOLUTION_START_FAILED';this.log('[personality-evolution] EVOLUTION_START_FAILED; chat continues');}});
  return this.ready;
 }
 async #start(generation){
  await this.#close();
  if(generation!==this.generation)return;
  if(!fs.existsSync(this.file)){this.error='MIGRATION_REQUIRED';return;}
  let key=null;
  try{
   const stat=fs.lstatSync(this.keyFile);
   if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))fail('PRIVACY_KEY_PERMISSIONS');
   key=fs.readFileSync(this.keyFile);if(key.length!==32)fail('PRIVACY_KEY_INVALID');
  }catch(e){if(e.code!=='ENOENT')throw e;}
  const scopeObserver=key?new Observer({key,host:null,allowed:()=>false}):null;
  const chats=this.cfg.groups.map(g=>'group:'+g).filter(c=>this.allowed(c));
  const scopes=scopeObserver?chats.map(c=>scopeObserver.scope(c)):[];
  const host=new EvolutionHost({file:this.file,allowedScopes:scopes,coreHash:digest(buildSystemPrompt()),privacyKey:key,apiInfo:currentModelInfo(),authenticate:this.authenticate,
   model:createBackgroundModel({canStart:()=>this.cfg.enabled&&!this.busy()&&this.active,chatKeysForScope:id=>chats.filter(c=>scopeObserver?.scope(c)===id&&this.allowed(c))})});
  this.host=host;await host.start();
  if(generation!==this.generation){await host.stop();return;}
  if(key)this.observer=new Observer({key,host,now:this.now,allowed:c=>this.cfg.enabled&&this.cfg.groups.includes(c.slice(6))&&this.allowed(c),captureText:host.status.settings.captureText});
  this.active=!!key&&this.cfg.enabled&&host.status.settings.enabled;this.error=key?'':'PRIVACY_KEY_REQUIRED';
  // Independent retention survives learning disablement; it never calls a model.
  this.retention=new PrivacyRetentionService(host);this.retention.start();
  this.scheduler=new Scheduler(host,{busy:()=>!this.cfg.enabled||this.busy(),beforeTick:()=>host.data('api',{apiInfo:currentModelInfo()})});
  if(this.active)this.scheduler.start();
 }
 async #close(){
  this.scheduler?.stop();this.retention?.stop();await this.observer?.close();this.observer=null;const host=this.host;this.host=null;this.active=false;
  if(host)await host.stop();
 }
 async stop(){++this.generation;await this.#close();}
 async initialize(auth){
  if(!this.authenticate(auth))fail('AUTHENTICATION_REQUIRED',401);
  if(!fs.existsSync(this.file))fail('MIGRATION_REQUIRED');
  if(fs.existsSync(this.keyFile))fail('PRIVACY_KEY_ALREADY_EXISTS');
  // Explicit administrative action, never a GET/startup side effect.
  fs.writeFileSync(this.keyFile,crypto.randomBytes(32),{flag:'wx',mode:0o600});
  await this.start(this.cfg);return this.status();
 }
 async refresh(){await this.ready;if(!this.host)fail('EVOLUTION_UNAVAILABLE',503);await this.host.data('api',{apiInfo:currentModelInfo()});await this.host.refresh();return this.status();}
 status(){
  const snapshot=this.host?.snapshot(),stats=this.host?.status||{};
  return {...stats,version:snapshot?.version??null,active:this.active,error:this.error||this.host?.failure||'',privacyKeyReady:!!this.observer,
   backgroundError:this.scheduler?.error||'',retentionError:this.retention?.error||'',
   observationQueue:this.observer?{pending:this.observer.pending,accepted:this.observer.accepted,dropped:this.observer.dropped,failed:this.observer.failed}:null,
   automaticPublicationSupported:false,scopePolicy:{group:true,object:false,global:false}};
 }
 context(chat,text='',subject='',scene='chat'){
  const snapshot=this.host?.snapshot(),empty={text:'',injected:[],version:snapshot?.version??0,fingerprint:''};
  if(!this.active||this.host?.failure||!this.cfg.injectEnabled||this.cfg.mode!=='dynamic'||!this.allowed(chat)||!this.cfg.groups.includes(chat.slice(6))||!this.observer)return empty;
  const scopeId=this.observer.scope(chat),subjectId=subject?this.observer.pseudonym('o',chat+':'+subject):null;
  const result=renderSnapshot(snapshot,{scopeId,subjectId,scene,maxBytes:this.cfg.maxTokens,now:this.now()});
  return {...result,version:snapshot?.version??0,fingerprint:digest({hash:snapshot?.hash,scopeId,subjectId,scene,maxBytes:this.cfg.maxTokens})};
 }
 observe(event){if(this.active&&this.observer)return this.observer.observe(event);return false;}
 chatPriority(){void this.host?.setBusy(true).catch(()=>{});}
 async review(action,auth,body){
  await this.ready;if(!this.host)fail('EVOLUTION_UNAVAILABLE',503);
  if(action==='initialize')return this.initialize(auth);
  await this.host.data('core',{hash:digest(buildSystemPrompt())});
  if(action==='settings'){
   if(body.captureText&&!this.observer)fail('PRIVACY_KEY_REQUIRED');
   if(body.analysisEnabled){
    const cfg=getConfig(),raw=resolveModelPrice(cfg.api.model,cfg),p=priceAt(raw);
    const known=['official','custom','manual'].includes(raw.source)&&!!(p.in||p.out);
    const unlimited=body.unlimitedBudget??this.host.status.settings.unlimitedBudget??false;
    if(!known&&!unlimited)fail('MODEL_PRICE_UNVERIFIED');
    body={...body,priceInputPerM:known?p.in:null,priceOutputPerM:known?p.out:null,priceCachedPerM:known?(p.cached??p.in):null};
   }else if(Object.keys(body).some(k=>k.startsWith('price')))fail('USE_EXISTING_MODEL_PRICES');
  }
  const result=await this.host.review(action,auth,body);
  if(action==='settings'){await this.start(this.cfg);}
  return result;
 }
 async query(kind,options={}){await this.ready;if(!this.host)fail('EVOLUTION_UNAVAILABLE',503);return this.host.data('query',{kind,...options});}
}
