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
  // 去除各种可能出现的「圆点/分隔符」变体（中间点·、项目符号•、片假名中点・、全角句号．等），避免 OCR 误识导致归属地/查重失效
  return String(plate || '').replace(/[·•・．・]/g, '').replace(/\s+/g, '').toUpperCase()
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
    const r = await fetch('js/plate-areas.json', { cache: 'no-cache' });
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
}

// 实时查重：输入车牌时提示库中是否已存在（新增车辆场景）
let _dupTimer = null;
function checkPlateDuplicate(plate) {
  const dup = document.getElementById('plate-dup');
  plate = unformatPlate(plate || '');
  clearTimeout(_dupTimer);
  if (!plate || !PLATE_RE.test(plate)) { if (dup) dup.style.display = 'none'; return; }
  _dupTimer = setTimeout(() => {
    api('/api/admin/vehicles/check?plate=' + encodeURIComponent(plate), { noLogout: true })
      .then(r => {
        if (!dup) return;
        if (r && r.success && r.exists) {
          const d = r.data || {};
          dup.textContent = '⚠ 库中已有' + (d.owner ? '（车主：' + d.owner + '）' : '');
          dup.style.display = 'inline-block';
        } else {
          dup.style.display = 'none';
        }
      })
      .catch(() => { if (dup) dup.style.display = 'none'; });
  }, 350);
}
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
  try {
    initColResize('vehTbl',
      ['check', 'photo', 'plate', 'owner', 'phone', 'dept', 'valid', 'remark', 'op'],
      { check: 42, photo: 76, plate: 110, owner: 90, phone: 120, dept: 110, valid: 120, remark: 150, op: 150 },
      'vehTbl_colwidths', { lastFixed: 'op' })
  } catch (e) {
    console.error('initColResize failed:', e)
  }
  loadPlateAreas();
  loadVehicles();

  const plateInput = document.getElementById('f-plate');
  if (plateInput) {
    // 仅做大写 / 去空格，不在此插入「·」分隔符，避免打断移动端英文（九宫格）输入
    plateInput.addEventListener('input', e => {
      const el = e.target;
      const v = el.value.toUpperCase().replace(/\s+/g, '').replace(/[·•・．・]/g, '');
      if (el.value !== v) {
        const start = el.selectionStart;
        el.value = v;
        const pos = Math.min(start, el.value.length);
        el.setSelectionRange(pos, pos);
      }
      updatePlateArea(el.value);
      checkPlateDuplicate(el.value);
    });
    // 失焦时再统一格式化为「粤B·12345」展示样式
    plateInput.addEventListener('blur', e => {
      const el = e.target;
      if (el.value) el.value = formatPlate(el.value);
      checkPlateDuplicate(el.value);
    });
  }

  document.getElementById('add-btn').onclick = openAdd;
  document.getElementById('refresh-btn').onclick = loadVehicles;
  document.getElementById('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') { vState.keyword = e.target.value.trim(); vState.page = 1; loadVehicles(); }
  });
  // 查询按钮
  const queryBtn = document.getElementById('query-btn');
  if (queryBtn) queryBtn.onclick = () => {
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

  // 批量新增车辆：在新增车辆弹窗内切换为批量行表单
  const batchInputBtn = document.getElementById('batch-input-btn')
  if (batchInputBtn) batchInputBtn.onclick = openBatchAdd
  // 批量表单底部「+ 添加一行」
  const batchAddBtn = document.getElementById('batch-add-btn')
  if (batchAddBtn) batchAddBtn.onclick = () => addBatchRow()
  // 粘贴导入
  const batchPasteToggle = document.getElementById('batch-paste-toggle')
  if (batchPasteToggle) batchPasteToggle.onclick = () => showBatchPastePanel(true)
  const batchPasteCancel = document.getElementById('batch-paste-cancel')
  if (batchPasteCancel) batchPasteCancel.onclick = () => showBatchPastePanel(false)
  const batchPasteConfirm = document.getElementById('batch-paste-confirm')
  if (batchPasteConfirm) batchPasteConfirm.onclick = applyBatchPaste

  document.getElementById('check-all').addEventListener('change', e => {
    const checked = e.target.checked;
    document.querySelectorAll('#list input.row-check').forEach(cb => {
      cb.checked = checked;
      const id = Number(cb.value);
      if (checked) selectedIds.add(id); else selectedIds.delete(id);
    });
    updateSelCount();
  });

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

async function loadVehicles() {
  const box = document.getElementById('list');
  box.innerHTML = '<tr><td colspan="9" class="empty">加载中…</td></tr>';
  try {
    const qs = new URLSearchParams({ page: vState.page, pageSize: vState.pageSize, keyword: vState.keyword });
    if (vState.department) qs.set('department', vState.department);
    const r = await api('/api/admin/vehicles?' + qs.toString());
    if (!r.success) throw new Error(r.message || '加载失败');
    const list = r.data || [];
    vState.total = r.total || 0;
    vRows = {};
    list.forEach(v => {
      // 仅当后端 photo 字段有值时才生成 photoUrl；无照片直接显示占位，避免 404 破图
      // 通过 ?token= 附带 admin token，使 <img> 能访问需鉴权的照片接口
      v.photoUrl = (v.photo && v.id) ? '/api/vehicles/' + v.id + '/photo?token=' + encodeURIComponent(getToken() || '') : '';
      vRows[v.id] = v;
    });

    const tbody = document.getElementById('list');
    if (!list.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="empty">暂无车辆</td></tr>';
      document.getElementById('empty').style.display = 'none';
    } else {
      tbody.innerHTML = list.map(v => {
        const checked = selectedIds.has(v.id) ? 'checked' : '';
        return `<tr>
          <td><input type="checkbox" class="row-check" value="${v.id}" ${checked}></td>
          <td>${v.photoUrl ? '<img class="thumb" src="' + esc(v.photoUrl) + '" onclick="zoomPhoto(\'' + esc(v.photoUrl) + '\')">' : '<span class="no-photo">未上传车辆照片</span>'}</td>
          <td>${formatPlateCell(v.plateNo)}</td>
          <td>${esc(v.owner || '')}</td>
          <td>${esc(v.phone || '')}</td>
          <td>${renderDepTag(v.department)}</td>
          <td>${formatValidCell(v.validUntil)}</td>
          <td class="remark-cell">${esc(v.remark || '')}</td>
          <td>
            <button class="btn sm danger" onclick="delVehicle(${v.id})">删除</button>
            <button class="btn sm warn" onclick="editVehicle(${v.id})">编辑</button>
          </td>
        </tr>`;
      }).join('');
      tbody.querySelectorAll('input.row-check').forEach(cb => {
        cb.addEventListener('change', () => {
          const id = Number(cb.value);
          if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
          updateSelCount();
        });
      });
      document.getElementById('empty').style.display = 'none';
    }
    updateSelCount();
    // 关键：传入 vState 自身（而非 {...vState} 浅拷贝），
    // 否则 renderPager 内 state.page=np 只改到副本，reload 时仍读旧页码，导致翻页无反应。
    vState.reload = loadVehicles;
    renderPager('pager', vState);
  } catch (e) {
    document.getElementById('list').innerHTML = '<tr><td colspan="9" class="empty">' + esc(e.message) + '</td></tr>';
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
  const dp = document.getElementById('plate-dup'); if (dp) dp.style.display = 'none';
  document.getElementById('modal').classList.add('show');
  updatePlateArea(document.getElementById('f-plate').value);
  document.getElementById('f-plate').focus();
}

function editVehicle(id) {
  const v = vRows[id];
  if (!v) { toast('数据不存在，请刷新后重试'); return; }
  editingId = id;
  // 切回单条编辑视图（若此前处于批量视图）；H5 无批量区块，做存在性保护
  modalMode = 'single';
  const bs = document.getElementById('batch-single'); if (bs) bs.style.display = '';
  const bm = document.getElementById('batch-multi'); if (bm) bm.style.display = 'none';
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
  if (modalMode === 'batch') { await submitBatchCreate(); return; }
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
  allCb.checked = boxes.length > 0 && [...boxes].every(b => b.checked);
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
  modalMode = 'single';
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
  // 上传与识别并行：用同一文件直接识别，省去“下载回传”的一次往返
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
    // 上传与识别并行，且直接把原始文件发给识别接口，省去下载回传
    const fd = new FormData(); fd.append('photo', file);
    const upP = api('/api/admin/vehicles/photo', { method: 'POST', body: fd, noJson: true, noLogout: true });
    const ocrR = await recognizePlate(file);
    const up = await upP;
    if (!up.success) throw new Error(up.message || '上传失败');
    if (!ocrR) throw new Error('识别失败');
    const plate = (ocrR && ocrR.data && ocrR.data.plateNo);
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

// ---------- 批量新增车辆（多行表单，无照片） ----------
let modalMode = 'single';   // 'single' | 'batch'
let batchRowSeq = 0;        // 行去重序号

function openBatchAdd() {
  modalMode = 'batch';
  editingId = null;
  document.getElementById('modal-title').textContent = '批量新增车辆';
  document.getElementById('batch-single').style.display = 'none';
  document.getElementById('batch-multi').style.display = 'block';
  // 切换模式时让 modal 更宽
  const box = document.getElementById('modal-box');
  if (box) box.style.width = 'min(1100px,96vw)';
  document.getElementById('modal-save').textContent = '批量添加';
  // 清空粘贴面板与提示
  showBatchPastePanel(false);
  const ta = document.getElementById('batch-paste-text');
  if (ta) ta.value = '';
  const hint = document.getElementById('batch-hint');
  if (hint) { hint.textContent = ''; hint.style.color = ''; }
  // 初始给 2 个空行
  const wrap = document.getElementById('batch-rows');
  wrap.innerHTML = '';
  batchRowSeq = 0;
  for (let i = 0; i < 2; i++) addBatchRow();
  refreshBatchSeq();
  document.getElementById('modal').classList.add('show');
}

// 解析 validUntil 字符串为 {validStart, validEnd}
function splitValidUntil(v) {
  if (!v) return { validStart: '', validEnd: '' };
  v = String(v).trim();
  if (v.includes('~')) {
    const [s, e] = v.split('~').map(x => x.trim());
    return { validStart: s || '', validEnd: e || '' };
  }
  // 单个日期视为结束日期，开始日期留空（后端按今天处理）
  return { validStart: '', validEnd: v };
}

// 新增批量录入行：桌面端横向一行，移动端自动变卡片
function addBatchRow(values) {
  values = values || {};
  let { validStart, validEnd } = splitValidUntil(values.validUntil || '');
  if (values.validStart) validStart = values.validStart;
  if (values.validEnd) validEnd = values.validEnd;
  const seq = ++batchRowSeq;
  const wrap = document.getElementById('batch-rows');
  const row = document.createElement('div');
  row.className = 'batch-row';
  row.dataset.seq = seq;
  const fields = [
    { f: 'plateNo', label: '车牌号', ph: '粤B12345', cls: 'batch-plate', required: true },
    { f: 'owner', label: '车主', ph: '姓名', cls: 'batch-owner', required: true },
    { f: 'department', label: '部门', ph: '部门', cls: 'batch-dept' },
    { f: 'phone', label: '手机号', ph: '11位手机号', cls: 'batch-phone' },
    { f: 'validRange', label: '有效期', cls: 'batch-valid', isRange: true },
    { f: 'remark', label: '备注', ph: '选填', cls: 'batch-remark' }
    ];
    let html = '<div class="batch-row-head"><span class="batch-seq">#</span><button type="button" class="del" title="删除本行" onclick="removeBatchRow(' + seq + ')">×</button></div>';
    html += '<div class="batch-fields">';
    for (const fd of fields) {
    if (fd.isRange) {
    html += '<div class="batch-field ' + fd.cls + '">' +
      '<label>' + (fd.required ? '<span class="req">*</span>' : '') + fd.label + '</label>' +
      '<div class="batch-valid-inputs">' +
        '<input type="date" data-f="validStart" value="' + esc(validStart) + '" title="开始时间">' +
        '<span class="batch-valid-sep">~</span>' +
        '<input type="date" data-f="validEnd" value="' + esc(validEnd) + '" title="结束时间（留空为长期）">' +
      '</div>' +
    '</div>';
    } else if (fd.f === 'plateNo') {
    const val = esc(formatPlate(values[fd.f] || ''));
    html += '<div class="batch-field ' + fd.cls + '">' +
      '<label>' + (fd.required ? '<span class="req">*</span>' : '') + fd.label + '</label>' +
      '<div class="batch-plate-input">' +
        '<input data-f="plateNo" placeholder="' + fd.ph + '" value="' + val + '" maxlength="10">' +
        '<button type="button" class="ocr-snap" title="拍照/上传识别车牌" data-seq="' + seq + '">📷</button>' +
        '<input type="file" accept="image/*" capture="environment" class="ocr-file" data-seq="' + seq + '" style="display:none">' +
      '</div>' +
    '</div>';
    } else {
    const val = esc(values[fd.f] || '');
    html += '<div class="batch-field ' + fd.cls + '">' +
      '<label>' + (fd.required ? '<span class="req">*</span>' : '') + fd.label + '</label>' +
      '<input data-f="' + fd.f + '" placeholder="' + fd.ph + '" value="' + val + '">' +
    '</div>';
    }
    }
    html += '</div>';
    html += '<div class="batch-actions">' +
    '<button type="button" class="add" title="新增一行" onclick="addBatchRow()">+</button>' +
    '<button type="button" class="del" title="删除本行" onclick="removeBatchRow(' + seq + ')">×</button>' +
    '</div>';
    row.innerHTML = html;

    // 车牌输入时实时格式化并校验
    const plateInput = row.querySelector('[data-f="plateNo"]');
    plateInput.addEventListener('input', e => {
    const el = e.target;
    const start = el.selectionStart;
    const formatted = formatPlate(el.value);
    if (el.value !== formatted) {
    el.value = formatted;
    el.setSelectionRange(Math.min(start + 1, el.value.length), Math.min(start + 1, el.value.length));
    }
    el.classList.toggle('error', el.value && !isValidPlate(el.value));
    });
    // 拍照识别车牌
    const snapBtn = row.querySelector('.ocr-snap');
    const fileInput = row.querySelector('.ocr-file');
    if (snapBtn && fileInput) {
    snapBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
    const f = e.target.files && e.target.files[0];
    if (f) batchRowOcr(seq, f);
    fileInput.value = ''; // 允许重复选同一张图
    });
    }
    // 手机号输入仅允许数字
    const phoneInput = row.querySelector('[data-f="phone"]');
    phoneInput.addEventListener('input', e => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 11); });

  wrap.appendChild(row);
  refreshBatchDelState();
  return row;
}

