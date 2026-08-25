// 车辆管理
let vRows = {};            // 当前页行缓存（编辑用）
let vState = { page: 1, pageSize: 10, total: 0, keyword: '' };
let editingId = null;      // null=新增
let photoUrl = '';         // 已上传照片 URL
let selectedIds = new Set();
let depTags = [];          // 当前车辆所属部门标签（可多个）
const PLATE_RE = /^[\u4e00-\u9fa5][A-Za-z0-9]{5,8}$/;

// 车牌显示格式化：粤B12345 → 粤B·12345；粤M FP196 → 粤M·FP196
function formatPlate(plate) {
  if (!plate) return ''
  let p = String(plate).trim().toUpperCase().replace(/\s+/g, '')
  if (/^[\u4e00-\u9fa5][A-Za-z]·/.test(p)) return p
  if (/^[\u4e00-\u9fa5][A-Za-z]/.test(p)) {
    p = p.slice(0, 2) + '·' + p.slice(2)
  }
  return p
}
function unformatPlate(plate) {
  return String(plate || '').replace(/·/g, '').replace(/\s+/g, '').toUpperCase()
}
function isValidPlate(p) {
  return PLATE_RE.test(unformatPlate(p))
}
// HTML 转义（用于动态拼接行内 input 的 value）
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// 给图片 URL 追加 token，避免 <img> 请求 /uploads/* 或 /api/vehicles/:id/photo 因无令牌而 401 破图
function withToken(url) {
  if (!url) return url;
  if (/[?&]token=/.test(url)) return url;
  const token = getToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'token=' + encodeURIComponent(token);
}
let plateAreas = {};       // 全国车牌地区映射（省份简称 -> {province, cities}）

// 加载全国车牌归属地映射
async function loadPlateAreas() {
  try {
    const r = await fetch('/admin/js/plate-areas.json', { cache: 'no-cache' });
    if (r.ok) plateAreas = await r.json();
  } catch (e) { /* 不影响主流程 */ }
}

// 根据车牌号实时显示归属地，返回是否格式有效
function updatePlateArea(plate) {
  const hint = document.getElementById('plate-area');
  if (!hint) return true;
  plate = unformatPlate(plate);
  if (!plate) { hint.textContent = ''; hint.className = 'plate-area-hint'; return false; }
  if (!PLATE_RE.test(plate)) {
    hint.textContent = '车牌号格式不正确';
    hint.className = 'plate-area-hint err';
    return false;
  }
  const prov = plate.charAt(0);
  const letter = plate.charAt(1);
  const info = plateAreas[prov];
  if (!info) {
    hint.textContent = '';
    hint.className = 'plate-area-hint';
    return true;
  }
  const city = info.cities[letter] || '';
  hint.textContent = '归属地：' + info.province + (city && city !== info.province ? ' · ' + city : '');
  hint.className = 'plate-area-hint';
  return true;
}

