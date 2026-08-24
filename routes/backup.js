// 数据备份 / 恢复（.bin 加密格式）
// .bin 文件结构：
//   [0:6]   魔数 "QMBK01"
//   [6]     版本 (0x01)
//   [7]     标志：bit0=1 已加密（AES-256-GCM）
//   [8:24]  salt（16B，scrypt 派生密钥用，仅加密时）
//   [24:36] IV（12B，仅加密时）
//   [36:52] authTag（16B，仅加密时）
//   [52:]   payload：加密时为密文；未加密时为原始 tar.gz（未加密时 payload 从 [8:] 开始）
module.exports = function (ctx) {
  const fs = require('fs')
  const path = require('path')
  const crypto = require('crypto')
  const { execFileSync } = require('child_process')
  const { router, db, config, authMiddleware, roleGate } = ctx

  const BACKUP_DIR = path.join(__dirname, '..', 'web', 'backup')
  const BACKUP_UPLOAD_DIR = path.join(BACKUP_DIR, '.upload')
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'vehicles.db')
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  fs.mkdirSync(BACKUP_UPLOAD_DIR, { recursive: true })
  const BACKUP_MAGIC = Buffer.from('QMBK01', 'ascii')

  // settings 表读写（与系统设置共用，key/value）
  function getSetting(k, def) {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k)
    return row ? row.value : def
  }
  function setSetting(k, v) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v)
  }

  // 生成一次备份（含加密），返回文件信息
  function createBackup(password) {
    const tgz = buildBackupTgz()
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const binName = `qmlpars-backup-${stamp}.bin`
    fs.writeFileSync(path.join(BACKUP_DIR, binName), makeBinFile(tgz, password))
    const st = fs.statSync(path.join(BACKUP_DIR, binName))
    return { file: binName, size: st.size, time: st.mtimeMs, encrypted: !!password }
  }

  function copyDirRecursive(src, dest) {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name)
      const d = path.join(dest, entry.name)
      if (entry.isDirectory()) copyDirRecursive(s, d)
      else if (entry.isFile()) fs.copyFileSync(s, d)
    }
  }

  function buildBackupTgz() {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch (e) { /* WAL 合并失败不阻塞 */ }
    const work = path.join(BACKUP_DIR, '.build-' + process.pid + '-' + Date.now())
    const buildData = path.join(work, 'data')
    fs.mkdirSync(path.join(buildData, 'uploads'), { recursive: true })
    fs.mkdirSync(path.join(buildData, 'assets'), { recursive: true })
    fs.copyFileSync(dbPath, path.join(buildData, 'vehicles.db'))
    copyDirRecursive(ctx.uploadDir, path.join(buildData, 'uploads'))
    copyDirRecursive(ctx.ASSETS_DIR, path.join(buildData, 'assets'))
    const tgzPath = path.join(work, 'payload.tar.gz')
    try {
      execFileSync('tar', ['-czf', tgzPath, '-C', buildData, '.'], { stdio: 'pipe' })
      const tgz = fs.readFileSync(tgzPath)
      fs.rmSync(work, { recursive: true, force: true })
      return tgz
    } catch (e) {
      fs.rmSync(work, { recursive: true, force: true })
      throw new Error('打包失败：' + e.message)
    }
  }

  function makeBinFile(tgz, password) {
    if (password) {
      const salt = crypto.randomBytes(16)
      const iv = crypto.randomBytes(12)
      const key = crypto.scryptSync(password, salt, 32)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(tgz), cipher.final()])
      return Buffer.concat([BACKUP_MAGIC, Buffer.from([0x01, 0x01]), salt, iv, cipher.getAuthTag(), enc])
    }
    return Buffer.concat([BACKUP_MAGIC, Buffer.from([0x01, 0x00]), tgz])
  }

  function parseBinFile(buf, password) {
    if (buf.length < 8 || !buf.subarray(0, 6).equals(BACKUP_MAGIC)) throw new Error('不是有效的 qmlpars 备份文件')
    if (buf[6] !== 1) throw new Error('不支持的备份文件版本')
    if (buf[7] & 1) {
      if (buf.length < 52) throw new Error('备份文件已损坏（头部不完整）')
      if (!password) throw new Error('该备份已加密，请输入备份密码')
      const key = crypto.scryptSync(password, buf.subarray(8, 24), 32)
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(24, 36))
        decipher.setAuthTag(buf.subarray(36, 52))
        return Buffer.concat([decipher.update(buf.subarray(52)), decipher.final()])
      } catch (e) {
        throw new Error('密码错误或备份文件已损坏')
      }
    }
    return buf.subarray(8)
  }

  router.post('/api/admin/backup/create', ...roleGate('admin', 'manager'), (req, res) => {
    try {
      const password = (req.body && req.body.password) || ''
      const info = createBackup(password)
      ctx.addSysLog('创建备份', info.file, password ? '已加密' : '未加密', req.admin.username, req.ip)
      res.json({ success: true, ...info, message: '备份成功' })
    } catch (e) {
      res.status(500).json({ success: false, message: e.message })
    }
  })

  // ===== 自动备份配置 =====
  const AUTO_KEY = 'AUTO_BACKUP'
  function loadAutoConfig() {
    try {
      const raw = getSetting(AUTO_KEY, '{}')
      const o = JSON.parse(raw || '{}')
      return {
        enabled: !!o.enabled,
        period: (o.period === 'weekly' || o.period === 'monthly' || o.period === 'daily') ? o.period : 'daily',
        password: o.password || '',
        lastRun: o.lastRun || null,
        createdAt: o.createdAt || null
      }
    } catch (e) {
      return { enabled: false, period: 'daily', password: '', lastRun: null, createdAt: null }
    }
  }
  function nextRunAt(cfg, fromMs) {
    const base = fromMs
    const d = new Date(base)
    if (cfg.period === 'daily') {
      d.setDate(d.getDate() + 1); d.setHours(3, 0, 0, 0) // 每天 03:00
    } else if (cfg.period === 'weekly') {
      // 每周一 03:00
      const day = d.getDay(); const diff = (8 - day) % 7 || 7
      d.setDate(d.getDate() + diff); d.setHours(3, 0, 0, 0)
    } else { // monthly
      d.setMonth(d.getMonth() + 1, 1); d.setHours(3, 0, 0, 0) // 每月 1 日 03:00
    }
    return d.getTime()
  }
  function saveAutoConfig(cfg) {
    setSetting(AUTO_KEY, JSON.stringify(cfg))
  }
  router.get('/api/admin/backup/auto', ...roleGate('admin', 'manager'), (req, res) => {
    try {
      const cfg = loadAutoConfig()
      const nr = cfg.enabled ? nextRunAt(cfg, cfg.lastRun ? cfg.lastRun : Date.now()) : null
      res.json({ success: true, data: { ...cfg, nextRun: nr } })
    } catch (e) {
      res.status(500).json({ success: false, message: e.message })
    }
  })
  router.post('/api/admin/backup/auto', ...roleGate('admin', 'manager'), (req, res) => {
    try {
      const body = req.body || {}
      const period = (body.period === 'weekly' || body.period === 'monthly' || body.period === 'daily') ? body.period : 'daily'
      const enabled = !!body.enabled
      const cfg = loadAutoConfig()
      cfg.enabled = enabled
      cfg.period = period
      cfg.password = (body.password != null ? String(body.password) : cfg.password)
      if (enabled && !cfg.createdAt) cfg.createdAt = Date.now()
      saveAutoConfig(cfg)
      ctx.addSysLog('设置自动备份', null, (enabled ? '启用，周期：' + period : '停用'), req.admin.username, req.ip)
      const nr = enabled ? nextRunAt(cfg, cfg.lastRun ? cfg.lastRun : Date.now()) : null
      res.json({ success: true, data: { ...cfg, nextRun: nr }, message: '自动备份设置已保存' })
    } catch (e) {
      res.status(500).json({ success: false, message: e.message })
    }
  })

  // 进程内调度：每分钟检查一次，到点自动生成备份
  function runAutoBackupIfDue() {
    const cfg = loadAutoConfig()
    if (!cfg.enabled) return
    const now = Date.now()
    const last = cfg.lastRun ? cfg.lastRun : 0
    const next = nextRunAt(cfg, last)
    if (now >= next) {
      try {
        const info = createBackup(cfg.password)
        cfg.lastRun = Date.now()
        saveAutoConfig(cfg)
        ctx.addSysLog('自动备份', info.file, cfg.period + (cfg.password ? '，已加密' : ''), 'system', '内部调度')
        console.log('[自动备份] 已生成：', info.file)
      } catch (e) {
        console.error('[自动备份] 失败：', e.message)
      }
    }
  }
  const autoTimer = setInterval(runAutoBackupIfDue, 60 * 1000)
  if (autoTimer.unref) autoTimer.unref() // 不阻止进程退出
  // 启动后立即检查一次（处理上次停机期间应执行但未执行的情况）
  try { runAutoBackupIfDue() } catch (e) {}

  router.get('/api/admin/backup/list', ...roleGate('admin', 'manager'), (req, res) => {
    try {
      const list = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.endsWith('.bin'))
        .map(f => {
          const st = fs.statSync(path.join(BACKUP_DIR, f))
          return { file: f, size: st.size, time: st.mtimeMs }
        })
        .sort((a, b) => b.time - a.time)
      res.json({ success: true, list })
    } catch (e) {
      res.status(500).json({ success: false, message: e.message })
    }
  })

  router.get('/api/admin/backup/download', ...roleGate('admin', 'manager'), (req, res) => {
    const file = path.basename(req.query.file || '')
    const p = path.join(BACKUP_DIR, file)
    if (!/\.bin$/.test(file) || !fs.existsSync(p)) return res.status(404).json({ success: false, message: '备份文件不存在' })
    res.download(p, file)
  })

  router.post('/api/admin/backup/delete', ...roleGate('admin', 'manager'), (req, res) => {
    const file = path.basename((req.body && req.body.file) || '')
    const p = path.join(BACKUP_DIR, file)
    if (!/\.bin$/.test(file) || !fs.existsSync(p)) return res.status(404).json({ success: false, message: '备份文件不存在' })
    fs.unlinkSync(p)
    ctx.addSysLog('删除备份', file, null, req.admin.username, req.ip)
    res.json({ success: true, message: '已删除' })
  })

  router.post('/api/admin/backup/upload', ...roleGate('admin', 'manager'), require('multer')({ dest: BACKUP_UPLOAD_DIR }).single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '请选择备份文件' })
    ctx.addSysLog('上传备份', req.file.originalname || req.file.filename, null, req.admin.username, req.ip)
    res.json({ success: true, file: req.file.filename })
  })

  router.post('/api/admin/backup/restore', ...roleGate('admin', 'manager'), (req, res) => {
    const uploaded = path.basename((req.body && req.body.file) || '')
    const password = (req.body && req.body.password) || ''
    let work = ''
    let uploadTmp = ''
    try {
      let binPath = ''
      const up = path.join(BACKUP_UPLOAD_DIR, uploaded)
      if (uploaded && fs.existsSync(up)) { binPath = up; uploadTmp = up }
      else {
        if (!/\.bin$/.test(uploaded)) throw new Error('无效的备份文件名')
        binPath = path.join(BACKUP_DIR, uploaded)
        if (!fs.existsSync(binPath)) throw new Error('备份文件不存在')
      }
      const tgz = parseBinFile(fs.readFileSync(binPath), password || '')
      work = path.join(BACKUP_DIR, '.restore-' + process.pid + '-' + Date.now())
      fs.mkdirSync(work, { recursive: true })
      const tgzPath = path.join(work, 'payload.tar.gz')
      fs.writeFileSync(tgzPath, tgz)
      execFileSync('tar', ['-xzf', tgzPath, '-C', work], { stdio: 'pipe' })
      const newDb = path.join(work, 'vehicles.db')
      if (!fs.existsSync(newDb)) throw new Error('备份内容不完整：缺少 vehicles.db')
      try {
        const { DatabaseSync } = require('node:sqlite')
        const t = new DatabaseSync(newDb)
        t.prepare('SELECT COUNT(*) FROM vehicles').get()
        t.close()
      } catch (e) {
        throw new Error('备份数据库校验失败：' + e.message)
      }
      const trash = path.join(BACKUP_DIR, 'trash-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14))
      fs.mkdirSync(trash, { recursive: true })
      for (const suffix of ['', '-wal', '-shm']) {
        const src = dbPath + suffix
        if (fs.existsSync(src)) fs.renameSync(src, path.join(trash, 'vehicles.db' + suffix))
      }
      if (fs.existsSync(ctx.uploadDir)) fs.renameSync(ctx.uploadDir, path.join(trash, 'uploads'))
      if (fs.existsSync(ctx.ASSETS_DIR)) fs.renameSync(ctx.ASSETS_DIR, path.join(trash, 'assets'))
      fs.copyFileSync(newDb, dbPath)
      const newUploads = path.join(work, 'uploads')
      if (fs.existsSync(newUploads)) copyDirRecursive(newUploads, ctx.uploadDir)
      const newAssets = path.join(work, 'assets')
      if (fs.existsSync(newAssets)) copyDirRecursive(newAssets, ctx.ASSETS_DIR)
      fs.rmSync(work, { recursive: true, force: true })
      if (uploadTmp) { try { fs.unlinkSync(uploadTmp) } catch (e) {} }
      ctx.addSysLog('恢复备份', uploaded, null, req.admin.username, req.ip)
      res.json({ success: true, message: '恢复成功，系统将在 3 秒后自动重启，请稍候重新登录' })
      setTimeout(() => { try { process.exit(0) } catch (e) {} }, 3000)
    } catch (e) {
      if (work) { try { fs.rmSync(work, { recursive: true, force: true }) } catch (e2) {} }
      if (uploadTmp) { try { fs.unlinkSync(uploadTmp) } catch (e2) {} }
      res.status(400).json({ success: false, message: e.message })
    }
  })

  return router
}