function removeBatchRow(seq) {
  const row = document.querySelector('.batch-row[data-seq="' + seq + '"]');
  if (row) row.remove();
  refreshBatchSeq();
  refreshBatchDelState();
}

// 重排卡片序号
function refreshBatchSeq() {
  document.querySelectorAll('#batch-rows .batch-row').forEach((r, i) => {
    const seqEl = r.querySelector('.batch-seq');
    if (seqEl) seqEl.textContent = '#' + (i + 1);
  });
}

// 至少保留一行（首行删除按钮禁用）
function refreshBatchDelState() {
  const rows = document.querySelectorAll('#batch-rows .batch-row');
  rows.forEach(r => {
    r.querySelectorAll('.del').forEach(btn => { btn.disabled = rows.length <= 1; });
  });
}

// 收集并校验所有有效行（车牌号非空视为有效行）
function collectBatchRows() {
  const rows = document.querySelectorAll('#batch-rows .batch-row');
  const items = [];
  let firstErr = '';
  rows.forEach(r => {
    const get = f => (r.querySelector('[data-f="' + f + '"]') || {}).value || '';
    const rawPlate = get('plateNo').trim();
    const plateNo = unformatPlate(rawPlate);
    const owner = get('owner').trim();
    const department = get('department').trim();
    const phone = get('phone').trim();
    const validStart = get('validStart').trim();
    const validEnd = get('validEnd').trim();
    const remark = get('remark').trim();
    if (!plateNo && !owner && !department && !phone && !remark) return; // 空行跳过
    // 校验
    if (!plateNo) { firstErr = firstErr || '存在车牌号为空行，请补全'; return; }
    if (!PLATE_RE.test(plateNo)) { firstErr = firstErr || ('车牌号格式不正确：' + rawPlate); return; }
    if (!owner) { firstErr = firstErr || ('车主不能为空：' + plateNo); return; }
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) { firstErr = firstErr || ('手机号格式不正确：' + plateNo); return; }
    if (validEnd && validStart && validEnd < validStart) { firstErr = firstErr || ('结束时间早于开始时间：' + plateNo); return; }
    const validUntil = validEnd ? (validStart ? (validStart + '~' + validEnd) : validEnd) : (validStart || '');
    items.push({ plateNo, owner, department, phone, validUntil, remark });
  });
  return { items, error: firstErr };
}

