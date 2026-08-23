/* 通用：从 query 取参数 */
function getQuery(name){ const u=new URLSearchParams(location.search); return u.get(name); }
/* HTML 转义，防止存储型 XSS（车主名/备注/部门等自由文本拼接进 innerHTML） */
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
const channel=getQuery('channel')||'app'; // app / web / mini
// 后端动态 base：优先 APP_CONFIG.serverUrl（打包注入），其次 __API_BASE__，再回退同源
// 统一去掉末尾斜杠，避免与后续 '/api/...' 拼接出 '//api'（服务器地址带不带 / 都能正常打开）
const _rawApi = (window.APP_CONFIG && window.APP_CONFIG.serverUrl) || window.__API_BASE__ || location.origin;
const API = (_rawApi || '').replace(/\/+$/, '');

/* ============ 用户登录门禁 ============ */
const USER_TOKEN_KEY='qmlpars_user_token';
function getUserToken(){ return localStorage.getItem(USER_TOKEN_KEY)||''; }
function setUserToken(t){ if(t) localStorage.setItem(USER_TOKEN_KEY,t); else localStorage.removeItem(USER_TOKEN_KEY); }

/* 带用户 token 的 fetch：自动加 x-user-token，401 needLogin 时跳登录页 */
async function userFetch(url, opts){
  opts=opts||{};
  opts.headers=Object.assign({}, opts.headers, { 'x-user-token': getUserToken() });
  const r=await fetch(url, opts);
  if(r.status===401){
    let j=null; try{ j=await r.json(); }catch(e){}
    if(j&&j.needLogin){ goLogin(); }
  }
  return r;
}

/* 站点名称（来自后台设置 COMPANY_NAME，避免硬编码）。带缓存与回退 */
let _siteNameCache=null;
async function getSiteName(){
  if(_siteNameCache!==null) return _siteNameCache;
  let name='物业车辆识别系统';
  try{
    const r=await fetch(API+'/api/settings/public');
    const j=await r.json();
    if(j&&j.success&&j.data&&j.data.COMPANY_NAME) name=j.data.COMPANY_NAME;
  }catch(_){}
  _siteNameCache=name;
  return name;
}
/* 把站点名应用到页面：所有 [data-site] 元素 + document.title（替换占位 {SITE}） */
async function applySiteName(){
  const name=await getSiteName();
  document.querySelectorAll('[data-site]').forEach(el=>{ el.textContent=name; });
  if(document.title && document.title.indexOf('{SITE}')>=0){
    document.title=document.title.replace('{SITE}', name);
  }
  const og=document.querySelector('meta[property="og:title"]');
  if(og && og.getAttribute('content') && og.getAttribute('content').indexOf('{SITE}')>=0){
    og.setAttribute('content', og.getAttribute('content').replace('{SITE}', name));
  }
  document.querySelectorAll('[data-site-suffix]').forEach(el=>{
    el.textContent = name + (el.getAttribute('data-site-suffix') || '');
  });
  // 把 OG 标签的相对图片/URL 补全为当前站点完整地址，微信/浏览器抓取分享卡片时才有效
  const origin=location.origin;
  ['og:image','og:url'].forEach(prop=>{
    const m=document.querySelector('meta[property="'+prop+'"]');
    if(!m) return;
    let v=m.getAttribute('content')||'';
    if(v && !/^https?:\/\//i.test(v)){
      v = (v.startsWith('/') ? origin : origin+'/') + v;
      m.setAttribute('content', v);
    }
  });
}

