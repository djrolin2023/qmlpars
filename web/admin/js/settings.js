// 系统设置：站点信息 + 备案信息 + 站点图片 + 修改密码
const SITE_KEYS = ['COMPANY_NAME'];
const ICP_KEYS = ['ICP_NO', 'POLICE_NO'];
const INFO_KEYS = [...SITE_KEYS, ...ICP_KEYS];

function initSettings() {
  loadInfo();
  loadImgGrid();
  initImgGrid();

  document.getElementById('save-site').onclick = saveSite;
  document.getElementById('save-info').onclick = saveInfo;
  document.getElementById('save-img').onclick = saveImg;
}

// ---------- 站点信息 + 备案信息 ----------
async function loadInfo() {
  try {
    const r = await api('/api/admin/settings');
    if (!r.success) throw new Error(r.message || '读取失败');
    const list = r.data || [];
    INFO_KEYS.forEach(key => {
      const f = list.find(x => x.key === key);
      const input = document.getElementById(key);
      if (input && f) input.value = f.value || '';
    });
  } catch (e) { toast('读取设置失败：' + e.message); }
}

async function saveSite() {
  await saveKeys(SITE_KEYS, 'save-site', '保存站点信息');
}

async function saveInfo() {
  await saveKeys(ICP_KEYS, 'save-info', '保存备案信息');
}

async function saveKeys(keys, btnId, btnText) {
  const body = {};
  keys.forEach(key => {
    const input = document.getElementById(key);
    if (input) body[key] = input.value.trim();
  });
  const btn = document.getElementById(btnId);
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) });
    if (!r.success) throw new Error(r.message || '保存失败');
    toast(r.message || '保存成功');
    await loadInfo(); // 保存后重新回填，确保各面板显示一致
  } catch (e) {
    toast('保存失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = btnText;
  }
}

// ---------- 站点图片（photo-box：点击/拖拽/粘贴 → 立即上传） ----------
function initImgGrid() {
  document.querySelectorAll('.set-card').forEach(card => {
    const box = card.querySelector('.photo-box');
    const file = card.querySelector('[data-file]');
    const done = card.querySelector('[data-done]');
    box.addEventListener('click', () => { if (done.style.display === 'none') file.click(); });
    file.onchange = () => { if (file.files && file.files[0]) uploadImg(card, file.files[0]); file.value = ''; };
    ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, e => { e.preventDefault(); box.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(ev => box.addEventListener(ev, e => { e.preventDefault(); box.classList.remove('drag'); }));
    box.addEventListener('drop', e => {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) uploadImg(card, f);
    });
    card.querySelector('[data-remove]').onclick = e => {
      e.stopPropagation();
      card.querySelector('[data-key]').value = '';
      setImgState(card, 'empty');
    };
  });
  // 粘贴上传
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    for (const it of items || []) {
      if (it.type.indexOf('image/') === 0) {
        const card = document.querySelector('.set-card .photo-box:hover') && document.querySelector('.set-card .photo-box:hover').closest('.set-card');
        if (card) { uploadImg(card, it.getAsFile()); break; }
      }
    }
  });
}

async function loadImgGrid() {
  try {
    const r = await api('/api/admin/settings');
    if (!r.success) throw new Error(r.message || '读取失败');
    const list = r.data || [];
    document.querySelectorAll('.set-card').forEach(card => {
      const key = card.querySelector('[data-key]').getAttribute('data-key');
      const f = list.find(x => x.key === key);
      const val = f ? (f.value || '') : '';
      card.querySelector('[data-key]').value = val;
      if (val) setImgState(card, 'done', absUrl(val));
      else setImgState(card, 'empty');
    });
  } catch (e) { toast('读取图片设置失败：' + e.message); }
}

function setImgState(card, state, url) {
  card.querySelector('[data-empty]').style.display = state === 'empty' ? '' : 'none';
  card.querySelector('[data-loading]').style.display = state === 'loading' ? '' : 'none';
  card.querySelector('[data-done]').style.display = state === 'done' ? '' : 'none';
  if (state === 'done' && url) card.querySelector('[data-img]').src = url;
}

async function uploadImg(card, f) {
  if (!f || f.type.indexOf('image/') !== 0) { toast('请选择图片文件'); return; }
  const fd = new FormData();
  fd.append('image', f);
  setImgState(card, 'loading');
  try {
    const r = await api('/api/admin/upload', { method: 'POST', body: fd, noJson: true });
    if (!r.success) throw new Error(r.message || '上传失败');
    card.querySelector('[data-key]').value = r.url;
    setImgState(card, 'done', absUrl(r.url));
  } catch (e) {
    setImgState(card, 'empty');
    toast('上传失败：' + e.message);
  }
}

async function saveImg() {
  const body = {};
  document.querySelectorAll('.set-card').forEach(card => {
    const key = card.querySelector('[data-key]').getAttribute('data-key');
    body[key] = card.querySelector('[data-key]').value.trim();
  });
  const btn = document.getElementById('save-img');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) });
    if (!r.success) throw new Error(r.message || '保存失败');
    toast(r.message || '保存成功');
  } catch (e) {
    toast('保存失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '保存图片设置';
  }
}

// ---------- 部门管理 ----------
function absUrl(u) {
  if (!u) return u;
  if (/^https?:\/\//.test(u)) return u;
  return location.origin + (u.charAt(0) === '/' ? u : '/' + u);
}
