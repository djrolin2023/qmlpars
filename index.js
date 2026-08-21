require('dotenv').config()
const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const db = require('./db')
const config = require('./config')
const { normalizePlate, toPlateKey } = require('./plate')
const { recognizeByBaidu, recognizeByTencent } = require('./ocr')
const { hashPassword, verifyPassword } = require('./auth')

const app = express()
app.use(express.json({ limit: '15mb' }))

// 首次启动：把 .env 中的配置迁移进数据库（仅当库里无对应记录）
try { config.migrateEnvToDb() } catch (e) { console.error('[jyedu] 配置迁移失败:', e.message) }

// ---------- 静态图片访问（需鉴权，避免车辆照片被公开枚举） ----------
const uploadDir = path.join(__dirname, config.UPLOAD_DIR)
fs.mkdirSync(uploadDir, { recursive: true })
// 识别抓拍存储目录（独立于车辆照片 uploads：识别成功的帧保留作证据，失败删除）
const SNAP_DIR = path.join(uploadDir, 'snapshots')
fs.mkdirSync(SNAP_DIR, { recursive: true })
// 受保护的图片访问：仅管理员可读取
app.get('/uploads/:file', authMiddleware, (req, res) => {
  const f = path.join(uploadDir, path.basename(req.params.file))
  if (!fs.existsSync(f)) return res.status(404).json({ success: false, message: '文件不存在' })
  res.sendFile(f)
})
// 识别快照（保留在 uploads/snapshots 子目录）受保护访问，仅管理员可读取
app.get('/uploads/snapshots/:file', authMiddleware, (req, res) => {
  const f = path.join(SNAP_DIR, path.basename(req.params.file))
  if (!fs.existsSync(f)) return res.status(404).json({ success: false, message: '文件不存在' })
  res.sendFile(f)
})

// ---------- 文件上传 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg'
    // 随机前缀 + 长随机串，避免文件名被猜测枚举
    cb(null, crypto.randomBytes(16).toString('hex') + ext)
  }
})
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } })

// ---------- 工具函数 ----------
function nowLocal() { return new Date().toLocaleString('sv') }
function genToken() { return crypto.randomBytes(24).toString('hex') }

// 车辆颜色英文 -> 中文
const COLOR_CN = {
  blue: '蓝牌', yellow: '黄牌', green: '绿牌', white: '白牌', black: '黑牌',
  blue2: '蓝牌', yellow2: '黄牌', green2: '绿牌',
  '蓝': '蓝牌', '黄': '黄牌', '绿': '绿牌', '白': '白牌', '黑': '黑牌'
}
function toColorCn(c) {
  if (!c) return ''
  const key = String(c).trim().toLowerCase()
  return COLOR_CN[key] || COLOR_CN[c.trim()] || (String(c).includes('牌') ? c.trim() : c.trim() + '牌')
}

// 写/改 .env 中某个变量（不存在则追加）
function writeEnvVar(key, value) {
  const envPath = path.join(__dirname, '.env')
  let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
  const line = `${key}=${value}`
  if (new RegExp('^' + key + '=', 'm').test(content)) {
    content = content.replace(new RegExp('^' + key + '=.*$', 'm'), line)
  } else {
    content = content.trimEnd() + '\n' + line + '\n'
  }
  fs.writeFileSync(envPath, content)
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token || req.body.token
  if (!token) return res.status(401).json({ success: false, message: '未登录' })
  const row = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token)
  if (!row) return res.status(401).json({ success: false, message: '登录已失效' })
  if (new Date(row.expireAt).getTime() < Date.now()) {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
    return res.status(401).json({ success: false, message: '登录已过期' })
  }
  req.admin = row
  next()
}

function logRecognition(plateNo, source, confidence, result, channel, image) {
  try {
    db.prepare('INSERT INTO recognition_logs (plateNo, source, channel, confidence, result, image) VALUES (?,?,?,?,?,?)')
      .run(plateNo || '', source || '', channel || 'mini', confidence || 0, result || '', image || null)
  } catch (e) { /* 忽略日志错误 */ }
}

// ================= 公开接口 =================

