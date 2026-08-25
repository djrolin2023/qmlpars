// ===== admin 公共逻辑 =====
const API = '';
const TOKEN_KEY = 'qmlpars_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function setUser(u) { localStorage.setItem('qmlpars_admin_user', u || ''); }
function getDepartmentLabels() { return JSON.parse(localStorage.getItem('qmlpars_departments') || '[]'); }

// 后端 authMiddleware 读取 x-admin-token 请求头；H5 页面额外带上 x-user-token，给 /api/recognize 双保险
function authHeaders() {
  const t = getToken();
  const h = t ? { 'x-admin-token': t } : {};
  try {
    if (location.pathname.includes('/cpsb/')) {
      const ut = localStorage.getItem('qmlpars_user_token');
      if (ut) h['x-user-token'] = ut;
    }
  } catch (_) {}
  return h;
}

function isNetworkError(e) {
  if (!e) return false;
  const msg = (e.message || '').toString();
  return msg.includes('Failed to fetch') ||
         msg.includes('ERR_NETWORK_CHANGED') ||
         msg.includes('ERR_INTERNET_DISCONNECTED') ||
         msg.includes('ERR_CONNECTION') ||
         msg.includes('NetworkError') ||
         msg.includes('AbortError') ||
         msg.includes('timeout') ||
         e.name === 'TypeError';
}

async function api(path, opts = {}, retries = 2) {
  const noJson = !!opts.noJson;
  const noLogout = !!opts.noLogout;
  const headers = Object.assign({}, authHeaders(), opts.headers || {});
  if (!noJson) headers['Content-Type'] = 'application/json';
  const { noJson: _nj, noLogout: _nl, ...rest } = opts;
  try {
    const res = await fetch(API + path, Object.assign({}, rest, { headers }));
    // 后台接口返回 401 表示登录失效：默认跳转登录页；
    // 但上传图片、OCR 等非关键链路用 noLogout 标记，失败仅提示，避免误踢回登录页。
    if (res.status === 401) {
      if (!noLogout) doLogout();
      throw new Error('未授权，请重新登录');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && (data.error || data.message)) || ('请求失败 ' + res.status));
    return data;
  } catch (e) {
    if (retries > 0 && isNetworkError(e)) {
      await new Promise(r => setTimeout(r, 600));
      return api(path, opts, retries - 1);
    }
    console.error('Fetch request failed:', e);
    throw e;
  }
}

let _toastTimer = null;
function toast(msg, type) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.style.background = (type === 'error') ? '#dc2626' : (type === 'success' ? '#16a34a' : '#1e293b');
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
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
    // 点击遮罩不关闭，避免误触；仅按钮可确认
  });
}

function esc(s) { return escapeHtml(s); }

async function loadDeps(selectId, cb, withAll) {
  const sel = document.getElementById(selectId);
  if (!sel) { if (cb) cb([]); return; }
  const cur = sel.value;
  try {
    const r = await api('/api/admin/departments');
    const deps = (r.data || []).map(d => d.name);
    sel.innerHTML = (withAll ? '<option value="">全部部门</option>' : '') + deps.map(d => '<option value="' + escapeHtml(d) + '">' + escapeHtml(d) + '</option>').join('');
    if (cur) sel.value = cur;
    if (cb) cb(deps);
  } catch (e) {
    if (cb) cb([]);
  }
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDepTag(dep) {
  const raw = (dep || '').toString().trim();
  if (!raw) return '<span class="muted">—</span>';
  const tags = raw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  return tags.map(t => '<span class="tag">' + escapeHtml(t) + '</span>').join(' ');
}

function renderPager(containerId, state) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const total = state.total || 0;
  const size = state.pageSize || 10;
  // 后端不返回 totalPages 时按 total/pageSize 计算，避免分页显示错误
  const totalPages = Math.max(1, state.totalPages || Math.ceil(total / size));
  const cur = Math.min(state.page || 1, totalPages);
  if (totalPages <= 1) {
    el.innerHTML = total ? '<div class="pager-right"><span class="pager-info">共 ' + total + ' 条</span></div>' : '';
    return;
  }
  const ELL = -1;
  const nums = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) nums.push(i);
  } else {
    nums.push(1);
    if (cur > 3) nums.push(ELL);
    const s = Math.max(2, cur - 1);
    const e = Math.min(totalPages - 1, cur + 1);
    for (let i = s; i <= e; i++) nums.push(i);
    if (cur < totalPages - 2) nums.push(ELL);
    nums.push(totalPages);
  }
  const sizeOpts = [10, 20, 50, 100]
    .map(v => '<option value="' + v + '"' + (v === size ? ' selected' : '') + '>' + v + '条/页</option>')
    .join('');
  let html = '<div class="pager-right">';
  html += '<span class="pager-info">共 ' + total + ' 条</span>';
  html += '<select class="pager-size" id="' + containerId + '_size">' + sizeOpts + '</select>';
  html += '<span class="pager-links">';
  if (cur > 1) html += '<a class="pager-link" data-pg="' + (cur - 1) + '">上一页</a>';
  nums.forEach(n => {
    if (n === ELL) { html += '<span class="pager-ell">…</span>'; return; }
    html += '<a class="pager-link pager-num' + (n === cur ? ' active' : '') + '" data-pg="' + n + '">' + n + '</a>';
  });
  if (cur < totalPages) html += '<a class="pager-link" data-pg="' + (cur + 1) + '">下一页</a>';
  html += '</span></div>';
  el.innerHTML = html;
  el.querySelectorAll('.pager-link[data-pg]').forEach(a => {
    a.onclick = () => {
      const np = parseInt(a.getAttribute('data-pg'), 10);
      if (np >= 1 && np <= totalPages) { state.page = np; state.reload(); }
    };
  });
  const sizeSel = document.getElementById(containerId + '_size');
  if (sizeSel) sizeSel.onchange = () => { state.pageSize = parseInt(sizeSel.value, 10); state.page = 1; state.reload(); };
}

