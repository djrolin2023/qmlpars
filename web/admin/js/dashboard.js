/* 数据大屏 */
let categoryModalEl = null;
let categoryModalBody = null;

function initDashboard() {
  loadDashboard().catch((err) => {
    console.error('[dashboard] load failed', err);
    toast(isNetworkError(err) ? '无法连接服务器，请检查网络' : '数据大屏加载失败');
  });
}

async function loadDashboard() {
  const data = await api('/api/admin/stats');
  if (!data || data.success !== true) throw new Error('bad response');
  const d = data.data || {};

  // 顶部统计卡
  setNum('s-vehicles', d.vehicleTotal);
  setNum('s-long', d.longTermTotal);
  setNum('s-temp', d.tempTotal);
  setNum('s-expired', d.expiredTotal);
  setNum('s-today', d.todayTotal);
  setNum('s-internal', d.internalTotal);
  setNum('s-external', d.externalTotal);
  setNum('s-log', d.logTotal);

  renderTrend(d.trend || []);
  renderPie({ app: d.appTotal, wechat: d.wechatTotal, h5: d.webTotal });
  renderRecent(d.recent || []);

  // 系统信息
  initSysInfo();
}

function setNum(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = (val == null || val === '') ? '—' : formatNum(val);
}

/* 最近识别记录 */
function renderRecent(rows) {
  const box = document.getElementById('recent');
  if (!box) return;
  if (!rows.length) { box.innerHTML = '<div class="empty">暂无识别记录</div>'; return; }
  box.innerHTML = rows.map(r => {
    const plate = escapeHtml(r.plateNo || '未知');
    const ts = r.createdAt ? fmtDateFull(r.createdAt) : '';
    const conf = (r.confidence != null) ? Math.round(r.confidence * 100) + '%' : '';
    const typeCls = r.source === 'exit' ? 'exit' : (r.source === 'entry' ? 'entry' : 'unknown');
    const typeTxt = r.source === 'exit' ? '出口' : (r.source === 'entry' ? '入口' : '—');
    const resultCls = r.result === 'internal' ? 'internal' : (r.result === 'external' ? 'external' : 'unknown');
    const resultTxt = r.result === 'internal' ? '内部' : (r.result === 'external' ? '外部' : '未匹配');
    return `<div class="recent-row">
      <span class="r-plate">${plate}</span>
      <span class="r-type ${typeCls}">${typeTxt}</span>
      <span class="r-tag ${resultCls}">${resultTxt}</span>
      ${conf ? `<span class="r-conf">${conf}</span>` : ''}
      <span class="r-time">${escapeHtml(ts)}</span>
    </div>`;
  }).join('');
}

/* 趋势图（带网格线 + 数值标签） */
function renderTrend(list) {
  const box = document.getElementById('trend');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div class="empty">暂无趋势数据</div>'; return; }
  const max = Math.max(1, ...list.map(d => d.count || 0));
  const ticks = 4;
  const grid = [];
  for (let i = 0; i <= ticks; i++) {
    const v = Math.round((max * (ticks - i)) / ticks);
    grid.push(`<div class="trend-grid-line" style="bottom:${(i / ticks) * 100}%"><span>${formatNum(v)}</span></div>`);
  }
  box.innerHTML = grid.join('') + list.map(d => {
    const h = Math.round(((d.count || 0) / max) * 100);
    const wd = (100 / list.length).toFixed(2);
    const label = d.date ? String(d.date).slice(5) : '';
    return `<div class="trend-col" style="width:${wd}%">
      <div class="trend-val">${formatNum(d.count || 0)}</div>
      <div class="trend-bar" style="height:${h}%"></div>
      <div class="trend-x">${escapeHtml(label)}</div>
    </div>`;
  }).join('');
}

/* 渠道饼图 */
function renderPie(channel) {
  const pie = document.getElementById('pie');
  const legend = document.getElementById('pie-legend');
  if (!pie || !legend) return;
  const items = [
    { key: 'app', label: 'APP', color: '#3b82f6' },
    { key: 'wechat', label: '微信浏览器', color: '#22c55e' },
    { key: 'h5', label: '手机浏览器', color: '#06b6d4' }
  ];
  const total = items.reduce((s, it) => s + (Number(channel[it.key]) || 0), 0) || 1;
  let acc = 0;
  const segs = items.map(it => {
    const v = Number(channel[it.key]) || 0;
    const start = (acc / total) * 360;
    acc += v;
    const end = (acc / total) * 360;
    return `<div class="pie-seg" style="--start:${start}deg;--end:${end}deg;background:${it.color}"></div>`;
  }).join('');
  pie.innerHTML = segs + `<div class="pie-hole"><span class="pie-total">${formatNum(total)}</span><span class="pie-total-lbl">总识别</span></div>`;
  legend.innerHTML = items.map(it => {
    const v = Number(channel[it.key]) || 0;
    const pct = total ? Math.round((v / total) * 100) : 0;
    return `<div class="pie-legend-item"><span class="dot" style="background:${it.color}"></span><span class="pl-lbl">${it.label}</span><span class="pl-val">${formatNum(v)} · ${pct}%</span></div>`;
  }).join('');
}

