// ===== H5 车辆页专用桥接：复用 H5 common.js 的 API 常量，补齐 admin 体系所需函数 =====
// 注意：本文件不含 const API（由 /cpsb/js/common.js 提供），避免与 admin/common.js 重名冲突。
// 本文件为 /android-vehicles.html 单独使用，不污染其他 H5 页面。
const TOKEN_KEY = 'qmlpars_admin_token';

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }

// 后端 authMiddleware 读取 x-admin-token 请求头，且已支持普通用户会话(user_sessions)。
// H5 车辆页以普通用户身份运行，可能只有 user token（qmlpars_user_token），并无 admin token。
// 因此当 admin token 缺失时，把 user token 作为 x-admin-token 发送，使后端 authMiddleware
// 能用 user_sessions 通过鉴权；同时保留 x-user-token 给需要它的接口（如 /api/recognize）。
function authHeaders() {
  const t = getToken();
  const h = {};
  try {
    const ut = localStorage.getItem('qmlpars_user_token') || '';
    if (t) {
      h['x-admin-token'] = t;
      if (ut) h['x-user-token'] = ut;
    } else if (ut) {
      // 无 admin token 但有 user token：H5 普通用户场景，用 user token 走 authMiddleware
      h['x-admin-token'] = ut;
      h['x-user-token'] = ut;
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
    if (res.status === 401) {
      // 注意：H5 车辆页运行在 /cpsb/ 的 iframe 内，若此处自动 doLogout() 顶层跳 /admin/login.html，
      // 会把整个手机 webview 带走，用户看到“管理后台登录页”。改为仅抛出错误，
      // 由调用方（如 loadVehicles 的 catch）显示“登录已失效，点击重新登录”提示，用户主动点击才跳。
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

function renderPager(containerId, state) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const total = state.total || 0;
  const size = state.pageSize || 10;
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

function doLogout() {
  const tk = getToken();
  if (tk) {
    fetch(API + '/api/admin/logout', { method: 'POST', headers: authHeaders() }).catch(() => {});
  }
  setToken('');
  localStorage.removeItem('qmlpars_admin_user');
  location.href = '/admin/login.html';
}

// H5 车辆页专用：普通用户登录失效后的重新登录，跳到 H5 登录页而非管理后台登录页。
// 同时清空 user token，确保回退后不会因缓存的 user token 误以为仍登录。
function h5Relogin() {
  try { localStorage.removeItem('qmlpars_user_token'); } catch (_) {}
  setToken('');
  localStorage.removeItem('qmlpars_admin_user');
  location.href = 'login.html';
}