// 1. 车牌识别
app.post('/api/recognize', upload.single('image'), async (req, res) => {
  const _t0 = Date.now()
  try {
    if (!req.file && !req.body.imageBase64 && !req.body.imageUrl) {
      return res.status(400).json({ success: false, message: '缺少图片数据' })
    }
    const channel = (req.body.channel === 'web') ? 'web' : 'app'
    let imageBase64 = null, imageUrl = null
    if (req.file) {
      const b64 = fs.readFileSync(req.file.path).toString('base64')
      imageBase64 = b64
    } else if (req.body.imageBase64) {
      imageBase64 = req.body.imageBase64
    } else if (req.body.imageUrl) {
      imageUrl = req.body.imageUrl
    }
    console.log('[OCR] channel=%s, hasFile=%s, base64Len=%s, url=%s', channel, !!req.file, imageBase64 ? imageBase64.length : 0, imageUrl || '')

    let result, source, lastErr
    // 自动识别：列出所有已配置好的通道，依次尝试，第一个成功即用，
    // 任一通道失败自动切换下一个（不再依赖手动优先级）。
    const channels = []
    // 腾讯优先（免费额度更充裕、识别稳定），百度作后备
    if (config.TENCENT_ENABLED) channels.push(['腾讯OCR', recognizeByTencent])
    if (config.BAIDU_ENABLED) channels.push(['百度OCR', recognizeByBaidu])
    if (channels.length === 0) {
      if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path) } catch (e) {} }
      return res.status(500).json({ success: false, message: '未配置任何 OCR 通道（请到系统设置填写百度或腾讯 OCR 密钥）' })
    }
    for (const [name, fn] of channels) {
      try {
        if (name === '腾讯OCR' && !config.TENCENT_ENABLED) continue
        if (name === '百度OCR' && !config.BAIDU_ENABLED) continue
        result = await fn(imageBase64, imageUrl)
        source = name
        break
      } catch (err) {
        lastErr = err
        logRecognition('', name, 0, '失败:' + err.message, channel)
      }
    }
    if (!result) {
      console.log('[OCR] 所有通道失败: lastErr=%s', lastErr && lastErr.stack ? lastErr.stack : lastErr)
      if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path) } catch (e) {} }
      return res.status(500).json({ success: false, message: '所有识别通道均失败:' + (lastErr && lastErr.message || '') })
    }

    const plateNo = result.plateNo
    const vehicle = db.prepare('SELECT * FROM vehicles WHERE plateKey = ?').get(toPlateKey(plateNo))
    // 识别成功的抓拍帧移存到独立目录保留作证据（与原临时文件同分区，rename 原子移动；失败则删除兜底）
    let snapFile = null
    if (req.file && fs.existsSync(req.file.path)) {
      try {
        snapFile = req.file.filename
        const dest = path.join(SNAP_DIR, snapFile)
        fs.renameSync(req.file.path, dest)
        console.log('[OCR] 抓拍保留: %s', snapFile)
      } catch (e) {
        try { fs.unlinkSync(req.file.path) } catch (e2) {}
      }
    }
    const snapImageUrl = snapFile ? `/uploads/snapshots/${snapFile}` : null
    logRecognition(plateNo, source, result.confidence, vehicle ? '命中内部车辆' : '未命中', channel, snapImageUrl)
    // 统计该车牌累计扫描次数与最近扫描时间（含本次）
    const stat = db.prepare('SELECT COUNT(*) AS cnt, MAX(createdAt) AS lastAt FROM recognition_logs WHERE plateNo = ?').get(plateNo || '') || { cnt: 0, lastAt: '' }
    res.json({
      success: true,
      data: {
        plateNo,
        confidence: result.confidence,
        color: toColorCn(result.color),
        isInternal: !!vehicle,
        scanCount: stat.cnt || 0,
        lastScanAt: stat.lastAt || '',
        vehicle: vehicle ? { ...vehicle, photoUrl: `${config.BASE_URL}/api/vehicles/${vehicle.id}/photo`, valid: isVehicleValid(vehicle) } : null
      }
    })
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path) } catch (e) {} }
    res.status(500).json({ success: false, message: err.message })
  }
})

// 2. 车辆查询（公开，无需登录）
app.get('/api/vehicles/search', (req, res) => {
  try {
    const plate = req.query.plate
    if (!plate) return res.status(400).json({ success: false, message: '缺少车牌参数' })
    const plateKey = toPlateKey(plate)
    const q = plateKey // 归一化后的查询串
    // 1) 精确匹配优先
    let v = q ? db.prepare('SELECT * FROM vehicles WHERE plateKey = ?').get(q) : null
    // 2) 模糊匹配：查询串为某车牌的“连续子串”且长度 ≥ 4
    if (!v && q && q.length >= 4) {
      const all = db.prepare('SELECT * FROM vehicles').all()
      v = all.find(row => row.plateKey && row.plateKey.includes(q)) || null
    }
    const stat = db.prepare('SELECT COUNT(*) AS cnt, MAX(createdAt) AS lastAt FROM recognition_logs WHERE plateNo = ?').get(plate || '') || { cnt: 0, lastAt: '' }
    res.json({ success: true, data: { isInternal: !!v, scanCount: stat.cnt || 0, lastScanAt: stat.lastAt || '', vehicle: v ? { ...v, photoUrl: `${config.BASE_URL}/api/vehicles/${v.id}/photo`, valid: isVehicleValid(v) } : null } })
  } catch (err) {
    res.status(500).json({ success: false, message: err.message })
  }
})