/* 点击统计卡弹窗 */
function bindCategoryCards() {
  document.querySelectorAll('.stat-card.clickable').forEach(card => {
    card.addEventListener('click', () => openCategoryModal(card.dataset.cat));
  });
}

function openCategoryModal(cat) {
  if (!categoryModalEl) {
    categoryModalEl = document.getElementById('category-modal');
    categoryModalBody = document.getElementById('category-body');
  }
  if (!categoryModalEl) return;
  const countEl = document.getElementById('category-count');
  if (countEl) countEl.textContent = '';
  categoryModalBody.innerHTML = '<div class="loading">加载中…</div>';
  document.getElementById('category-title').textContent =
    cat === 'long' ? '长期车辆明细' : (cat === 'temp' ? '临时车辆明细' : '过期车辆明细');
  categoryModalEl.classList.add('open');
  api(`/api/admin/vehicles?validity=${cat}&pageSize=200`).then(res => {
    if (!res || res.success !== true) throw new Error('bad');
    const list = res.data || [];
    if (countEl) countEl.textContent = `共 ${list.length} 条${cat === 'expired' ? '（已过期）' : ''}`;
    renderCategoryList(list, cat);
  }).catch(() => {
    categoryModalBody.innerHTML = '<div class="empty">加载失败</div>';
    if (countEl) countEl.textContent = '';
  });
}

function renderCategoryList(list, cat) {
  if (!list.length) { categoryModalBody.innerHTML = '<div class="empty">暂无数据</div>'; return; }
  const header = '<div class="cat-head"><span class="cat-cell col-plate">车牌号</span><span class="cat-cell col-owner">车主</span><span class="cat-cell col-dept">部门</span><span class="cat-cell col-phone">手机号</span></div>';
  const rows = list.map(v => `<div class="cat-row"><span class="cat-cell col-plate">${escapeHtml(v.plateNo || '—')}</span><span class="cat-cell col-owner">${escapeHtml(v.owner || '—')}</span><span class="cat-cell col-dept">${escapeHtml(v.department || '—')}</span><span class="cat-cell col-phone">${escapeHtml(v.phone || '—')}</span></div>`).join('');
  categoryModalBody.innerHTML = header + rows;
}

function closeCategoryModal() {
  if (categoryModalEl) categoryModalEl.classList.remove('open');
}

function initSysInfo() {
  api('/api/admin/sysinfo').then(r => {
    if (!r || r.success !== true) return;
    const s = r.data || {};
    const os = s.os || {};
    const cpu = s.cpu || {};
    const mem = s.memory || {};
    const disk = s.disk || {};
    const net = s.network || {};

    setText('sys-os', os.name);
    setText('sys-arch', os.arch);
    setText('sys-cpu', cpu.usage != null ? cpu.usage + '%' : null);
    setText('sys-cpu-model', cpu.model);
    setText('sys-mem', mem.total ? `${formatBytes(mem.used || 0)} / ${formatBytes(mem.total)}` : null);
    setBar('sys-mem-bar', mem.usage);
    setText('sys-disk', disk.total ? `${formatBytes(disk.used || 0)} / ${formatBytes(disk.total)}` : null);
    setBar('sys-disk-bar', disk.usage);
    setText('sys-net', (net.rxRate != null || net.txRate != null) ? `↓${formatNetRate(net.rxRate)} / ↑${formatNetRate(net.txRate)}` : null);
    setText('sys-net-detail', net.rxBytes != null ? `累计 ↓${formatBytes(net.rxBytes)} ↑${formatBytes(net.txBytes)}` : '');
    setText('sys-ver', s.version);
    setText('sys-uptime', '');
    setText('sys-node', os.nodeVersion ? 'Node.js ' + os.nodeVersion : null);
    setText('sys-uptime-detail', os.uptime);
  }).catch((err) => {
    console.error('[sysinfo] failed', err);
  });
}

function setText(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = (v == null || v === '') ? '—' : v;
}
function setBar(id, pct) {
  const el = document.getElementById(id);
  if (!el) return;
  const span = el.querySelector('span');
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  if (span) span.style.width = p + '%';
  el.title = p + '%';
}