/* 站点 LOGO（三种版式，来自后台设置，绝不硬编码）。带缓存 */
let _logosCache=null;
async function getLogos(){
  if(_logosCache) return _logosCache;
  const def='/static/images/logo.png';
  const logos={ icon:def, horizontal:def, vertical:def };
  try{
    const r=await fetch(API+'/api/settings/public');
    const j=await r.json();
    if(j&&j.success&&j.data){
      if(j.data.LOGO_ICON_URL) logos.icon=j.data.LOGO_ICON_URL;
      if(j.data.LOGO_HORIZONTAL_URL) logos.horizontal=j.data.LOGO_HORIZONTAL_URL;
      if(j.data.LOGO_VERTICAL_URL) logos.vertical=j.data.LOGO_VERTICAL_URL;
    }
  }catch(_){}
  _logosCache=logos;
  return logos;
}
/* 品牌区 LOGO 渲染：variant='stack' 顶部品牌（竖>横>纯图标>默认）；variant='icon' 仅纯图标 */
async function applyBrandLogo(container, variant){
  if(!container) return;
  const logos=await getLogos();
  const siteName=await getSiteName();
  const fallback='/static/images/logo.png';
  container.innerHTML='';
  if(variant==='icon'){
    const img=document.createElement('img');
    img.src=logos.icon; img.alt=siteName; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    container.appendChild(img);
    return;
  }
  // stack：优先级 竖版 > 横版 > 纯图标 > 默认
  if(logos.vertical && logos.vertical!==fallback){
    const img=document.createElement('img'); img.src=logos.vertical; img.alt=siteName; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    const cap=document.createElement('div'); cap.className='brand-cap'; cap.textContent=siteName;
    container.appendChild(img); container.appendChild(cap);
  } else if(logos.horizontal && logos.horizontal!==fallback){
    const img=document.createElement('img'); img.src=logos.horizontal; img.alt=siteName; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    const cap=document.createElement('div'); cap.className='brand-cap'; cap.textContent=siteName;
    container.classList.add('brand-horizontal');
    container.appendChild(img); container.appendChild(cap);
  } else {
    const img=document.createElement('img'); img.src=logos.icon; img.alt=siteName; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    container.appendChild(img);
  }
}

/* 备案信息（ICP 备案号 + 公安备案号），来自后台设置，未填写则不显示。
   公安备案链接：https://beian.mps.gov.cn/#/query/webSearch?code=<备案号>
   其中备案号去除“粤公网安备”前缀与“号”后缀；图标在前、编号文字在右。 */
function normalizePoliceCode(no){
  return String(no||'').replace(/^粤公网安备/, '').replace(/号$/, '').trim();
}
async function applyBeian(){
  // 容器
  const icpLine=document.getElementById('icpLine');
  const policeLine=document.getElementById('policeLine');
  let data={};
  try{
    const r=await fetch(API+'/api/settings/public');
    const j=await r.json();
    if(j&&j.success&&j.data) data=j.data;
  }catch(_){}

  // ICP 备案号
  if(icpLine){
    const icpNo=data.ICP_NO||'';
    if(icpNo){
      const a=document.createElement('a');
      a.href='https://beian.miit.gov.cn/';
      a.target='_blank'; a.rel='noopener';
      a.textContent=icpNo;
      icpLine.appendChild(a);
    } else {
      icpLine.style.display='none';
    }
  }

  // 公安备案号（图标 + 编号）
  if(policeLine){
    const policeNo=data.POLICE_NO||'';
    if(policeNo){
      const code=normalizePoliceCode(policeNo);
      const url=(data.POLICE_URL && data.POLICE_URL.indexOf('#')<0
        ? data.POLICE_URL
        : 'https://beian.mps.gov.cn/#/query/webSearch')
        + (code ? '?code='+encodeURIComponent(code) : '');
      const a=document.createElement('a');
      a.href=url; a.target='_blank'; a.rel='noopener';
      a.style.cssText='display:inline-flex;align-items:center;gap:4px;text-decoration:none;';
      const icon=document.createElement('img');
      icon.className='police';
      icon.src=data.POLICE_ICON_URL || '/static/images/police.png';
      icon.alt='';
      icon.onerror=()=>{ icon.style.display='none'; };
      const span=document.createElement('span');
      span.textContent=policeNo;
      a.appendChild(icon);
      a.appendChild(span);
      policeLine.appendChild(a);
    } else {
      policeLine.style.display='none';
    }
  }
}

/* 网站图标 favicon 套用纯图标 LOGO（LOGO_ICON_URL），缺省回退 logo.png */
async function applyFavicon(){
  const link=document.querySelector('link[rel="icon"]');
  if(!link) return;
  const logos=await getLogos();
  link.href=(logos.icon && logos.icon!=='/static/images/logo.png') ? logos.icon : '/static/images/logo.png';
}

/* 跳转到登录页（带 redirect 回当前页） */
function goLogin(){
  setUserToken('');
  try { localStorage.removeItem('guard_auto_login'); } catch(_){}
  location.replace('login.html?redirect=' + encodeURIComponent(location.pathname + location.search));
}

/* 登录态校验：带 token 且后端 /api/auth/me 有效才返回 true */
async function checkLogin(){
  const t=getUserToken();
  if(!t) return false;
  try {
    const r=await fetch(API+'/api/auth/me',{headers:{'x-user-token':t}});
    if(r.ok){ const j=await r.json(); return !!(j&&j.success); }
  } catch(_){}
  return false;
}