// 车辆照片访问（公开，但通过文件直发，避免暴露 /uploads 路径）
app.get('/api/vehicles/:id/photo', (req, res) => {
  const v = db.prepare('SELECT photo FROM vehicles WHERE id = ?').get(req.params.id)
  if (!v || !v.photo) return res.status(404).json({ success: false })
  const f = path.join(uploadDir, path.basename(v.photo))
  if (!fs.existsSync(f)) {
    // 文件已丢失：清空数据库 photo 字段，下次列表会显示"未上传车辆照片"占位
    try { db.prepare('UPDATE vehicles SET photo = NULL WHERE id = ?').run(req.params.id) } catch (e) {}
    return res.status(404).json({ success: false })
  }
  res.sendFile(f)
})

// ================= 管理员接口 =================

// 3. 登录（用户名固定 admin，前端只提交管理密码）
app.post('/api/admin/login', (req, res) => {
  const password = (req.body && req.body.password) || ''
  const username = 'admin'
  if (!password) return res.status(400).json({ success: false, message: '请输入管理密码' })

  // 失败锁定检查
  const since = new Date(Date.now() - config.LOCK_MINUTES * 60000).toISOString()
  const fails = db.prepare(
    "SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND success = 0 AND createdAt > ?"
  ).get(username, since)
  if (fails.c >= config.MAX_LOGIN_FAILS) {
    return res.status(429).json({ success: false, message: `失败次数过多，请 ${config.LOCK_MINUTES} 分钟后再试` })
  }

  // 校验密码：优先哈希存储；兼容旧明文自动迁移为哈希
  let ok = false
  if (config.ADMIN_PASSWORD_HASH) {
    ok = verifyPassword(password, config.ADMIN_PASSWORD_HASH)
  } else if (config.ADMIN_PASSWORD) {
    ok = (password === config.ADMIN_PASSWORD)
    // 首次登录成功后，将明文迁移为哈希并写入数据库
    if (ok) {
      const hashed = hashPassword(password)
      config.dbSet('ADMIN_PASSWORD_HASH', hashed)
      config.dbSet('ADMIN_PASSWORD', '') // 清除明文
    }
  }
  db.prepare('INSERT INTO login_attempts (username, success) VALUES (?,?)').run(username, ok ? 1 : 0)
  if (!ok) return res.status(401).json({ success: false, message: '管理密码错误' })

  const token = genToken()
  const expireAt = new Date(Date.now() + config.TOKEN_EXPIRE_HOURS * 3600000).toLocaleString('sv')
  db.prepare('INSERT INTO admin_sessions (token, username, expireAt) VALUES (?,?,?)').run(token, username, expireAt)
  res.json({ success: true, data: { token } })
})

// 3.4 当前管理员信息（需登录）
app.get('/api/admin/me', authMiddleware, (req, res) => {
  res.json({ success: true, data: { user: req.admin.username || 'admin' } })
})

