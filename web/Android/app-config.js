// 标记当前运行于原生 APP（原生 APP 的 WebView 通过 capacitor server.url 加载本目录 /Android/）
// 同时给出 serverUrl（当前服务器地址），供 common.js 解析 API 基址，避免回退到错误源。
// 注意：打包时 buildapp 会用真实 serverUrl 重新生成本文件并覆盖，此处为源码兜底值。
window.__CHANNEL__ = 'qmlpars_APP';
window.__API_BASE__ = 'https://jy.wanglin.gd.cn';
window.APP_CONFIG = { serverUrl: 'https://jy.wanglin.gd.cn', channel: 'qmlpars_APP' };
