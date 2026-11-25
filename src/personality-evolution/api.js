import crypto from 'node:crypto';
import {fail} from './integrity.js';
function same(a,b){const x=Buffer.from(String(a||'')),y=Buffer.from(String(b||''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
export function createEvolutionApi({learning,config,readBody,json,now=Date.now}){
 const secret=crypto.randomBytes(32);
 function token(req){
  const configured=config().server?.token;if(!configured||!config().admin?.ownerUin)fail('ADMIN_AUTHENTICATION_REQUIRED',403);
  const cookie=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('qq_agent_token='));
  let raw=req.headers['x-console-token'];if(!raw&&cookie){try{raw=decodeURIComponent(cookie.slice('qq_agent_token='.length));}catch{}}
  if(!same(raw,configured))fail('ADMIN_AUTHENTICATION_REQUIRED',401);return configured;
 }
 function csrf(raw,bucket){return bucket+'.'+crypto.createHmac('sha256',secret).update(raw+'\0'+bucket).digest('hex');}
 return async(req,res,url)=>{
  try{
   const raw=token(req),action=url.pathname.slice('/api/personality-learning/v2/'.length),bucket=Math.floor(now()/300000);
   if(req.method==='GET'){
    if(action==='csrf')return json(res,200,{csrfToken:csrf(raw,bucket),expiresInMs:300000,principalType:'shared-console-token',individualIdentityVerified:false});
    if(action==='status'){await learning.reload();return json(res,200,learning.status());}
    return json(res,200,await learning.query(action,{limit:Number(url.searchParams.get('limit')||50),offset:Number(url.searchParams.get('offset')||0),id:url.searchParams.get('id')||undefined,includeText:url.searchParams.get('includeText')==='true'}));
   }
   if(req.method!=='POST')fail('METHOD_NOT_ALLOWED',405);
   const given=req.headers['x-pe-csrf'];
   if(!same(given,csrf(raw,bucket))&&!same(given,csrf(raw,bucket-1)))fail('CSRF_REQUIRED',403);
   if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail('JSON_REQUIRED',415);
   const body=await readBody(req,32768);
   if(!body||typeof body!=='object'||Array.isArray(body))fail('INVALID_BODY');
   if(['actor','principal','ownerUin','secret'].some(k=>Object.hasOwn(body,k)))fail('ACTOR_IS_SERVER_ASSIGNED');
   if(!['preview','publish','decide','settings','initialize','feedback'].includes(action))fail('UNKNOWN_REVIEW_API',404);
   const {confirm,...input}=body;
   if(action!=='preview'&&confirm!==true)fail('EXPLICIT_CONFIRMATION_REQUIRED',409);
   return json(res,200,await learning.review(action,raw,input));
  }catch(e){
   const code=/^[A-Z][A-Z0-9_]{2,79}$/.test(e.code||'')?e.code:'EVOLUTION_OPERATION_FAILED';
   return json(res,e.status||e.httpStatus||400,{error:code});
  }
 };
}