// 3.5 识别日志（需登录，支持按 channel / 时间范围筛选、分页）
app.get('/api/admin/logs', authMiddleware, (req, res) => {
  const channel = req.query.channel
  const start = req.query.start
  const end = req.query.end
  const page = Math.max(1, Number(req.query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
  const wheres = []
  const params = []
  if (channel === 'app' || channel === 'mini') { wheres.push('channel IN (?,?)'); params.push('app', 'mini') }
  else if (channel === 'web') { wheres.push('channel = ?'); params.push('web') }
  if (start) { wheres.push('createdAt >= ?'); params.push(start + ' 00:00:00') }
  if (end) { wheres.push('createdAt <= ?'); params.push(end + ' 23:59:59') }
  const whereSql = wheres.length ? ('WHERE ' + wheres.join(' AND ')) : ''
  const countRow = db.prepare(`SELECT COUNT(*) AS total FROM recognition_logs ${whereSql}`).get(...params)
  const total = (countRow && countRow.total) || 0
  const offset = (page - 1) * pageSize
  const rows = db.prepare(`SELECT * FROM recognition_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset)
  res.json({ success: true, data: rows, total, page, pageSize })
})
// 3.6 数据大屏统计（需登录）
app.get('/api/admin/stats', authMiddleware, (req, res) => {
  try {
    const today = new Date().toLocaleDateString('sv') // YYYY-MM-DD
    const vehicleTotal = (db.prepare('SELECT COUNT(*) AS c FROM vehicles').get().c) || 0
    // 按有效期分类：长期（无有效期）/ 临时（有有效期且未过期）/ 过期（已过期）
    const endExpr = "CASE WHEN validUntil LIKE '%~%' THEN substr(validUntil, instr(validUntil,'~')+1) ELSE validUntil END"
    const longTermTotal = (db.prepare("SELECT COUNT(*) AS c FROM vehicles WHERE validUntil IS NULL OR validUntil = ''").get().c) || 0
    const expiredTotal = (db.prepare("SELECT COUNT(*) AS c FROM vehicles WHERE validUntil IS NOT NULL AND validUntil <> '' AND date(" + endExpr + ") < date('now')").get().c) || 0
    const tempTotal = (db.prepare("SELECT COUNT(*) AS c FROM vehicles WHERE validUntil IS NOT NULL AND validUntil <> '' AND date(" + endExpr + ") >= date('now')").get().c) || 0
    const logTotal = (db.prepare('SELECT COUNT(*) AS c FROM recognition_logs').get().c) || 0
    const todayTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE date(createdAt) = date('now','localtime')").get().c) || 0
    const internalTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE result LIKE '%命中%'").get().c) || 0
    const externalTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE result LIKE '%未命中%'").get().c) || 0
    const validTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE result LIKE '%命中%'").get().c) || 0
    const appTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE channel IN ('app','mini')").get().c) || 0
    const webTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE channel = 'web'").get().c) || 0
    // 近 7 天趋势（日期与分组 key 完全由 SQLite 用本地时间生成，避免 Node locale 差异）
    const trendRows = db.prepare(`
      WITH RECURSIVE days(d) AS (
        SELECT date('now','localtime','-6 days')
        UNION ALL
        SELECT date(d,'+1 days') FROM days WHERE d < date('now','localtime')
      )
      SELECT days.d AS day, COUNT(recognition_logs.id) AS c
      FROM days
      LEFT JOIN recognition_logs ON date(recognition_logs.createdAt) = days.d
      GROUP BY days.d ORDER BY days.d
    `).all()
    const trend = trendRows.map(r => ({ date: r.day.slice(5), count: r.c || 0 }))
    // 最近 10 条识别记录
    const recent = db.prepare('SELECT * FROM recognition_logs ORDER BY id DESC LIMIT 10').all()
      .map(r => ({ plateNo: r.plateNo || '—', result: r.result, channel: r.channel, confidence: r.confidence, createdAt: r.createdAt }))
    res.json({
      success: true,
      data: {
        vehicleTotal, logTotal, todayTotal,
        internalTotal, externalTotal, validTotal,
        longTermTotal, tempTotal, expiredTotal,
        appTotal, webTotal, trend, recent
      }
    })
  } catch (e) {
    res.status(500).json({ success: false, message: e.message })
  }
})

// 删除日志关联的抓拍图文件（image 指向 uploads/snapshots）
function deleteLogImages(ids) {
  if (!ids || !ids.length) return
  try {
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT image FROM recognition_logs WHERE id IN (${placeholders})`).all(...ids)
    for (const r of rows) {
      if (!r.image || !r.image.includes('/uploads/snapshots/')) continue
      const f = path.join(SNAP_DIR, path.basename(r.image))
      if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch (e) {} }
    }
  } catch (e) { /* 忽略 */ }
}
// 删除单条日志
app.delete('/api/admin/logs/:id', authMiddleware, (req, res) => {
  const id = Number(req.params.id)
  deleteLogImages([id])
  db.prepare('DELETE FROM recognition_logs WHERE id = ?').run(id)
  res.json({ success: true, message: '已删除' })
})
// 清空所有日志
app.delete('/api/admin/logs', authMiddleware, (req, res) => {
  const all = db.prepare('SELECT id FROM recognition_logs').all().map(r => r.id)
  deleteLogImages(all)
  db.prepare('DELETE FROM recognition_logs').run()
  res.json({ success: true, message: '已清空' })
})
// 批量删除日志（支持按筛选条件删除全部）
app.post('/api/admin/logs/batch-delete', authMiddleware, (req, res) => {
  const body = req.body || {}
  const channel = body.channel
  const start = body.start
  const end = body.end
  const wheres = []
  const params = []
  if (body.all) {
    // 渠道筛选：app(含历史 mini) 与 web(H5) 两类
    if (channel === 'app' || channel === 'mini') { wheres.push('channel IN (?,?)'); params.push('app', 'mini') }
    else if (channel === 'web') { wheres.push('channel = ?'); params.push('web') }
    if (start) { wheres.push('createdAt >= ?'); params.push(start + ' 00:00:00') }
    if (end) { wheres.push('createdAt <= ?'); params.push(end + ' 23:59:59') }
    const whereSql = wheres.length ? ('WHERE ' + wheres.join(' AND ')) : ''
    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM recognition_logs ${whereSql}`).get(...params)
    const total = (countRow && countRow.total) || 0
    if (!total) return res.status(400).json({ success: false, message: '没有符合条件的记录' })
    const ids = db.prepare(`SELECT id FROM recognition_logs ${whereSql}`).all(...params).map(r => r.id)
    deleteLogImages(ids)
    db.prepare(`DELETE FROM recognition_logs ${whereSql}`).run(...params)
    return res.json({ success: true, message: `已删除 ${total} 条` })
  }
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => n > 0) : []
  if (!ids.length) return res.status(400).json({ success: false, message: '未选择任何记录' })
  deleteLogImages(ids)
  const placeholders = ids.map(() => '?').join(',')
  db.prepare(`DELETE FROM recognition_logs WHERE id IN (${placeholders})`).run(...ids)
  res.json({ success: true, message: `已删除 ${ids.length} 条` })
})

// 3.8 部门列表（需登录，返回持久化的全部部门，含是否内置）
app.get('/api/admin/departments', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT name, builtin FROM departments ORDER BY builtin DESC, id ASC').all()
  res.json({ success: true, data: rows.map(r => ({ name: r.name, builtin: !!r.builtin })) })
})

// 3.9 新增部门（需登录，持久化到数据库）
app.post('/api/admin/departments', authMiddleware, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim()
  if (!name) return res.status(400).json({ success: false, message: '部门名称不能为空' })
  const exists = db.prepare('SELECT 1 FROM departments WHERE name = ?').get(name)
  if (exists) return res.status(409).json({ success: false, message: '该部门已存在' })
  db.prepare('INSERT INTO departments (name, builtin) VALUES (?, 0)').run(name)
  res.json({ success: true, message: '已添加', data: name })
})

// 3.10 删除部门（需登录，仅允许删除非内置部门）
app.delete('/api/admin/departments', authMiddleware, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim()
  if (!name) return res.status(400).json({ success: false, message: '部门名称不能为空' })
  const row = db.prepare('SELECT * FROM departments WHERE name = ?').get(name)
  if (!row) return res.status(404).json({ success: false, message: '部门不存在' })
  if (row.builtin) return res.status(400).json({ success: false, message: '内置部门不可删除' })
  db.prepare('DELETE FROM departments WHERE name = ?').run(name)
  res.json({ success: true, message: '已删除部门：' + name })
})

// 3.11 汇总车辆中已使用的部门（去重），作为标签输入候选
app.get('/api/admin/vehicles/departments', authMiddleware, (req, res) => {
  const rows = db.prepare('SELECT department FROM vehicles WHERE department IS NOT NULL AND department <> \'\'').all()
  const set = new Set()
  rows.forEach(r => String(r.department || '').split(/[,，]/).forEach(x => { x = x.trim(); if (x) set.add(x) }))
  res.json({ success: true, data: [...set].sort() })
})

// 4. 车辆列表（需登录）
function isVehicleValid(v){
  if(!v.validUntil) return null // 无有效期限制（长期车辆）
  // 兼容 "start~end" 与单一结束日两种格式
  const endStr = v.validUntil.includes('~') ? v.validUntil.split('~')[1] : v.validUntil
  // 结束日视为当天 23:59:59.999 仍有效（与前端 formatValidCell 和 SQL date() 比较保持一致）
  const end = new Date(String(endStr).replace(/-/g,'/') + ' 23:59:59').getTime()
  if(isNaN(end)) return null
  return Date.now() <= end
}
app.get('/api/admin/vehicles', authMiddleware, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1)
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 10))
  const dept = String(req.query.department || '').trim()
  const keyword = String(req.query.keyword || '').trim()
  const validity = String(req.query.validity || '').trim()
  let where = '', params = []
  if(dept){ where = ' WHERE department LIKE ?'; params.push('%' + dept + '%') }
  if(validity === 'long' || validity === 'temp' || validity === 'expired'){
    const endExpr = "CASE WHEN validUntil LIKE '%~%' THEN substr(validUntil, instr(validUntil,'~')+1) ELSE validUntil END"
    let cond
    if(validity === 'long') cond = "(validUntil IS NULL OR validUntil = '')"
    else if(validity === 'expired') cond = "(validUntil IS NOT NULL AND validUntil <> '' AND date(" + endExpr + ") < date('now','localtime'))"
    else cond = "(validUntil IS NOT NULL AND validUntil <> '' AND date(" + endExpr + ") >= date('now','localtime'))"
    where += (where ? ' AND' : ' WHERE') + ' ' + cond
  }
  if(keyword){
    const kw = '%' + keyword + '%'
    where += (where ? ' AND' : ' WHERE') + ' (plateNo LIKE ? OR owner LIKE ? OR phone LIKE ?)'
    params.push(kw, kw, kw)
  }
  const totalRow = db.prepare('SELECT COUNT(*) AS c FROM vehicles' + where).get(...params)
  const total = totalRow.c
  const rows = db.prepare('SELECT * FROM vehicles' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, pageSize, (page - 1) * pageSize)
  // photo 改为使用公开可访问的 photo 接口地址，前端无需 token 即可展示
  const data = rows.map(v => ({
    ...v,
    photoUrl: v.photo ? `${config.BASE_URL}/api/vehicles/${v.id}/photo` : null,
    valid: isVehicleValid(v)
  }))
  res.json({ success: true, data, total, page, pageSize })
})

// 5. 单独上传车辆照片（需登录）：选图即传，返回可保存的 URL
app.post('/api/admin/vehicles/photo', authMiddleware, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: '未收到图片' })
  res.json({ success: true, url: `${config.BASE_URL}/uploads/${req.file.filename}` })
})

// 6. 新增/编辑车辆（需登录）：photo 可传已上传的 URL 字符串
app.post('/api/admin/vehicles', authMiddleware, upload.single('photo'), (req, res) => {
  const b = req.body || {}
  const plateNo = normalizePlate(b.plateNo)
  if (!plateNo) return res.status(400).json({ success: false, message: '车牌号不能为空' })
  const plateKey = toPlateKey(plateNo)
  const photo = req.file ? `${config.BASE_URL}/uploads/${req.file.filename}` : (b.photo || null)

  const editId = b.id ? parseInt(b.id) : null
  const existing = db.prepare('SELECT * FROM vehicles WHERE plateKey = ?').get(plateKey)
  const department = String(b.department || '').split(/[,，]/).map(s => s.trim()).filter(Boolean).join(',')
  const validUntil = String(b.validUntil || '').trim() || null

  if (editId) {
    // 编辑：以 id 为准更新该记录（允许修改车牌号，不会多出一条）
    const old = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(editId)
    if (!old) return res.status(404).json({ success: false, message: '车辆不存在，无法编辑' })
    // 若新车牌被其它车辆占用则拒绝（避免车牌冲突）
    if (existing && existing.id !== editId) {
      return res.status(409).json({ success: false, message: '该车牌已存在，请勿重复添加' })
    }
    // 重新上传文件：用新图；未上传但前端明确传了 photo（含 null=主动移除）：用前端值；其余保留原图
    const finalPhoto = req.file ? photo : (b.photo !== undefined ? b.photo : (old.photo || null))
    db.prepare(`UPDATE vehicles SET plateNo=?, plateKey=?, owner=?, phone=?, department=?, remark=?, photo=?, validUntil=?, updatedAt=? WHERE id=?`)
      .run(plateNo, plateKey, b.owner || '', b.phone || '', department, b.remark || '', finalPhoto, validUntil, nowLocal(), editId)
  } else {
    // 新增：按车牌去重
    if (existing) {
      return res.status(409).json({ success: false, message: '该车牌已存在，请勿重复添加' })
    }
    db.prepare(`INSERT INTO vehicles (plateNo, plateKey, owner, phone, department, remark, photo, validUntil, createdAt, updatedAt)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(plateNo, plateKey, b.owner || '', b.phone || '', department, b.remark || '', photo, validUntil, nowLocal(), nowLocal())
  }
  res.json({ success: true, message: '保存成功' })
})

// 6. 删除车辆（需登录）
app.delete('/api/admin/vehicles/:id', authMiddleware, (req, res) => {
  const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id)
  if (!v) return res.status(404).json({ success: false, message: '车辆不存在' })
  // 删除本地照片
  if (v.photo && v.photo.includes('/uploads/')) {
    const f = path.join(uploadDir, path.basename(v.photo))
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
  db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id)
  res.json({ success: true, message: '删除成功' })
})