// 智能粘贴导入：从 Excel / 文本解析多行
function showBatchPastePanel(show) {
  document.getElementById('batch-paste-panel').style.display = show ? 'block' : 'none';
  if (show) document.getElementById('batch-paste-text').focus();
}

function parseBatchPaste(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const items = [];
  for (const line of lines) {
    // 优先按 Tab 分割；没有 Tab 则按 2 个及以上空格 或 全角逗号/英文逗号分割
    let parts = line.includes('\t') ? line.split('\t') : line.split(/\s{2,}|[，,]/);
    parts = parts.map(p => p.trim()).filter(p => p !== '');
    if (!parts.length) continue;
    const [plateNo, owner = '', department = '', phone = '', validUntil = '', remark = ''] = parts;
    if (!plateNo) continue;
    items.push({ plateNo, owner, department, phone, validUntil, remark });
  }
  return items;
}

function applyBatchPaste() {
  const ta = document.getElementById('batch-paste-text');
  const hint = document.getElementById('batch-hint');
  const items = parseBatchPaste(ta.value || '');
  if (!items.length) {
    if (hint) { hint.textContent = '未解析到有效数据，请检查粘贴内容'; hint.style.color = 'var(--no)'; }
    return;
  }
  // 清空现有行并填充
  const wrap = document.getElementById('batch-rows');
  wrap.innerHTML = '';
  items.forEach(it => addBatchRow(it));
  refreshBatchSeq();
  showBatchPastePanel(false);
  ta.value = '';
  if (hint) { hint.textContent = '已解析 ' + items.length + ' 条数据，请核对后保存'; hint.style.color = 'var(--yes)'; }
}

