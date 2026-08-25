// 服务配置文件
// 配置优先从数据库 settings 表读取（即时生效，无需重启），
// 数据库中没有时回退到 .env 环境变量（仅用于首次初始化/部署）。
//
// 文件拆分说明：
//   - config/core.js  服务核心配置（端口/上传/管理员等）
//   - config/ocr.js   OCR 各通道配置（百度/腾讯/阿里云/华为云/自定义）
//   - config.js       入口：合并上面两个模块并导出，对调用方完全透明
const db = require('./db')
const buildCore = require('./config/core')
const buildOcr = require('./config/ocr')

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
    'TENCENT_SECRET_ID', 'TENCENT_SECRET_KEY', 'TENCENT_REGION',
    'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'ALIYUN_REGION',
    'HUAWEI_AK', 'HUAWEI_SK', 'HUAWEI_PROJECT_ID', 'HUAWEI_REGION',
    'CUSTOM_OCR_URL', 'CUSTOM_OCR_METHOD', 'CUSTOM_OCR_HEADERS', 'CUSTOM_OCR_BODY_TEMPLATE',
    'CUSTOM_OCR_PLATE_FIELD', 'CUSTOM_OCR_CONFIDENCE_FIELD', 'CUSTOM_OCR_COLOR_FIELD'
  ]
  for (const k of envKeys) {
    const envVal = process.env[k]
    if (envVal === undefined) continue
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k)
    if (!row) dbSet(k, envVal)
  }
}

// 合并各模块。注意：必须用 defineProperties + getOwnPropertyDescriptors，
// 否则普通 {...a, ...b} / Object.assign 会触发 getter 求值并变成静态值，
// 导致「改配置即时生效」的特性被破坏。
const config = {}
const modules = [buildCore(dbGet), buildOcr(dbGet)]
for (const mod of modules) {
  Object.defineProperties(config, Object.getOwnPropertyDescriptors(mod))
}

// 读写方法（供系统设置接口调用）
config.dbGet = dbGet
config.dbSet = dbSet
config.migrateEnvToDb = migrateEnvToDb

module.exports = config