// 6.1 批量删除车辆（需登录）
app.post('/api/admin/vehicles/batch-delete', authMiddleware, (req, res) => {
  const body = req.body || {}
  const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => n > 0) : []
  if (!ids.length) return res.status(400).json({ success: false, message: '未选择任何车辆' })
  const placeholders = ids.map(() => '?').join(',')
  const rows = db.prepare(`SELECT * FROM vehicles WHERE id IN (${placeholders})`).all(...ids)
  for (const v of rows) {
    if (v.photo && v.photo.includes('/uploads/')) {
      const f = path.join(uploadDir, path.basename(v.photo))
      if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch (e) {} }
    }
  }
  db.prepare(`DELETE FROM vehicles WHERE id IN (${placeholders})`).run(...ids)
  res.json({ success: true, message: `已删除 ${rows.length} 辆车` })
})

// 7. 退出登录
app.post('/api/admin/logout', authMiddleware, (req, res) => {
  db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(req.admin.token)
  res.json({ success: true })
})

// 7.5 修改管理员密码（需登录，哈希写入数据库 settings 表）
app.post('/api/admin/change-password', authMiddleware, (req, res) => {
  const { oldPassword, newPassword } = req.body || {}
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, message: '新密码至少 6 位' })
  if (req.admin.username !== config.ADMIN_USERNAME) return res.status(403).json({ success: false, message: '无权限' })
  // 校验旧密码（哈希或兼容明文）
  const oldOk = config.ADMIN_PASSWORD_HASH
    ? verifyPassword(oldPassword, config.ADMIN_PASSWORD_HASH)
    : (config.ADMIN_PASSWORD && oldPassword === config.ADMIN_PASSWORD)
  if (!oldOk) return res.status(401).json({ success: false, message: '旧密码错误' })

  const hashed = hashPassword(newPassword)
  config.dbSet('ADMIN_PASSWORD_HASH', hashed)
  config.dbSet('ADMIN_PASSWORD', '') // 清除可能存在的明文
  res.json({ success: true, message: '密码已修改（建议重新登录）' })
})

