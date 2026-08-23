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
  try {
    if (!stored || !stored.includes(':')) return false
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    if (hash.length !== 64) return false // sha256 hex 固定 64，长度不等直接判错，避免 timingSafeEqual 抛 RangeError
    const calc = crypto.createHash('sha256').update(salt + password).digest('hex')
    // 定长比较，避免时序侧信道
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(calc))
  } catch (e) {
    return false
  }
}

module.exports = { hashPassword, verifyPassword }