// ---------- 有效期日期选择器（开始 ~ 结束，自动计算） ----------
let dpYear, dpMonth;
let dpStart = null, dpEnd = null;
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function fmtDate(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
function parseDateStr(v) {
  if (!v) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  return { y: parseInt(m[1]), m: parseInt(m[2]) - 1, d: parseInt(m[3]) };
}
function parseRange(v) {
  if (!v) return { start: null, end: null };
  const parts = v.split('~');
  return { start: parseDateStr(parts[0]) || null, end: parseDateStr(parts[1]) || null };
}
function dayKey(y, m, d) { return y + '-' + (m + 1) + '-' + d; }
function fmtRange() {
  if (!dpStart && !dpEnd) return '';
  const s = dpStart ? fmtDate(dpStart.y, dpStart.m, dpStart.d) : '';
  const e = dpEnd ? fmtDate(dpEnd.y, dpEnd.m, dpEnd.d) : '';
  // 仅开始日期 → 结束留空（形如 "2026-08-25~"）表示长期；都有 → 区间；都无 → 空(长期)
  return s + '~' + e;
}
function toggleValidUntilClear() {
  const v = fmtRange();
  const clear = document.getElementById('valid-until-clear');
  if (clear) clear.style.display = v ? '' : 'none';
  document.getElementById('f-valid-start').value = dpStart ? fmtDate(dpStart.y, dpStart.m, dpStart.d) : '';
  document.getElementById('f-valid-end').value = dpEnd ? fmtDate(dpEnd.y, dpEnd.m, dpEnd.d) : '';
  renderValidDuration();
}
function renderValidDuration() {
  const box = document.getElementById('valid-duration');
  if (!box) return;
  if (!dpStart && !dpEnd) { box.textContent = '未设置（默认长期有效）'; box.className = 'valid-duration'; return; }
  if (dpStart && !dpEnd) {
    box.textContent = '自 ' + fmtDate(dpStart.y, dpStart.m, dpStart.d) + ' 起 · 长期有效';
    box.className = 'valid-duration long';
    return;
  }
  if (dpStart && dpEnd) {
    const a = new Date(dpStart.y, dpStart.m, dpStart.d).getTime();
    const b = new Date(dpEnd.y, dpEnd.m, dpEnd.d).getTime();
    if (b < a) { box.textContent = '结束时间不能早于开始时间'; box.className = 'valid-duration err'; return; }
    const days = Math.round((b - a) / 86400000) + 1; // 含首尾
    box.textContent = '共 ' + days + ' 天（' + fmtDate(dpStart.y, dpStart.m, dpStart.d) + ' ~ ' + fmtDate(dpEnd.y, dpEnd.m, dpEnd.d) + '）';
    box.className = 'valid-duration';
    return;
  }
  box.textContent = '';
}
function openDatePicker() {
  const now = new Date();
  const fallback = dpStart || dpEnd || { y: now.getFullYear(), m: now.getMonth() };
  dpYear = fallback.y; dpMonth = fallback.m;
  renderPicker();
  const p = document.getElementById('date-picker');
  const input = document.getElementById('f-valid-start');
  const rect = input.getBoundingClientRect();
  p.classList.add('show');
  const pw = p.offsetWidth, ph = p.offsetHeight;
  let left = rect.left, top = rect.bottom + 6;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (left < 8) left = 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 6;
  p.style.left = left + 'px'; p.style.top = top + 'px';
  setTimeout(() => document.addEventListener('click', dpOutside), 0);
}
function closeDatePicker() { document.getElementById('date-picker').classList.remove('show'); document.removeEventListener('click', dpOutside); }
function dpOutside(e) {
  const p = document.getElementById('date-picker');
  const f = document.getElementById('valid-until-field');
  if (p && f && !p.contains(e.target) && !f.contains(e.target)) closeDatePicker();
}
function dpShift(n) { dpMonth += n; if (dpMonth < 0) { dpMonth = 11; dpYear--; } else if (dpMonth > 11) { dpMonth = 0; dpYear++; } renderPicker(); }
function dpToday() { const n = new Date(); pickDate(n.getFullYear(), n.getMonth(), n.getDate()); }
function renderPicker() {
  document.getElementById('dp-title').textContent = dpYear + '年 ' + (dpMonth + 1) + '月';
  const first = new Date(dpYear, dpMonth, 1).getDay();
  const days = new Date(dpYear, dpMonth + 1, 0).getDate();
  const prevDays = new Date(dpYear, dpMonth, 0).getDate();
  const today = new Date(); const tY = today.getFullYear(), tM = today.getMonth(), tD = today.getDate();
  const sK = dpStart ? dayKey(dpStart.y, dpStart.m, dpStart.d) : null;
  const eK = dpEnd ? dayKey(dpEnd.y, dpEnd.m, dpEnd.d) : null;
  let cells = '';
  for (let i = 0; i < first; i++) { cells += '<div class="dp-cell muted">' + (prevDays - first + 1 + i) + '</div>'; }
  for (let d = 1; d <= days; d++) {
    const k = dayKey(dpYear, dpMonth, d);
    const cls = ['dp-cell'];
    if (dpYear === tY && dpMonth === tM && d === tD) cls.push('today');
    if (sK && k === sK) cls.push('start');
    if (eK && k === eK) cls.push('end');
    if (sK && eK && k > sK && k < eK) cls.push('inrange');
    cells += '<div class="' + cls.join(' ') + '" onclick="pickDate(' + dpYear + ',' + dpMonth + ',' + d + ')">' + d + '</div>';
  }
  const total = first + days;
  const tail = (7 - (total % 7)) % 7;
  for (let i = 1; i <= tail; i++) { cells += '<div class="dp-cell muted">' + i + '</div>'; }
  document.getElementById('dp-grid').innerHTML = cells;
  const tip = document.getElementById('dp-tip');
  if (tip) tip.textContent = (!dpStart || (dpStart && dpEnd)) ? '先选开始日期' : '再选结束日期';
}
function pickDate(y, m, d) {
  const pick = { y, m, d };
  if (!dpStart || (dpStart && dpEnd)) { dpStart = pick; dpEnd = null; }
  else {
    const a = new Date(dpStart.y, dpStart.m, dpStart.d).getTime();
    const b = new Date(y, m, d).getTime();
    if (b < a) { dpStart = pick; dpEnd = null; }
    else { dpEnd = pick; }
  }
  toggleValidUntilClear(); renderPicker();
}
function clearValidUntil() { dpStart = null; dpEnd = null; toggleValidUntilClear(); renderPicker(); }

// ---------- 有效期展示 ----------
function isExpiredYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return d.getTime() < now.getTime();
}
function formatValid(v) {
  if (!v || v === '长期') return '<span class="muted">长期</span>';
  let start = v, end = v;
  const i = v.indexOf('~');
  if (i >= 0) { start = v.slice(0, i); end = v.slice(i + 1); }
  if (!end) return '<span class="muted">长期</span> <span class="muted">（自 ' + esc(start) + ' 起）</span>';
  const html = esc(start) + (start !== end ? ' ~ ' + esc(end) : '');
  if (isExpiredYmd(end)) return '<span style="color:#f87171">已过期</span> <span class="muted">' + html + '</span>';
  return html;
}

