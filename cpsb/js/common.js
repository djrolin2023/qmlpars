/* ============ 全局基础 ============ */
const API = location.origin;

function esc(s){ return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]); }
function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============ 动态站点设置（后台可改，公开读取） ============ */
async function loadSiteSettings(){
  try{
    const r = await fetch(API + '/api/settings/public');
    if(!r.ok) return;
    const j = await r.json();
    const d = (j && j.data) || {};
    if(d.COMPANY_NAME){
      const name = d.COMPANY_NAME;
      const org = document.getElementById('orgName');
      if(org) org.textContent = name + ' · 车辆识别';
    }
    const icpLine = document.getElementById('icpLine');
    if(icpLine) icpLine.innerHTML = d.ICP_NO ? (escapeHtml(d.ICP_NO) + '<br>') : '';
    const policeLine = document.getElementById('policeLine');
    const policeNo = document.getElementById('policeNo');
    if(d.POLICE_NO){
      if(policeNo) policeNo.textContent = d.POLICE_NO;
      if(policeLine) policeLine.href = d.POLICE_URL || 'https://beian.mps.gov.cn/#/query/webSearch';
    }else{
      if(policeNo) policeNo.textContent = '网络不是非法之地，切莫侥幸以身试法';
    }
    // 图片资源（后台可改，缺省回退固定文件）
    if(d.LOGO_URL){ const o=document.getElementById('orgLogo'); if(o) o.src = d.LOGO_URL; }
    if(d.POLICE_ICON_URL){ const p=document.querySelector('#policeLine .police'); if(p) p.src = d.POLICE_ICON_URL; }
    if(d.FAVICON_URL){ let l=document.querySelector("link[rel~='icon']"); if(!l){ l=document.createElement('link'); l.rel='icon'; document.head.appendChild(l);} l.href = d.FAVICON_URL; }
  }catch(e){ /* 静默忽略，使用默认值 */ }
}
loadSiteSettings();

/* ============ 扫描提示音 ============ */
let _sndSuccess=null, _sndFailure=null, _sndNoResult=null, _audioUnlocked=false;
function getAudio(kind){
  if(kind==='success'){
    if(!_sndSuccess) _sndSuccess=new Audio('sond/Success.mp3');
    return _sndSuccess;
  }else if(kind==='noresult'){
    if(!_sndNoResult) _sndNoResult=new Audio('sond/noresult.mp3');
    return _sndNoResult;
  }else{
    if(!_sndFailure) _sndFailure=new Audio('sond/failure.mp3');
    return _sndFailure;
  }
}
function playSound(kind){
  try{
    const a=getAudio(kind);
    a.currentTime=0;
    const p=a.play();
    if(p&&p.catch) p.catch(()=>{ /* 浏览器策略限制时静默忽略 */ });
  }catch(e){ /* 静默忽略 */ }
}
/* 浏览器自动播放策略：首次用户手势时激活音频与语音 */
function unlockAudio(){
  if(_audioUnlocked) return;
  _audioUnlocked=true;
  [getAudio('success'), getAudio('failure'), getAudio('noresult')].forEach(a=>{
    a.muted=true; a.volume=0;
    const p=a.play();
    if(p&&p.catch) p.catch(()=>{});
    else a.pause();
    a.muted=false; a.volume=1;
  });
  // 激活语音合成引擎
  try{
    if('speechSynthesis' in window){
      pickZhVoice();
      const u=new SpeechSynthesisUtterance(' ');
      u.volume=0;
      speechSynthesis.speak(u);
    }
  }catch(e){}
}

/* 语音列表异步加载完成后重新选择中文 voice */
if('speechSynthesis' in window){
  speechSynthesis.onvoiceschanged = pickZhVoice;
  pickZhVoice();
}
['click','touchstart'].forEach(ev=>document.addEventListener(ev, unlockAudio, {once:false, passive:true}));

/* ============ 语音提示 ============ */
let _lastSpeak=0, _zhVoice=null;
function pickZhVoice(){
  try{
    const vs=speechSynthesis.getVoices()||[];
    _zhVoice = vs.find(v=>/zh|cmn|Chinese/i.test(v.lang||'')) || vs.find(v=>/zh|cmn|Chinese/i.test(v.name||'')) || null;
  }catch(e){ _zhVoice=null; }
}
function speak(text){
  try{
    if(!('speechSynthesis' in window)) return;
    const now=Date.now();
    if(now-_lastSpeak<4000) return;   // 节流：4 秒内不重复播报
    _lastSpeak=now;
    const u=new SpeechSynthesisUtterance(text);
    u.lang='zh-CN'; u.rate=1; u.pitch=1;
    if(_zhVoice) u.voice=_zhVoice;
    speechSynthesis.speak(u);
  }catch(e){ /* 静默忽略 */ }
}

/* ============ Tab 切换 ============ */
function switchTab(t){
  document.getElementById('tab-cam').classList.toggle('active', t==='cam');
  document.getElementById('tab-q').classList.toggle('active', t==='q');
  document.getElementById('panel-cam').classList.toggle('active', t==='cam');
  document.getElementById('panel-q').classList.toggle('active', t==='q');
  if(t==='cam'){ document.getElementById('result').innerHTML=''; startCam(); }
  else stopCam();
}

