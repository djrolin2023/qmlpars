// OCR 配置（百度 / 腾讯）
const OCR_KEYS = ['BAIDU_API_KEY', 'BAIDU_SECRET_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY'];
let ocrOriginals = {};   // 已填写的原始值（脱敏后），用于"留空不修改"

async function initOcr() {
  await loadOcrSettings();
  document.getElementById('save-btn').onclick = saveOcrSettings;
}

// 读取已填写的 KEY 并回显（脱敏值），未填写的留空
async function loadOcrSettings() {
  try {
    const r = await api('/api/admin/settings');
    if (!r.success) throw new Error(r.message || '读取配置失败');
    const list = r.data || [];
    OCR_KEYS.forEach(key => {
      const f = list.find(x => x.key === key);
      const val = f ? (f.value || '') : '';
      ocrOriginals[key] = val;
      const input = document.getElementById(key);
      if (input) {
        input.value = val;
        input.placeholder = val ? '已配置，留空表示不修改' : '未配置，请输入';
      }
    });
  } catch (e) {
    toast('读取配置失败：' + e.message);
  }
}

async function saveOcrSettings() {
  const body = {};
  let changed = false;
  OCR_KEYS.forEach(key => {
    const input = document.getElementById(key);
    if (!input) return;
    let v = input.value.trim();
    // 未修改（仍是脱敏值）或留空 → 不传，后端保留原值
    if (v === ocrOriginals[key]) v = '';
    body[key] = v;
    if (v) changed = true;
  });
  const btn = document.getElementById('save-btn');
  btn.disabled = true; btn.textContent = '保存中…';
  try {
    const r = await api('/api/admin/settings', { method: 'POST', body: JSON.stringify(body) });
    if (!r.success) throw new Error(r.message || '保存失败');
    toast(r.message || '保存成功');
    await loadOcrSettings();
  } catch (e) {
    toast('保存失败：' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = '保存配置';
  }
}