/* 渲染用户区：顶部右上角。已登录显示用户名 + 退出 */
function renderUserArea(){
  const token=getUserToken();
  const areas=[document.getElementById('topUser'), document.getElementById('footerUser')].filter(Boolean);
  areas.forEach(el=>{
    el.innerHTML='';
    if(token){
      const u=document.createElement('span'); u.className='user-name'; u.textContent='当前用户：加载中…';
      const out=document.createElement('button'); out.className='user-logout'; out.textContent='退出';
      out.addEventListener('click', ()=> goLogout());
      el.appendChild(u); el.appendChild(out);
      fetch(API+'/api/auth/me',{headers:{'x-user-token':token}}).then(r=>r.json()).then(j=>{
        if(j&&j.success&&j.data){ u.textContent='当前用户：'+(j.data.name?j.data.name+'（'+j.data.username+'）':j.data.username); }
        else { u.textContent='已登录'; }
      }).catch(()=>{ u.textContent='已登录'; });
    }
  });
}

async function doLogin(username, password, autoLogin){
  const r=await fetch(API+'/api/auth/login',{
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify({username,password})
  });
  const j=await r.json();
  if(j.success && j.data && j.data.token){
    setUserToken(j.data.token);
    // 自动登录：记住账号并标记，下次直接进入；未勾选则不标记
    try {
      localStorage.setItem('guard_auto_login', autoLogin ? '1' : '');
      localStorage.setItem('guard_remember_user', username);
    } catch(_){}
    return {ok:true, redirect: getQuery('redirect') || 'index.html'};
  }
  return {ok:false, msg:j.message||'登录失败'};
}

/* 退出：调用后端销毁会话，清理本地 token，跳转登录页 */
async function goLogout(){
  const t=getUserToken();
  setUserToken('');
  try { localStorage.removeItem('guard_auto_login'); } catch(_){}
  if(t){ try{ await fetch(API+'/api/auth/logout',{method:'POST',headers:{'x-user-token':t}}); }catch(_){} }
  location.replace('logout.html');
}

/* 登录页专用：DOMContentLoaded 时绑定表单（仅 login.html 调用） */
function bindCpsbLogin(){
  try {
    const ru=localStorage.getItem('guard_remember_user');
    const auto=localStorage.getItem('guard_auto_login')==='1';
    const uEl=document.getElementById('loginUser');
    const aEl=document.getElementById('autoLogin');
    if(uEl && ru) uEl.value=ru;
    if(aEl && auto) aEl.checked=true;
  } catch(_){}
  const form=document.getElementById('loginForm');
  if(form){
    form.addEventListener('submit', async (e)=>{
      e.preventDefault();
      const u=document.getElementById('loginUser').value.trim();
      const p=document.getElementById('loginPass').value;
      const err=document.getElementById('loginErr');
      err.textContent='';
      if(!u||!p){ err.textContent='请输入账号和密码'; return; }
      const btn=form.querySelector('button[type=submit]'); btn.disabled=true; btn.textContent='登录中...';
      const auto=document.getElementById('autoLogin') && document.getElementById('autoLogin').checked;
      const res=await doLogin(u,p,auto);
      btn.disabled=false; btn.textContent='登 录';
      if(!res.ok){ err.textContent=res.msg; return; }
      location.replace(res.redirect);
    });
  }
  const pToggle=document.getElementById('pwdToggle');
  const pEl=document.getElementById('loginPass');
  if(pToggle && pEl){
    pToggle.addEventListener('click', ()=>{
      const show=pEl.type==='password';
      pEl.type=show?'text':'password';
      pToggle.innerHTML=show
        ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-6.5 0-10-7-10-7a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>'
        : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
    });
  }
}

/* ============ 语音播报 ============ */
let _audioCache={};
function playSound(type){
  try{
    const map={ 'success':'Success.mp3', 'ok':'Success.mp3', 'failure':'failure.mp3', 'no':'failure.mp3', 'noresult':'noresult.mp3' };
    const file=map[type]||(type+'.mp3');
    let a=_audioCache[file];
    if(!a){
      a=new Audio('/static/sound/'+file);
      a.preload='auto';
      _audioCache[file]=a;
    }
    a.currentTime=0;
    a.play().catch(()=>{});
  }catch(e){}
}

