// ===== 系统在线升级（公共模块，所有后台页统一引入） =====
// 职责：
//   1) 在侧边栏注入版本号节点（若页面已有则复用）
//   2) 注入升级模态框（若页面已有则复用）
//   3) 读取/显示版本号、手动检查、自动检测调度、设置持久化、执行升级
// 后端接口：GET /api/admin/upgrade/check  POST /api/admin/upgrade/do  GET /version.json

(function () {
  // ---------------- 动态注入 DOM ----------------
  function injectVersionNode() {
    if (document.getElementById('version-info')) return
    const sidebar = document.querySelector('.app-shell .sidebar') || document.querySelector('.sidebar')
    if (!sidebar) return
    const wrap = document.createElement('div')
    wrap.className = 'side-version'
    wrap.innerHTML =
      '<a href="javascript:void(0)" id="version-info" title="点击检查更新">版本号：加载中…</a>' +
      '<span class="update-dot" id="update-dot" style="display:none" title="有可用更新">● 可升级</span>'
    sidebar.appendChild(wrap)
  }

  const MODAL_HTML = `
  <div class="modal-mask" id="upgrade-modal">
    <div class="modal">
      <div class="modal-head"><span>版本更新</span><span class="x" data-close="upgrade-modal">×</span></div>
      <div class="modal-body">
        <div class="up-row"><span class="up-label">当前版本</span><span id="up-current" class="up-val">—</span></div>
        <div id="upgrade-loading" class="hint" style="display:none;padding:6px 0">正在检查更新…</div>
        <div class="warn" id="upgrade-tip" style="display:none;margin-bottom:10px">检测到可用更新。<strong>升级前建议先到「备份恢复」导出数据备份</strong>（系统也会自动生成数据库快照兜底）。升级会拉取最新代码并重启服务。</div>
        <div id="upgrade-result" style="display:none">
          <div class="up-row"><span class="up-label">最新版本</span><span id="up-latest" class="up-val">—</span></div>
          <div class="up-row" id="up-remote-row" style="display:none"><span class="up-label">更新来源</span><span id="up-remote" class="up-val">—</span></div>
          <div class="up-notes" id="up-notes"></div>
        </div>
        <div id="upgrade-error" class="warn" style="display:none;margin-top:10px"></div>

        <div class="up-settings">
          <div class="up-set-row up-switch-row">
            <span>自动检查升级</span>
            <span class="up-switch-inline">
              <button class="btn" id="upgrade-check-btn">检查更新</button>
              <label class="up-switch">
                <input type="checkbox" id="up-auto-check">
                <span class="up-switch-track"><span class="up-switch-thumb"></span></span>
              </label>
            </span>
          </div>
          <div class="up-set-row" id="up-source-row">
            <span class="up-radio"><input type="radio" name="up-source" id="up-source-github" value="github" checked><label for="up-source-github">GitHub</label></span>
            <span class="up-radio"><input type="radio" name="up-source" id="up-source-gitee" value="gitee"><label for="up-source-gitee">Gitee</label></span>
          </div>
          <div class="up-set-row" id="up-freq-row">
            <span class="up-radio"><input type="radio" name="up-freq" id="up-freq-day" value="day"><label for="up-freq-day">每天</label></span>
            <span class="up-radio"><input type="radio" name="up-freq" id="up-freq-week" value="week" checked><label for="up-freq-week">每周</label></span>
            <span class="up-radio"><input type="radio" name="up-freq" id="up-freq-month" value="month"><label for="up-freq-month">每月</label></span>
          </div>
          <div class="up-set-row" id="up-mode-row">
            <span class="up-radio"><input type="radio" name="up-mode" id="up-mode-auto" value="auto"><label for="up-mode-auto">自动帮我安装</label></span>
            <span class="up-radio"><input type="radio" name="up-mode" id="up-mode-notify" value="notify" checked><label for="up-mode-notify">有新版本时提醒我</label></span>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close="upgrade-modal">关闭</button>
        <button class="btn primary" id="upgrade-btn" style="display:none">立即升级</button>
      </div>
    </div>
  </div>`

  function injectModal() {
    if (document.getElementById('upgrade-modal')) return
    const div = document.createElement('div')
    div.innerHTML = MODAL_HTML.trim()
    document.body.appendChild(div.firstElementChild)
  }

  // ---------------- 设置（localStorage） ----------------
  const UP_SETTING_KEY = 'qmlpars_upgrade_settings'
  function loadUpSettings() {
    try {
      const s = JSON.parse(localStorage.getItem(UP_SETTING_KEY) || '{}')
      return {
        autoCheck: !!s.autoCheck,
        mode: s.mode === 'auto' ? 'auto' : 'notify',
        freq: ['day', 'week', 'month'].includes(s.freq) ? s.freq : 'week',
        source: s.source === 'gitee' ? 'gitee' : 'github',
        lastCheckAt: s.lastCheckAt || 0
      }
    } catch (e) {
      return { autoCheck: false, mode: 'notify', freq: 'week', source: 'github', lastCheckAt: 0 }
    }
  }
  function saveUpSettings(s) { try { localStorage.setItem(UP_SETTING_KEY, JSON.stringify(s)) } catch (e) {} }

  // ---------------- 主初始化 ----------------
  function initUpgrade() {
    injectVersionNode()
    injectModal()

    const versionEl = document.getElementById('version-info')
    const updateDot = document.getElementById('update-dot')
    const upModal = document.getElementById('upgrade-modal')
    const upLoading = document.getElementById('upgrade-loading')
    const upResult = document.getElementById('upgrade-result')
    const upError = document.getElementById('upgrade-error')
    const upCurrent = document.getElementById('up-current')
    const upLatest = document.getElementById('up-latest')
    const upRemoteRow = document.getElementById('up-remote-row')
    const upRemote = document.getElementById('up-remote')
    const upNotes = document.getElementById('up-notes')
    const upBtn = document.getElementById('upgrade-btn')
    const upCheckBtn = document.getElementById('upgrade-check-btn')
    const upAutoEl = document.getElementById('up-auto-check')
    const upFreqRow = document.getElementById('up-freq-row')

    let upSet = loadUpSettings()

    function getSource() {
      const el = document.querySelector('input[name="up-source"]:checked')
      return el ? el.value : upSet.source
    }
    function renderUpSettings() {
      if (!upAutoEl) return
      upAutoEl.checked = upSet.autoCheck
      const f = document.getElementById('up-freq-' + upSet.freq); if (f) f.checked = true
      const m = document.getElementById('up-mode-' + upSet.mode); if (m) m.checked = true
      const sc = document.getElementById('up-source-' + upSet.source); if (sc) sc.checked = true
      upFreqRow.style.display = upSet.autoCheck ? 'flex' : 'none'
    }

    // 显示本地版本号
    function showLocalVersion() {
      if (!versionEl) return
      fetch(API + '/version.json', { cache: 'no-store' })
        .then(r => r.ok ? r.json() : null)
        .then(j => { if (j && j.version) versionEl.textContent = '版本号：' + j.version })
        .catch(() => { versionEl.textContent = '版本号：未知' })
    }
    showLocalVersion()

    // 检查更新
    async function runCheck(opts) {
      const showModal = !!(opts && opts.showModal)
      const fromAuto = !!(opts && opts.fromAuto)
      if (showModal) {
        upLoading.style.display = 'block'
        upResult.style.display = 'none'
        upError.style.display = 'none'
        upBtn.style.display = 'none'
      }
      try {
        const source = getSource()
        const r = await api('/api/admin/upgrade/check?source=' + encodeURIComponent(source))
        upSet.lastCheckAt = Date.now()
        saveUpSettings(upSet)
        if (showModal) {
          upLoading.style.display = 'none'
          upResult.style.display = 'block'
          upCurrent.textContent = r.current || '未知'
          upLatest.textContent = r.hasUpdate ? ('更新可用（落后 ' + (r.behind || 0) + ' 个提交）') : (r.current || '未知')
          upRemoteRow.style.display = r.remote ? 'flex' : 'none'
          upRemote.textContent = r.remote || '—'
          upNotes.textContent = r.notes || (r.hasUpdate ? '' : '已是最新版本')
          const tip = document.getElementById('upgrade-tip')
          if (tip) tip.style.display = r.hasUpdate ? 'block' : 'none'
          if (r.hasUpdate) upBtn.style.display = 'inline-block'
        }
        if (r.hasUpdate) {
          if (upSet.mode === 'auto' && fromAuto) {
            toast('检测到新版本，正在自动升级…', 'success')
            doUpgrade(false)
          } else {
            if (updateDot) updateDot.style.display = 'inline'
            if (versionEl) versionEl.classList.add('has-update')
          }
        } else {
          if (updateDot) updateDot.style.display = 'none'
          if (versionEl) versionEl.classList.remove('has-update')
        }
      } catch (e) {
        if (showModal) {
          upLoading.style.display = 'none'
          upError.style.display = 'block'
          upError.textContent = '检测失败：' + e.message
        } else {
          console.warn('[upgrade] 自动检查失败：', e.message)
        }
      }
    }

    // 执行升级
    async function doUpgrade(needConfirm) {
      if (needConfirm && !confirm('升级将从 GitHub / Gitee 拉取最新代码并重启服务。\n\n建议：升级前请先到「备份恢复」导出一份数据备份（系统也会自动生成数据库快照兜底）。\n\n确定继续升级？')) return
      upBtn.disabled = true
      const oldText = upBtn.textContent
      upBtn.textContent = '升级中…'
      try {
        const r = await api('/api/admin/upgrade/do', { method: 'POST', body: JSON.stringify({ source: getSource() }) })
        if (!r.success) throw new Error(r.message || '升级失败')
        toast(r.message || '升级成功', 'success')
        upModal.classList.remove('show')
        setTimeout(() => { location.replace('login.html') }, 4000)
      } catch (e) {
        upBtn.disabled = false
        upBtn.textContent = oldText
        upError.style.display = 'block'
        upError.textContent = e.message
      }
    }

    // 打开模态框（不自动检测）
    function openUpgradeModal() {
      showLocalVersion()
      upResult.style.display = 'none'
      upLoading.style.display = 'none'
      upError.style.display = 'none'
      upBtn.style.display = 'none'
      upBtn.disabled = false
      upBtn.textContent = '立即升级'
      renderUpSettings()
      upModal.classList.add('show')
    }

    // 事件绑定
    if (versionEl) versionEl.addEventListener('click', openUpgradeModal)
    if (upCheckBtn) upCheckBtn.addEventListener('click', () => runCheck({ showModal: true, fromAuto: false }))
    if (upBtn) upBtn.addEventListener('click', () => doUpgrade(true))

    // 通用关闭（× / 取消 / 遮罩）
    document.querySelectorAll('#upgrade-modal [data-close]').forEach(el => {
      el.addEventListener('click', () => {
        const m = document.getElementById(el.getAttribute('data-close'))
        if (m) m.classList.remove('show')
      })
    })
    upModal.addEventListener('click', e => { if (e.target === upModal) upModal.classList.remove('show') })

    // 设置事件
    if (upAutoEl) upAutoEl.addEventListener('change', () => {
      upSet.autoCheck = upAutoEl.checked
      upFreqRow.style.display = upSet.autoCheck ? 'flex' : 'none'
      saveUpSettings(upSet)
      scheduleNext()
    })
    document.querySelectorAll('input[name="up-freq"]').forEach(el => el.addEventListener('change', () => {
      upSet.freq = el.value; saveUpSettings(upSet); scheduleNext()
    }))
    document.querySelectorAll('input[name="up-mode"]').forEach(el => el.addEventListener('change', () => {
      upSet.mode = el.value; saveUpSettings(upSet)
    }))
    document.querySelectorAll('input[name="up-source"]').forEach(el => el.addEventListener('change', () => {
      upSet.source = el.value; saveUpSettings(upSet)
    }))

    // 定时调度
    let upTimer = null
    function freqMs() { return { day: 86400000, week: 604800000, month: 2592000000 }[upSet.freq] || 604800000 }
    function scheduleNext() {
      if (upTimer) { clearTimeout(upTimer); upTimer = null }
      if (!upSet.autoCheck) return
      const since = Date.now() - (upSet.lastCheckAt || 0)
      const wait = Math.max(60000, freqMs() - since)
      upTimer = setTimeout(() => { runCheck({ fromAuto: true }).finally(scheduleNext) }, wait)
    }
    renderUpSettings()
    scheduleNext()
  }

  // DOM 就绪后初始化（页面已引入 common.js，api/toast 全局可用）
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUpgrade)
  } else {
    initUpgrade()
  }
})()
