// 密码哈希工具：salt + SHA-256，不可逆存储
const crypto = require('crypto')

// 生成 "salt:hash" 形式
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.createHash('sha256').update(salt + password).digest('hex')
  return `${salt}:${hash}`
}

// 校验明文密码与存储的 "salt:hash" 是否匹配
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false
  const [salt, hash] = stored.split(':')
  const calc = crypto.createHash('sha256').update(salt + password).digest('hex')
  // 定长比较，避免时序侧信道
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc))
}

module.exports = { hashPassword, verifyPassword }
