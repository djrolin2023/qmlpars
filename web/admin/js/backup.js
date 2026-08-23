// ===== 备份恢复页 =====

function fmtSize(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

function fmtTime(t) {
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

async function loadBackupList() {
  const tbody = document.getElementById('bk-tbody');
  const empty = document.getElementById('bk-empty');
  try {
    const r = await api('/api/admin/backup/list');
    const list = r.list || [];
    empty.style.display = list.length ? 'none' : '';
    tbody.innerHTML = list.map(b => `
      <tr>
        <td class="mono">${esc(b.file)}</td>
        <td>${fmtSize(b.size)}</td>
        <td>${fmtTime(b.time)}</td>
        <td>
          <span class="op-link" data-act="dl" data-file="${esc(b.file)}">下载</span>
          <span class="op-link danger" data-act="rs" data-file="${esc(b.file)}">恢复</span>
          <span class="op-link danger" data-act="del" data-file="${esc(b.file)}">删除</span>
        </td>
      </tr>`).join('');
  } catch (e) {
    toast('加载备份列表失败：' + e.message, 'error');
  }
}

function downloadBackup(file) {
  try {
    const h = authHeaders();
    const token = h['x-admin-token'] || '';
    const url = '/api/admin/backup/download?file=' + encodeURIComponent(file) +
      (token ? '&token=' + encodeURIComponent(token) : '');
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch (e) {
    toast(e.message || '下载失败', 'error');
  }
}

async function createBackup(pwd) {
  const btn = document.getElementById('bk-confirm-ok');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/backup/create', { method: 'POST', body: JSON.stringify({ password: pwd }) });
    toast('备份成功' + (r.encrypted ? '（已加密）' : '') + '：' + r.file, 'success');
    loadBackupList();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
    closeModal('bk-confirm-modal');
  }
}

// 上传选中文件并返回临时文件名
async function uploadSelected() {
  const fileInput = document.getElementById('bk-file');
  const f = fileInput.files[0];
  if (!f) throw new Error('请先选择备份文件');
  const fd = new FormData();
  fd.append('file', f);
  const r = await api('/api/admin/backup/upload', { method: 'POST', body: fd, noJson: true });
  return r.file;
}

async function restoreBackup(fileName, password) {
  const btn = document.getElementById('rs-ok');
  btn.disabled = true;
  btn.textContent = '恢复中...';
  try {
    const r = await api('/api/admin/backup/restore', { method: 'POST', body: JSON.stringify({ file: fileName, password: password }) });
    toast(r.message || '恢复成功', 'success');
    // 3 秒后服务自动重启，引导用户重新登录
    setTimeout(() => {
      try { location.replace('login.html'); } catch (e) {}
    }, 4000);
  } catch (e) {
    toast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = '确认恢复';
  }
}

function openModal(id) { const m = document.getElementById(id); if (m) m.classList.add('show'); }
function closeModal(id) { const m = document.getElementById(id); if (m) m.classList.remove('show'); }

let pendingRestoreFile = null; // 历史恢复时已有文件名；null 表示需上传

function showRestoreModal(fileName) {
  pendingRestoreFile = fileName || null;
  const pwdEl = document.getElementById('bk-restore-pwd');
  const fileEl = document.getElementById('bk-file');
  const fileRow = document.getElementById('rs-file-row');
  const nameEl = document.getElementById('rs-file-name');
  pwdEl.value = '';
  fileEl.value = '';
  if (pendingRestoreFile) {
    fileRow.style.display = 'none';
    nameEl.style.display = 'block';
    nameEl.textContent = '将恢复备份：' + pendingRestoreFile;
  } else {
    fileRow.style.display = 'block';
    nameEl.style.display = 'none';
  }
  openModal('rs-modal');
}

function initBackup() {
  const crumb = document.getElementById('crumb');
  if (crumb) crumb.innerHTML = '<a href="index.html">控制台</a> / 备份恢复';

  loadBackupList();

  // 点击遮罩 / × / 取消 关闭所有模态框
  document.querySelectorAll('.modal-mask').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
    m.querySelectorAll('[data-close]').forEach(x => x.addEventListener('click', () => closeModal(x.dataset.close)));
  });

  // 生成备份：弹模态框确认（含密码与加密提示）
  document.getElementById('btn-create').addEventListener('click', () => {
    const pwdEl = document.getElementById('bk-pwd');
    pwdEl.value = '';
    const warn = document.getElementById('bk-confirm-warn');
    warn.innerHTML = '请设置备份密码（可选）。<br><strong>若设置密码，备份将使用密码加密，请牢记该密码（忘记将无法恢复）。</strong><br>留空则备份文件不加密，任何拿到文件的人都能直接恢复。';
    openModal('bk-confirm-modal');
  });
  document.getElementById('bk-confirm-ok').addEventListener('click', () => {
    const pwd = document.getElementById('bk-pwd').value;
    createBackup(pwd);
  });

  // 恢复：上传文件方式
  document.getElementById('btn-restore').addEventListener('click', () => showRestoreModal(null));
  document.getElementById('rs-ok').addEventListener('click', async () => {
    try {
      let fileName = pendingRestoreFile;
      if (!fileName) fileName = await uploadSelected();
      const pwd = document.getElementById('bk-restore-pwd').value;
      await restoreBackup(fileName, pwd);
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  // 历史备份操作：下载 / 恢复 / 删除
  document.getElementById('bk-tbody').addEventListener('click', async (ev) => {
    const el = ev.target.closest('.op-link');
    if (!el) return;
    const file = el.dataset.file;
    const act = el.dataset.act;
    if (act === 'dl') { downloadBackup(file); return; }
    if (act === 'del') {
      if (!confirm('确定删除备份 ' + file + ' ？')) return;
      try {
        await api('/api/admin/backup/delete', { method: 'POST', body: JSON.stringify({ file: file }) });
        toast('已删除', 'success');
        loadBackupList();
      } catch (e) { toast(e.message, 'error'); }
      return;
    }
    if (act === 'rs') {
      showRestoreModal(file);
    }
  });
}
