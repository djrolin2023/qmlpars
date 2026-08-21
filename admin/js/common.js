// ===== admin 公共逻辑 =====
const API = '';
const TOKEN_KEY = 'qmlpars_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function setUser(u) { localStorage.setItem('qmlpars_admin_user', u || ''); }
function getDepartmentLabels() { return JSON.parse(localStorage.getItem('qmlpars_departments') || '[]'); }

// 后端 authMiddleware 读取 x-admin-token 请求头
function authHeaders() { const t = getToken(); return t ? { 'x-admin-token': t } : {}; }

async function api(path, opts = {}) {
  const noJson = !!opts.noJson;
  const headers = Object.assign({}, authHeaders(), opts.headers || {});
  if (!noJson) headers['Content-Type'] = 'application/json';
  const { noJson: _nj, ...rest } = opts;
  const res = await fetch(API + path, Object.assign({}, rest, { headers }));
  if (res.status === 401) { doLogout(); throw new Error('未授权，请重新登录'); }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || ('请求失败 ' + res.status));
  return data;
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

// 侧边栏 SVG 图标（按 href 注入）
const NAV_ICONS = {
  'dashboard.html': '<svg class="nav-ic" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
  'vehicles.html': '<svg class="nav-ic" viewBox="0 0 24 24"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><path d="M3 11h18v5a1 1 0 0 1-1 1h-1v2h-3v-2H8v2H5v-2H4a1 1 0 0 1-1-1v-5z"/><circle cx="7.5" cy="16" r="1"/><circle cx="16.5" cy="16" r="1"/></svg>',
  'logs.html': '<svg class="nav-ic" viewBox="0 0 24 24"><path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/></svg>',
  'ocr.html': '<svg class="nav-ic" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35"/></svg>',
  'settings.html': '<svg class="nav-ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  'about.html': '<svg class="nav-ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5v.5"/></svg>'
};

function injectNavIcons() {
  document.querySelectorAll('.sidebar nav a').forEach(a => {
    const href = a.getAttribute('href');
    if (NAV_ICONS[href]) a.insertAdjacentHTML('afterbegin', NAV_ICONS[href]);
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

// 页脚版权：公司名 + ICP + 公安备案（不依赖不存在的老接口）
async function loadSiteFooter() {
  const el = document.getElementById('site-footer-text');
  if (!el) return;
  const year = new Date().getFullYear();
  let txt = '© ' + year + ' QMLPARS 车牌识别系统 版权所有';
  try {
    const data = await api('/api/settings/public');
    const s = (data && data.data) ? data.data : {};
    const parts = [];
    if (s.COMPANY_NAME) parts.push(s.COMPANY_NAME);
    if (s.ICP_NO) parts.push('ICP备' + s.ICP_NO + '号');
    if (s.POLICE_NO) parts.push(s.POLICE_NO);
    if (parts.length) txt = '© ' + year + ' ' + parts.join('　') + '　版权所有';
  } catch (e) { /* 保持默认版权 */ }
  el.textContent = txt;
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
  injectNavIcons();
  buildCrumb();
  highlightNav();
  bindLogout();
  bindMenuToggle();
  loadSiteFooter();
  startClock();
}
