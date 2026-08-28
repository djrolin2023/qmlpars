require('dotenv').config()
const express = require('express')
const multer = require('multer')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const db = require('./db')
const config = require('./config')

const app = express()
// 信任反向代理，确保 req.ip 能正确解析 X-Forwarded-For 中的真实客户端 IP
app.set('trust proxy', true)
// CORS：APP（Capacitor androidScheme='https'）的源是 https://localhost，
// 浏览器同源请求 origin 为空，无需 CORS 头。
// 默认放开所有跨域源（*）。本项目所有接口均带 x-user-token / x-admin-token 鉴权，
// CORS 只是跨域栅栏，放开不影响安全。APP 内 webview（http://localhost / capacitor://localhost / null origin）
// 必须被 CORS 放行才能登录与请求数据。如需收紧，设置环境变量 CORS_ORIGIN 为逗号分隔的可信源。
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*'
app.use((req, res, next) => {
  const origin = req.headers.origin
  if (CORS_ORIGIN === '*') {
    // 通配符不能与 Allow-Credentials: true 共存，本项目用自定义 token 头、不依赖 cookie，故不设 credentials
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Vary', 'Origin')
  } else if (!origin || origin === CORS_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', origin || CORS_ORIGIN)
    res.setHeader('Vary', 'Origin')
  } else {
    const allowList = CORS_ORIGIN.split(',').map(s => s.trim())
    if (allowList.includes(origin)) {
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
// 抓拍快照含人脸/车牌隐私信息，必须鉴权（同时支持 ?token= 便于前端 <img> 展示）
// 注意：必须在通配路由 /uploads/* 之前注册，否则会被通配短路、本路由永不生效
app.get('/uploads/snapshots/:file', authMiddleware, (req, res) => {
  const f = path.join(SNAP_DIR, path.basename(req.params.file))
  if (!fs.existsSync(f)) return res.status(404).json({ success: false, message: '文件不存在' })
  res.sendFile(f)
})
app.get('/uploads/*', authMiddleware, (req, res) => {
  const rel = req.params[0]
  const f = path.resolve(uploadDir, rel)
  if (!f.startsWith(uploadDir) || !fs.existsSync(f)) return res.status(404).json({ success: false, message: '文件不存在' })
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

// 后台鉴权：同时接受 管理员会话(admin_sessions) 与 普通用户会话(user_sessions)
// - admin_sessions：固定为超级管理员，role='admin'
// - user_sessions：role 取自 users 表（admin/manager/user）
function authMiddleware(req, res, next) {
  let token = req.headers['x-admin-token'] || req.query.token || req.body.token
  if (!token && req.headers['authorization']) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'])
    if (m) token = m[1]
  }
  if (!token) return res.status(401).json({ success: false, message: '未登录' })
  // 1) 管理员会话
  const adminRow = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token)
  if (adminRow) {
    if (new Date(adminRow.expireAt).getTime() < Date.now()) {
      db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
      return res.status(401).json({ success: false, message: '登录已过期' })
    }
    req.admin = { id: 0, username: adminRow.username, name: adminRow.username, role: 'admin', token: adminRow.token, isUser: false }
    return next()
  }
  // 2) 普通用户会话（含用普通用户账号登录的后台角色：超级管理员/普通管理员/普通用户）
  const userRow = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token)
  if (userRow) {
    if (new Date(userRow.expireAt).getTime() < Date.now()) {
      db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token)
      return res.status(401).json({ success: false, message: '登录已过期' })
    }
    let role = 'user'
    if (userRow.username === 'admin') role = 'admin'
    else {
      const u = db.prepare('SELECT role FROM users WHERE username = ?').get(userRow.username)
      role = (u && u.role) || 'user'
    }
    req.admin = { id: userRow.userId, username: userRow.username, name: userRow.username, role, token: userRow.token, isUser: true }
    return next()
  }
  return res.status(401).json({ success: false, message: '登录已失效' })
}

// 角色权限网关：仅允许指定角色访问。用法：router.get('/x', ...roleGate('admin','manager'), handler)
function roleGate(...roles) {
  return [
    authMiddleware,
    (req, res, next) => {
      if (!roles.includes(req.admin.role)) {
        return res.status(403).json({ success: false, message: '权限不足，当前角色：' + (req.admin.role || '未知') })
      }
      next()
    }
  ]
}

// 普通用户鉴权（H5/APP 端识别/查询）
function userAuthMiddleware(req, res, next) {
  const token = req.headers['x-user-token'] || req.headers['x-admin-token'] || req.query.token || req.body.token
  if (!token) return res.status(401).json({ success: false, message: '请先登录', needLogin: true })
  // 1) 普通用户会话
  const row = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token)
  if (row) {
    if (new Date(row.expireAt).getTime() < Date.now()) {
      db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token)
      return res.status(401).json({ success: false, message: '登录已过期', needLogin: true })
    }
    req.user = row
    return next()
  }
  // 2) 管理员会话（H5 车辆管理页复用 admin common.js，上传后 OCR 走 x-admin-token）
  const adminRow = db.prepare('SELECT * FROM admin_sessions WHERE token = ?').get(token)
  if (adminRow) {
    if (new Date(adminRow.expireAt).getTime() < Date.now()) {
      db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token)
      return res.status(401).json({ success: false, message: '登录已过期', needLogin: true })
    }
    req.user = { userId: 0, username: adminRow.username, name: adminRow.username, token: adminRow.token, role: 'admin' }
    return next()
  }
  return res.status(401).json({ success: false, message: '登录已失效', needLogin: true })
}

function genUserToken() { return crypto.randomBytes(24).toString('hex') }

const { normalizePlate, toPlateKey } = require('./plate')
// 同一车牌 + 同一通道在窗口期内重复识别将被去重（防抖），避免数据库被噪声刷爆
const DEDUP_WINDOW_SEC = 300 // 5 分钟

