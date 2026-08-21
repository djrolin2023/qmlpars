// 服务配置文件
// 配置优先从数据库 settings 表读取（即时生效，无需重启），
// 数据库中没有时回退到 .env 环境变量（仅用于首次初始化/部署）。
const db = require('./db')

// 从数据库 settings 表读取一个配置值
function dbGet(key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
    return row ? row.value : fallback
  } catch (e) {
    return fallback
  }
}

// 写配置到数据库（即时生效）
function dbSet(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? '' : String(value))
}

// 首次启动：把 .env 中的配置迁移进数据库（仅当库里没有对应记录时）
function migrateEnvToDb() {
  const envKeys = [
    'BASE_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD_HASH', 'ADMIN_PASSWORD',
    'BAIDU_API_KEY', 'BAIDU_SECRET_KEY',
    'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION'
  ]
  for (const k of envKeys) {
    const envVal = process.env[k]
    if (envVal === undefined) continue
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k)
    if (!row) dbSet(k, envVal)
  }
}

module.exports = {
  // 服务监听端口（群晖反向代理会转发到此端口）—— 端口/DB路径仍走 .env，启动即固定
  PORT: process.env.PORT || 7081,
  DB_PATH: process.env.DB_PATH || '',

  // 对外可访问的基础 URL（仅用于拼接上传图片完整地址，当前前端未强制使用）
  get BASE_URL() { return dbGet('BASE_URL', process.env.BASE_URL || 'https://jyedu.wl.gd.cn') },

  // 上传图片本地保存目录
  UPLOAD_DIR: process.env.UPLOAD_DIR || 'uploads',

  // 管理员登录配置（账号从数据库读取；密码哈希优先，兼容明文）
  get ADMIN_USERNAME() { return dbGet('ADMIN_USERNAME', process.env.ADMIN_USERNAME || 'admin') },
  get ADMIN_PASSWORD_HASH() { return dbGet('ADMIN_PASSWORD_HASH', process.env.ADMIN_PASSWORD_HASH || '') },
  get ADMIN_PASSWORD() { return dbGet('ADMIN_PASSWORD', process.env.ADMIN_PASSWORD || '') },
  TOKEN_EXPIRE_HOURS: 24 * 7, // 7 天
  MAX_LOGIN_FAILS: 5,
  LOCK_MINUTES: 10,

  // 百度 OCR 配置（车牌识别）
  get BAIDU_API_KEY() { return dbGet('BAIDU_API_KEY', process.env.BAIDU_API_KEY || '') },
  get BAIDU_SECRET_KEY() { return dbGet('BAIDU_SECRET_KEY', process.env.BAIDU_SECRET_KEY || '') },
  get BAIDU_ENABLED() { return !!(this.BAIDU_API_KEY && this.BAIDU_SECRET_KEY) },

  // 腾讯云 OCR 配置（车牌识别备用通道）
  get TENCENT_SECRET_ID() { return dbGet('TENCENT_SECRET_ID', process.env.TENCENT_SECRET_ID || '') },
  get TENCENT_SECRET_KEY() { return dbGet('TENCENT_SECRET_KEY', process.env.TENCENT_SECRET_KEY || '') },
  get TENCENT_REGION() { return dbGet('TENCENT_REGION', process.env.TENCENT_REGION || 'ap-guangzhou') },
  get TENCENT_ENABLED() { return !!(this.TENCENT_SECRET_ID && this.TENCENT_SECRET_KEY) },

  // 读写方法（供系统设置接口调用）
  dbGet,
  dbSet,
  migrateEnvToDb
}
