// ===== 识别记录 =====
let lState = { page: 1, pageSize: 20, total: 0, channel: '', start: '', end: '' };
let selectedIds = new Set();

function formatDate(s) {
  if (!s) return '';
  // 已是标准格式 YYYY-MM-DD HH:MM:SS 直接返回
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(s)) return s.replace('T', ' ');
  // en-US 格式 8/21/2026, 1:29:59 PM -> 转换
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2}):(\d{2})\s*(AM|PM)?/i);
  if (m) {
    let h = parseInt(m[4], 10); const ap = (m[7] || '').toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12; if (ap === 'AM' && h === 12) h = 0;
    const p = n => String(n).padStart(2, '0');
    return `${m[3]}-${p(m[1])}-${p(m[2])} ${p(h)}:${m[5]}:${m[6]}`;
  }
  return s;
}

function buildParams() {
  const p = new URLSearchParams({ page: lState.page, pageSize: lState.pageSize, channel: lState.channel, start: lState.start, end: lState.end });
  return p.toString();
}

function updateSelCount() {
  document.getElementById('sel-count').textContent = selectedIds.size ? `已选 ${selectedIds.size} 条` : '';
  document.getElementById('batch-del-btn').style.display = selectedIds.size > 0 ? '' : 'none';
  const allCb = document.getElementById('check-all');
  const boxes = document.querySelectorAll('#list input.row-check');
  allCb.checked = boxes.length > 0 && [...boxes].every(b => b.checked);
}

async function loadLogs() {
  try {
    const data = await api('/api/admin/logs?' + buildParams());
    const list = (data.data || []);
    lState.total = data.total || 0;
    const tbody = document.getElementById('list');
    if (!list.length) {
      tbody.innerHTML = '';
      document.getElementById('empty').style.display = 'block';
    } else {
      document.getElementById('empty').style.display = 'none';
      tbody.innerHTML = list.map(r => {
        // 渠道：qmlpars_APP/微信/手机浏览器/mini（兼容旧数据 app/web）
        let chan;
        if (r.channel === 'qmlpars_APP' || r.channel === 'app') chan = '<span class="pill app">APP</span>';
        else if (r.channel === 'wechat') chan = '<span class="pill web">微信浏览器</span>';
        else if (r.channel === 'h5' || r.channel === 'web') chan = '<span class="pill web">手机浏览器</span>';
        else chan = '<span class="pill mini">小程序</span>';
        let res;
        if ((r.result || '').includes('成功')) res = '<span class="pill ok">成功</span>';
        else if ((r.result || '').includes('无车辆数据')) res = '<span class="pill no">无车辆数据</span>';
        else if ((r.result || '').includes('命中')) res = '<span class="pill ok">内部</span>';
        else if ((r.result || '').includes('失败')) res = '<span class="pill no">失败</span>';
        else res = '<span class="pill web">外部</span>';
        const checked = selectedIds.has(r.id) ? 'checked' : '';
        // 抓拍图带 token，便于 <img>/<a> 直接访问
        const imgUrl = r.image ? r.image + (r.image.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(getToken() || '') : '';
        const img = r.image
          ? `<a href="${imgUrl}" target="_blank"><img class="thumb" src="${imgUrl}" alt="抓拍" onerror="this.parentNode.textContent='—'"></a>`
          : '<span class="muted">—</span>';
        return '<tr>' +
          `<td><input type="checkbox" class="row-check" value="${r.id}" ${checked}></td>` +
          '<td>' + escapeHtml(r.plateNo || '—') + '</td>' +
          '<td>' + chan + '</td>' +
          '<td>' + res + '</td>' +
          '<td>' + (r.confidence != null ? Math.round(r.confidence * 100) + '%' : '-') + '</td>' +
          '<td>' + img + '</td>' +
          '<td>' + (r.userName || r.username ? escapeHtml((r.username || '') + (r.username && r.userName ? '/' : '') + (r.userName || '')) : '<span class="muted">—</span>') + '</td>' +
          '<td>' + escapeHtml(formatDate(r.createdAt)) + '</td>' +
          '<td><button class="btn sm danger" onclick="deleteLog(' + r.id + ')">删除</button></td>' +
          '</tr>';
      }).join('');
    }
    // 行复选框事件
    tbody.querySelectorAll('input.row-check').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = Number(cb.value);
        if (cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        updateSelCount();
      });
    });
    // 直接传 lState 引用，确保翻页修改页码后 reload 读到新值
    lState.reload = loadLogs;
    renderPager('pager', lState);
    updateSelCount();
  } catch (e) { toast(e.message, 'error'); }
}

async function deleteLog(id) {
  if (!(await confirmModal('删除记录', '确定删除该记录？', '删除', true))) return;
  try {
    await api('/api/admin/logs/' + id, { method: 'DELETE' });
    selectedIds.delete(id);
    toast('已删除', 'success');
    loadLogs();
  } catch (e) { toast(e.message, 'error'); }
}

async function clearAll() {
  if (!confirm('确定清空全部识别记录？此操作不可恢复！')) return;
  try {
    const data = await api('/api/admin/logs/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ all: true, channel: lState.channel, start: lState.start, end: lState.end })
    });
    selectedIds.clear();
    toast(data.message || '已清空', 'success');
    lState.page = 1;
    loadLogs();
  } catch (e) { toast(e.message, 'error'); }
}

async function batchDelete() {
  if (!selectedIds.size) { toast('请先勾选要删除的记录', 'error'); return; }
  if (!(await confirmModal('批量删除', `确定删除选中的 ${selectedIds.size} 条记录？`, '删除', true))) return;
  try {
    const data = await api('/api/admin/logs/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids: [...selectedIds] })
    });
    selectedIds.clear();
    toast(data.message || '已删除', 'success');
    loadLogs();
  } catch (e) { toast(e.message, 'error'); }
}

function initLogs() {
  initColResize('logTbl',
    ['check', 'plate', 'channel', 'result', 'conf', 'img', 'opby', 'time', 'op'],
    { check: 42, plate: 110, channel: 90, result: 160, conf: 80, img: 120, opby: 90, time: 160, op: 150 },
    'logTbl_colwidths', { lastFixed: 'op' })
  loadLogs();
  document.getElementById('channel').addEventListener('change', e => { lState.channel = e.target.value; lState.page = 1; loadLogs(); });
  document.getElementById('start').addEventListener('change', e => { lState.start = e.target.value; lState.page = 1; });
  document.getElementById('end').addEventListener('change', e => { lState.end = e.target.value; lState.page = 1; });
  document.getElementById('query-btn').onclick = () => { lState.start = document.getElementById('start').value; lState.end = document.getElementById('end').value; lState.page = 1; loadLogs(); };
  document.getElementById('clear-btn').onclick = clearAll;
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
}