/* ============ 结果渲染 ============ */
function daysInfo(validUntil){
  if(!validUntil) return '';
  const m=String(validUntil).match(/(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/);
  const endStr = m ? m[2] : String(validUntil).trim();
  const end = new Date(endStr+'T00:00:00');
  if(isNaN(end.getTime())) return '';
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((end - today)/86400000);
  if(diff > 0) return `<span style="color:var(--accent)">剩余 ${diff} 天</span>`;
  if(diff === 0) return `<span style="color:var(--accent)">今日到期</span>`;
  return `<span style="color:var(--no)">已过期 ${-diff} 天</span>`;
}
function showResult(plate,data){
  const v=data&&data.vehicle?data.vehicle:null;
  if(!v){
    // 识别出车牌但无报备记录：播放失败提示音
    playSound('failure');
    document.getElementById('result').innerHTML=`<div class="result-wrap"><div class="result-bar"><button class="id-close" onclick="closeResult()" aria-label="关闭">✕</button></div><div class="id-card"><div class="id-info" style="text-align:center;padding:26px 0;color:var(--sub);line-height:2">【<b style="color:var(--txt)">${esc(plate)}</b>】暂无无数据<br>请联系管理人员是否有报备该车辆</div></div></div>`;
    scrollToResult();
    return;
  }
  playSound('success');
  scrollToResult();
  const isInternal=!!(data&&data.isInternal);
  const now=new Date().toLocaleString('zh-CN',{hour12:false});
  const photo=v&&v.photoUrl?`<img class="id-photo" src="${v.photoUrl}" alt="照片" onerror="this.outerHTML='<div class=\\'id-photo-placeholder\\'>请联系管理员上传车辆照片</div>'">`:'<div class="id-photo-placeholder">请联系管理员上传车辆照片</div>';
  let rows='';
  rows+=`<div class="row"><span class="k">车牌号</span><span class="v">${esc(plate)}</span></div>`;
  if(v){
    if(v.owner) rows+=`<div class="row"><span class="k">车主</span><span class="v">${esc(v.owner)}</span></div>`;
    if(v.department) rows+=`<div class="row"><span class="k">部门</span><span class="v">${esc(v.department)}</span></div>`;
    const di=daysInfo(v.validUntil);
    rows+=`<div class="row"><span class="k">有效期</span><span class="v">${esc(v.validUntil?v.validUntil:'长期')}${di?' '+di:''}</span></div>`;
    const isLong = !v.validUntil || v.validUntil==='长期';
    const stateTxt = isLong ? '长期有效' : (v.valid ? '有效' : '过期');
    const stateColor = (isLong || v.valid) ? 'var(--ok)' : 'var(--no)';
    rows+=`<div class="row"><span class="k">状态</span><span class="v"><span style="color:${stateColor}">${stateTxt}</span></span></div>`;
  }
  if(data&&data.scanCount>0){
    rows+=`<div class="row"><span class="k">识别次数</span><span class="v">${data.scanCount}</span></div>`;
    rows+=`<div class="row"><span class="k">最近识别</span><span class="v">${esc(data.lastScanAt||'—')}</span></div>`;
  }
  document.getElementById('result').innerHTML=`
    <div class="result-wrap">
      <div class="result-bar"><button class="id-close" onclick="closeResult()" aria-label="关闭">✕</button></div>
      <div class="id-card">
        <div class="id-info">${rows}</div>
        ${photo}
      </div>
    </div>`;
}
function showNotFound(msg){
  document.getElementById('result').innerHTML=`<div class="result-wrap"><div class="result-bar"><button class="id-close" onclick="closeResult()" aria-label="关闭">✕</button></div><div class="id-card"><div class="id-info"><div style="color:var(--sub);text-align:center;padding:8px 0;">${esc(msg)}</div></div></div></div>`;
  scrollToResult();
}
function showLoading(){
  document.getElementById('result').innerHTML=`<div class="id-card"><div class="id-info" style="text-align:center;padding:30px 0;color:var(--sub)">查询中…</div></div>`;
}
/* 出结果后自动滚动到结果区域 */
function scrollToResult(){
  try{
    const el=document.getElementById('result');
    if(!el) return;
    requestAnimationFrame(()=>{
      setTimeout(()=>{
        const top=el.getBoundingClientRect().top + (window.pageYOffset||document.documentElement.scrollTop) - 10;
        if('scrollBehavior' in document.documentElement.style){
          window.scrollTo({ top:top, behavior:'smooth' });
        }else{
          window.scrollTo(0, top);
        }
      }, 60);
    });
  }catch(e){ /* 静默忽略 */ }
}
function copyLink(){
  var text='嘉应学院-丰顺校区物业车牌识别系统】：https://jyedu.wl.gd.cn/cpsb/';
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(text).then(function(){ alert('链接已复制'); }).catch(function(){ prompt('复制以下内容', text); });
  } else {
    prompt('复制以下内容', text);
  }
}
