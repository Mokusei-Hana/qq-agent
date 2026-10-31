'use strict';
(function () {
  async function update(patch) {
    const response = await fetch('/api/slang-learning/settings',{method:'POST',headers:{'content-type':'application/json','x-console-token':'qq-agent-console'},body:JSON.stringify(patch)});
    const data=await response.json(); if(!response.ok) throw Error(data.error); return data;
  }
  function install() {
    const section=document.querySelector('#settings-experiments')?.parentElement;
    if(section&&!section.querySelector('#slang-learning-controls')) {
      const row=document.createElement('div');row.id='slang-learning-controls';
      row.innerHTML='<b>黑话学习</b> <label><input type="checkbox"> 启用</label> <button type="button">固化</button> <a href="/slang-learning.html">打开独立页面</a><span role="alert"></span>';
      section.append(row);
      fetch('/api/slang-learning/status',{headers:{'x-console-token':'qq-agent-console'}}).then(r=>r.json()).then(s=>{
        row.querySelector('input').checked=s.enabled;row.querySelector('button').disabled=s.graduated;
      });
      row.querySelector('input').onchange=async e=>{try{await update({enabled:e.target.checked});}catch(error){e.target.checked=!e.target.checked;row.querySelector('span').textContent=error.message;}};
      row.querySelector('button').onclick=async()=>{if(!confirm('将黑话学习固化为独立导航入口？运行开关仍可单独关闭。'))return;try{await update({graduated:true,confirm:true});location.reload();}catch(error){row.querySelector('span').textContent=error.message;}};
    }
  }
  const old=window.renderSettings;
  if(typeof old==='function')window.renderSettings=function(...args){const value=old.apply(this,args);install();return value;};
  fetch('/api/slang-learning/status',{headers:{'x-console-token':'qq-agent-console'}}).then(r=>r.json()).then(s=>{
    if(s.graduated&&!document.querySelector('#slang-learning-nav')){const link=document.createElement('a');link.id='slang-learning-nav';link.href='/slang-learning.html';link.textContent='黑话学习';document.querySelector('#tabs')?.append(link);}
  }).catch(()=>{});
  install();
})();