// 列表单元格：车牌 + 归属地
function formatPlateCell(plate) {
  if (!plate) return '<div>—</div>';
  const p = String(plate).trim();
  const display = formatPlate(p);
  const prov = p.charAt(0);
  const letter = p.charAt(1);
  const info = plateAreas[prov];
  let area = '';
  if (info) {
    const city = info.cities[letter] || '';
    area = info.province + (city && city !== info.province ? ' · ' + city : '');
  }
  return area
    ? '<div><b>' + esc(display) + '</b></div><div class="plate-area-cell">' + esc(area) + '</div>'
    : '<div><b>' + esc(display) + '</b></div>';
}

// 列表单元格：有效期 + 剩余时间
function formatValidCell(v) {
  if (!v || v === '长期') {
    return '<div>长期</div><div class="valid-left muted">长期有效</div>';
  }
  let start = v, end = v;
  const i = v.indexOf('~');
  if (i >= 0) { start = v.slice(0, i); end = v.slice(i + 1); }
  if (!end) {
    return '<div>自 ' + esc(start) + ' 起</div><div class="valid-left muted">长期有效</div>';
  }
  const base = esc(start) + (start !== end ? ' ~ ' + esc(end) : '');
  if (isExpiredYmd(end)) {
    return '<div style="color:#f87171">已过期</div><div class="valid-left muted">' + base + '</div>';
  }
  // 剩余天数：从今天到 end 当天
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((d.getTime() - now.getTime()) / 86400000);
  let leftTxt;
  if (days === 0) leftTxt = '今天到期';
  else if (days > 0) leftTxt = '剩余 ' + days + ' 天';
  else leftTxt = '已过期';
  const leftColor = days <= 7 ? '#f59e0b' : '#86efac';
  return '<div>' + base + '</div><div class="valid-left" style="color:' + leftColor + '">' + leftTxt + '</div>';
}

function initVehicles() {
  loadPlateAreas();
  loadVehicles();

  const plateInput = document.getElementById('f-plate');
  if (plateInput) {
    // 仅做大写 / 去空格，不在此插入「·」分隔符，避免打断移动端英文（九宫格）输入
    plateInput.addEventListener('input', e => {
      const el = e.target;
      const v = el.value.toUpperCase().replace(/\s+/g, '');
      if (el.value !== v) {
        const start = el.selectionStart;
        el.value = v;
        const pos = Math.min(start, el.value.length);
        el.setSelectionRange(pos, pos);
      }
      updatePlateArea(el.value);
    });
    // 失焦时再统一格式化为「粤B·12345」展示样式
    plateInput.addEventListener('blur', e => {
      const el = e.target;
      if (el.value) el.value = formatPlate(el.value);
    });
  }

  document.getElementById('add-btn').onclick = openAdd;
  document.getElementById('refresh-btn').onclick = loadVehicles;
  document.getElementById('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') { vState.keyword = e.target.value.trim(); vState.page = 1; loadVehicles(); }
  });
  // 查询按钮（移动端键盘 Enter 不明显，提供显式按钮）
  document.getElementById('query-btn').onclick = () => {
    vState.keyword = document.getElementById('search').value.trim();
    vState.page = 1;
    loadVehicles();
  };

  // 部门筛选
  loadDepFilter();
  document.getElementById('dep-filter').addEventListener('change', e => {
    vState.department = e.target.value.trim();
    vState.page = 1;
    loadVehicles();
  });

  // 部门标签输入
  setupDepTagInput();

  // 弹窗：只允许 关闭 / 取消 / 保存 按钮关闭，点击遮罩不关闭
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-cancel').onclick = closeModal;
  document.getElementById('modal-save').onclick = saveVehicle;

  document.getElementById('batch-del-btn').onclick = batchDelete;

  initDetailModal();
  initPhotoBox();
}

