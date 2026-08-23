require('dotenv').config()
const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const db = require('./db')
const config = require('./config')

const app = express()
// CORS：APP（Capacitor androidScheme='https'）的源是 https://localhost，
// 浏览器请求也是跨源（同源策略）。后端需返回 CORS 头才能让 fetch 跨域成功。
// 限制来源：APP 用 https://localhost；Web 端用配置的 ORIGIN（默认 *，可通过 env CORS_ORIGIN 指定）。
// 轻量自实现：不依赖 cors 包，避免装包/重启问题
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (CORS_ORIGIN === '*') {
    res.setHeader('Access-Control-Allow-Origin', '*')
  } else {
    const allowList = CORS_ORIGIN.split(',').map(s => s.trim())
    if (origin && allowList.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-user-token, x-admin-token')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})
app.use(express.json({ limit: '15mb' }))

// 首次启动：把 .env 中的配置迁移进数据库（仅当库里无对应记录）
try { config.migrateEnvToDb() } catch (e) { console.error('[qmlpars] 配置迁移失败:', e.message) }

// ---------- 静态图片访问（需鉴权，避免车辆照片被公开枚举） ----------
const uploadDir = path.join(__dirname, config.UPLOAD_DIR)
fs.mkdirSync(uploadDir, { recursive: true })
// 识别抓拍存储目录（独立于车辆照片 uploads：识别成功的帧保留作证据，失败删除）
const SNAP_DIR = path.join(uploadDir, 'snapshots')
fs.mkdirSync(SNAP_DIR, { recursive: true })
app.get('/uploads/*', authMiddleware, (req, res) => {
  const rel = req.params[0]
  const f = path.resolve(uploadDir, rel)
  if (!f.startsWith(uploadDir) || !fs.existsSync(f)) return res.status(404).json({ success: false, message: '文件不存在' })
  res.sendFile(f)
})
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
    cb(null, crypto.randomBytes(16).toString('hex') + ext)
  }
})
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } })

// ---------- 工具函数 ----------
function nowLocal() { return new Date().toLocaleString('sv') }
function genToken() { return crypto.randomBytes(24).toString('hex') }

function authMiddleware(req, res, next) {
  let token = req.headers['x-admin-token'] || req.query.token || req.body.token
  if (!token && req.headers['authorization']) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'])
    if (m) token = m[1]
  }
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

// 普通用户鉴权（H5/APP 端识别/查询）
function userAuthMiddleware(req, res, next) {
  const token = req.headers['x-user-token'] || req.query.token || req.body.token
  if (!token) return res.status(401).json({ success: false, message: '请先登录', needLogin: true })
  const row = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token)
  if (!row) return res.status(401).json({ success: false, message: '登录已失效', needLogin: true })
  if (new Date(row.expireAt).getTime() < Date.now()) {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token)
    return res.status(401).json({ success: false, message: '登录已过期', needLogin: true })
  }
  req.user = row
  next()
}

function genUserToken() { return crypto.randomBytes(24).toString('hex') }

function logRecognition(plateNo, source, confidence, result, channel, image, userId, userName) {
  try {
    db.prepare('INSERT INTO recognition_logs (plateNo, source, channel, confidence, result, image, userId, userName) VALUES (?,?,?,?,?,?,?,?)')
      .run(plateNo || '', source || '', channel || 'mini', confidence || 0, result || '', image || null, userId || null, userName || null)
  } catch (e) { /* 忽略日志错误 */ }
}

// ---------- 共享上下文：注入给各路由模块 ----------
const ASSETS_DIR = path.join(__dirname, 'uploads', 'assets')
fs.mkdirSync(ASSETS_DIR, { recursive: true })

const ctx = {
  app, db, config, upload, multer, crypto, fs, path,
  root: __dirname,
  router: express.Router(),
  authMiddleware, genToken, logRecognition, nowLocal,
  userAuthMiddleware, genUserToken,
  uploadDir, SNAP_DIR, ASSETS_DIR
}

// ---------- 路由装配 ----------
app.use(require('./routes/public')(ctx))   // 公开接口：识别 / 车辆查询 / 公开设置
app.use(require('./routes/admin')(ctx))    // 管理员接口 + 静态托管 + 站点上传
app.use(require('./routes/backup')(ctx))   // 数据备份 / 恢复
app.use(require('./routes/upgrade')(ctx))   // 在线升级（git 拉取）
app.use(require('./routes/buildapp')(ctx))   // APP 离线打包构建

// ================= PC 管理端 / 前台页面托管 =================
const adminDir = path.join(__dirname, 'web', 'admin')
const cpsbDir = path.join(__dirname, 'web', 'cpsb')
const staticDir = path.join(__dirname, 'static')
fs.mkdirSync(adminDir, { recursive: true })
fs.mkdirSync(cpsbDir, { recursive: true })
fs.mkdirSync(staticDir, { recursive: true })

// 公共静态资源（图片 / 样式 / 脚本 / 音频），各端统一引用 /static/...
app.use('/static', express.static(staticDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
}))

app.use('/admin', express.static(adminDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
}))
app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(adminDir, 'index.html')))

app.use('/cpsb', express.static(cpsbDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
}))
app.get(['/cpsb', '/cpsb/'], (req, res) => res.sendFile(path.join(cpsbDir, 'index.html')))

// 已构建 APK 下载目录（项目内相对路径，避免暴露系统根 /App）
const appOutDir = path.join(__dirname, 'app-out')
fs.mkdirSync(appOutDir, { recursive: true })
app.use('/App', express.static(appOutDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }))

// APP 下载页（公开）
const appPageDir = path.join(__dirname, 'app')
fs.mkdirSync(appPageDir, { recursive: true })
app.use('/app', express.static(appPageDir, {
  setHeaders: (res, filePath) => { if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate') }
}))
app.get(['/app', '/app/'], (req, res) => {
  // 兜底：若 app/index.html 不存在或 static 未配置命中，发送宣传/下载页
  res.sendFile(path.join(appPageDir, 'index.html'))
})

// 引导页（根路径 / 与 /index.html）
app.get(['/', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, 'index.html')))

// 版本信息（统一数据源：项目根 version.json；no-store 避免缓存）
app.get('/version.json', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.sendFile(path.join(__dirname, 'version.json'))
})

const PORT = config.PORT

// 启动时清理：数据库里有 photo 记录但本地文件已丢失的，将 photo 置空
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
  if (cleaned > 0) console.log(`[qmlpars] 启动清理: ${cleaned} 条车辆记录的照片文件已丢失，已置空 photo 字段`)
} catch (e) {
  console.log('[qmlpars] 启动清理跳过:', e.message)
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[qmlpars] 服务已启动: http://0.0.0.0:${PORT} (IPv4)`)
  console.log(`[qmlpars] 百度 OCR: ${config.BAIDU_ENABLED ? '已启用' : '未配置'}`)
  console.log(`[qmlpars] 腾讯 OCR: ${config.TENCENT_ENABLED ? '已启用' : '未配置'}`)
})
