// ===== 识别记录 =====
let lState = { page: 1, pageSize: 20, total: 0, channel: '', start: '', end: '' };
let selectedIds = new Set();

function buildParams() {
  const p = new URLSearchParams({ page: lState.page, pageSize: lState.pageSize, channel: lState.channel, start: lState.start, end: lState.end });
  return p.toString();
}

function updateSelCount() {
  document.getElementById('sel-count').textContent = selectedIds.size ? `已选 ${selectedIds.size} 条` : '';
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
        const chan = r.channel === 'mini' ? '<span class="pill mini">小程序</span>' : '<span class="pill web">网页</span>';
        let res;
        if ((r.result || '').includes('命中')) res = '<span class="pill ok">内部</span>';
        else if ((r.result || '').includes('失败')) res = '<span class="pill no">失败</span>';
        else res = '<span class="pill web">外部</span>';
        const checked = selectedIds.has(r.id) ? 'checked' : '';
        const img = r.image
          ? `<a href="${r.image}" target="_blank"><img class="thumb" src="${r.image}" alt="抓拍"></a>`
          : '<span class="muted">—</span>';
        return '<tr>' +
          `<td><input type="checkbox" class="row-check" value="${r.id}" ${checked}></td>` +
          '<td>' + escapeHtml(r.plateNo || '—') + '</td>' +
          '<td>' + chan + '</td>' +
          '<td>' + res + '</td>' +
          '<td>' + (r.confidence != null ? Math.round(r.confidence * 100) + '%' : '-') + '</td>' +
          '<td>' + img + '</td>' +
          '<td>' + escapeHtml(r.createdAt || '') + '</td>' +
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
  if (!confirm('确定删除该记录？')) return;
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
  if (!confirm(`确定删除选中的 ${selectedIds.size} 条记录？`)) return;
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