// ---------- 列表 ----------
async function loadDepFilter() {
  const sel = document.getElementById('dep-filter');
  if (!sel) return;
  const cur = vState.department || '';
  try {
    const r = await api('/api/admin/vehicles/departments');
    const deps = (r.data || []).filter(Boolean);
    sel.innerHTML = '<option value="">全部部门</option>' + deps.map(d =>
      '<option value="' + esc(d) + '">' + esc(d) + '</option>'
    ).join('');
    if (cur) sel.value = cur;
  } catch (e) { /* 忽略，保留默认全部部门 */ }
}

// 车牌类型判断（蓝/黄/绿/白）
function plateType(plate) {
  const p = String(plate || '').toUpperCase().replace(/\s+/g, '').replace(/·/g, '');
  if (/使|领|警|O|WJ/.test(p)) return 'white';
  if (/挂|学|港|澳/.test(p)) return 'yellow';
  const body = p.slice(1);
  if (/^[A-Z][0-9A-Z]{5}$/.test(body)) return 'blue';
  if (/^[A-Z][0-9A-Z]{6}$/.test(body)) return 'green';
  if (/^[A-Z][0-9]{4,}[A-Z]?$/.test(body)) return 'yellow';
  return 'blue';
}
// 渲染为真实车牌外观（省份+字母+分隔+余下）
function plateHtml(plate) {
  const p = String(plate || '').trim().toUpperCase().replace(/·/g, '');
  const prov = p.charAt(0), letter = p.charAt(1), rest = p.slice(2);
  const sep = plateType(plate) === 'green'
    ? '<span class="ev-mark"><img src="/static/images/ev-plate-mark.png" alt="新能源"></span>'
    : '<span class="prov"></span>';
  return '<span class="plate-no ' + plateType(plate) + '">' + prov + letter + sep + rest + '</span>';
}
// 归属地：复用车牌映射（plateAreas[省份] = {province, cities}）
function plateArea(plate) {
  const p = String(plate || '').toUpperCase().replace(/·/g, '');
  const info = plateAreas[p.charAt(0)];
  if (!info) return p.charAt(0);
  const city = (info.cities && info.cities[p.charAt(1)]) || '';
  return '归属地：' + info.province + (city && city !== info.province ? ' · ' + city : '');
}

async function loadVehicles() {
  const box = document.getElementById('list');
  box.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const qs = new URLSearchParams({ page: vState.page, pageSize: vState.pageSize, keyword: vState.keyword });
    if (vState.department) qs.set('department', vState.department);
    const r = await api('/api/admin/vehicles?' + qs.toString());
    if (!r.success) throw new Error(r.message || '加载失败');
    const list = r.data || [];
    vState.total = r.total || 0;
    vRows = {};
    list.forEach(v => {
      v.photoUrl = (v.photo && v.id) ? '/api/vehicles/' + v.id + '/photo?token=' + encodeURIComponent(getToken() || '') : '';
      vRows[v.id] = v;
    });

    const tbody = document.getElementById('list');
    if (!list.length) {
      tbody.innerHTML = '<div class="empty">暂无车辆</div>';
      document.getElementById('empty').style.display = 'none';
    } else {
      tbody.innerHTML = list.map(v => {
        const deps = (v.department || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const depHtml = deps.length
          ? deps.map(d => '<span class="plate-dep">' + esc(d) + '</span>').join('')
          : '<span style="color:#5b6b80;font-size:12px">未分配部门</span>';
        const hasPhoto = !!(v.photo && String(v.photo).trim());
        const photoTag = hasPhoto
          ? '<span class="plate-photo has" title="已上传车辆图片">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M9 3l-1.5 2H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.5L15 3H9zm3 5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg></span>'
          : '<span class="plate-photo none" title="未上传车辆图片">' +
              '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">' +
                '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 8l1.5-3.5h13L20 8"/>' +
                '<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 8h16v11H4z"/>' +
                '<circle cx="12" cy="13" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/>' +
                '<line x1="5" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' +
              '</svg></span>';
        return `<div class="plate-btn" onclick="openDetail(${v.id})">
          ${plateHtml(v.plateNo)}
          <div class="plate-meta">车主：<b>${esc(v.owner || '-')}</b>${photoTag}</div>
          <div class="plate-tags">${depHtml}</div>
        </div>`;
      }).join('');
      document.getElementById('empty').style.display = 'none';
    }
    updateSelCount();
    vState.reload = loadVehicles;
    renderPager('pager', vState);
  } catch (e) {
    const msg = (e && e.message) || '加载失败';
    const isAuth = /登录|授权|失效|token/i.test(msg);
    document.getElementById('list').innerHTML = isAuth
      ? '<div class="empty">登录已失效，<a href="javascript:doLogout()" style="color:var(--primary)">点击重新登录</a></div>'
      : '<div class="empty">' + esc(msg) + '</div>';
  }
}

