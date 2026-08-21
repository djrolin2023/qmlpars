// 车辆管理
let vRows = {};            // 当前页行缓存（编辑用）
let vState = { page: 1, pageSize: 10, total: 0, keyword: '' };
let editingId = null;      // null=新增
let photoUrl = '';         // 已上传照片 URL
let selectedIds = new Set();
let depTags = [];          // 当前车辆所属部门标签（可多个）
const PLATE_RE = /^[\u4e00-\u9fa5][A-Za-z0-9]{5,7}$/;
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
  plate = (plate || '').trim();
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
  return e ? (s + '~' + e) : s;   // 仅开始：自该日起长期；都有：区间；都无：空(长期)
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
  const prov = p.charAt(0);
  const letter = p.charAt(1);
  const info = plateAreas[prov];
  let area = '';
  if (info) {
    const city = info.cities[letter] || '';
    area = info.province + (city && city !== info.province ? ' · ' + city : '');
  }
  return area
    ? '<div><b>' + esc(p) + '</b></div><div class="plate-area-cell">' + esc(area) + '</div>'
    : '<div><b>' + esc(p) + '</b></div>';
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
  if (plateInput) plateInput.addEventListener('input', e => updatePlateArea(e.target.value));

  document.getElementById('add-btn').onclick = openAdd;
  document.getElementById('refresh-btn').onclick = loadVehicles;
  document.getElementById('search').addEventListener('keydown', e => {
    if (e.key === 'Enter') { vState.keyword = e.target.value.trim(); vState.page = 1; loadVehicles(); }
  });

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
      v.photoUrl = (v.photo && v.id) ? '/api/vehicles/' + v.id + '/photo' : '';
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
            <button class="btn sm" onclick="editVehicle(${v.id})">编辑</button>
            <button class="btn sm danger" onclick="delVehicle(${v.id})">删除</button>
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
  document.getElementById('modal').classList.add('show');
  updatePlateArea(document.getElementById('f-plate').value);
  document.getElementById('f-plate').focus();
}

function editVehicle(id) {
  const v = vRows[id];
  if (!v) { toast('数据不存在，请刷新后重试'); return; }
  editingId = id;
  document.getElementById('modal-title').textContent = '编辑车辆';
  document.getElementById('f-plate').value = v.plateNo || '';
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
  photoUrl = v.photo ? ('/api/vehicles/' + v.id + '/photo') : '';
  photoUploaded = false; photoRemoteUrl = '';
  if (photoUrl) showPhotoDone(photoUrl);
  else showPhotoEmpty();
  document.getElementById('modal').classList.add('show');
  updatePlateArea(document.getElementById('f-plate').value);
  document.getElementById('f-plate').focus();
}

async function saveVehicle() {
  const plate = document.getElementById('f-plate').value.trim().toUpperCase();
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

function closeModal() { document.getElementById('modal').classList.remove('show'); }

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
  api('/api/admin/vehicles/photo', { method: 'POST', body: fd, noJson: true })
    .then(r => {
      if (!r.success) throw new Error(r.message || '上传失败');
      photoUrl = r.url;
      photoRemoteUrl = r.url;       // 提交给后端的 URL（服务器返回的绝对地址）
      photoUploaded = true;         // 标记本次确实重新上传了
      showPhotoDone(r.url);
      autoOcr(r.url);
    })
    .catch(e => { showPhotoEmpty(); toast('上传失败：' + e.message); });
}

function autoOcr(url) {
  fetch(url).then(res => res.blob()).then(blob => {
    const fd = new FormData();
    fd.append('image', blob, 'snap.jpg');
    api('/api/recognize', { method: 'POST', body: fd, noJson: true })
      .then(r => {
        const plate = r && r.data && r.data.plateNo;
        if (plate && !document.getElementById('f-plate').value) {
          document.getElementById('f-plate').value = plate;
        }
      })
      .catch(() => {});
  }).catch(() => {});
}

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
