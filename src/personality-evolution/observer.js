import crypto from 'node:crypto';
import { redact } from './privacy.js';
import { canonical,digest,fail } from './integrity.js';
export class Observer {
 constructor({key,host,allowed=()=>false,maxPending=500,captureText=false,now=Date.now}) {
  if(!Buffer.isBuffer(key)||key.length!==32)fail('PRIVACY_KEY_REQUIRED');
  this.key=key;this.host=host;this.allowed=allowed;this.maxPending=maxPending;this.captureText=captureText;this.now=now;this.pending=0;this.dropped=0;this.accepted=0;this.failed=0;this.buffer=[];this.timer=null;this.inFlight=null;this.closed=false;
 }
 pseudonym(kind,value){return kind+'_'+crypto.createHmac('sha256',this.key).update(kind+':'+value).digest('hex').slice(0,24);}
 scope(chat){return this.pseudonym('g',chat);}
 observe({chatKey,messageId,interactionId,sourceId='',text='',context='',aliases=[],features={},version=0,injected=[],sticker=false,silence=false}) {
  if(this.closed||!this.allowed(chatKey)||!/^group:[1-9]\d*$/.test(chatKey)||sticker||messageId==null||(!silence&&!String(text).trim()))return false;
  if(this.pending>=this.maxPending){this.dropped++;return false;}
  const allowedFeatures={};
  for(const key of ['length','scene','responseType','joking','emptyFiller']) {
   const value=features[key];
   if(key==='length'&&Number.isSafeInteger(value)&&value>=0&&value<=2000)allowedFeatures[key]=value;
   if(key==='scene'&&['question','complaint','sharing','debate','distress','chat'].includes(value))allowedFeatures[key]=value;
   if(key==='responseType'&&['silence','follow_up','disagreement','empathy','joke','direct_answer'].includes(value))allowedFeatures[key]=value;
   if(['joking','emptyFiller'].includes(key)&&typeof value==='boolean')allowedFeatures[key]=value;
  }
  const scopeId=this.scope(chatKey),subjectId=sourceId?this.pseudonym('o',chatKey+':'+sourceId):null,id=this.pseudonym('obs',chatKey+':'+messageId);
  const payload={id,scopeId,subjectId,interactionId:this.pseudonym('turn',chatKey+':'+(interactionId||messageId)),at:this.now(),features:allowedFeatures,version,injected};
  if(this.captureText&&!silence) {
   const clean=redact(text,aliases),cleanContext=redact(context,aliases);
   const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',this.key,iv);
   const content=Buffer.concat([cipher.update(canonical({reply:clean,context:cleanContext}),'utf8'),cipher.final()]);
   payload.textPayload={ciphertext:Buffer.concat([iv,cipher.getAuthTag(),content]),keyId:digest(this.key).slice(0,16)};
  }
  this.pending++;this.buffer.push(payload);
  if(!this.timer&&!this.inFlight){this.timer=setTimeout(()=>this.flush(),25);this.timer.unref?.();}
  return true;
 }
 async flush() {
  if(this.inFlight)return this.inFlight;
  clearTimeout(this.timer);this.timer=null;
  const batch=this.buffer.splice(0,16);if(!batch.length)return;
  this.inFlight=Promise.resolve().then(()=>this.host.data('observeBatch',{observations:batch}))
   .then(()=>{this.accepted+=batch.length;},()=>{this.failed+=batch.length;})
   .finally(()=>{this.pending-=batch.length;this.inFlight=null;if(this.buffer.length&&!this.closed){this.timer=setTimeout(()=>this.flush(),25);this.timer.unref?.();}});
  return this.inFlight;
 }
 async close() {
  this.closed=true;clearTimeout(this.timer);this.timer=null;let timeout;
  try{await Promise.race([(async()=>{while(this.pending)await this.flush();})(),new Promise(resolve=>{timeout=setTimeout(resolve,1000);})]);}
  finally{clearTimeout(timeout);this.dropped+=this.buffer.length;this.pending-=this.buffer.length;this.buffer=[];}
 }
}
export function decryptPayload(payload,key) {
 const bytes=Buffer.from(payload.ciphertext),decipher=crypto.createDecipheriv('aes-256-gcm',key,bytes.subarray(0,12));
 decipher.setAuthTag(bytes.subarray(12,28));
 return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
}
