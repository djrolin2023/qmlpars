// 服务核心配置（非 OCR 部分）
// 工厂函数：接收 dbGet，返回核心配置对象（保留 getter 实时性）
module.exports = function (dbGet) {
  return {
    // 服务监听端口（群晖反向代理会转发到此端口）—— 端口/DB路径仍走 .env，启动即固定
    PORT: process.env.PORT || 7081,
    DB_PATH: process.env.DB_PATH || '',

    // 对外可访问的基础 URL（仅用于拼接上传图片完整地址，当前前端未强制使用）
    get BASE_URL() { return dbGet('BASE_URL', process.env.BASE_URL || '') },

    // 自适应基础 URL：优先取当前请求的协议+域名（兼容反向代理 X-Forwarded-*），
    // 其次回退到 settings/.env 中配置的 BASE_URL，最后回退空串（前端用相对路径也能工作）。
    // 这样内外网、不同域名部署都无需手动改配置。
    baseUrl(req) {
      if (req) {
        const proto = (req.headers['x-forwarded-proto'] || (req.connection && req.connection.encrypted ? 'https' : req.protocol) || 'http').split(',')[0]
        const host = req.headers['x-forwarded-host'] || req.headers.host
        if (host) return `${proto}://${host}`
      }
      const cfg = dbGet('BASE_URL', process.env.BASE_URL || '')
      return cfg || ''
    },

    // 上传图片本地保存目录
    UPLOAD_DIR: process.env.UPLOAD_DIR || 'uploads',

    // 管理员登录配置（账号从数据库读取；密码哈希优先，兼容明文）
    get ADMIN_USERNAME() { return dbGet('ADMIN_USERNAME', process.env.ADMIN_USERNAME || 'admin') },
    get ADMIN_PASSWORD_HASH() { return dbGet('ADMIN_PASSWORD_HASH', process.env.ADMIN_PASSWORD_HASH || '') },
    get ADMIN_PASSWORD() { return dbGet('ADMIN_PASSWORD', process.env.ADMIN_PASSWORD || '') },
    TOKEN_EXPIRE_HOURS: 24 * 7, // 7 天
    MAX_LOGIN_FAILS: 5,
    LOCK_MINUTES: 10,
    MAX_USER_DEVICES: 3, // 同一账号最多同时在线设备数（超出则挤掉最早登录的设备）
  }
}