// 8. 系统设置（需登录）：读取/保存配置（存数据库 settings 表，即时生效无需重启）
const SETTING_FIELDS = [
  { key: 'BAIDU_API_KEY', label: '百度 OCR API Key', placeholder: '', secret: true },
  { key: 'BAIDU_SECRET_KEY', label: '百度 OCR Secret Key', placeholder: '', secret: true },
  { key: 'TENCENT_SECRET_ID', label: '腾讯云 SecretId', placeholder: '', secret: true },
  { key: 'TENCENT_SECRET_KEY', label: '腾讯云 SecretKey', placeholder: '', secret: true },
  { key: 'COMPANY_NAME', label: '公司名称', placeholder: '如：丰顺校区物业', secret: false },
  { key: 'ICP_NO', label: 'ICP 备案号', placeholder: '如：粤ICP备XXXXXXXX号', secret: false },
  { key: 'POLICE_NO', label: '公安备案号', placeholder: '如：粤公网安备XXXXXXXX号', secret: false },
  { key: 'POLICE_URL', label: '公安备案链接', placeholder: 'https://beian.mps.gov.cn/#/query/webSearch', secret: false, hideInForm: true },
  { key: 'LOGO_URL', label: '站点 LOGO', placeholder: '/cpsb/Images/school_logo.png', secret: false, image: true },
  { key: 'FAVICON_URL', label: '网站图标 favicon', placeholder: '/cpsb/Images/favicon.ico', secret: false, image: true },
  { key: 'POLICE_ICON_URL', label: '公安备案图标', placeholder: '/cpsb/Images/police.png', secret: false, image: true, hideInForm: true }
]

