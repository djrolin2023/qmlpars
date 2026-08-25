function initSettings() {
  const API = '/api/admin/settings'
  const toast = window.toast || ((m) => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2000) })

  // 字段分类（与后端 SETTING_FIELDS 对应）
  const GROUPS = {
    site: ['COMPANY_NAME'],
    icp: ['ICP_NO', 'POLICE_NO'],
    img: ['LOGO_URL', 'LOGO_ICON_URL', 'LOGO_HORIZONTAL_URL', 'LOGO_VERTICAL_URL'],
    ocr: ['BAIDU_API_KEY', 'BAIDU_SECRET_KEY', 'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY',
          'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_REGION',
          'HUAWEI_AK', 'HUAWEI_SK', 'HUAWEI_PROJECT_ID', 'HUAWEI_REGION',
          'CUSTOM_OCR_URL', 'CUSTOM_OCR_METHOD', 'CUSTOM_OCR_HEADERS', 'CUSTOM_OCR_BODY_TEMPLATE', 'CUSTOM_OCR_PLATE_FIELD', 'CUSTOM_OCR_CONFIDENCE_FIELD', 'CUSTOM_OCR_COLOR_FIELD']
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
    TENCENT_SECRET_KEY: '腾讯云 SecretKey',
    ALIYUN_ACCESS_KEY_ID: '阿里云 AccessKeyId',
    ALIYUN_ACCESS_KEY_SECRET: '阿里云 AccessKeySecret',
    ALIYUN_REGION: '阿里云 Region',
    HUAWEI_AK: '华为云 Ak',
    HUAWEI_SK: '华为云 Sk',
    HUAWEI_PROJECT_ID: '华为云 ProjectId',
    HUAWEI_REGION: '华为云 Region',
    CUSTOM_OCR_URL: '自定义 OCR 接口 URL',
    CUSTOM_OCR_METHOD: '自定义 OCR 请求方法',
    CUSTOM_OCR_HEADERS: '自定义 OCR 请求头（JSON）',
    CUSTOM_OCR_BODY_TEMPLATE: '自定义 OCR 请求体模板',
    CUSTOM_OCR_PLATE_FIELD: '自定义 OCR 车牌字段',
    CUSTOM_OCR_CONFIDENCE_FIELD: '自定义 OCR 置信度字段',
    CUSTOM_OCR_COLOR_FIELD: '自定义 OCR 颜色字段'
  }
  const PLACEHOLDERS = {
    COMPANY_NAME: '如：乾明车牌识别系统 / XX公司',
    ICP_NO: '如：粤ICP备XXXXXXXX号',
    POLICE_NO: '如：粤公网安备XXXXXXXX号',
    POLICE_URL: 'https://beian.mps.gov.cn/#/query/webSearch',
    BAIDU_API_KEY: '百度智能云 OCR 应用的 API Key',
    BAIDU_SECRET_KEY: '百度智能云 OCR 应用的 Secret Key',
    TENCENT_SECRET_ID: '腾讯云账号 SecretId',
    TENCENT_SECRET_KEY: '腾讯云账号 SecretKey',
    ALIYUN_ACCESS_KEY_ID: '阿里云 AccessKeyId',
    ALIYUN_ACCESS_KEY_SECRET: '阿里云 AccessKeySecret',
    ALIYUN_REGION: 'cn-shanghai',
    HUAWEI_AK: '华为云 Ak',
    HUAWEI_SK: '华为云 Sk',
    HUAWEI_PROJECT_ID: '华为云 ProjectId',
    HUAWEI_REGION: 'cn-north-4',
    CUSTOM_OCR_URL: 'https://your-api.com/recognize',
    CUSTOM_OCR_METHOD: 'POST',
    CUSTOM_OCR_HEADERS: '{"Authorization":"Bearer xxx"}',
    CUSTOM_OCR_BODY_TEMPLATE: '{"image":"{{base64}}"}',
    CUSTOM_OCR_PLATE_FIELD: 'plateNo',
    CUSTOM_OCR_CONFIDENCE_FIELD: 'confidence',
    CUSTOM_OCR_COLOR_FIELD: 'color'
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
    const isLong = /_BODY_TEMPLATE$|_HEADERS$/.test(key)
    const input = isLong
      ? `<textarea data-key="${key}" rows="3" placeholder="${ph}">${escapeAttr(s.value)}</textarea>`
      : `<input type="text" data-key="${key}" value="${escapeAttr(s.value)}" placeholder="${ph}">`
    return `<div class="form-row">
      <label>${label}</label>
      ${input}
      ${hint}
    </div>`
  }

  function renderAll() {
    document.getElementById('site-fields').innerHTML = GROUPS.site.map(fieldHtml).join('')
    document.getElementById('icp-fields').innerHTML = GROUPS.icp.map(fieldHtml).join('')
    renderOcrCards()
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
      const el = document.querySelector(`input[data-key="${key}"], textarea[data-key="${key}"]`)
      let v = el ? el.value.trim() : ''
      // secret 字段：值未变动（仍是后端返回的脱敏值）或留空 → 不提交，保留原值
      const s = store[key]
      if (s && s.secret && (v === s.value || v === '')) v = ''
      obj[key] = v
    }
    return obj
  }

  // OCR 通道定义（卡片式，独立保存）
  const OCR_CHANNELS = [
    {
      id: 'baidu', name: '百度 OCR', badge: '主通道', badgeCls: 'green',
      keys: ['BAIDU_API_KEY', 'BAIDU_SECRET_KEY'],
      tut: '<ol><li>登录 <a href="https://console.bce.baidu.com/" target="_blank" rel="noopener">百度智能云控制台</a> → 进入「文字识别」产品页。</li><li>在「应用列表」中<strong>创建应用</strong>（勾选「车牌识别」），获得 <code>API Key</code> 与 <code>Secret Key</code>。</li><li>将两值粘贴保存即可，系统自动启用。</li></ol>'
    },
    {
      id: 'tencent', name: '腾讯 OCR', badge: '备用', badgeCls: 'green',
      keys: ['TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION'],
      tut: '<ol><li>登录 <a href="https://console.cloud.tencent.com/ocr" target="_blank" rel="noopener">腾讯云控制台</a> → 进入「文字识别 OCR」。</li><li>在「访问管理 → API 密钥管理」获取 <code>SecretId</code> 与 <code>SecretKey</code>。</li><li>粘贴保存后自动作为百度通道的备用。</li></ol>'
    },
    {
      id: 'aliyun', name: '阿里云 OCR', badge: '官方', badgeCls: 'blue',
      keys: ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_REGION'],
      tut: '<ol><li>登录 <a href="https://usercenter.console.aliyun.com/" target="_blank" rel="noopener">阿里云控制台</a> → 「访问控制 → 创建 AccessKey」获取 <code>AccessKeyId</code> 与 <code>AccessKeySecret</code>。</li><li>在「视觉智能开放平台」开通「文字识别 → 车牌识别」服务。</li><li>Region 默认 <code>cn-shanghai</code>，其他地域（如 cn-shenzhen）可改。</li></ol>'
    },
    {
      id: 'huawei', name: '华为云 OCR', badge: '官方', badgeCls: 'blue',
      keys: ['HUAWEI_AK', 'HUAWEI_SK', 'HUAWEI_PROJECT_ID', 'HUAWEI_REGION'],
      tut: '<ol><li>登录 <a href="https://console.huaweicloud.com/ocr" target="_blank" rel="noopener">华为云控制台</a> → 获取 <code>Ak</code> 与 <code>Sk</code>（我的凭证 → 访问密钥）。</li><li>在「我的凭证 → 项目」获取对应 Region 的 <code>ProjectId</code>。</li><li>Region 默认 <code>cn-north-4</code>（北京四）。</li></ol>'
    },
    {
      id: 'custom', name: '自定义 OCR', badge: '高级', badgeCls: 'purple',
      keys: ['CUSTOM_OCR_URL', 'CUSTOM_OCR_METHOD', 'CUSTOM_OCR_HEADERS', 'CUSTOM_OCR_BODY_TEMPLATE', 'CUSTOM_OCR_PLATE_FIELD', 'CUSTOM_OCR_CONFIDENCE_FIELD', 'CUSTOM_OCR_COLOR_FIELD'],
      tut: '<ol><li>对接自有车牌识别接口：填接口 URL、请求方法、请求头（JSON）。</li><li>请求体模板用 <code>{{base64}}</code> 占位图片 Base64；<code>{{url}}</code> 占位图片 URL。</li><li>分别填写返回结果中的车牌字段、置信度字段、颜色字段名（如 <code>plateNo</code> / <code>confidence</code> / <code>color</code>）。</li></ol>'
    }
  ]

  function ocrCardFieldHtml(key) {
    const s = store[key] || { value: '', secret: false }
    const label = LABELS[key] || key
    const ph = PLACEHOLDERS[key] || ''
    const isLong = /_BODY_TEMPLATE$|_HEADERS$/.test(key)
    const input = isLong
      ? `<textarea data-key="${key}" rows="3" placeholder="${ph}">${escapeAttr(s.value)}</textarea>`
      : `<input type="text" data-key="${key}" value="${escapeAttr(s.value)}" placeholder="${ph}">`
    const hint = s.secret ? '<div class="hint">留空则不修改</div>' : ''
    return `<div class="ocr-field">
      <label>${label}</label>
      ${input}
      ${hint}
    </div>`
  }

  function renderOcrCards() {
    const wrap = document.getElementById('ocr-cards')
    wrap.innerHTML = OCR_CHANNELS.map(ch => {
      const fields = ch.keys.map(ocrCardFieldHtml).join('')
      return `<div class="ocr-card" data-ch="${ch.id}">
        <div class="ocr-card-head">
          <span class="ocr-card-title">${ch.name}</span>
          <span class="badge ${ch.badgeCls}">${ch.badge}</span>
          <button type="button" class="ocr-tut-btn" data-tut="${ch.id}" title="查看配置教程">?</button>
        </div>
        <div class="ocr-card-body">${fields}</div>
        <div class="ocr-card-foot">
          <button type="button" class="btn primary ocr-save" data-save="${ch.id}">保存此通道</button>
        </div>
      </div>`
    }).join('')

    // 教程按钮
    wrap.querySelectorAll('.ocr-tut-btn').forEach(b => {
      b.addEventListener('click', () => openOcrTut(b.getAttribute('data-tut')))
    })
    // 保存按钮
    wrap.querySelectorAll('.ocr-save').forEach(b => {
      b.addEventListener('click', () => {
        const ch = OCR_CHANNELS.find(c => c.id === b.getAttribute('data-save'))
        saveOcrChannel(ch, b)
      })
    })
  }

  async function saveOcrChannel(ch, btn) {
    const old = btn.textContent; btn.disabled = true; btn.textContent = '保存中…'
    try {
      const obj = collect(ch.keys)
      const r = await api(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) })
      if (!r.success) throw new Error(r.message || '保存失败')
      toast((ch.name) + ' 已保存')
      await load() // 重新拉取，刷新脱敏值
    } catch (e) {
      toast(e.message)
    } finally { btn.disabled = false; btn.textContent = old }
  }

  // OCR 教程模态框
  const tutModal = document.getElementById('ocr-tut-modal')
  function openOcrTut(id) {
    const ch = OCR_CHANNELS.find(c => c.id === id)
    if (!ch) return
    document.getElementById('ocr-tut-title').textContent = ch.name + ' 配置教程'
    document.getElementById('ocr-tut-body').innerHTML = ch.tut
    tutModal.classList.add('show')
  }
  function closeOcrTut() { tutModal.classList.remove('show') }
  document.getElementById('ocr-tut-close').onclick = closeOcrTut
  document.getElementById('ocr-tut-ok').onclick = closeOcrTut
  tutModal.addEventListener('click', e => { if (e.target === tutModal) closeOcrTut() })


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