// ---------- 新增 / 编辑 ----------
let photoUploaded = false;     // 本次编辑/新增中用户是否重新上传了照片
let photoRemoteUrl = '';      // 重新上传后服务器返回的 URL（绝对），用于提交

// ---------- 部门标签输入 ----------
let depSuggestions = [];   // 候选部门（历史已用），点击即可添加

function setupDepTagInput() {
  const input = document.getElementById('f-department');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      const name = input.value.trim().replace(/[,，]$/, '');
      if (name) addDepTag(name);
      input.value = '';
    } else if (e.key === 'Backspace' && !input.value && depTags.length) {
      depTags.pop();
      renderDepTags();
    }
  });
  input.addEventListener('blur', () => {
    const name = input.value.trim().replace(/[,，]$/, '');
    if (name) { addDepTag(name); input.value = ''; }
  });
  loadDepSuggestions();
}
async function loadDepSuggestions() {
  try {
    const r = await api('/api/admin/vehicles/departments');
    depSuggestions = (r.data || []).filter(d => !depTags.includes(d));
    renderDepSuggest();
  } catch (e) { /* 忽略 */ }
}
function renderDepSuggest() {
  const box = document.getElementById('dep-suggest');
  if (!box) return;
  const list = depSuggestions.filter(d => !depTags.includes(d));
  box.innerHTML = list.length
    ? '<span class="muted suggest-tip">常用部门：</span>' + list.map(t =>
        '<span class="tag suggest" onclick="addDepTag(\'' + esc(t).replace(/'/g, "\\'") + '\')" title="点击添加">' + esc(t) + '</span>'
      ).join('')
    : '';
}
function addDepTag(name) {
  name = name.trim();
  if (!name) return;
  if (!depTags.includes(name)) depTags.push(name);
  renderDepTags();
  renderDepSuggest();
}
function removeDepTag(name) {
  depTags = depTags.filter(t => t !== name);
  renderDepTags();
  renderDepSuggest();
}
function renderDepTags() {
  const box = document.getElementById('dep-tags');
  if (!box) return;
  box.innerHTML = depTags.map(t =>
    '<span class="tag removable">' + esc(t) + ' <a href="javascript:void(0)" onclick="removeDepTag(\'' + esc(t).replace(/'/g, "\\'") + '\')" title="删除">×</a></span>'
  ).join('');
}

function openAdd() {
  editingId = null; photoUrl = ''; photoUploaded = false; photoRemoteUrl = '';
  document.getElementById('modal-title').textContent = '新增车辆';
  document.getElementById('f-plate').value = '';
  document.getElementById('f-owner').value = '';
  document.getElementById('f-phone').value = '';
  document.getElementById('f-remark').value = '';
  depTags = [];
  renderDepTags();
  const td = new Date();
  dpStart = { y: td.getFullYear(), m: td.getMonth(), d: td.getDate() };
  dpEnd = null;
  toggleValidUntilClear();
  showPhotoEmpty();
  document.getElementById('modal').classList.add('show');
  updatePlateArea(document.getElementById('f-plate').value);
  document.getElementById('f-plate').focus();
}

function editVehicle(id) {
  const v = vRows[id];
  if (!v) { toast('数据不存在，请刷新后重试'); return; }
  editingId = id;
  // H5 仅单条编辑，无批量视图
  const box = document.getElementById('modal-box');
  if (box) box.style.width = '';
  const saveBtn = document.getElementById('modal-save'); if (saveBtn) saveBtn.textContent = '保存';
  document.getElementById('modal-title').textContent = '编辑车辆';
  document.getElementById('f-plate').value = formatPlate(v.plateNo || '');
  document.getElementById('f-owner').value = v.owner || '';
  document.getElementById('f-phone').value = v.phone || '';
  document.getElementById('f-remark').value = v.remark || '';
  depTags = (v.department || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  renderDepTags();
  // validUntil 形如 "2026-08-20~2026-09-19" / "2026-12-31" / "长期"
  const rng = parseRange(v.validUntil);
  dpStart = rng.start; dpEnd = rng.end;
  toggleValidUntilClear();
  // 预览用相对路径，不依赖 config.BASE_URL（避免内外网不一致导致破图）
  // 必须附带 ?token=，否则 <img> 无法携带鉴权头，照片接口返回 401 导致编辑时图片不显示
  photoUrl = v.photo ? ('/api/vehicles/' + v.id + '/photo?token=' + encodeURIComponent(getToken() || '')) : '';
  photoUploaded = false; photoRemoteUrl = '';
  if (photoUrl) showPhotoDone(photoUrl);
  else showPhotoEmpty();
  document.getElementById('modal').classList.add('show');
  updatePlateArea(document.getElementById('f-plate').value);
  document.getElementById('f-plate').focus();
}

async function saveVehicle() {
  const plate = unformatPlate(document.getElementById('f-plate').value);
  const owner = document.getElementById('f-owner').value.trim();
  const phone = document.getElementById('f-phone').value.trim();
  const department = depTags.join(',');
  const remark = document.getElementById('f-remark').value.trim();

  if (!plate) { toast('请填写车牌号（必填）'); return; }
  if (!PLATE_RE.test(plate)) { toast('车牌号格式不正确，请检查'); updatePlateArea(plate); return; }
  if (!owner) { toast('请填写车主（必填）'); return; }
  if (!department) { toast('请至少添加一个部门（必填）'); return; }
  if (phone && !/^1[3-9]\d{9}$/.test(phone)) { toast('手机号格式不正确（11 位，1 开头）'); return; }

  // 有效期由开始~结束日期自动计算，未选择则为空（长期）
  const validUntil = fmtRange();

  const body = { plateNo: plate, owner, phone, department, validUntil, remark };
  // 仅在本次确实重新上传（或移除）了照片时才提交 photo 字段，避免编辑未改图时被错误覆盖
  if (photoUploaded) body.photo = photoRemoteUrl || null;
  if (editingId) body.id = editingId;

  const btn = document.getElementById('modal-save');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await api('/api/admin/vehicles', { method: 'POST', body: JSON.stringify(body) });
    if (!r.success) {
      // 后端按车牌去重，返回 409 表示已存在
      if (r.message && /已存在|重复/.test(r.message)) toast('车牌号已存在，请勿重复添加');
      else toast(r.message || '保存失败');
      return;
    }
    toast(r.message || '保存成功');
    closeModal();
    loadVehicles();
  } catch (e) {
    toast('保存失败：' + (e.message || ''));
  } finally {
    btn.disabled = false; btn.textContent = '保存';
  }
}

function delVehicle(id) {
  const v = vRows[id] || {};
  if (!confirm('确定删除车辆 ' + (v.plateNo || id) + ' 吗？')) return;
  api('/api/admin/vehicles/' + id, { method: 'DELETE' }).then(r => {
    if (r.success) { toast('已删除'); selectedIds.delete(id); loadVehicles(); }
    else toast(r.message || '删除失败');
  }).catch(e => toast('删除失败：' + e.message));
}

function updateSelCount() {
  document.getElementById('sel-count').textContent = selectedIds.size ? `已选 ${selectedIds.size} 辆` : '';
  const batchBtn = document.getElementById('batch-del-btn');
  batchBtn.style.display = selectedIds.size > 0 ? '' : 'none';
  const allCb = document.getElementById('check-all');
  const boxes = document.querySelectorAll('#list input.row-check');
  if (allCb) allCb.checked = boxes.length > 0 && [...boxes].every(b => b.checked);
}

async function batchDelete() {
  if (!selectedIds.size) { toast('请先勾选要删除的车辆', 'error'); return; }
  if (!confirm(`确定删除选中的 ${selectedIds.size} 辆车？`)) return;
  try {
    const r = await api('/api/admin/vehicles/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids: [...selectedIds] })
    });
    if (!r.success) throw new Error(r.message || '删除失败');
    toast(r.message || '已删除');
    selectedIds.clear();
    loadVehicles();
  } catch (e) { toast('删除失败：' + e.message); }
}

function closeModal() {
  document.getElementById('modal').classList.remove('show');
}

// ---------- 详情模态框（车牌按钮 → 弹出） ----------
function closeDetail() {
  document.getElementById('detailModal').classList.remove('show');
}
function openDetail(id) {
  const v = vRows[id];
  if (!v) { toast('数据不存在，请刷新后重试'); return; }
  const hasPhotoLocal = !!(v.photo && String(v.photo).trim());
  const el = document.getElementById('dPlate');
  el.className = 'plate-no ' + plateType(v.plateNo);
  const pp = String(v.plateNo || '').toUpperCase().replace(/·/g, '');
  const sep = plateType(v.plateNo) === 'green'
    ? '<span class="ev-mark"><img src="/static/images/ev-plate-mark.png" alt="新能源"></span>'
    : '<span class="prov"></span>';
  el.innerHTML = pp.charAt(0) + pp.charAt(1) + sep + pp.slice(2);
  document.getElementById('dSub').textContent = plateArea(v.plateNo).replace(/^归属地：/, '');
  document.getElementById('dOwner').textContent = v.owner || '-';
  document.getElementById('dPhone').textContent = v.phone || '-';
  document.getElementById('dDept').textContent = (v.department || '').split(/[,，]/).map(s => s.trim()).filter(Boolean).join(' / ') || '-';
  document.getElementById('dValid').innerHTML = formatValidCell(v.validUntil);
  document.getElementById('dRemark').textContent = v.remark || '-';
  const thumbImg = document.getElementById('dThumbImg');
  const thumbEmpty = document.getElementById('dThumbEmpty');
  const thumb = document.getElementById('dThumb');
  const photoUrl = (v.id) ? ('/api/vehicles/' + v.id + '/photo?token=' + encodeURIComponent(getToken() || '')) : '';
  if (hasPhotoLocal && photoUrl) {
    thumbImg.src = photoUrl;
    thumbImg.style.display = '';
    thumbEmpty.style.display = 'none';
    thumb.onclick = () => zoomPhoto(photoUrl);
    thumb.style.cursor = 'pointer';
  } else {
    thumbImg.removeAttribute('src');
    thumbImg.style.display = 'none';
    thumbEmpty.style.display = '';
    thumb.onclick = null;
    thumb.style.cursor = 'default';
  }
  document.getElementById('detail-del').onclick = () => { closeDetail(); delVehicle(id); };
  document.getElementById('detail-edit').onclick = () => { closeDetail(); editVehicle(id); };
  document.getElementById('detailModal').classList.add('show');
}
function initDetailModal() {
  document.getElementById('detail-close').onclick = closeDetail;
  document.getElementById('detailModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeDetail();
  });
}

