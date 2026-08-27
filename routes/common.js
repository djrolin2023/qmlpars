// 公共工具函数：供各路由模块复用，避免重复实现导致逻辑漂移
const path = require('path')

// 数据库文件路径：与 db.js 保持一致（启动即固定，支持 DB_PATH 覆盖）
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'vehicles.db')

// 判断车辆是否在有效期内：返回 true=有效 / false=过期 / null=长期有效（无截止日期）
// 同时兼容两种写法：纯日期 "2026-12-31" 或区间 "2026-01-01~2026-12-31"
function isVehicleValid(v) {
  if (!v || !v.validUntil) return null
  const endStr = v.validUntil.includes('~') ? v.validUntil.split('~')[1] : v.validUntil
  const end = new Date(String(endStr).replace(/-/g, '/') + ' 23:59:59').getTime()
  if (isNaN(end)) return null
  return Date.now() <= end
}

module.exports = { DB_PATH, isVehicleValid }