// 批量保存：在 saveVehicle 内根据 modalMode 分流
async function submitBatchCreate() {
  const btn = document.getElementById('modal-save');
  const hint = document.getElementById('batch-hint');
  const { items, error } = collectBatchRows();
  if (error) { if (hint) { hint.textContent = error; hint.style.color = 'var(--no)'; } return; }
  if (!items.length) { if (hint) { hint.textContent = '请至少填写一行有效数据（车牌号必填）'; hint.style.color = 'var(--no)'; } return; }
  if (hint) { hint.textContent = ''; }
  btn.disabled = true; btn.textContent = '提交中…';
  try {
    const conflict = (document.getElementById('batch-conflict') || {}).value || 'skip'
    const r = await api('/api/admin/vehicles/batch-create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, conflict })
    });
    if (!r.success) throw new Error(r.message || '导入失败');
    let msg = r.message || '批量导入成功'
    if (r.conflictPlates && r.conflictPlates.length) {
      msg += `（已存在 ${r.conflictPlates.length} 个：${r.conflictPlates.slice(0, 10).join('、')}${r.conflictPlates.length > 10 ? '…' : ''}）`
    }
    toast(msg, r.conflictPlates && r.conflictPlates.length ? 'warn' : 'ok');
    closeModal();
    loadVehicles();
  } catch (e) {
    if (hint) { hint.textContent = e.message; hint.style.color = 'var(--no)'; }
  } finally {
    btn.disabled = false; btn.textContent = '批量添加';
  }
}

// 供 HTML 内联 onclick 调用
window.addBatchRow = addBatchRow
window.removeBatchRow = removeBatchRow