// ---------- 照片上传（点击/拖拽/粘贴 → 先上传再保存） ----------
function initPhotoBox() {
  const box = document.getElementById('v-photo-box');
  const file = document.getElementById('v-photo-file');
  box.addEventListener('click', () => { if (document.getElementById('v-photo-done').style.display === 'none') file.click(); });
  file.onchange = () => { if (file.files && file.files[0]) pickPhoto(file.files[0]); file.value = ''; };

  // 拖拽
  ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, e => { e.preventDefault(); box.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => box.addEventListener(ev, e => { e.preventDefault(); box.classList.remove('drag'); }));
  box.addEventListener('drop', e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) pickPhoto(f);
  });

  // 粘贴
  document.addEventListener('paste', e => {
    if (!document.getElementById('modal').classList.contains('show')) return;
    const items = e.clipboardData && e.clipboardData.items;
    for (const it of items || []) {
      if (it.type.indexOf('image/') === 0) { pickPhoto(it.getAsFile()); break; }
    }
  });

  document.getElementById('v-photo-remove').onclick = e => {
    e.stopPropagation(); photoUrl = ''; photoRemoteUrl = ''; photoUploaded = true; showPhotoEmpty();
  };
}

function pickPhoto(f) {
  if (!f) return;
  if (f.type.indexOf('image/') !== 0) { toast('请选择图片文件'); return; }
  const fd = new FormData();
  fd.append('photo', f);
  showPhotoLoading();
  // 上传与识别并行发起：用同一文件对象直接识别，省去“下载回传”的一次往返
  const ocrP = recognizePlate(f);
  api('/api/admin/vehicles/photo', { method: 'POST', body: fd, noJson: true, noLogout: true })
    .then(r => {
      if (!r.success) throw new Error(r.message || '上传失败');
      photoRemoteUrl = r.url;       // 提交给后端的 URL（服务器返回的绝对地址）
      photoUrl = withToken(r.url);  // 预览/识别用带令牌的 URL，防止 401 破图
      photoUploaded = true;         // 标记本次确实重新上传了
      showPhotoDone(photoUrl);
    })
    .catch(e => { showPhotoEmpty(); toast('上传失败：' + e.message); });
  // 识别不阻塞预览：无论上传是否成功都尝试识别
  ocrP.catch(() => {});
}