// 侧边栏图标（内联 SVG，由 data-icon 占位 + applyIcons 填充）
const NAV_ICON_NAMES = {
  'dashboard.html': 'dashboard',
  'vehicles.html': 'vehicle',
  'users.html': 'user',
  'logs.html': 'log',
  'backup.html': 'backup',
  'buildapp.html': 'buildapp',
  'syslog.html': 'syslog',
  'settings.html': 'setting',
  'about.html': 'about'
};

function injectNavIcons() {
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    const page = a.getAttribute('data-page') || a.getAttribute('href');
    const name = NAV_ICON_NAMES[page];
    if (name && !a.querySelector('.svg-ic')) {
      const span = document.createElement('span');
      span.className = 'menu-ic';
      span.innerHTML = svgIcon(name);
      a.insertAdjacentElement('afterbegin', span);
    }
  });
}

// 面包屑：首页 / 当前页
function buildCrumb() {
  const el = document.getElementById('crumb');
  if (!el) return;
  const cur = location.pathname.split('/').pop() || 'index.html';
  const link = document.querySelector('.sidebar nav a[href="' + cur + '"]');
  const label = link ? link.textContent.trim() : '后台管理';
  el.innerHTML =
    '<a href="dashboard.html">首页</a><span class="sep">/</span><span class="cur">' + escapeHtml(label) + '</span>';
}

function highlightNav() {
  const cur = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    const href = a.getAttribute('href');
    if (href === cur) a.classList.add('active');
  });
}

async function checkAuth() {
  const tk = getToken();
  if (!tk) { return false; }
  try {
    const data = await api('/api/admin/me');
    const u = (data.data && data.data.user) || (data.user) || '';
    setUser(u);
    const uEl = document.getElementById('nav-user');
    if (uEl) uEl.textContent = '管理员：' + u;
    // 顶部 tb-user 也显示当前登录用户
    const tbEl = document.getElementById('tb-user');
    if (tbEl) tbEl.textContent = '当前登录用户：' + u;
    return true;
  } catch (e) {
    return false;
  }
}