function logRecognition(plateNo, source, confidence, result, channel, image, userId, userName, username) {
  const ch = channel || 'mini'
  const norm = normalizePlate(plateNo)
  const plateKey = norm ? toPlateKey(norm) : null
  try {
    // 1) 去重防抖：窗口期内同车牌+同通道已存在记录则跳过入库
    if (plateKey) {
      const dupRow = db.prepare(
        `SELECT id FROM recognition_logs WHERE plateNo=? AND channel=? AND createdAt >= datetime('now','localtime','-${DEDUP_WINDOW_SEC} seconds') LIMIT 1`
      ).get(norm, ch)
      if (dupRow) {
        // 命中去重：不重复写库，直接返回（仍保留本次识别结果供调用方）
        return { deduped: true }
      }
    }
    // 2) 黑白名单标记
    let flag = 'normal'
    if (plateKey) {
      const white = db.prepare('SELECT id FROM vehicles WHERE plateKey=?').get(plateKey)
      const black = db.prepare('SELECT id,reason FROM vehicle_lists WHERE plateKey=? AND type=?').get(plateKey, 'black')
      if (black) {
        flag = 'black'
        // 黑名单告警：写入系统日志（便于 qm / 前端审计）
        addSysLog('黑名单告警', norm, black.reason || '黑名单车辆出现', (username || userName || 'system'), null)
      } else if (white) {
        flag = 'white'
      }
    }
    // 3) 入库
    db.prepare('INSERT INTO recognition_logs (plateNo, source, channel, confidence, result, image, userId, userName, username, flag) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(norm || plateNo || '', source || '', ch, confidence || 0, result || '', image || null, userId || null, userName || null, username || null, flag)
    return { deduped: false, flag }
  } catch (e) { /* 忽略日志错误 */ return { deduped: false, error: String(e) } }
}

// 记录系统操作日志（登录/登出/编辑/删除等）
function addSysLog(action, target, detail, operator, ip) {
  try {
    db.prepare('INSERT INTO sys_logs (action, target, detail, operator, ip) VALUES (?,?,?,?,?)')
      .run(action || '', target || '', detail || '', operator || null, ip || null)
  } catch (e) { /* 忽略日志错误 */ }
}

// ---------- 共享上下文：注入给各路由模块 ----------
const ASSETS_DIR = path.join(__dirname, 'uploads', 'assets')
fs.mkdirSync(ASSETS_DIR, { recursive: true })

const ctx = {
  app, db, config, upload, multer, crypto, fs, path,
  root: __dirname,
  router: express.Router(),
  authMiddleware, genToken, logRecognition, addSysLog, nowLocal,
  userAuthMiddleware, genUserToken, roleGate,
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
const cpsbDir = path.join(__dirname, 'web', 'h5')
const staticDir = path.join(__dirname, 'static')
fs.mkdirSync(adminDir, { recursive: true })
fs.mkdirSync(cpsbDir, { recursive: true })
fs.mkdirSync(staticDir, { recursive: true })

// 前端缓存破坏：微信等 webview 常强缓存入口 HTML（即便返回 no-store），导致修复后仍卡旧脚本。
// 仅对“目录入口”（/cpsb、/admin，即 path 为 '' 或 '/'）做 302 跳转到带 CACHE_BUST 的 URL。
// 注意：不要对 iframe 内的子页面（*.html）做 302——微信 webview 在 iframe 302 时会错误地使用磁盘旧缓存，
//       反而导致旧 h5-vehicles.html（含 location.replace('/admin/login.html')）被执行、跳后台。
//       子页面统一由父页 iframe 的 src 直接带 ?v= 参数请求（见 web/h5/index.html），服务器直接返回 200 新版。
// 每次修复前端后把 CACHE_BUST 改新值即可全量刷新入口，无需动 version.json。
const CACHE_BUST = '20260826g'
function vBust(){
  return function(req, res, next){
    if((req.path === '' || req.path === '/') && !req.query.v){
      return res.redirect((req.originalUrl.split('?')[0]) + '?v=' + CACHE_BUST)
    }
    next()
  }
}
app.use('/cpsb', vBust())
app.use('/admin', vBust())

// 公共静态资源（图片 / 样式 / 脚本 / 音频），各端统一引用 /static/...
app.use('/static', express.static(staticDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  }
}))

app.use('/admin', express.static(adminDir, {
  setHeaders: (res, filePath) => {
    // HTML 始终不缓存；JS/CSS 每次上线后内容可能变化，也不缓存，避免前端升级后浏览器仍用旧文件
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
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
const appOutDir = path.join(__dirname, 'app', 'downloads')
fs.mkdirSync(appOutDir, { recursive: true })
app.use('/app/downloads', express.static(appOutDir, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }))

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

// Android APP 端：安卓打包后的 www 目录挂载在 /Android，与后端 API 同源，
// 避免 capacitor://localhost 跨域时 Android WebView 返回 type=basic + body 不可读的假响应。
const androidWwwDir = path.join(__dirname, 'android-app', 'www')
fs.mkdirSync(androidWwwDir, { recursive: true })
app.use('/Android', express.static(androidWwwDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    }
  }
}))
app.get('/Android', (req, res) => res.redirect('/Android/login.html'))

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
  // .env 权限告警：含管理员初始密码/密钥，若组或其他用户可读存在泄露风险
  try {
    const envPath = path.join(ROOT, '.env')
    if (fs.existsSync(envPath)) {
      const mode = fs.statSync(envPath).mode & 0o077
      if (mode !== 0) console.warn('[安全告警] .env 文件权限过宽（应为 0600），建议执行: chmod 600 .env')
    }
  } catch (_) {}
})