function maskSecret(v){
  v = v || ''
  if(!v) return ''
  if(v.length <= 6) return '••••••'
  return v.slice(0, 4) + '••••••' + v.slice(-4)
}
app.get('/api/admin/settings', authMiddleware, (req, res) => {
  const data = SETTING_FIELDS.map(f => ({
    key: f.key,
    label: f.label,
    secret: !!f.secret,
    image: !!f.image,
    hideInForm: !!f.hideInForm,
    value: f.secret ? maskSecret(config[f.key]) : (config[f.key] || '')
  }))
  res.json({ success: true, data })
})

app.post('/api/admin/settings', authMiddleware, (req, res) => {
  const body = req.body || {}
  for (const f of SETTING_FIELDS) {
    if (f.key in body) {
      const val = String(body[f.key] || '').trim()
      // secret 字段留空表示不修改，保留原值
      if(f.secret && !val) continue
      config.dbSet(f.key, val)
    }
  }
  // 配置已写入数据库，每次请求实时读取，无需重启即可生效
  res.json({ success: true, message: '已保存，配置即时生效' })
})

// 8.1 公开站点设置（无需登录）：公司名、备案号、公安备案链接、图片资源，供前端动态展示
const PUBLIC_SETTING_KEYS = ['COMPANY_NAME', 'ICP_NO', 'POLICE_NO', 'POLICE_URL', 'LOGO_URL', 'FAVICON_URL', 'POLICE_ICON_URL']
const SETTING_DEFAULTS = {
  LOGO_URL: '/cpsb/Images/school_logo.png',
  FAVICON_URL: '/cpsb/Images/favicon.ico',
  POLICE_ICON_URL: '/cpsb/Images/police.png',
  POLICE_URL: 'https://beian.mps.gov.cn/#/query/webSearch'
}
app.get('/api/settings/public', (req, res) => {
  const data = {}
  for (const k of PUBLIC_SETTING_KEYS) data[k] = config.dbGet(k, '') || (SETTING_DEFAULTS[k] || '')
  if (!data.POLICE_URL) data.POLICE_URL = 'https://beian.mps.gov.cn/#/query/webSearch'
  res.json({ success: true, data })
})

