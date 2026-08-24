function initSettings() {
  const API = '/api/admin/settings'
  const toast = window.toast || ((m) => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000) })

  // 字段分类（与后端 SETTING_FIELDS 对应）
  const GROUPS = {
    site: ['COMPANY_NAME'],
    icp: ['ICP_NO', 'POLICE_NO'],
    img: ['LOGO_URL', 'LOGO_ICON_URL', 'LOGO_HORIZONTAL_URL', 'LOGO_VERTICAL_URL'],
    ocr: ['BAIDU_API_KEY', 'BAIDU_SECRET_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY']
  }
  const LABELS = {
    COMPANY_NAME: '公司名称',
    ICP_NO: 'ICP 备案号',
    POLICE_NO: '公安备案号',
    POLICE_URL: '公安备案链接',
    LOGO_URL: '站点 LOGO',
    LOGO_ICON_URL: 'LOGO-纯图标（菜单/页脚）',
    LOGO_HORIZONTAL_URL: 'LOGO-横版（图标+公司名）',
    LOGO_VERTICAL_URL: 'LOGO-竖版（图标在上+公司名）',
    BAIDU_API_KEY: '百度 OCR API Key',
    BAIDU_SECRET_KEY: '百度 OCR Secret Key',
    TENCENT_SECRET_ID: '腾讯云 SecretId',
    TENCENT_SECRET_KEY: '腾讯云 SecretKey'
  }
  const PLACEHOLDERS = {
    COMPANY_NAME: '如：乾明车牌识别系统 / XX公司',
    ICP_NO: '如：粤ICP备XXXXXXXX号',
    POLICE_NO: '如：粤公网安备XXXXXXXX号',
    POLICE_URL: 'https://beian.mps.gov.cn/#/query/webSearch',
    BAIDU_API_KEY: '百度智能云 OCR 应用的 API Key',
    BAIDU_SECRET_KEY: '百度智能云 OCR 应用的 Secret Key',
    TENCENT_SECRET_ID: '腾讯云账号 SecretId',
    TENCENT_SECRET_KEY: '腾讯云账号 SecretKey'
  }
  const allKeys = [...GROUPS.site, ...GROUPS.icp, ...GROUPS.img, ...GROUPS.ocr]
  const store = {} // key -> {value, secret, image}

  let uploaded = {} // image key -> 已上传的 url（pending）

  async function load() {
    const j = await api(API)
    if (!j.success) return
    for (const f of (j.data || [])) {
      store[f.key] = { value: f.value || '', secret: !!f.secret, image: !!f.image }
    }
    renderAll()
  }

  function fieldHtml(key) {
    const s = store[key] || { value: '', secret: false }
    const label = LABELS[key] || key
    const ph = PLACEHOLDERS[key] || ''
    const hint = s.secret ? '<div class="hint">留空则不修改</div>' : ''
    return `<div class="form-row">
      <label>${label}</label>
      <input type="text" data-key="${key}" value="${escapeAttr(s.value)}" placeholder="${ph}">
      ${hint}
    </div>`
  }

  function renderAll() {
    document.getElementById('site-fields').innerHTML = GROUPS.site.map(fieldHtml).join('')
    document.getElementById('icp-fields').innerHTML = GROUPS.icp.map(fieldHtml).join('')
    document.getElementById('ocr-fields').innerHTML = GROUPS.ocr.map(fieldHtml).join('')
    renderImg()
    renderFooter()
  }

  function renderImg() {
    const grid = document.getElementById('img-grid')
    grid.innerHTML = GROUPS.img.map(key => {
      const cur = uploaded[key] !== undefined ? uploaded[key] : (store[key] ? store[key].value : '')
      const body = cur
        ? `<div class="photo-done"><img src="${cur}" alt=""><button class="photo-remove" data-rm="${key}">×</button></div>`
        : `<div class="photo-placeholder">点击 / 拖拽 / 粘贴上传</div>`
      return `<div class="set-card">
        <div class="card-title">${LABELS[key] || key}</div>
        <div class="photo-box" data-img="${key}">${body}</div>
        <div class="img-key">${cur || '未设置'}</div>
      </div>`
    }).join('')
    grid.querySelectorAll('.photo-box').forEach(box => {
      const key = box.getAttribute('data-img')
      box.addEventListener('click', () => pickImage(key))
      box.addEventListener('dragover', e => { e.preventDefault(); box.classList.add('drag') })
      box.addEventListener('dragleave', () => box.classList.remove('drag'))
      box.addEventListener('drop', e => {
        e.preventDefault(); box.classList.remove('drag')
        const f = e.dataTransfer.files && e.dataTransfer.files[0]
        if (f) uploadImage(key, f)
      })
    })
    grid.querySelectorAll('.photo-remove').forEach(b => {
      b.addEventListener('click', e => {
        e.stopPropagation()
        const key = b.getAttribute('data-rm')
        uploaded[key] = ''
        renderImg()
      })
    })
  }

  function pickImage(key) {
    const inp = document.createElement('input')
    inp.type = 'file'; inp.accept = 'image/*'
    inp.onchange = () => { if (inp.files[0]) uploadImage(key, inp.files[0]) }
    inp.click()
  }

  async function uploadImage(key, file) {
    const box = document.querySelector(`.photo-box[data-img="${key}"]`)
    if (box) box.innerHTML = '<div class="photo-loading">上传中…</div>'
    const fd = new FormData()
    fd.append('image', file)
    try {
      const r = await api('/api/admin/upload', { method: 'POST', body: fd, noJson: true })
      if (!r.success) throw new Error(r.message || '上传失败')
      uploaded[key] = r.url
      renderImg()
    } catch (e) {
      toast('上传失败：' + e.message)
      renderImg()
    }
  }

  function renderFooter() {
    const cn = store.COMPANY_NAME ? store.COMPANY_NAME.value : ''
    const foot = document.getElementById('site-footer-text')
    foot.style.cssText = 'margin-top:26px;color:#64748b;font-size:12px;text-align:center'
    foot.innerHTML = (cn ? cn : '')
  }

  function collect(keys) {
    const obj = {}
    for (const key of keys) {
      const el = document.querySelector(`input[data-key="${key}"]`)
      obj[key] = el ? el.value.trim() : ''
    }
    return obj
  }

  async function saveGroup(keys, btnId, msg) {
    const btn = document.getElementById(btnId)
    const old = btn.textContent; btn.disabled = true; btn.textContent = '保存中…'
    try {
      const obj = collect(keys)
      const r = await api(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
      if (!r.success) throw new Error(r.message || '保存失败')
      toast(msg || '已保存')
      await load()
    } catch (e) {
      toast(e.message)
    } finally { btn.disabled = false; btn.textContent = old }
  }

  document.getElementById('save-site').onclick = () => saveGroup(GROUPS.site, 'save-site', '站点信息已保存')
  document.getElementById('save-info').onclick = () => saveGroup(GROUPS.icp, 'save-info', '备案信息已保存')
  document.getElementById('save-ocr').onclick = () => saveGroup(GROUPS.ocr, 'save-ocr', 'OCR 配置已保存')
  document.getElementById('save-img').onclick = async () => {
    const btn = document.getElementById('save-img'); const old = btn.textContent; btn.disabled = true; btn.textContent = '保存中…'
    try {
      const obj = {}
      for (const key of GROUPS.img) obj[key] = uploaded[key] !== undefined ? uploaded[key] : (store[key] ? store[key].value : '')
      const r = await api(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
      if (!r.success) throw new Error(r.message || '保存失败')
      toast('图片设置已保存')
      await load()
    } catch (e) { toast(e.message) } finally { btn.disabled = false; btn.textContent = old }
  }
  // 左侧导航切换
  const nav = document.getElementById('set-nav')
  nav.addEventListener('click', e => {
    const item = e.target.closest('.nav-item')
    if (!item) return
    const tab = item.getAttribute('data-tab')
    nav.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'))
    item.classList.add('active')
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.getAttribute('data-panel') === tab))
  })

  load()
}

function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
