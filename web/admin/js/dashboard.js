// ===== 数据大屏 =====
async function initDashboard() {
  try {
    const data = await api('/api/admin/stats');
    const d = data.data || {};
    document.getElementById('s-vehicles').textContent = d.vehicleTotal || 0;
    document.getElementById('s-today').textContent = d.todayTotal || 0;
    document.getElementById('s-internal').textContent = d.internalTotal || 0;
    document.getElementById('s-external').textContent = d.externalTotal || 0;
    document.getElementById('s-long').textContent = d.longTermTotal || 0;
    document.getElementById('s-temp').textContent = d.tempTotal || 0;
    document.getElementById('s-expired').textContent = d.expiredTotal || 0;

    // 趋势柱状图
    const trend = d.trend || [];
    const max = Math.max(1, ...trend.map(t => t.count));
    document.getElementById('trend').innerHTML = trend.map(t =>
      '<div class="bar-col"><div class="v">' + t.count + '</div>' +
      '<div class="bar" style="height:' + Math.round(t.count / max * 100) + '%"></div>' +
      '<div class="d">' + t.date + '</div></div>'
    ).join('');

    // 渠道占比（APP / H5）—— SVG 环形饼图
    const appN = d.appTotal || 0, webN = d.webTotal || 0, total = appN + webN;
    document.getElementById('channel').innerHTML = renderChannelPie(appN, webN, total);

    function renderChannelPie(appN, webN, total) {
      // 比例都为0时给一个空环占位，避免除零 + 让大屏不空荡
      const size = 180, cx = size / 2, cy = size / 2, r = 64, stroke = 22;
      const C = 2 * Math.PI * r;
      let pie = '';
      if (total === 0) {
        // 空数据占位：淡灰整环
        pie = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="rgba(120,200,255,.15)" stroke-width="' + stroke + '"/>';
      } else {
        // 第一个扇形从 12 点方向开始（rotate -90）
        const appPct = appN / total, webPct = webN / total;
        // APP 段（蓝青渐变 → 蓝色调）
        if (appPct > 0) {
          pie += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" ' +
            'stroke="url(#pieApp)" stroke-width="' + stroke + '" stroke-linecap="butt" ' +
            'stroke-dasharray="' + (appPct * C) + ' ' + C + '" stroke-dashoffset="0" ' +
            'transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
        }
        // H5 段（青色）
        if (webPct > 0) {
          pie += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" ' +
            'stroke="url(#pieWeb)" stroke-width="' + stroke + '" stroke-linecap="butt" ' +
            'stroke-dasharray="' + (webPct * C) + ' ' + C + '" ' +
            'stroke-dashoffset="-' + (appPct * C) + '" ' +
            'transform="rotate(-90 ' + cx + ' ' + cy + ')"/>';
        }
      }
      const appPctStr = total ? Math.round(appN / total * 100) : 0;
      const webPctStr = total ? Math.round(webN / total * 100) : 0;
      return '' +
        '<div class="pie-wrap">' +
          '<svg class="pie-svg" viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
            '<defs>' +
              '<linearGradient id="pieApp" x1="0" y1="0" x2="1" y2="1">' +
                '<stop offset="0%" stop-color="#1890FF"/><stop offset="100%" stop-color="#40a9ff"/>' +
              '</linearGradient>' +
              '<linearGradient id="pieWeb" x1="0" y1="0" x2="1" y2="1">' +
                '<stop offset="0%" stop-color="#36CFC9"/><stop offset="100%" stop-color="#5eead4"/>' +
              '</linearGradient>' +
              '<filter id="pieGlow" x="-30%" y="-30%" width="160%" height="160%">' +
                '<feGaussianBlur stdDeviation="3" result="b"/>' +
                '<feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>' +
              '</filter>' +
            '</defs>' +
            pie +
            '<text x="' + cx + '" y="' + (cy - 4) + '" text-anchor="middle" fill="#86909C" font-size="11">总数</text>' +
            '<text x="' + cx + '" y="' + (cy + 18) + '" text-anchor="middle" fill="#FFFFFF" font-size="22" font-weight="700">' + total + '</text>' +
          '</svg>' +
          '<div class="pie-legend">' +
            '<div class="pie-li"><span class="pie-dot" style="background:linear-gradient(135deg,#1890FF,#40a9ff)"></span>' +
              '<span class="pill mini">APP</span>' +
              '<b>' + appN + '</b><span class="muted">(' + appPctStr + '%)</span></div>' +
            '<div class="pie-li"><span class="pie-dot" style="background:linear-gradient(135deg,#36CFC9,#5eead4)"></span>' +
              '<span class="pill web">H5</span>' +
              '<b>' + webN + '</b><span class="muted">(' + webPctStr + '%)</span></div>' +
          '</div>' +
        '</div>';
    }

    // 最近记录
    const recent = d.recent || [];
    const fmtResult = r => {
      if ((r.result || '').includes('命中')) return '<span class="pill ok">内部</span>';
      if ((r.result || '').includes('失败')) return '<span class="pill no">失败</span>';
      return '<span class="pill web">外部</span>';
    };
    const fmtChan = r => r.channel === 'web' ? '<span class="pill web">H5</span>' : '<span class="pill mini">APP</span>';
    document.getElementById('recent').innerHTML = recent.length ? recent.map(r =>
      '<div class="ri"><span class="p">' + escapeHtml(r.plateNo) + '</span>' +
      '<span class="meta">' + fmtResult(r) + ' ' + fmtChan(r) + ' ' +
      escapeHtml(r.createdAt || '') + '</span></div>'
    ).join('') : '<div class="empty">暂无记录</div>';
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ===== 长期 / 临时 / 过期 分类卡片点击 → 模态框 =====
const CAT_LABEL = { long: '长期车辆', temp: '临时车辆', expired: '过期车辆' };

function bindCategoryCards() {
  document.querySelectorAll('.stat-card.clickable').forEach(card => {
    card.addEventListener('click', () => openCategoryModal(card.dataset.cat));
  });
  document.getElementById('cat-close').addEventListener('click', closeCategoryModal);
  document.getElementById('cat-cancel').addEventListener('click', closeCategoryModal);
  document.getElementById('cat-modal').addEventListener('click', e => {
    if (e.target.id === 'cat-modal') closeCategoryModal();
  });
}

function openCategoryModal(cat) {
  document.getElementById('cat-title').textContent = (CAT_LABEL[cat] || '分类') + '明细';
  document.getElementById('cat-modal').classList.add('show');
  loadCategory(cat);
}

function closeCategoryModal() {
  document.getElementById('cat-modal').classList.remove('show');
}

async function loadCategory(cat) {
  const list = document.getElementById('cat-list');
  list.innerHTML = '<div class="empty">加载中…</div>';
  try {
    const r = await api('/api/admin/vehicles?validity=' + cat + '&pageSize=100&page=1');
    const rows = r.data || [];
    if (!rows.length) { list.innerHTML = '<div class="empty">暂无' + (CAT_LABEL[cat] || '') + '</div>'; return; }
    list.innerHTML = rows.map(v => {
      const status = v.valid === null ? '<span class="pill ok">长期</span>'
        : (v.valid ? '<span class="pill mini">有效</span>' : '<span class="pill no">已过期</span>');
      const validTxt = v.validUntil ? escapeHtml(v.validUntil) : '长期';
      const dept = v.department ? escapeHtml(v.department) : '—';
      return '<div class="cat-modal-row">' +
        '<div class="cat-modal-plate"><b>' + escapeHtml(v.plateNo || '—') + '</b></div>' +
        '<div class="cat-modal-meta">' +
          '<span>' + escapeHtml(v.owner || '—') + '</span>' +
          '<span class="dot">·</span>' +
          '<span>' + dept + '</span>' +
          '<span class="dot">·</span>' +
          '<span>' + validTxt + ' ' + status + '</span>' +
        '</div>' +
        '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty">加载失败：' + escapeHtml(e.message) + '</div>';
  }
}

// ===== 系统信息大屏 =====
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = Number(n)
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return v.toFixed(i === 0 ? 0 : 1) + ' ' + u[i]
}
function fmtRate(n) { return fmtBytes(n) + '/s' }

function detectBrowser() {
  const ua = navigator.userAgent
  let name = '未知浏览器', ver = ''
  const map = [
    ['Edg', 'Edge'], ['OPR', 'Opera'], ['Firefox', 'Firefox'],
    ['Chrome', 'Chrome'], ['Safari', 'Safari']
  ]
  for (const [t, n] of map) {
    const m = ua.match(new RegExp(t + '\\/([\\d.]+)'))
    if (m) { name = n; ver = m[1]; break }
  }
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua)
  return { name: name + (ver ? ' ' + ver : ''), mobile: isMobile }
}

function renderSysInfo(d, version) {
  if (!d) return
  const os = d.os || {}
  const cpu = d.cpu || {}
  const mem = d.memory || {}
  const net = d.network || null

  const elOs = document.getElementById('sys-os')
  if (elOs) elOs.textContent = (os.name || os.platform || '未知') + (os.release ? ' (' + os.release + ')' : '')
  const elArch = document.getElementById('sys-arch')
  if (elArch) elArch.textContent = [os.arch, '主机 ' + (os.hostname || '—'), os.nodeVersion ? 'Node ' + os.nodeVersion : ''].filter(Boolean).join(' · ')

  const elCpu = document.getElementById('sys-cpu')
  if (elCpu) elCpu.textContent = (cpu.cores || '—') + ' 核' + (cpu.usage != null ? ' · 负载 ' + cpu.usage + '%' : '')
  const elCpuModel = document.getElementById('sys-cpu-model')
  if (elCpuModel) elCpuModel.textContent = cpu.model || ''

  const elMem = document.getElementById('sys-mem')
  if (elMem) elMem.textContent = fmtBytes(mem.used) + ' / ' + fmtBytes(mem.total) + (mem.usage != null ? ' (' + mem.usage + '%)' : '')
  const elMemBar = document.getElementById('sys-mem-bar')
  if (elMemBar) {
    elMemBar.firstElementChild.style.width = (mem.usage != null ? Math.min(100, mem.usage) : 0) + '%'
    elMemBar.style.background = 'rgba(120,200,255,.12)'
    elMemBar.firstElementChild.style.background = (mem.usage >= 85) ? 'linear-gradient(90deg,#ff7875,#ff4d4f)' : 'linear-gradient(90deg,#36CFC9,#1890FF)'
  }

  const disk = d.disk
  const elDisk = document.getElementById('sys-disk')
  if (elDisk) elDisk.textContent = disk ? (fmtBytes(disk.used) + ' / ' + fmtBytes(disk.total) + ' (' + disk.usage + '%)') : '不支持'
  const elDiskBar = document.getElementById('sys-disk-bar')
  if (elDiskBar) {
    elDiskBar.firstElementChild.style.width = (disk && disk.usage != null ? Math.min(100, disk.usage) : 0) + '%'
    elDiskBar.style.background = 'rgba(120,200,255,.12)'
    elDiskBar.firstElementChild.style.background = (disk && disk.usage >= 85) ? 'linear-gradient(90deg,#ff7875,#ff4d4f)' : 'linear-gradient(90deg,#36CFC9,#1890FF)'
  }

  const elNet = document.getElementById('sys-net')
  if (elNet) elNet.textContent = net ? ('↓ ' + fmtRate(net.rxRate) + ' ↑ ' + fmtRate(net.txRate)) : '不支持'
  const elNetDetail = document.getElementById('sys-net-detail')
  if (elNetDetail && net) elNetDetail.textContent = '累计 ↓ ' + fmtBytes(net.rxBytes) + ' ↑ ' + fmtBytes(net.txBytes)

  const elVer = document.getElementById('sys-ver')
  if (elVer) elVer.textContent = version || '未知'
  const elUp = document.getElementById('sys-uptime')
  if (elUp) elUp.textContent = os.uptime ? '已运行 ' + os.uptime : ''

  const b = detectBrowser()
  const elBrowser = document.getElementById('sys-browser')
  if (elBrowser) elBrowser.textContent = b.name + (b.mobile ? ' · 移动端' : ' · 桌面端')
  const elScreen = document.getElementById('sys-screen')
  if (elScreen) elScreen.textContent = window.screen.width + ' × ' + window.screen.height + ' · ' + navigator.language
}

async function initSysInfo() {
  // 浏览器与屏幕尺寸是前端信息，立即渲染
  const b = detectBrowser()
  const elBrowser = document.getElementById('sys-browser')
  if (elBrowser) elBrowser.textContent = b.name + (b.mobile ? ' · 移动端' : ' · 桌面端')
  const elScreen = document.getElementById('sys-screen')
  if (elScreen) elScreen.textContent = window.screen.width + ' × ' + window.screen.height + ' · ' + navigator.language

  async function refresh() {
    try {
      const [infoR, verR] = await Promise.all([
        api('/api/admin/sysinfo'),
        fetch('/version.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null)
      ])
      const info = (infoR && infoR.success && infoR.data) ? infoR.data : null
      const ver = verR && verR.version ? verR.version : null
      renderSysInfo(info, ver)
    } catch (e) { /* 静默，下次轮询重试 */ }
  }
  refresh()
  // 每 3 秒刷新（CPU 使用率 / 流量速率需两次采样差值）
  setInterval(refresh, 3000)
}
