// ===== 内联 SVG 图标库（统一 24x24 stroke 风格，使用 currentColor 跟随文字颜色） =====
// 用法：
//   HTML 中： <span class="ic" data-icon="dashboard"></span>  （由 applyIcons() 自动填充）
//   或 JS 中： element.innerHTML = svgIcon('dashboard');
const SVG_PATHS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  vehicle: '<path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><path d="M3 11h18v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><circle cx="7.5" cy="14.5" r="1"/><circle cx="16.5" cy="14.5" r="1"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  log: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  backup: '<path d="M20 17a3 3 0 0 0-5-2.2A3 3 0 0 0 11 18a3 3 0 0 0 5 2.1"/><path d="M12 13v8"/><path d="M12 3a8 8 0 0 1 8 8"/><path d="M16 11l-4-4-4 4"/>',
  buildapp: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/>',
  syslog: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h4"/>',
  setting: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1M18.7 18.7l-2.1-2.1M7.4 7.4 5.3 5.3"/>',
  about: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 4 2c0 1.5-2 2-2 3.5"/><circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none"/>',
  ocr: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/><path d="M8.5 11h5M11 8.5v5"/>',
  site: '<path d="M3 10.5 12 4l9 6.5"/><path d="M5 9.5V20h14V9.5"/><path d="M9 20v-6h6v6"/>',
  icp: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><path d="M9 13h6M9 17h6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.8"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  base: '<path d="M12 2 3 7v10l9 5 9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
  icon: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.3"/><path d="m5 18 5-5 3 3 6-6"/>',
  splash: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 16l4-4 3 3 5-5 4 4"/><circle cx="9" cy="8" r="1.3"/>',
  perm: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9.5 12l1.8 1.8L15 10"/>',
  other: '<circle cx="12" cy="12" r="9"/><path d="M12 8v.01M11 12h1v4h1"/>',
  sign: '<path d="M3 21h18"/><path d="M5 21V8l7-5 7 5v13"/><path d="M9 21v-6h6v6"/>',
  overview: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 4v4h4"/><path d="M12 8v4l3 2"/>',
  qrcode: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v3h-3v-3zM17 17h4v4h-4z"/>',
  disk: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><path d="M12 6v3M12 15v3M6 12h3M15 12h3"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h7V3"/><path d="M8 14h8v7H8z"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  os: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
  mem: '<rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 7v10M11 7v10M15 7v10"/>',
  net: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  version: '<path d="M20.5 13.5 12 5 3.5 13.5 12 22z"/><path d="M12 5v17M3.5 13.5h17"/><path d="M7.5 9.5h9"/>',
  browser: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><circle cx="6" cy="6" r="0.6" fill="currentColor" stroke="none"/><circle cx="8.5" cy="6" r="0.6" fill="currentColor" stroke="none"/><path d="M6 12l3 3 3-4 3 3 3-3"/>',
  batch: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 9h8M8 13h8M8 17h5"/>',
  light: '<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.3V16h6v-.2c0-.9.4-1.7 1-2.3A6 6 0 0 0 12 3z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  camera: '<path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  car: '<path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11"/><path d="M3 11h18v6a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><circle cx="7.5" cy="14.5" r="1"/><circle cx="16.5" cy="14.5" r="1"/>',
  scan: '<path d="M4 7V5a1 1 0 0 1 1-1h2M20 7V5a1 1 0 0 0-1-1h-2M4 17v2a1 1 0 0 0 1 1h2M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M4 12h16"/>',
  shield: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 9v5M12 17.5v.01"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>'
};

function svgIcon(name, extraClass) {
  const p = SVG_PATHS[name] || '';
  const cls = 'svg-ic' + (extraClass ? ' ' + extraClass : '');
  return '<svg class="' + cls + '" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
}

// 把容器内所有 [data-icon] 占位元素填充为对应 SVG（递归至 root）
function applyIcons(root) {
  (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
    const name = el.getAttribute('data-icon');
    if (name && SVG_PATHS[name] !== undefined) {
      el.innerHTML = svgIcon(name);
    }
  });
}

if (typeof window !== 'undefined') {
  window.SVG_PATHS = SVG_PATHS;
  window.svgIcon = svgIcon;
  window.applyIcons = applyIcons;
}

// 页面 DOM 就绪后自动填充所有 [data-icon] 占位（无需各页面手动调用）
function _autoApplyIcons() {
  if (typeof applyIcons === 'function') applyIcons(document);
}
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoApplyIcons);
  } else {
    _autoApplyIcons();
  }
}