function doLogout() {
  const tk = getToken();
  if (tk) {
    fetch(API + '/api/admin/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
  }
  setToken('');
  localStorage.removeItem('qmlpars_admin_user');
  if (!location.pathname.endsWith('login.html') && !location.pathname.endsWith('index.html')) {
    location.href = 'login.html';
  } else if (location.pathname.endsWith('index.html')) {
    // 分发页：留给 index.html 自己处理
  } else {
    location.href = 'login.html';
  }
}

function bindLogout() {
  // 支持侧边栏旧按钮与页头右侧按钮
  const btn = document.getElementById('logout-btn');
  if (btn) btn.onclick = () => { doLogout(); location.href = 'login.html'; };
  const btnTop = document.getElementById('logout-btn-top');
  if (btnTop) btnTop.onclick = () => { doLogout(); location.href = 'login.html'; };
}

function bindMenuToggle() {
  const t = document.getElementById('menu-toggle');
  const s = document.querySelector('.sidebar');
  if (t && s) t.onclick = () => s.classList.toggle('open');
}

// 公安备案编号提取：去掉「<省简称>公网安备」前缀（兼容粤/京/沪等任意省份，1+个汉字）与结尾「号」字
function normalizePoliceCode(no) {
  return String(no || '').replace(/^[\u4e00-\u9fa5]+公网安备/, '').replace(/号$/, '').trim();
}

// 统一页脚：单行 © + 技术支持 + ICP + 公安备案（全部从后台「备案信息」读取，不硬编码）
async function loadSiteFooter() {
  const el = document.getElementById('site-footer-text');
  if (!el) return;
  const year = new Date().getFullYear();
  let icpNo = '', policeNo = '', policeUrl = '';
  try {
    const data = await api('/api/settings/public');
    const s = (data && data.data) ? data.data : {};
    icpNo = s.ICP_NO || '';
    policeNo = s.POLICE_NO || '';
    policeUrl = s.POLICE_URL || '';
  } catch (e) { /* 保持空白 */ }
  const icpPart = icpNo ? `<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">${escapeHtml(icpNo)}</a>` : '';
  const code = policeNo ? normalizePoliceCode(policeNo) : '';
  const pLink = policeUrl && policeUrl.indexOf('#') < 0
    ? policeUrl + (code ? '?code=' + encodeURIComponent(code) : '')
    : 'https://beian.mps.gov.cn/#/query/webSearch' + (code ? '?code=' + encodeURIComponent(code) : '');
  const policePart = policeNo
    ? `<a href="${pLink}" target="_blank" rel="noopener" class="police-link"><img src="/static/images/police.png" class="police" alt="公安备案"> ${escapeHtml(policeNo)}</a>`
    : '';
  el.innerHTML =
    '© ' + year + ' 乾明工作室 版权所有 | 技术支持：乾明' +
    '<div class="beian-line">' + icpPart + (icpPart && policePart ? '　' : '') + policePart + '</div>';
}

// 页面公共初始化（每个业务页末尾调用）
function startClock() {
  const el = document.getElementById('time-now');
  if (!el) return;
  const pad = n => String(n).padStart(2, '0');
  const tick = () => {
    const d = new Date();
    el.textContent = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  };
  tick();
  setInterval(tick, 1000);
}

function adminInit() {
  if (typeof applyIcons === 'function') applyIcons(document);
  injectNavIcons();
  buildCrumb();
  highlightNav();
  bindLogout();
  bindMenuToggle();
  loadSiteFooter();
  startClock();
}

/* ===== 站点 LOGO（三种版式，来自后台设置，绝不硬编码） ===== */
let _logosCache=null;
async function getLogos(){
  if(_logosCache) return _logosCache;
  const def='/static/images/logo.png';
  const logos={ icon:def, horizontal:def, vertical:def };
  try{
    const data = await api('/api/settings/public');
    const s = (data && data.data) ? data.data : {};
    if(s.LOGO_ICON_URL) logos.icon=s.LOGO_ICON_URL;
    if(s.LOGO_HORIZONTAL_URL) logos.horizontal=s.LOGO_HORIZONTAL_URL;
    if(s.LOGO_VERTICAL_URL) logos.vertical=s.LOGO_VERTICAL_URL;
  }catch(_){}
  _logosCache=logos;
  return logos;
}
/* 品牌区 LOGO 渲染：variant='stack' 顶部品牌（竖>横>纯图标>默认）；variant='icon' 仅纯图标 */
async function applyBrandLogo(container, variant){
  if(!container) return;
  const logos=await getLogos();
  const name=(await getSiteNameAdmin()) || '乾明车牌识别系统';
  const fallback='/static/images/logo.png';
  container.innerHTML='';
  if(variant==='icon'){
    const img=document.createElement('img'); img.src=logos.icon; img.alt=name; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    container.appendChild(img); return;
  }
  if(logos.vertical && logos.vertical!==fallback){
    const img=document.createElement('img'); img.src=logos.vertical; img.alt=name; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    const cap=document.createElement('div'); cap.className='brand-cap'; cap.textContent=name;
    container.appendChild(img); container.appendChild(cap);
  } else if(logos.horizontal && logos.horizontal!==fallback){
    const img=document.createElement('img'); img.src=logos.horizontal; img.alt=name; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    const cap=document.createElement('div'); cap.className='brand-cap'; cap.textContent=name;
    container.classList.add('brand-horizontal');
    container.appendChild(img); container.appendChild(cap);
  } else {
    const img=document.createElement('img'); img.src=logos.icon; img.alt=name; img.className='brand-logo-img';
    img.onerror=()=>{ img.src=fallback; };
    container.appendChild(img);
  }
}
async function getSiteNameAdmin(){
  try{
    const data = await api('/api/settings/public');
    const s = (data && data.data) ? data.data : {};
    return s.COMPANY_NAME || '乾明车牌识别系统';
  }catch(_){ return '乾明车牌识别系统'; }
}
/* 网站图标 favicon 套用纯图标 LOGO（LOGO_ICON_URL），缺省回退 logo.png */
async function applyFavicon(){
  const link=document.querySelector('link[rel="icon"]');
  if(!link) return;
  const logos=await getLogos();
  link.href=(logos.icon && logos.icon!=='/static/images/logo.png') ? logos.icon : '/static/images/logo.png';
}
