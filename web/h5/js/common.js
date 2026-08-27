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
  let name='乾明工作室';
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
   备案号格式为「<省简称>公网安备<编号>号」（如 粤公网安备…号 / 京公网安备…号），
   提取其中的编号时，去掉开头的「X公网安备」前缀与结尾的「号」字；图标在前、编号文字在右。 */
function normalizePoliceCode(no){
  return String(no||'').replace(/^[\u4e00-\u9fa5]+公网安备/, '').replace(/号$/, '').trim();
}
function escapeHtml(s){
  return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
async function applyBeian(){
  // 登录页 / 手机端 / APP 端：两行显示（第1行版权+技术支持，第2行备案号），全部从后台「备案信息」读取，不硬编码
  const cr=document.getElementById('copyrightLine');
  const beian=document.getElementById('beianLine');
  const year=new Date().getFullYear();
  let icpNo='', policeNo='', policeUrl='', policeIconUrl='';
  try{
    const r=await fetch(API+'/api/settings/public');
    const j=await r.json();
    if(j&&j.success&&j.data){
      icpNo=j.data.ICP_NO||'';
      policeNo=j.data.POLICE_NO||'';
      policeUrl=j.data.POLICE_URL||'';
      policeIconUrl=j.data.POLICE_ICON_URL||'';
    }
  }catch(_){}
  if(cr){
    cr.innerHTML='© '+year+' 乾明工作室 版权所有 | 技术支持：乾明';
  }
  if(beian){
    const icpPart=icpNo?`<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">${escapeHtml(icpNo)}</a>`:'';
    const policeLink=policeUrl && policeUrl.indexOf('#')<0
      ? policeUrl + (policeNo ? '?code='+encodeURIComponent(normalizePoliceCode(policeNo)) : '')
      : 'https://beian.mps.gov.cn/#/query/webSearch' + (policeNo ? '?code='+encodeURIComponent(normalizePoliceCode(policeNo)) : '');
    const policePart=policeNo
      ? `<a href="${policeLink}" rel="noopener" class="police-link"><img src="${policeIconUrl||'/static/images/police.png'}" class="police" alt="公安备案" onerror="this.style.display='none'"> ${escapeHtml(policeNo)}</a>`
      : '';
    beian.innerHTML=icpPart + (icpPart && policePart ? '　' : '') + policePart;
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

/* 登录态校验：带 token 且后端 /api/auth/me 有效才返回 true（带超时兜底，避免无限 pending） */
async function checkLogin(){
  const t=getUserToken();
  if(!t) return false;
  try {
    const ctrl=new AbortController();
    const to=setTimeout(()=>ctrl.abort(), 6000);
    const r=await fetch(API+'/api/auth/me',{headers:{'x-user-token':t}, signal:ctrl.signal});
    clearTimeout(to);
    if(r.ok){ const j=await r.json(); return !!(j&&j.success); }
  } catch(_){}
  return false;
}

/* 渲染用户区：顶部右上角。已登录显示用户名下拉（修改密码、退出登录） */
function renderUserArea(){
  const token=getUserToken();
  const topUser=document.getElementById('topUser');
  if(!topUser) return;
  topUser.innerHTML='';
  if(!token) return;
  const wrap=document.createElement('div'); wrap.className='user-dropdown';
  const toggle=document.createElement('button'); toggle.className='user-dropdown-toggle';
  toggle.innerHTML='<span class="user-dropdown-name">加载中…</span><span class="caret">▼</span>';
  const menu=document.createElement('div'); menu.className='user-dropdown-menu';
  menu.innerHTML='<button class="user-dropdown-item" data-action="changePwd">修改密码</button><button class="user-dropdown-item" data-action="logout">退出登录</button>';
  wrap.appendChild(toggle); wrap.appendChild(menu); topUser.appendChild(wrap);

  // 切换下拉
  toggle.addEventListener('click', e=>{ e.stopPropagation(); wrap.classList.toggle('open'); });
  document.addEventListener('click', ()=> wrap.classList.remove('open'));
  menu.addEventListener('click', e=>{
    const item=e.target.closest('[data-action]'); if(!item) return;
    const action=item.getAttribute('data-action');
    wrap.classList.remove('open');
    if(action==='logout') goLogout();
    if(action==='changePwd') openChangePwd();
  });

  fetch(API+'/api/auth/me',{headers:{'x-user-token':token}}).then(r=>r.json()).then(j=>{
    if(j&&j.success&&j.data){ toggle.querySelector('.user-dropdown-name').textContent=(j.data.name?j.data.name+'（'+j.data.username+'）':j.data.username); }
    else { toggle.querySelector('.user-dropdown-name').textContent='已登录'; }
  }).catch(()=>{ toggle.querySelector('.user-dropdown-name').textContent='已登录'; });
}

/* 打开/关闭修改密码弹窗 */
function openChangePwd(){ document.getElementById('pwdModal').classList.add('show'); }
function closeChangePwd(){
  const m=document.getElementById('pwdModal'); if(m) m.classList.remove('show');
  ['pwdOld','pwdNew','pwdNew2','pwdErr'].forEach(id=>{ const el=document.getElementById(id); if(el) el.value=''; });
}

/* 提交修改密码 */
async function submitChangePwd(){
  const oldP=document.getElementById('pwdOld').value.trim();
  const newP=document.getElementById('pwdNew').value.trim();
  const newP2=document.getElementById('pwdNew2').value.trim();
  const err=document.getElementById('pwdErr');
  if(!oldP||!newP){ err.textContent='请填写当前密码和新密码'; return; }
  if(newP.length<6){ err.textContent='新密码至少 6 位'; return; }
  if(newP!==newP2){ err.textContent='两次输入的新密码不一致'; return; }
  err.textContent='';
  const btn=document.getElementById('pwdOk'); btn.disabled=true; btn.textContent='修改中…';
  try{
    const r=await fetch(API+'/api/auth/change-password',{
      method:'POST', headers:{'Content-Type':'application/json','x-user-token':getUserToken()},
      body:JSON.stringify({oldPassword:oldP,newPassword:newP})
    });
    const j=await r.json();
    if(!j||!j.success) throw new Error((j&&j.message)||'修改失败');
    closeChangePwd();
    alert('密码已修改，请重新登录');
    goLogout();
  }catch(e){ err.textContent=e.message||'修改失败'; }
  finally{ btn.disabled=false; btn.textContent='确定修改'; }
}

/* 绑定修改密码弹窗事件（index.html 引入 common.js 后调用） */
function bindChangePwdEvents(){
  document.getElementById('pwdModalX').addEventListener('click', closeChangePwd);
  document.getElementById('pwdCancel').addEventListener('click', closeChangePwd);
  document.getElementById('pwdOk').addEventListener('click', submitChangePwd);
  document.getElementById('pwdModal').addEventListener('click', e=>{ if(e.target.id==='pwdModal') closeChangePwd(); });
  document.getElementById('pwdOld').addEventListener('keydown', e=>{ if(e.key==='Enter') submitChangePwd(); });
  document.getElementById('pwdNew').addEventListener('keydown', e=>{ if(e.key==='Enter') submitChangePwd(); });
  document.getElementById('pwdNew2').addEventListener('keydown', e=>{ if(e.key==='Enter') submitChangePwd(); });
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
    // 提示本次登录来源 IP，增强安全感知
    if(j.data.loginIp){
      try {
        const el = document.getElementById('loginIpTip');
        if(el){ el.textContent = '本次登录来源 IP：' + j.data.loginIp; el.style.display='block'; }
      } catch(_){}
    }
    // —— redirect 安全过滤：拒绝跨协议 / 跨域跳转（防御开放重定向钓鱼）
    const rawRedirect = getQuery('redirect') || 'index.html';
    let safeRedirect = 'index.html';
    try {
      const u = new URL(rawRedirect, location.origin);
      if (u.origin === location.origin) safeRedirect = u.toString();
    } catch (_) {}
    if (/^\/(?!\/)[\w\u4e00-\u9fa5./?&=%#-]*$/.test(rawRedirect)) safeRedirect = rawRedirect;
    else if (/^[\w\u4e00-\u9fa5./?&=%#-]+\.html(\?.*)?(#.*)?$/i.test(rawRedirect)) safeRedirect = rawRedirect;
    return {ok:true, redirect: safeRedirect};
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
    // 勾选了自动登录且 token 仍有效时直接跳过登录页
    if(auto){
      checkLogin().then(ok=>{
        if(ok){
          // —— getQuery(name) 为单参数函数，此处不能无参调用（否则返回 undefined 引发 TypeError）
          const rawRedirect = getQuery('redirect') || 'index.html';
          // 开放重定向防护：仅允许站内相对路径 / 同域绝对路径，拒绝带协议或 // 的外部跳转
          let redirect = 'index.html';
          try {
            const u = new URL(rawRedirect, location.origin);
            if (u.origin === location.origin) redirect = u.toString();
          } catch (_) { /* 非法 URL 走默认 */ }
          if (/^\/(?!\/)[\w\u4e00-\u9fa5./?&=%#-]*$/.test(rawRedirect)) {
            // 合法站内相对路径（开头单个 /，后不接 //，避免 //evil.com 这种协议相对 URL）
            redirect = rawRedirect;
          } else if (/^[\w\u4e00-\u9fa5./?&=%#-]+\.html(\?.*)?(#.*)?$/i.test(rawRedirect)) {
            // 合法同目录 html 跳转（如 index.html?foo=bar）
            redirect = rawRedirect;
          }
          location.replace(redirect);
        }
      }).catch(()=>{ /* checkLogin 网络异常时不阻断页面，让用户手动登录 */ });
    }
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
  // 切换标签时自动清除上一次扫描/查询结果
  if(typeof closeResult==='function') closeResult();
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
function imgUrlWithToken(url){
  if(!url) return url;
  if(/[?&]token=/.test(url)) return url;
  const t=getUserToken();
  if(!t) return url;
  return url + (url.indexOf('?')>=0 ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

/* ============ 归属地（车牌 → 省·市） ============
 * Bug#10 修复：原代码 fetch('/admin/js/plate-areas.json') 在 H5 部署于子路径
 * （如 /cpsb/xxx.html）时，若该路径未被反代到 web/admin/ 就会 404。
 * 改为内联数据（同源、零网络依赖），彻底消除 404；同时保留 fetch 兜底兼容。 */
const PLATE_AREAS_DATA = {
  "京": { "province": "北京市", "cities": { "A": "北京市" } },
  "津": { "province": "天津市", "cities": { "A": "天津市" } },
  "沪": { "province": "上海市", "cities": { "A": "上海市", "B": "上海市", "C": "上海市", "D": "上海市" } },
  "渝": { "province": "重庆市", "cities": { "A": "重庆市", "B": "重庆市", "C": "重庆市", "F": "重庆市" } },
  "冀": { "province": "河北省", "cities": { "A": "石家庄", "B": "唐山", "C": "秦皇岛", "D": "邯郸", "E": "邢台", "F": "保定", "G": "张家口", "H": "承德", "J": "沧州", "R": "廊坊", "S": "衡水", "T": "衡水" } },
  "豫": { "province": "河南省", "cities": { "A": "郑州", "B": "开封", "C": "洛阳", "D": "平顶山", "E": "安阳", "F": "鹤壁", "G": "新乡", "H": "焦作", "J": "濮阳", "K": "许昌", "L": "漯河", "M": "三门峡", "N": "商丘", "P": "周口", "Q": "驻马店", "R": "南阳", "S": "信阳", "U": "洛阳", "V": "商丘" } },
  "云": { "province": "云南省", "cities": { "A": "昆明", "C": "昭通", "D": "曲靖", "E": "楚雄", "F": "玉溪", "G": "红河", "H": "文山", "J": "普洱", "K": "西双版纳", "L": "大理", "M": "保山", "N": "德宏", "P": "丽江", "Q": "怒江", "R": "迪庆", "S": "临沧" } },
  "辽": { "province": "辽宁省", "cities": { "A": "沈阳", "B": "大连", "C": "鞍山", "D": "抚顺", "E": "本溪", "F": "丹东", "G": "锦州", "H": "营口", "J": "阜新", "K": "辽阳", "L": "盘锦", "M": "铁岭", "N": "朝阳", "P": "葫芦岛" } },
  "黑": { "province": "黑龙江省", "cities": { "A": "哈尔滨", "B": "齐齐哈尔", "C": "牡丹江", "D": "佳木斯", "E": "大庆", "F": "伊春", "G": "鸡西", "H": "鹤岗", "J": "双鸭山", "K": "七台河", "L": "松花江", "M": "绥化", "N": "黑河", "P": "大兴安岭", "R": "农垦" } },
  "湘": { "province": "湖南省", "cities": { "A": "长沙", "B": "株洲", "C": "湘潭", "D": "衡阳", "E": "邵阳", "F": "岳阳", "G": "张家界", "H": "益阳", "J": "常德", "K": "娄底", "L": "郴州", "M": "永州", "N": "怀化", "U": "湘西" } },
  "皖": { "province": "安徽省", "cities": { "A": "合肥", "B": "芜湖", "C": "蚌埠", "D": "淮南", "E": "马鞍山", "F": "淮北", "G": "铜陵", "H": "安庆", "J": "黄山", "K": "阜阳", "L": "宿州", "M": "滁州", "N": "六安", "P": "宣城", "Q": "巢湖", "R": "池州" } },
  "鲁": { "province": "山东省", "cities": { "A": "济南", "B": "青岛", "C": "淄博", "D": "枣庄", "E": "东营", "F": "烟台", "G": "潍坊", "H": "济宁", "J": "泰安", "K": "威海", "L": "日照", "M": "莱芜", "N": "临沂", "P": "德州", "Q": "聊城", "R": "临沂", "S": "菏泽", "U": "青岛", "V": "潍坊", "Y": "烟台" } },
  "新": { "province": "新疆维吾尔自治区", "cities": { "A": "乌鲁木齐", "B": "昌吉", "C": "石河子", "D": "奎屯", "E": "博尔塔拉", "F": "伊犁", "G": "塔城", "H": "阿勒泰", "J": "克拉玛依", "K": "吐鲁番", "L": "哈密", "M": "巴音郭楞", "N": "阿克苏", "P": "克孜勒苏", "Q": "喀什", "R": "和田" } },
  "苏": { "province": "江苏省", "cities": { "A": "南京", "B": "无锡", "C": "徐州", "D": "常州", "E": "苏州", "F": "南通", "G": "连云港", "H": "淮安", "J": "盐城", "K": "扬州", "L": "镇江", "M": "泰州", "N": "宿迁" } },
  "浙": { "province": "浙江省", "cities": { "A": "杭州", "B": "宁波", "C": "温州", "D": "绍兴", "E": "湖州", "F": "嘉兴", "G": "金华", "H": "衢州", "J": "台州", "K": "丽水", "L": "舟山" } },
  "赣": { "province": "江西省", "cities": { "A": "南昌", "B": "赣州", "C": "宜春", "D": "吉安", "E": "上饶", "F": "抚州", "G": "九江", "H": "景德镇", "J": "萍乡", "K": "新余", "L": "鹰潭" } },
  "鄂": { "province": "湖北省", "cities": { "A": "武汉", "B": "黄石", "C": "十堰", "D": "荆州", "E": "宜昌", "F": "襄阳", "G": "鄂州", "H": "荆门", "J": "黄冈", "K": "孝感", "L": "咸宁", "M": "仙桃", "N": "潜江", "P": "神农架", "Q": "恩施", "R": "天门", "S": "随州" } },
  "桂": { "province": "广西壮族自治区", "cities": { "A": "南宁", "B": "柳州", "C": "桂林", "D": "梧州", "E": "北海", "F": "崇左", "G": "来宾", "H": "桂林", "J": "贺州", "K": "玉林", "L": "百色", "M": "河池", "N": "钦州", "P": "防城港", "R": "贵港" } },
  "甘": { "province": "甘肃省", "cities": { "A": "兰州", "B": "嘉峪关", "C": "金昌", "D": "白银", "E": "天水", "F": "酒泉", "G": "张掖", "H": "武威", "J": "定西", "K": "陇南", "L": "平凉", "M": "庆阳", "N": "临夏", "P": "甘南" } },
  "晋": { "province": "山西省", "cities": { "A": "太原", "B": "大同", "C": "阳泉", "D": "长治", "E": "晋城", "F": "朔州", "H": "忻州", "J": "吕梁", "K": "晋中", "L": "临汾", "M": "运城" } },
  "蒙": { "province": "内蒙古自治区", "cities": { "A": "呼和浩特", "B": "包头", "C": "乌海", "D": "赤峰", "E": "呼伦贝尔", "F": "兴安盟", "G": "通辽", "H": "锡林郭勒盟", "J": "乌兰察布", "K": "鄂尔多斯", "L": "巴彦淖尔", "M": "阿拉善盟" } },
  "陕": { "province": "陕西省", "cities": { "A": "西安", "B": "铜川", "C": "宝鸡", "D": "咸阳", "E": "渭南", "F": "汉中", "G": "安康", "H": "商洛", "J": "延安", "K": "榆林", "U": "西安" } },
  "吉": { "province": "吉林省", "cities": { "A": "长春", "B": "吉林", "C": "四平", "D": "辽源", "E": "通化", "F": "白山", "G": "白城", "H": "延边", "J": "松原" } },
  "闽": { "province": "福建省", "cities": { "A": "福州", "B": "莆田", "C": "泉州", "D": "厦门", "E": "漳州", "F": "龙岩", "G": "三明", "H": "南平", "J": "宁德", "K": "省直系统" } },
  "贵": { "province": "贵州省", "cities": { "A": "贵阳", "B": "六盘水", "C": "遵义", "D": "铜仁", "E": "黔西南", "F": "毕节", "G": "安顺", "H": "黔东南", "J": "黔南" } },
  "粤": { "province": "广东省", "cities": { "A": "广州", "B": "深圳", "C": "珠海", "D": "汕头", "E": "佛山", "F": "韶关", "G": "湛江", "H": "肇庆", "J": "江门", "K": "茂名", "L": "惠州", "M": "梅州", "N": "汕尾", "P": "河源", "Q": "阳江", "R": "清远", "S": "东莞", "T": "中山", "U": "潮州", "V": "揭阳", "W": "云浮", "X": "顺德", "Y": "南海", "Z": "番禺" } },
  "青": { "province": "青海省", "cities": { "A": "西宁", "B": "海东", "C": "海北", "D": "黄南", "E": "海南", "F": "果洛", "G": "玉树", "H": "海西" } },
  "藏": { "province": "西藏自治区", "cities": { "A": "拉萨", "B": "昌都", "C": "山南", "D": "日喀则", "E": "那曲", "F": "阿里", "G": "林芝", "H": "区直系统" } },
  "川": { "province": "四川省", "cities": { "A": "成都", "B": "绵阳", "C": "自贡", "D": "攀枝花", "E": "泸州", "F": "德阳", "H": "广元", "J": "遂宁", "K": "内江", "L": "乐山", "M": "资阳", "Q": "宜宾", "R": "南充", "S": "达州", "T": "雅安", "U": "阿坝", "V": "甘孜", "W": "凉山", "X": "广安", "Y": "巴中", "Z": "眉山" } },
  "宁": { "province": "宁夏回族自治区", "cities": { "A": "银川", "B": "石嘴山", "C": "吴忠", "D": "固原", "E": "中卫" } },
  "琼": { "province": "海南省", "cities": { "A": "海口", "B": "三亚", "C": "琼北", "D": "琼南", "E": "洋浦", "F": "儋州" } },
  "使": { "province": "大使馆", "cities": { "": "外国驻华大使馆" } },
  "领": { "province": "领事馆", "cities": { "": "领事馆" } }
};
let _plateAreas = PLATE_AREAS_DATA;
async function loadPlateAreas(){
  // 优先使用内联数据（零网络依赖，避免子路径部署 404）
  _plateAreas = PLATE_AREAS_DATA;
  // 兜底：若将来内联与远程不一致，尝试 fetch 同步（失败不影响）
  try{
    const r = await fetch('/admin/js/plate-areas.json', { cache:'no-cache' });
    if(r.ok){ const d = await r.json(); if(d && typeof d === 'object') _plateAreas = d; }
  }catch(e){ /* 离线/无数据时不阻塞 */ }
}
function plateArea(plate){
  const p = String(plate || '').toUpperCase().replace(/\s+/g,'').replace(/·/g,'');
  const prov = p.charAt(0);
  const info = _plateAreas[prov];
  if(!info) return '归属地：' + prov;
  const letter = p.charAt(1);
  const city = info.cities && info.cities[letter] ? info.cities[letter] : '';
  return '归属地：' + info.province + (city && city !== info.province ? ' · ' + city : '');
}
function plateType(plate){
  const p = String(plate || '').toUpperCase().replace(/\s+/g,'').replace(/·/g,'');
  if(/使|领|警/.test(p) || /WJ$/.test(p) || /O$/.test(p)) return 'white';
  if(/挂$/.test(p) || /学$/.test(p) || /港$/.test(p) || /澳$/.test(p)) return 'yellow';
  const body = p.slice(1);
  // 新能源绿牌：城市字母后紧跟 D 或 F（小型车 6 位后缀 / 大型车 5 位后缀均涵盖），中间渲染 ev-plate-mark.png 图标
  if(/^[A-Z][DF]/.test(body)) return 'green';
  // 其他 6/7 位普通车牌 → 蓝牌（小型车）
  return 'blue';
}
function plateHtml(plate){
  const p = String(plate || '').trim().toUpperCase().replace(/·/g,'');
  const prov = p.charAt(0), letter = p.charAt(1), rest = p.slice(2);
  const sep = plateType(plate) === 'green'
    ? '<span class="ev-mark"><img src="/static/images/ev-plate-mark.png" alt="新能源"></span>'
    : '<span class="prov"></span>';
  return '<span class="plate-no ' + plateType(plate) + '">' + prov + letter + sep + rest + '</span>';
}
function formatValidCell(validUntil){
  if(!validUntil) return '<div class="valid-long">长期</div><div class="valid-left muted">长期有效</div>';
  let target, label = '有效期至';
  // 兼容 "2026-08-25" 或 "2026-08-25 23:59"
  const m = String(validUntil).match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  if(m){ target = new Date(m[1] + 'T' + (m[2] || '23:59') + ':00'); }
  else { target = new Date(validUntil); }
  if(isNaN(target.getTime())) return '<div class="valid-long">'+esc(validUntil)+'</div>';
  const now = new Date();
  const diffMs = target.getTime() - now.getTime();
  const days = Math.ceil(diffMs / 86400000);
  const dateStr = (m ? m[1] : validUntil);
  if(days < 0){
    return '<div class="valid-long">'+esc(dateStr)+'</div>' +
      '<div class="valid-left expired">已过期 '+Math.abs(days)+' 天</div>';
  } else if(days === 0){
    return '<div class="valid-long">'+esc(dateStr)+'</div>' +
      '<div class="valid-left warn">今天到期</div>';
  } else {
    const cls = days <= 7 ? 'warn' : 'ok';
    return '<div class="valid-long">'+esc(dateStr)+'</div>' +
      '<div class="valid-left '+cls+'">还有 '+days+' 天到期</div>';
  }
}
function zoomPhoto(url){
  let m = document.getElementById('zoomModal');
  if(!m){
    m = document.createElement('div');
    m.id = 'zoomModal';
    m.className = 'modal-mask';
    m.innerHTML = '<div class="modal" style="background:transparent;box-shadow:none;border:none;max-width:92vw">' +
      '<img id="zoomImg" style="max-width:92vw;max-height:82vh;border-radius:12px;display:block" alt="车辆大图"></div>';
    document.body.appendChild(m);
    m.addEventListener('click', () => m.classList.remove('show'));
  }
  document.getElementById('zoomImg').src = url;
  m.classList.add('show');
}
/* 渲染车辆详情模态框（车辆管理页与扫描结果共用，确保显示一致） */
function renderDetail(v, modalId){
  modalId = modalId || 'detailModal';
  const modal = document.getElementById(modalId);
  if(!modal) return;
  const areaPure = plateArea(v.plateNo || '').replace(/^归属地：/, '');
  const el = modal.querySelector('#dPlate');
  if(el){
    const pp = String(v.plateNo || '').toUpperCase().replace(/·/g, '');
    const sep = plateType(v.plateNo || '') === 'green'
      ? '<span class="ev-mark"><img src="/static/images/ev-plate-mark.png" alt="新能源"></span>'
      : '<span class="prov"></span>';
    el.className = 'plate-no ' + plateType(v.plateNo || '');
    el.innerHTML = pp.charAt(0) + pp.charAt(1) + sep + pp.slice(2);
  }
  const sub = modal.querySelector('#dSub'); if(sub) sub.textContent = areaPure;
  const set = (id, val) => { const n = modal.querySelector('#' + id); if(n) n.textContent = (val || '-'); };
  set('dOwner', v.owner);
  set('dPhone', v.phone);
  set('dDept', (v.department || '').split(/[,，]/).map(s => s.trim()).filter(Boolean).join(' / '));
  set('dRemark', v.remark);
  const valid = modal.querySelector('#dValid'); if(valid) valid.innerHTML = formatValidCell(v.validUntil);
  // 缩略图
  const thumbImg = modal.querySelector('#dThumbImg');
  const thumbEmpty = modal.querySelector('#dThumbEmpty');
  const thumb = modal.querySelector('#dThumb');
  const photoUrl = (v.photoUrl) ? imgUrlWithToken(v.photoUrl) : '';
  if(v.photo && photoUrl && thumbImg){
    thumbImg.src = photoUrl; thumbImg.style.display = '';
    if(thumbEmpty) thumbEmpty.style.display = 'none';
    if(thumb){ thumb.onclick = () => zoomPhoto(photoUrl); thumb.style.cursor = 'pointer'; }
  } else if(thumbImg){
    thumbImg.removeAttribute('src'); thumbImg.style.display = 'none';
    if(thumbEmpty) thumbEmpty.style.display = '';
    if(thumb){ thumb.onclick = null; thumb.style.cursor = 'default'; }
  }
  // 命中时恢复"未找到提示隐藏 + 删除/编辑显示"（避免上轮未命中残留）
  const nfR = modal.querySelector('#dNotFound'); if(nfR) nfR.style.display='none';
  const delR = modal.querySelector('#detail-del'); if(delR) delR.style.display='';
  const editR = modal.querySelector('#detail-edit'); if(editR) editR.style.display='';
  // 删除/编辑按钮
  const del = modal.querySelector('#detail-del');
  const edit = modal.querySelector('#detail-edit');
  if(del) del.onclick = () => { closeDetail(modalId); if(typeof delVehicle==='function') delVehicle(v.id); };
  if(edit) edit.onclick = () => { closeDetail(modalId); if(typeof editVehicle==='function') editVehicle(v.id); };
  modal.classList.add('show');
}
function closeDetail(modalId){
  modalId = modalId || 'detailModal';
  const modal = document.getElementById(modalId);
  if(modal) modal.classList.remove('show');
}
function initDetailModal(modalId){
  modalId = modalId || 'detailModal';
  const modal = document.getElementById(modalId);
  if(!modal) return;
  const x = modal.querySelector('#detail-close'); if(x) x.onclick = () => closeDetail(modalId);
  modal.addEventListener('click', e => { if(e.target === e.currentTarget) closeDetail(modalId); });
}
/* 扫描 / 搜索结果：页面内下拉卡片（视觉与车辆管理页详情框一致，DOM 结构同 .modal 但不弹窗） */
function showResult(plate, data){
  data=data||{};
  const v0 = data.vehicle || null;
  const ok = !!v0 && data.isInternal!==false;
  const el = document.getElementById('result');
  if(!el) return;
  const pp = String((v0 && v0.plateNo) || plate || data.plateNo || '').toUpperCase().replace(/·/g, '');
  const areaPure = plateArea(pp).replace(/^归属地：/, '');
  // 车牌 DOM（用 plateHtml 输出完整 <span class="plate-no">）
  const plateDom = plateHtml(pp);
  if(v0 && ok){
    const v = Object.assign({}, v0);
    v.plateNo = v.plateNo || pp;
    v.photoUrl = v.photoUrl || (v.photo && v.id ? ('/api/vehicles/' + v.id + '/photo') : '');
    const photoUrl = v.photoUrl ? imgUrlWithToken(v.photoUrl) : '';
    const hasPhoto = !!(v.photo && String(v.photo).trim());
    const thumbInner = (hasPhoto && photoUrl)
      ? '<img src="'+esc(photoUrl)+'" alt="车辆缩略图" onclick="zoomPhoto(\''+esc(photoUrl)+'\')" onerror="this.style.display=\'none\'">'
      : '<div class="d-thumb-empty" title="暂无车辆图片">' +
          '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5A1.5 1.5 0 0 1 4.5 11H5zm2.1 0h9.8l-1.1-3.2a.5.5 0 0 0-.47-.35H8.67a.5.5 0 0 0-.47.35L7.1 11zM7.5 14a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm9 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/></svg>' +
        '</div>';
    const dept = (v.department||'').split(/[,，]/).map(s=>s.trim()).filter(Boolean).join(' / ');
    const passTxt = ok ? '✓ 可放行' : '✕ 不可放行';
    const passCls = ok ? 'ok' : 'no';
    el.innerHTML =
      '<div class="id-card">' +
        '<div class="result-head">' +
          '<button class="id-close" onclick="closeResult()">×</button>' +
          '<div class="result-plate"><div class="modal-plate-wrap">'+plateDom+'</div></div>' +
          '<div class="result-dept">'+esc(dept || areaPure)+'</div>' +
          '<div class="result-pass '+passCls+'">'+passTxt+'</div>' +
        '</div>' +
        '<div class="modal-body">' +
          '<div class="d-row d-row-owner">' +
            '<div class="d-label">车主</div>' +
            '<div class="d-value">'+esc(v.owner||'-')+'</div>' +
            '<div class="d-thumb" id="dThumb">'+thumbInner+'</div>' +
          '</div>' +
          '<div class="d-row"><div class="d-label">电话</div><div class="d-value">'+(v.phone?esc(v.phone):'-')+'</div></div>' +
          '<div class="d-row"><div class="d-label">归属地</div><div class="d-value">'+esc(areaPure||'-')+'</div></div>' +
          '<div class="d-row"><div class="d-label">有效期</div><div class="d-value">'+formatValidCell(v.validUntil)+'</div></div>' +
          '<div class="d-row"><div class="d-label">备注</div><div class="d-value">'+(v.remark?esc(v.remark):'-')+'</div></div>' +
        '</div>' +
      '</div>';
    playSound('success');
  } else {
    el.innerHTML =
      '<div class="id-card">' +
        '<div class="result-head">' +
          '<button class="id-close" onclick="closeResult()">×</button>' +
          '<div class="result-plate"><div class="modal-plate-wrap">'+plateDom+'</div></div>' +
          '<div class="result-dept">'+esc(areaPure)+'</div>' +
        '</div>' +
        '<div class="result-notfound">'+(data.notFoundText || '未找到车辆记录')+'</div>' +
      '</div>';
    playSound('failure');
  }
  setTimeout(()=>{ const c=el.querySelector('.id-card'); if(c) c.scrollIntoView({behavior:'smooth', block:'nearest'}); }, 50);
}

/* ============ 分享 ============ */
function toast(msg){
  let t=document.getElementById('toast');
  if(!t){ t=document.createElement('div'); t.id='toast'; t.style.cssText='position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:60;background:rgba(29,39,51,.92);color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.35);transition:opacity .3s;'; document.body.appendChild(t); }
  t.textContent=msg; t.style.opacity='1';
  clearTimeout(t._timer); t._timer=setTimeout(()=>{ t.style.opacity='0'; }, 1800);
}
// 通用模态确认框（替代原生 confirm），返回 Promise<boolean>
function confirmModal(title, message, confirmText, danger) {
  return new Promise(resolve => {
    const id = 'confirm-modal-' + Date.now();
    const mask = document.createElement('div');
    mask.className = 'modal-mask show';
    mask.id = id;
    mask.innerHTML =
      '<div class="modal confirm-modal">' +
        '<div class="modal-head"><span>' + escapeHtml(title || '确认操作') + '</span></div>' +
        '<div class="modal-body"><p class="confirm-msg">' + escapeHtml(message || '') + '</p></div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="cancel">取消</button>' +
          '<button class="btn ' + (danger ? 'danger' : 'primary') + '" data-act="ok">' + escapeHtml(confirmText || '确定') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(mask);
    const close = (val) => { mask.remove(); resolve(val); };
    mask.querySelector('[data-act="cancel"]').onclick = () => close(false);
    mask.querySelector('[data-act="ok"]').onclick = () => close(true);
  });
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