// 直接对图片文件做车牌识别（避免先把图片下载回前端再上传，减少一次网络往返）
function recognizePlate(file) {
  const fd = new FormData();
  fd.append('image', file, 'snap.jpg');
  return api('/api/recognize', { method: 'POST', body: fd, noJson: true, noLogout: true })
    .then(r => {
      if (!r || r.success === false) { toast('车牌识别失败：' + ((r && r.message) || '未知错误')); return; }
      const plate = r && r.data && r.data.plateNo;
      if (plate && !document.getElementById('f-plate').value) {
        document.getElementById('f-plate').value = formatPlate(plate);
        updatePlateArea(plate);
      }
    })
    .catch(e => { toast('车牌识别失败：' + (e && e.message || '请求异常')); });
}

// 批量录入：对某一行拍照/上传并识别车牌
async function batchRowOcr(seq, file) {
  if (!file || file.type.indexOf('image/') !== 0) { toast('请选择图片文件'); return; }
  const row = document.querySelector('.batch-row[data-seq="' + seq + '"]');
  if (!row) return;
  const plateInput = row.querySelector('[data-f="plateNo"]');
  const snapBtn = row.querySelector('.ocr-snap');
  if (snapBtn) { snapBtn.disabled = true; snapBtn.textContent = '…'; }
  try {
    const fd = new FormData(); fd.append('photo', file);
    const up = await api('/api/admin/vehicles/photo', { method: 'POST', body: fd, noJson: true, noLogout: true });
    if (!up.success) throw new Error(up.message || '上传失败');
    const url = withToken(up.url);
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) throw new Error('download ' + res.status);
    const blob = await res.blob();
    const rfd = new FormData(); rfd.append('image', blob, 'snap.jpg');
    const r = await api('/api/recognize', { method: 'POST', body: rfd, noJson: true, noLogout: true });
    if (!r || r.success === false) throw new Error((r && r.message) || '识别失败');
    const plate = r && r.data && r.data.plateNo;
    if (!plate) throw new Error('未识别到车牌');
    if (plateInput) {
      plateInput.value = formatPlate(plate);
      plateInput.classList.remove('error');
    }
    toast('识别成功：' + formatPlate(plate));
  } catch (e) {
    toast('识别失败：' + (e && e.message || '请求异常'));
  } finally {
    if (snapBtn) { snapBtn.disabled = false; snapBtn.textContent = '📷'; }
  }
}

// 供 HTML 内联 onclick 调用
window.batchRowOcr = batchRowOcr

function showPhotoEmpty() {
  document.getElementById('v-photo-empty').style.display = '';
  document.getElementById('v-photo-done').style.display = 'none';
  document.getElementById('v-photo-loading').style.display = 'none';
}
function showPhotoLoading() {
  document.getElementById('v-photo-empty').style.display = 'none';
  document.getElementById('v-photo-done').style.display = 'none';
  document.getElementById('v-photo-loading').style.display = '';
}
function showPhotoDone(url) {
  document.getElementById('v-photo-empty').style.display = 'none';
  document.getElementById('v-photo-loading').style.display = 'none';
  const done = document.getElementById('v-photo-done');
  done.style.display = '';
  document.getElementById('v-photo-img').src = url;
}

// ---------- 大图预览 ----------
function zoomPhoto(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox').classList.add('show');
  document.getElementById('lightbox').onclick = () => document.getElementById('lightbox').classList.remove('show');
}