/* ============ 标签切换 ============ */
function switchTab(name){
  const tabs={ cam:'tab-cam', q:'tab-q' };
  const panels={ cam:'panel-cam', q:'panel-q' };
  Object.keys(tabs).forEach(k=>{
    const t=document.getElementById(tabs[k]); if(t) t.classList.toggle('active', k===name);
    const p=document.getElementById(panels[k]); if(p) p.classList.toggle('active', k===name);
  });
  // 切到摄像头时：若摄像头已被关闭（如切到查询时 stopCam 停流），重新开启；否则恢复自动扫描
  if(name==='cam'){
    if(typeof startCam==='function' && (typeof stream==='undefined' || !stream)){
      startCam();
    } else if(typeof startScanning==='function'){
      startScanning();
    }
  }
  // 切到查询时，停止摄像头自动扫描，避免后台提示/语音干扰
  if(name==='q'){
    if(typeof stopCam==='function') stopCam();
    const cs=document.getElementById('camStatus');
    if(cs && cs.textContent.indexOf('未识别')>=0) cs.textContent='';
  }
}

/* ============ 结果渲染 ============ */
function showLoading(){
  const el=document.getElementById('result');
  if(el) el.innerHTML='<div class="id-card"><div class="id-info" style="text-align:center;color:var(--sub)">查询中…</div></div>';
}
function showNotFound(html){
  const el=document.getElementById('result');
  if(el) el.innerHTML='<div class="id-card"><div class="id-badge no">未找到</div><div class="id-info" style="text-align:center;color:var(--sub)">'+html+'</div></div>';
}
function row(k,v){ return '<div class="row"><span class="k">'+esc(k)+'</span><span class="v">'+esc(v)+'</span></div>'; }
function showResult(plate, data){
  data=data||{};
  const el=document.getElementById('result');
  if(!el) return;
  const v = data.vehicle || null;            // 命中车辆详情
  const ok = !!v && data.isInternal!==false; // 是否命中内部车辆
  const photo = v && v.photoUrl
    ? '<img class="id-photo" src="'+esc(v.photoUrl)+'" alt="车辆照片" onerror="this.style.display=\'none\'">'
    : '<div class="id-photo-placeholder">暂无车辆照片</div>';
  let info='';
  info += row('车牌', plate||data.plateNo||'-');
  info += row('姓名', v && v.owner ? v.owner : '-');
  if(v && v.phone) info += row('手机号', v.phone);
  if(v && v.department) info += row('部门/单位', v.department);
  if(v && v.validUntil) info += row('有效期至', v.validUntil);
  if(v && v.remark) info += row('备注', v.remark);
  info += row('扫描次数', (data.scanCount!=null?data.scanCount:'-') + (v&&v.valid===false?'（已过期）':''));
  const badge = ok ? '<div class="id-badge ok">识别成功 · 可放行</div>' : '<div class="id-badge no">未找到记录</div>';
  el.innerHTML='<div class="id-card">'
    +'<div class="result-bar"><button class="id-close" onclick="closeResult()">✕</button></div>'
    + badge
    + photo
    +'<div class="id-info">'+info+'</div>'
    +'</div>';
  // 语音：成功放行 / 失败
  playSound(ok ? 'success' : 'failure');
}

/* ============ 分享 ============ */
function toast(msg){
  let t=document.getElementById('toast');
  if(!t){ t=document.createElement('div'); t.id='toast'; t.style.cssText='position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:60;background:rgba(29,39,51,.92);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .3s;'; document.body.appendChild(t); }
  t.textContent=msg; t.style.opacity='1';
  clearTimeout(t._timer); t._timer=setTimeout(()=>{ t.style.opacity='0'; }, 1800);
}
async function copyLink(){
  const url=location.href;
  const site=await getSiteName();
  const shareText='【'+site+' 车牌识别系统】：'+url;
  if(navigator.share){
    navigator.share({ title:site+' 车牌识别系统', text:shareText, url:url }).catch(()=>{});
    return;
  }
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(shareText).then(()=>toast('分享文字已复制，去粘贴吧')).catch(()=>toast('复制失败，请手动复制'));
  }else{
    const ta=document.createElement('textarea'); ta.value=shareText; document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); toast('分享文字已复制，去粘贴吧'); }catch(e){ toast('复制失败，请手动复制'); }
    document.body.removeChild(ta);
  }
}
