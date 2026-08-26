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
  try {
    const r = await api('/api/admin/backup/list');
    const list = r.list || [];
    const tbody = document.getElementById('bk-tbody');
    const empty = document.getElementById('bk-empty');
    empty.style.display = list.length ? 'none' : '';
    if (tbody) tbody.innerHTML = renderBackupRows(list);
  } catch (e) {
    toast('加载备份列表失败：' + e.message, 'error');
  }
}

function renderBackupRows(list) {
  return list.map(b => {
    const isMigrate = b.kind === 'migrate';
    const tag = isMigrate ? '<span class="tag migrate">迁移包</span>' : '<span class="tag data">数据</span>';
    // 迁移包仅提供下载/删除（用 install.sh 部署后手动拷回，不支持在线恢复）
    const ops = isMigrate
      ? `<span class="op-link" data-act="dl" data-file="${esc(b.file)}">下载</span><span class="op-link danger" data-act="del" data-file="${esc(b.file)}">删除</span>`
      : `<span class="op-link" data-act="dl" data-file="${esc(b.file)}">下载</span><span class="op-link danger" data-act="rs" data-file="${esc(b.file)}">恢复</span><span class="op-link danger" data-act="del" data-file="${esc(b.file)}">删除</span>`;
    return `<tr>
      <td class="mono">${esc(b.file)}</td>
      <td>${tag}</td>
      <td>${fmtSize(b.size)}</td>
      <td>${fmtTime(b.time)}</td>
      <td>${ops}</td>
    </tr>`;
  }).join('');
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

async function createBackup(pwd, mode) {
  const btn = document.getElementById('bk-confirm-ok');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/backup/create', { method: 'POST', body: JSON.stringify({ password: pwd, mode: mode || 'data' }) });
    const kind = r.mode === 'migrate' ? '迁移包' : '备份';
    toast(kind + '已生成' + (r.encrypted ? '（已加密）' : '') + '：' + r.file, 'success');
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

function fmtNextRun(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function loadAutoBackup() {
  try {
    const r = await api('/api/admin/backup/auto');
    const c = r.data || {};
    document.getElementById('ab-enabled').checked = !!c.enabled;
    document.getElementById('ab-period').value = c.period || 'daily';
    document.getElementById('ab-pwd').value = ''; // 出于安全不回显密码
    document.getElementById('ab-advanced').style.display = c.enabled ? '' : 'none';
    const info = document.getElementById('ab-info');
    if (c.enabled) {
      let txt = '已启用自动备份（' + ({ daily: '每天', weekly: '每星期', monthly: '每月' }[c.period] || c.period) + (c.password ? '，已加密' : '，未加密') + '）';
      if (c.lastRun) txt += '；上次执行：' + fmtTime(c.lastRun);
      if (c.nextRun) txt += '；下次执行：' + fmtNextRun(c.nextRun);
      info.textContent = txt;
    } else {
      info.textContent = '自动备份未启用';
    }
  } catch (e) {
    toast('读取自动备份设置失败：' + e.message, 'error');
  }
}

async function saveAutoBackup() {
  const btn = document.getElementById('ab-save');
  btn.disabled = true;
  try {
    const r = await api('/api/admin/backup/auto', {
      method: 'POST',
      body: JSON.stringify({
        enabled: document.getElementById('ab-enabled').checked,
        period: document.getElementById('ab-period').value,
        password: document.getElementById('ab-pwd').value
      })
    });
    toast(r.message || '已保存', 'success');
    loadAutoBackup();
    closeModal('auto-backup-modal');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function initBackup() {
  const crumb = document.getElementById('crumb');
  if (crumb) crumb.innerHTML = '<a href="index.html">控制台</a> / 备份恢复';

  loadBackupList();
  loadAutoBackup();

  // 点击遮罩 / × / 取消 关闭所有模态框
  document.querySelectorAll('.modal-mask').forEach(m => {
    m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
    m.querySelectorAll('[data-close]').forEach(x => x.addEventListener('click', () => closeModal(x.dataset.close)));
  });

  // 数据备份：弹模态框确认（含密码与加密提示）
  document.getElementById('btn-create').addEventListener('click', () => {
    document.getElementById('bk-confirm-title').textContent = '生成数据备份';
    document.getElementById('bk-confirm-pwd-label').textContent = '备份密码（可选）';
    const pwdEl = document.getElementById('bk-pwd');
    pwdEl.value = '';
    const warn = document.getElementById('bk-confirm-warn');
    warn.innerHTML = '仅备份后台数据（不含上传图片）。<br>请设置备份密码（可选）。<br><strong>若设置密码，备份将使用密码加密，请牢记该密码（忘记将无法恢复）。</strong><br>留空则备份文件不加密，任何拿到文件的人都能直接恢复。';
    openModal('bk-confirm-modal');
    document.getElementById('bk-confirm-ok').onclick = () => createBackup(pwdEl.value, 'data');
  });

  // 打包迁移：弹模态框确认（含密码与加密提示）
  document.getElementById('btn-migrate').addEventListener('click', () => {
    document.getElementById('bk-confirm-title').textContent = '生成迁移包';
    document.getElementById('bk-confirm-pwd-label').textContent = '迁移包密码（可选，加密 zip）';
    const pwdEl = document.getElementById('bk-pwd');
    pwdEl.value = '';
    const warn = document.getElementById('bk-confirm-warn');
    warn.innerHTML = '将打包：数据备份(.bin) + 全部上传图片（车辆照片 + 识别抓拍快照）。<br>请设置迁移包密码（可选）。<br><strong>若设置密码，zip 将使用密码加密；忘记密码无法解包。</strong><br>新机用 install.sh 部署系统后，将 zip 内图片与 backup.bin 拷回即可完成迁移。';
    openModal('bk-confirm-modal');
    document.getElementById('bk-confirm-ok').onclick = () => createBackup(pwdEl.value, 'migrate');
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

  // 自动备份设置：打开模态框；启用开关联动显示周期/密码
  const btnAutoBackup = document.getElementById('btn-auto-backup');
  if (btnAutoBackup) btnAutoBackup.addEventListener('click', () => { openModal('auto-backup-modal'); });
  const abEnabled = document.getElementById('ab-enabled');
  if (abEnabled) abEnabled.addEventListener('change', () => {
    document.getElementById('ab-advanced').style.display = abEnabled.checked ? '' : 'none';
  });

  // 历史备份操作（底部面板）：下载 / 恢复 / 删除
  const onHistoryClick = async (ev) => {
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
  };
  const tbody = document.getElementById('bk-tbody');
  if (tbody) tbody.addEventListener('click', onHistoryClick);

  // 自动备份设置保存
  document.getElementById('ab-save').addEventListener('click', saveAutoBackup);
}
