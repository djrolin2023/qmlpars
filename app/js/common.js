/* ============ API / 全局 ============ */
// 去掉末尾斜杠，统一处理（服务器地址带不带 / 都能正常打开）
let API=(window.__API_BASE__||location.origin||'').replace(/\/+$/, '');
/* userFetch：自动带登录 token（x-user-token 头） */
function userFetch(url, opts={}){
  const token=(function(){try{return localStorage.getItem('user_token');}catch(e){return '';}})();
  const headers=Object.assign({}, opts.headers||{});
  if(token && !headers['x-user-token'] && !headers['Authorization']) headers['x-user-token']=token;
  const doFetch=(finalUrl)=>fetch(finalUrl, Object.assign({}, opts, {headers, credentials:'include'}));
  if(/^https?:\/\//.test(url)) return doFetch(url);
  return doFetch((API.replace(/\/$/,'')+'/'+url.replace(/^\//,'')));
}
/* 登录态 */
function getUserToken(){try{return localStorage.getItem('user_token')||'';}catch(e){return '';}}
function setUserToken(t){try{localStorage.setItem('user_token',t);}catch(e){}}
function clearUserToken(){try{localStorage.removeItem('user_token');}catch(e){}}
function showLogin(){const o=document.getElementById('loginOverlay'); if(o) o.classList.add('show'); if(typeof stopCam==='function') stopCam();}
function hideLogin(){const o=document.getElementById('loginOverlay'); if(o) o.classList.remove('show'); if(typeof startCam==='function') startCam();}
function showLogout(){const b=document.getElementById('logoutBtn'); if(b)b.style.display='flex';}
function logoutUser(){
  clearUserToken();
  try{ localStorage.removeItem('auto_login'); }catch(e){}
  showLogin();
}
function ensureLoggedIn(){
  let auto=false; try{auto=localStorage.getItem('auto_login')==='1';}catch(e){}
  // 已勾选自动登录且有 token -> 直接进入；否则需要登录（含未勾选但历史有 token 的情况）
  if(getUserToken() && auto){ hideLogin(); return true; }
  showLogin();
  return false;
}

/* 渲染用户区：顶部右上角。未登录显示「登录」按钮，已登录显示用户名 + 退出 */
function renderUserArea(){
  const token=getUserToken();
  const areas=[document.getElementById('topUser'), document.getElementById('footerUser')].filter(Boolean);
  areas.forEach(el=>{
    el.innerHTML='';
    if(token){
      const u=document.createElement('span'); u.className='user-name'; u.textContent='当前用户：加载中…';
      const out=document.createElement('button'); out.className='user-logout'; out.textContent='退出';
      out.addEventListener('click', ()=> logoutUser());
      el.appendChild(u); el.appendChild(out);
      fetch(API+'/api/auth/me',{headers:{'x-user-token':token}}).then(r=>r.json()).then(j=>{
        if(j.success&&j.data){ u.textContent='当前用户：'+(j.data.name?j.data.name+'（'+j.data.username+'）':j.data.username); }
        else { u.textContent='已登录'; }
      }).catch(()=>{ u.textContent='已登录'; });
    } else {
      const btn=document.createElement('button'); btn.className='user-login'; btn.textContent='登录';
      btn.addEventListener('click', ()=> showLogin());
      el.appendChild(btn);
    }
  });
}
window.renderUserArea=renderUserArea;
async function doLogin(username,password){
  // 加超时控制，避免网络不可达时按钮永远卡在"登录中..."
  const ac = new AbortController();
  const timer = setTimeout(()=>ac.abort(), 15000);
  try {
    var _url = API + '/api/auth/login';
    try { console.log('[doLogin] API=', API, 'URL=', _url); } catch(_){}
    const r=await fetch(_url,{
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,password}),
      signal: ac.signal
    });
    clearTimeout(timer);
    let j;
    try { j=await r.json(); } catch (_) { return {ok:false, msg:'服务器返回异常('+r.status+')'}; }
    if(j.success){
      setUserToken(j.data.token);
      try{
        const auto=document.getElementById('autoLogin');
        localStorage.setItem('auto_login', auto&&auto.checked?'1':'');
        localStorage.setItem('remember_user', username);
      }catch(e){}
      return {ok:true};
    }
    return {ok:false, msg:j.message||'登录失败'};
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') return {ok:false, msg:'请求超时(15s)，请检查服务器地址/网络'};
    // 详细错误：暴露真实失败原因（用 alert 弹出，便于排查）
    var _msg = '网络异常：' + (e && e.message ? e.message : '无法连接服务器');
    try { console.error('[doLogin] fetch failed:', e, 'API=', API, 'URL=', API+'/api/auth/login'); } catch(_){}
    return {ok:false, msg:_msg};
  }
}
/* 静默 token 续期 */
async function refreshToken(){
  const t=getUserToken(); if(!t) return;
  try{
    const r=await fetch(API+'/api/auth/me',{headers:{'x-user-token':t}});
    if(!r.ok) throw new Error('profile '+r.status);
    // 后端若签发新 token 可在此更新（当前复用原 token）
  }catch(e){}
}
window.getUserToken=getUserToken;
window.refreshToken=refreshToken;

/* 站点品牌：从系统设置「站点 LOGO / 站点名称」动态获取，避免硬编码私有图标 */
function absUrl(u){
  if(!u) return '';
  if(/^https?:\/\//.test(u)) return u;
  if(u.startsWith('//')) return location.protocol + u;
  const base = (API||'').replace(/\/api\/?$/,'');
  return base + (u.startsWith('/') ? u : '/' + u);
}
function applySiteBrand(){
  const base = (API||'').replace(/\/api\/?$/,'');
  fetch(base + '/api/settings/public').then(r=>r.json()).then(j=>{
    if(!j.success || !j.data) return;
    const d=j.data;
    const imgs=document.querySelectorAll('.school-logo, .login-logo img');
    const logo=absUrl(d.LOGO_URL);
    if(logo){ imgs.forEach(el=>{ el.src=logo; el.style.display=''; }); }
    if(d.COMPANY_NAME){ document.querySelectorAll('.org-name').forEach(el=>el.textContent=d.COMPANY_NAME); }
  }).catch(()=>{});
}
window.applySiteBrand=applySiteBrand;

/* ============ 服务器地址运行时配置（无需重打包即可切换） ============ */
function toggleServerCfg(btn){
  try{
    var box = btn.parentElement.querySelector('.server-cfg-box');
    if(!box) return;
    var shown = box.style.display !== 'none';
    box.style.display = shown ? 'none' : 'block';
    if(!shown){
      // 回填当前值
      var inp = document.getElementById('serverUrlInput');
      if(inp){
        try{ inp.value = localStorage.getItem('user_server_url') || (window.APP_CONFIG && window.APP_CONFIG.serverUrl) || (window.__API_BASE__||''); }catch(_){}
      }
    }
  }catch(_){}
}
function saveServerUrl(){
  try{
    var inp = document.getElementById('serverUrlInput');
    if(!inp) return;
    var v = (inp.value||'').trim().replace(/\/+$/,'');
    if(!v){ alert('请输入服务器地址'); return; }
    if(!/^https?:\/\//.test(v)){ alert('地址必须以 http:// 或 https:// 开头'); return; }
    localStorage.setItem('user_server_url', v);
    alert('已保存。APP 将自动使用新地址登录。');
    // 立即生效：更新当前页的 API
    window.__API_BASE__ = v;
    if(window.APP_CONFIG) window.APP_CONFIG.serverUrl = v;
  }catch(_){}
}
function resetServerUrl(){
  try{
    localStorage.removeItem('user_server_url');
    var def = (window.APP_CONFIG && window.APP_CONFIG.serverUrl) || (window.__API_BASE__||'');
    var inp = document.getElementById('serverUrlInput');
    if(inp) inp.value = def;
    alert('已恢复默认服务器地址。重启 APP 后生效。');
  }catch(_){}
}
window.toggleServerCfg = toggleServerCfg;
window.saveServerUrl = saveServerUrl;
window.resetServerUrl = resetServerUrl;

document.addEventListener('DOMContentLoaded',()=>{
  // 回填记住的账号，并默认勾选自动登录
  try{
    const ru=localStorage.getItem('remember_user');
    const auto=localStorage.getItem('auto_login')==='1';
    const uEl=document.getElementById('loginUser');
    const aEl=document.getElementById('autoLogin');
    if(uEl&&ru) uEl.value=ru;
    if(aEl&&auto) aEl.checked=true;
  }catch(e){}
  applySiteBrand();
  const form=document.getElementById('loginForm');
  if(form){
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const u=document.getElementById('loginUser').value.trim();
      const p=document.getElementById('loginPass').value;
      const err=document.getElementById('loginErr');
      err.textContent='';
      const btn=form.querySelector('button'); btn.disabled=true; btn.textContent='登录中...';
      let res;
      try { res = await doLogin(u,p); }
      catch (_) { res = {ok:false, msg:'登录异常，请重试'}; }
      btn.disabled=false; btn.textContent='登录';
      if(!res.ok){ err.textContent=res.msg; return; }
      hideLogin();
    });
  }
  const outBtn=document.getElementById('logoutBtn');
  if(outBtn) outBtn.addEventListener('click', logoutUser);
  renderUserArea();
});

/* ============ UI 辅助 ============ */
const $=(s,r=document)=>r.querySelector(s);
const $$=(s,r=document)=>Array.from(r.querySelectorAll(s));
function showLoading(){ const b=$('#loading'); if(b) b.classList.add('show'); }
function hideLoading(){ const b=$('#loading'); if(b) b.classList.remove('show'); }
function showResult(plateNo,data){
  const box=$('#result'); if(!box) return;
  const v=data&&data.vehicle?data.vehicle:null;
  const full=(v&&v.plateNo)?v.plateNo:plateNo;
  let html='<div class="result-head"><span class="result-plate">'+esc(full)+'</span>'+
           '<button class="result-close" onclick="closeResult()">✕</button></div>';
  html+='<div class="result-meta">'+
        '<span>'+(data.isInternal?'内部车辆':'外来车辆')+'</span>'+
        '<span>扫描 '+((data.scanCount!=null)?data.scanCount:0)+' 次</span>'+
        '</div>';
  if(v){
    html+='<div class="vehicle-box">';
    html+= v.photoUrl ? '<img src="'+esc(v.photoUrl)+'" alt="">' : '<div class="vehicle-photo-empty">无照片</div>';
    html+='<div class="vehicle-info">';
    html+='<div class="vi-name">'+esc(v.ownerName||'车主')+'</div>';
    html+='<div class="vi-row">电话：'+esc(v.phone||'—')+'</div>';
    html+='<div class="vi-row">类型：'+esc(v.type||'—')+'</div>';
    html+='<div class="vi-row">有效期：'+esc((v.validFrom||'')+' ~ '+(v.validTo||''))+'</div>';
    const valid=data.valid?'<span style="color:var(--ok)">有效期内</span>':'<span style="color:var(--warn)">已过期/无效</span>';
    html+='<div class="vi-row">状态：'+valid+'</div>';
    html+='</div></div>';
  }
  box.innerHTML=html; box.classList.remove('hidden');
  if(navigator.vibrate) navigator.vibrate(80);
  playSound('success');
}
function showNotFound(htmlMsg){
  const box=$('#result'); if(!box) return;
  box.innerHTML='<div class="notfound">'+htmlMsg+'</div>'; box.classList.remove('hidden');
  playSound('noresult');
}
function closeResult(){ const box=$('#result'); if(box){ box.innerHTML=''; box.classList.add('hidden'); } }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

/* ============ 声音 ============ */
let _audioCtx=null;
function playSound(type){
  try{
    const enabled = (function(){try{return localStorage.getItem('sound_on')!=='0';}catch(e){return true;}})();
    if(!enabled) return;
    _audioCtx=_audioCtx||new (window.AudioContext||window.webkitAudioContext)();
    const ctx=_audioCtx;
    if(type==='success'){
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type='sine'; o.frequency.setValueAtTime(880,ctx.currentTime);
      o.frequency.exponentialRampToValueAtTime(1320,ctx.currentTime+0.12);
      g.gain.setValueAtTime(0.18,ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.25);
      o.start(); o.stop(ctx.currentTime+0.26);
    } else if(type==='noresult'){
      const o=ctx.createOscillator(),g=ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type='triangle'; o.frequency.setValueAtTime(320,ctx.currentTime);
      g.gain.setValueAtTime(0.12,ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+0.18);
      o.start(); o.stop(ctx.currentTime+0.2);
    }
  }catch(e){}
}

/* 顶栏退出按钮注入（兼容有无） */
