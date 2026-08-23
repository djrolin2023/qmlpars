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
