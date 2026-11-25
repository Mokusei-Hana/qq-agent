export class Scheduler {
 constructor(host,{busy=()=>true,intervalMs=60000,beforeTick=async()=>{}}={}){this.host=host;this.busy=busy;this.intervalMs=intervalMs;this.beforeTick=beforeTick;this.timer=null;this.running=false;this.error='';}
 start(){this.stop();this.timer=setInterval(()=>this.tick(),this.intervalMs);this.timer.unref?.();}
 stop(){clearInterval(this.timer);this.timer=null;}
 async tick(){
  if(this.running)return;this.running=true;
  try{await this.beforeTick();await this.host.setBusy(this.busy());await this.host.data('schedule');await this.host.data('pump');await this.host.refresh();this.error='';}
  catch(e){this.error=e.code||'BACKGROUND_UNAVAILABLE';}
  finally{this.running=false;}
 }
}
export class PrivacyRetentionService {
 constructor(host){this.host=host;this.timer=null;this.error='';}
 start(){this.stop();void this.tick();this.timer=setInterval(()=>this.tick(),3600000);this.timer.unref?.();}
 stop(){clearInterval(this.timer);this.timer=null;}
 async tick(){try{await this.host.data('cleanupText');this.error='';}catch{this.error='TEXT_RETENTION_FAILED';}}
}
