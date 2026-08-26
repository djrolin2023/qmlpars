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

  // 生成一次数据备份（仅数据库，可加密），返回 .bin 文件信息
  function createBackup(password) {
    const bin = makeBinFile(buildDataBin(), password)
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const binName = `qmlpars-backup-${stamp}.bin`
    fs.writeFileSync(path.join(BACKUP_DIR, binName), bin)
    const st = fs.statSync(path.join(BACKUP_DIR, binName))
    return { file: binName, size: st.size, time: st.mtimeMs, encrypted: !!password }
  }

  // 生成迁移包：数据备份(.bin) + 全部上传图片(uploads) -> .zip（可加密）
  function createMigrateZip(password) {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch (e) { /* WAL 合并失败不阻塞 */ }
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const zipName = `qmlpars-migrate-${stamp}.zip`
    const zipPath = path.join(BACKUP_DIR, zipName)
    const work = path.join(BACKUP_DIR, '.migrate-' + process.pid + '-' + Date.now())
    const dataDir = path.join(work, 'data')
    const upDir = path.join(work, 'uploads')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(upDir, { recursive: true })
    // 1) 数据备份（.bin 放入 data/ 目录）
    const bin = makeBinFile(buildDataBin(), password)
    fs.writeFileSync(path.join(dataDir, 'backup.bin'), bin)
    // 2) 复制全部上传图片（车辆照片 + 抓拍快照 + 其它）
    if (fs.existsSync(ctx.uploadDir)) {
      try { execFileSync('cp', ['-a', ctx.uploadDir + '/.', upDir + '/'], { stdio: 'pipe' }) } catch (e) {
        copyDirRecursive(ctx.uploadDir, upDir)
      }
    }
    // 3) 打包成 zip（可加密）—— 优先用系统 zip，缺失时用 Node 内置生成未加密 zip
    try {
      const args = ['-r', '-q']
      if (password) { args.push('-P', password) }
      args.push(zipPath, '.')
      execFileSync('zip', args, { cwd: work, stdio: 'pipe' })
    } catch (e) {
      buildZipWithNode(path.join(work), zipPath)
    }
    fs.rmSync(work, { recursive: true, force: true })
    const st = fs.statSync(zipPath)
    return { file: zipName, size: st.size, time: st.mtimeMs, encrypted: !!password }
  }

  // 纯 Node 实现的简单 zip 打包（存储模式，不压缩；无密码加密能力），仅作系统无 zip 时的兜底
  function buildZipWithNode(srcDir, zipPath) {
    const files = []
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.isFile()) files.push(p)
      }
    }
    walk(srcDir)
    const chunks = []
    const central = []
    let offset = 0
    const enc = s => Buffer.from(s, 'utf8')
    for (const f of files) {
      const rel = path.relative(srcDir, f).split(path.sep).join('/')
      const data = fs.readFileSync(f)
      const nameBuf = enc(rel)
      const local = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]), // local file header sig
        Buffer.from([20, 0]), // version needed
        Buffer.from([0, 0]), // flags
        Buffer.from([0, 0]), // method: store
        Buffer.from([0, 0]), // mod time
        Buffer.from([0, 0]), // mod date
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(crc32(data), 0); return b })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(data.length, 0); return b })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(data.length, 0); return b })(),
        (() => { const b = Buffer.alloc(2); b.writeUInt16LE(nameBuf.length, 0); return b })(),
        Buffer.from([0, 0]),
        nameBuf, data
      ])
      chunks.push(local)
      const c = Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x01, 0x02]),
        Buffer.from([20, 0]), // version made by
        Buffer.from([20, 0]), // version needed
        Buffer.from([0, 0]), // flags
        Buffer.from([0, 0]), // method
        Buffer.from([0, 0]), // mod time
        Buffer.from([0, 0]), // mod date
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(crc32(data), 0); return b })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(data.length, 0); return b })(),
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(data.length, 0); return b })(),
        (() => { const b = Buffer.alloc(2); b.writeUInt16LE(nameBuf.length, 0); return b })(),
        Buffer.from([0, 0]), // extra len
        Buffer.from([0, 0]), // comment len
        Buffer.from([0, 0]), // disk number
        Buffer.from([0, 0]), // internal attr
        Buffer.from([0, 0, 0, 0]), // external attr
        (() => { const b = Buffer.alloc(4); b.writeUInt32LE(offset, 0); return b })(),
        nameBuf
      ])
      central.push(c)
      offset += local.length
    }
    const centralBuf = Buffer.concat(central)
    const end = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x05, 0x06]),
      Buffer.from([0, 0]), // disk number
      Buffer.from([0, 0]), // disk with central
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(files.length, 0); return b })(),
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(files.length, 0); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(centralBuf.length, 0); return b })(),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(offset, 0); return b })(),
      Buffer.from([0, 0]) // comment len
    ])
    fs.writeFileSync(zipPath, Buffer.concat([...chunks, centralBuf, end]))
  }

  // CRC32 计算（用于 zip 兜底）
  function crc32(buf) {
    let c = ~0
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
    }
    return ~c >>> 0
  }

  // 生成纯数据备份的 .bin payload（数据库文件）
  function buildDataBin() {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)') } catch (e) { /* WAL 合并失败不阻塞 */ }
    const work = path.join(BACKUP_DIR, '.build-' + process.pid + '-' + Date.now())
    fs.mkdirSync(work, { recursive: true })
    const dbCopy = path.join(work, 'vehicles.db')
    fs.copyFileSync(dbPath, dbCopy)
    const tgzPath = path.join(work, 'payload.tar.gz')
    try {
      execFileSync('tar', ['-czf', tgzPath, '-C', work, 'vehicles.db'], { stdio: 'pipe' })
      const tgz = fs.readFileSync(tgzPath)
      fs.rmSync(work, { recursive: true, force: true })
      return tgz
    } catch (e) {
      fs.rmSync(work, { recursive: true, force: true })
      throw new Error('数据打包失败：' + e.message)
    }
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
      const body = req.body || {}
      const password = body.password || ''
      const mode = body.mode === 'migrate' ? 'migrate' : 'data'
      const info = mode === 'migrate' ? createMigrateZip(password) : createBackup(password)
      const label = mode === 'migrate' ? '打包迁移' : '创建备份'
      ctx.addSysLog(label, info.file, password ? '已加密' : '未加密', req.admin.username, req.ip)
      res.json({ success: true, mode, ...info, message: mode === 'migrate' ? '迁移包已生成' : '备份成功' })
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
        .filter(f => f.endsWith('.bin') || f.endsWith('.zip'))
        .map(f => {
          const st = fs.statSync(path.join(BACKUP_DIR, f))
          const isZip = f.endsWith('.zip')
          return { file: f, kind: isZip ? 'migrate' : 'data', size: st.size, time: st.mtimeMs }
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
    if (!/(\.bin|\.zip)$/.test(file) || !fs.existsSync(p)) return res.status(404).json({ success: false, message: '备份文件不存在' })
    res.download(p, file)
  })

  router.post('/api/admin/backup/delete', ...roleGate('admin', 'manager'), (req, res) => {
    const file = path.basename((req.body && req.body.file) || '')
    const p = path.join(BACKUP_DIR, file)
    if (!/(\.bin|\.zip)$/.test(file) || !fs.existsSync(p)) return res.status(404).json({ success: false, message: '备份文件不存在' })
    fs.unlinkSync(p)
    ctx.addSysLog('删除备份', file, null, req.admin.username, req.ip)
    res.json({ success: true, message: '已删除' })
  })

  router.post('/api/admin/backup/upload', ...roleGate('admin', 'manager'), require('multer')({ dest: BACKUP_UPLOAD_DIR }).single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '请选择备份文件' })
    const ok = /(\.bin|\.zip)$/.test(req.file.originalname || '')
    if (!ok) { try { fs.unlinkSync(req.file.path) } catch (e) {} return res.status(400).json({ success: false, message: '仅支持 .bin 或 .zip 备份文件' }) }
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
