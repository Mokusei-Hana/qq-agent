import { getConfig } from '../config.js';
import { chatCompletion } from '../llm.js';
import { withTimeScope } from '../time-gate.js';
import {resolveModelPrice,priceAt} from '../model-prices.js';
import { digest,fail } from './integrity.js';
export function currentModelInfo() {
 const cfg=getConfig(),api=cfg.api||{};
 const raw=resolveModelPrice(api.model,cfg),price=['official','custom','manual'].includes(raw.source)?priceAt(raw):null;
 return {providerId:String(api.provider||'manual'),model:String(api.model||''),price,fingerprint:digest({provider:api.provider||'',baseUrl:api.baseUrl||'',model:api.model||'',price})};
}
export function createBackgroundModel({canStart=()=>false,chatKeysForScope=()=>[]}={}) {
 return async request=>{
  if(!canStart())fail('CHAT_PRIORITY_CANCELLED');
  const actual=currentModelInfo();if(request.expectedApi?.fingerprint&&request.expectedApi.fingerprint!==actual.fingerprint)fail('MODEL_CONFIG_CHANGED');
  const keys=chatKeysForScope(request.scopeId);
  if(!keys.length)fail('SCOPE_DENIED',403);
  const deadline=new AbortController();const timer=setTimeout(()=>{const e=Error('MODEL_TIMEOUT');e.code='MODEL_TIMEOUT';deadline.abort(e);},120000);timer.unref?.();
  const signal=request.signal?AbortSignal.any([request.signal,deadline.signal]):deadline.signal;
  try{return await withTimeScope(keys,()=>chatCompletion({
   messages:request.messages,tools:null,signal,maxTokens:request.maxTokens,maxResponseBytes:262144,safeErrors:true,requestTimeoutMs:120000,stream:actual.model.startsWith('clinepass/'),
   observer:async event=>{
    if(event.type==='beforeDispatch'){if(!canStart())fail('CHAT_PRIORITY_CANCELLED');await request.onPrepareDispatch?.();}
    if(event.type==='dispatched')await request.onDispatch();
    if(event.type==='response')await request.onResponse({status:event.status,requestId:event.requestId});
   }
  }));}finally{clearTimeout(timer);}
 };
}