// ================= PC 管理端页面 =================
// admin / cpsb 移到项目根目录，分别托管为静态目录（登录态由前端用 token 控制，接口本身已鉴权）
const adminDir = path.join(__dirname, 'admin')
const cpsbDir = path.join(__dirname, 'cpsb')
fs.mkdirSync(adminDir, { recursive: true })
fs.mkdirSync(cpsbDir, { recursive: true })
// admin 后台：挂到 /admin
app.use('/admin', express.static(adminDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
  }
}))
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(adminDir, 'index.html')))
// cpsb 前台：挂到 /cpsb
app.use('/cpsb', express.static(cpsbDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
  }
}))
// 网页识别页
app.get(['/cpsb', '/cpsb/'], (req, res) => res.sendFile(path.join(cpsbDir, 'index.html')))

// 9. 站点图片资源上传（LOGO/favicon/公安备案图标）：存 cpsb/Images/uploads，公开可访问
const ASSETS_DIR = path.join(cpsbDir, 'Images', 'uploads')
fs.mkdirSync(ASSETS_DIR, { recursive: true })
// 通用图片上传：field=image，返回 /cpsb/Images/uploads/<file> 公开 URL
app.post('/api/admin/upload', authMiddleware, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: '请选择图片' })
  const dest = path.join(ASSETS_DIR, req.file.filename)
  fs.copyFileSync(req.file.path, dest)
  fs.unlinkSync(req.file.path)
  const url = `/cpsb/Images/uploads/${req.file.filename}`
  res.json({ success: true, url })
})


const PORT = config.PORT

// 启动时清理：数据库里有 photo 记录但本地文件已丢失的，将 photo 置空，
// 避免列表里持续出现破图（显示"未上传车辆照片"占位）
try {
  const rows = db.prepare("SELECT id, photo FROM vehicles WHERE photo IS NOT NULL AND photo != ''").all()
  let cleaned = 0
  for (const r of rows) {
    const f = path.join(uploadDir, path.basename(r.photo))
    if (!fs.existsSync(f)) {
      db.prepare('UPDATE vehicles SET photo = NULL WHERE id = ?').run(r.id)
      cleaned++
    }
  }
  if (cleaned > 0) console.log(`[jyedu] 启动清理: ${cleaned} 条车辆记录的照片文件已丢失，已置空 photo 字段`)
} catch (e) {
  console.log('[jyedu] 启动清理跳过:', e.message)
}

app.listen(PORT, () => {
  console.log(`[jyedu] 服务已启动: http://localhost:${PORT}`)
  console.log(`[jyedu] 百度 OCR: ${config.BAIDU_ENABLED ? '已启用' : '未配置'}`)
  console.log(`[jyedu] 腾讯 OCR: ${config.TENCENT_ENABLED ? '已启用' : '未配置'}`)
})
