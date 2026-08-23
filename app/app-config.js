// 安卓端 app 配置（源码，由 buildapp 拷贝进安卓包）
// __API_BASE__：cpsb 同源脚本（common.js/camera.js/query.js）使用的 API 前缀
// APP_CONFIG.serverUrl：inline 脚本会据此覆盖 __API_BASE__，二者须一致
// 运行时：若 localStorage.user_server_url 存在，优先用它（避免改一次 serverUrl 就要重打包）
(function(){
  try{
    var stored = localStorage.getItem('user_server_url');
    if (stored && /^https?:\/\//.test(stored)) {
      window.__API_BASE__ = stored;
      window.APP_CONFIG = { serverUrl: stored };
      return;
    }
  } catch (e) {}
})();
// 占位值，仅用于本地直接预览；打包时由 buildapp 用真实 serverUrl 覆盖写入
window.__API_BASE__ = '';
window.APP_CONFIG = { serverUrl: '' };
