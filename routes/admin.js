// 管理员接口（需鉴权）+ PC 管理端静态托管 + 站点图片上传
module.exports = function (ctx) {
  const express = require('express')
  const fs = require('fs')
  const path = require('path')
  const os = require('os')
  const { router, db, config, upload, authMiddleware, roleGate } = ctx
  const { normalizePlate, toPlateKey } = require('../plate')
  const { hashPassword, verifyPassword } = require('../auth')
  const { flattenIfTransparent } = require('../image')

  function nowLocal() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  // 从 User-Agent 粗略解析设备/平台类型，用于在线设备列表展示
  function parseDevice(ua) {
    if (!ua) return '未知设备'
    const s = ua
    if (/iPhone|iPad|iPod/.test(s)) return /iPad/.test(s) ? 'iPad' : 'iPhone'
    if (/Android/.test(s)) {
      const m = s.match(/Android[^;)+]+/)
      return 'Android' + (m ? ' (' + m[0] + ')' : '')
    }
    if (/Windows NT 10/.test(s)) return 'Windows 10/11'
    if (/Windows NT/.test(s)) return 'Windows'
    if (/Mac OS X/.test(s)) return 'macOS'
    if (/Linux/.test(s)) return 'Linux'
    if (/MicroMessenger/.test(s)) return '微信内置浏览器'
    if (/QQ\//.test(s)) return 'QQ 浏览器'
    if (/Edg\//.test(s)) return 'Edge'
    if (/Chrome\//.test(s)) return 'Chrome'
    if (/Firefox\//.test(s)) return 'Firefox'
    if (/Safari\//.test(s)) return 'Safari'
    return '其他浏览器'
  }

  // ===== 系统信息采样状态（用于计算 CPU 使用率 / 网络速率）=====
  let _cpuPrev = null            // 上一次 os.cpus() 的 idle/total 累计
  let _netPrev = null            // 上一次网络累计字节 { rx, tx, ts }

  function readNetStats() {
    // 读取 /proc/net/dev 累计收发包/字节（Linux）；其他平台返回 null
    try {
      const raw = fs.readFileSync('/proc/net/dev', 'utf8')
      let rx = 0, tx = 0, rxPkts = 0, txPkts = 0
      raw.split('\n').forEach(line => {
        const m = line.match(/^\s*[\w:]+\s*:\s*(\d+)\s+(\d+)\s+(\d+)\s+[\d\s]+\d+\s+(\d+)\s+(\d+)\s+(\d+)/)
        if (!m) return
        rx += Number(m[1]); rxPkts += Number(m[2])
        tx += Number(m[4]); txPkts += Number(m[5])
      })
      return { rx, tx, rxPkts, txPkts, ts: Date.now() }
    } catch (e) { return null }
  }

  function cpuUsage() {
    const cpus = os.cpus()
    let idle = 0, total = 0
    cpus.forEach(c => {
      for (const k in c.times) total += c.times[k]
      idle += c.times.idle
    })
    const cur = { idle, total }
    let pct = null
    if (_cpuPrev) {
      const dIdle = cur.idle - _cpuPrev.idle
      const dTotal = cur.total - _cpuPrev.total
      if (dTotal > 0) pct = Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100))
    }
    _cpuPrev = cur
    return { model: (cpus[0] && cpus[0].model) || '未知', cores: cpus.length, usage: pct }
  }

  function netUsage() {
    const cur = readNetStats()
    let rate = null
    if (cur && _netPrev) {
      const dt = (cur.ts - _netPrev.ts) / 1000
      if (dt > 0) {
        rate = {
          rxRate: Math.max(0, (cur.rx - _netPrev.rx) / dt),
          txRate: Math.max(0, (cur.tx - _netPrev.tx) / dt)
        }
      }
    }
    _netPrev = cur
    return { stats: cur, rate }
  }

  // 3. 登录（用户名固定 admin，前端只提交管理密码）
  router.post('/api/admin/login', (req, res) => {
    const password = (req.body && req.body.password) || ''
    const username = 'admin'
    if (!password) return res.status(400).json({ success: false, message: '请输入管理密码' })

    const fails = db.prepare(
      "SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND success = 0 AND createdAt > datetime('now','localtime', ? || ' minutes')"
    ).get(username, String(-config.LOCK_MINUTES))
    if (fails.c >= config.MAX_LOGIN_FAILS) {
      return res.status(429).json({ success: false, message: `失败次数过多，请 ${config.LOCK_MINUTES} 分钟后再试` })
    }

    let ok = false
    if (config.ADMIN_PASSWORD_HASH) {
      ok = verifyPassword(password, config.ADMIN_PASSWORD_HASH)
    } else if (config.ADMIN_PASSWORD) {
      ok = (password === config.ADMIN_PASSWORD)
      if (ok) {
        const hashed = hashPassword(password)
        config.dbSet('ADMIN_PASSWORD_HASH', hashed)
        config.dbSet('ADMIN_PASSWORD', '')
      }
    }
    db.prepare('INSERT INTO login_attempts (username, success, ip) VALUES (?,?,?)').run(username, ok ? 1 : 0, req.ip || null)
    if (!ok) {
      ctx.addSysLog('登录失败', username, '管理密码错误', username, req.ip)
      return res.status(401).json({ success: false, message: '管理密码错误' })
    }

    // 单点登录：admin 仅允许一个有效会话，登录即作废旧登录
    db.prepare('DELETE FROM admin_sessions WHERE username = ?').run(username)
    const token = ctx.genToken()
    const expireAt = new Date(Date.now() + config.TOKEN_EXPIRE_HOURS * 3600000).toLocaleString('sv')
    db.prepare('INSERT INTO admin_sessions (token, username, expireAt) VALUES (?,?,?)').run(token, username, expireAt)
    ctx.addSysLog('登录成功', username, null, username, req.ip)
    res.json({ success: true, data: { token } })
  })

  router.get('/api/admin/me', authMiddleware, (req, res) => {
    res.json({ success: true, data: { user: req.admin.username || 'admin', role: req.admin.role || 'admin', name: req.admin.name || req.admin.username } })
  })

  // 3.1 系统操作日志
  router.get('/api/admin/sys-logs', authMiddleware, (req, res) => {
    const action = req.query.action
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
    const wheres = []
    const params = []
    if (action) { wheres.push('action = ?'); params.push(action) }
    const whereSql = wheres.length ? ' WHERE ' + wheres.join(' AND ') : ''
    const total = db.prepare('SELECT COUNT(*) AS c FROM sys_logs' + whereSql).get(...params).c
    const offset = (page - 1) * pageSize
    const rows = db.prepare(`SELECT id, action, target, detail, operator, ip, CAST(createdAt AS TEXT) AS createdAt FROM sys_logs${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset)
    res.json({ success: true, data: rows, total, page, pageSize })
  })

  // 清空全部系统日志
  router.delete('/api/admin/sys-logs', authMiddleware, (req, res) => {
    try {
      db.prepare('DELETE FROM sys_logs').run()
      ctx.addSysLog('清空日志', null, '已清空全部系统日志', req.admin.username, req.ip)
      res.json({ success: true, message: '已清空全部日志' })
    } catch (e) {
      res.status(500).json({ success: false, message: '清空失败：' + e.message })
    }
  })

  // 3.5 识别日志（支持筛选、分页）
  router.get('/api/admin/logs', authMiddleware, (req, res) => {
    const channel = req.query.channel
    const start = req.query.start
    const end = req.query.end
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20))
    const wheres = []
    const params = []
    if (channel === 'app' || channel === 'mini') { wheres.push('channel IN (?,?)'); params.push('app', 'mini') }
    else if (channel === 'web' || channel === 'h5') { wheres.push('channel IN (?,?)'); params.push('web', 'h5') }
    if (start) { wheres.push('createdAt >= ?'); params.push(start + ' 00:00:00') }
    if (end) { wheres.push('createdAt <= ?'); params.push(end + ' 23:59:59') }
    const whereSql = wheres.length ? ('WHERE ' + wheres.join(' AND ')) : ''
    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM recognition_logs ${whereSql}`).get(...params)
    const total = (countRow && countRow.total) || 0
    const offset = (page - 1) * pageSize
    const rows = db.prepare(`SELECT id, plateNo, source, channel, confidence, result, image, userId, userName, username, CAST(createdAt AS TEXT) AS createdAt FROM recognition_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset)
    res.json({ success: true, data: rows, total, page, pageSize })
  })

  // 3.7 系统信息（大屏展示：操作系统 / CPU / 内存 / 流量 / 版本）
  router.get('/api/admin/sysinfo', authMiddleware, (req, res) => {
    try {
      const cpu = cpuUsage()
      const net = netUsage()
      const totalMem = os.totalmem()
      const freeMem = os.freemem()
      const usedMem = totalMem - freeMem
      const uptimeSec = os.uptime()

      // 磁盘容量（基于应用所在挂载点）
      let disk = null
      try {
        const st = fs.statfsSync(__dirname)
        const blockSize = st.bsize || st.frsize || 0
        if (blockSize && st.blocks) {
          const totalBytes = st.blocks * blockSize
          const freeBytes = st.bavail * blockSize
          const usedBytes = totalBytes - freeBytes
          disk = {
            total: totalBytes,
            free: freeBytes,
            used: usedBytes,
            usage: Number((usedBytes / totalBytes * 100).toFixed(1))
          }
        }
      } catch (e) { disk = null }
      const days = Math.floor(uptimeSec / 86400)
      const hours = Math.floor((uptimeSec % 86400) / 3600)
      const mins = Math.floor((uptimeSec % 3600) / 60)
      const uptimeStr = (days > 0 ? days + ' 天 ' : '') + hours + ' 时 ' + mins + ' 分'

      let osName = os.type()
      let release = os.release()
      // Linux 尝试读取发行版名称
      if (os.platform() === 'linux') {
        try {
          const issue = fs.readFileSync('/etc/os-release', 'utf8')
          const name = (issue.match(/^PRETTY_NAME="?([^"\n]+)/m) || [])[1]
          if (name) osName = name
        } catch (e) {}
      } else if (os.platform() === 'win32') {
        osName = 'Windows'
      } else if (os.platform() === 'darwin') {
        osName = 'macOS'
      }

      res.json({
        success: true,
        data: {
          os: {
            platform: os.platform(),
            name: osName,
            release: release,
            arch: os.arch(),
            hostname: os.hostname(),
            uptime: uptimeStr,
            nodeVersion: process.version
          },
          cpu: {
            model: cpu.model,
            cores: cpu.cores,
            usage: cpu.usage === null ? null : Number(cpu.usage.toFixed(1))
          },
          memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            usage: Number((usedMem / totalMem * 100).toFixed(1))
          },
          network: net.stats ? {
            rxBytes: net.stats.rx,
            txBytes: net.stats.tx,
            rxPkts: net.stats.rxPkts,
            txPkts: net.stats.txPkts,
            rxRate: net.rate ? Number(net.rate.rxRate.toFixed(0)) : null,
            txRate: net.rate ? Number(net.rate.txRate.toFixed(0)) : null
          } : null,
          disk: disk
        }
      })
    } catch (e) {
      res.json({ success: false, message: e.message })
    }
  })

  // 3.6 数据大屏统计
  router.get('/api/admin/stats', authMiddleware, (req, res) => {
    try {
      const today = new Date().toLocaleDateString('sv')
      const vehicleTotal = (db.prepare('SELECT COUNT(*) AS c FROM vehicles').get().c) || 0
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
      const webTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE channel IN ('web','h5')").get().c) || 0
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
      const recent = db.prepare('SELECT id, plateNo, source, channel, confidence, result, image, userId, userName, username, CAST(createdAt AS TEXT) AS createdAt FROM recognition_logs ORDER BY id DESC LIMIT 10').all()
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

  // 删除日志关联的抓拍图文件
  function deleteLogImages(ids) {
    if (!ids || !ids.length) return
    try {
      const placeholders = ids.map(() => '?').join(',')
      const rows = db.prepare(`SELECT image FROM recognition_logs WHERE id IN (${placeholders})`).all(...ids)
      for (const r of rows) {
        if (!r.image || !r.image.includes('/uploads/snapshots/')) continue
        const f = path.join(ctx.SNAP_DIR, path.basename(r.image))
        if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch (e) {} }
      }
    } catch (e) { /* 忽略 */ }
  }
  router.delete('/api/admin/logs/:id', authMiddleware, (req, res) => {
    const id = Number(req.params.id)
    deleteLogImages([id])
    db.prepare('DELETE FROM recognition_logs WHERE id = ?').run(id)
    res.json({ success: true, message: '已删除' })
  })
  router.delete('/api/admin/logs', ...roleGate('admin', 'manager'), (req, res) => {
    const all = db.prepare('SELECT id FROM recognition_logs').all().map(r => r.id)
    deleteLogImages(all)
    db.prepare('DELETE FROM recognition_logs').run()
    res.json({ success: true, message: '已清空' })
  })
  router.post('/api/admin/logs/batch-delete', authMiddleware, (req, res) => {
    const body = req.body || {}
    const channel = body.channel
    const start = body.start
    const end = body.end
    const wheres = []
    const params = []
    if (body.all) {
      if (channel === 'app' || channel === 'mini') { wheres.push('channel IN (?,?)'); params.push('app', 'mini') }
      else if (channel === 'web' || channel === 'h5') { wheres.push('channel IN (?,?)'); params.push('web', 'h5') }
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

  // 3.8 部门
  router.get('/api/admin/departments', authMiddleware, (req, res) => {
    const rows = db.prepare('SELECT name, builtin FROM departments ORDER BY builtin DESC, id ASC').all()
    res.json({ success: true, data: rows.map(r => ({ name: r.name, builtin: !!r.builtin })) })
  })
  router.post('/api/admin/departments', authMiddleware, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim()
    if (!name) return res.status(400).json({ success: false, message: '部门名称不能为空' })
    const exists = db.prepare('SELECT 1 FROM departments WHERE name = ?').get(name)
    if (exists) return res.status(409).json({ success: false, message: '该部门已存在' })
    db.prepare('INSERT INTO departments (name, builtin) VALUES (?, 0)').run(name)
    res.json({ success: true, message: '已添加', data: name })
  })
  router.delete('/api/admin/departments', authMiddleware, (req, res) => {
    const name = String((req.body && req.body.name) || '').trim()
    if (!name) return res.status(400).json({ success: false, message: '部门名称不能为空' })
    const row = db.prepare('SELECT * FROM departments WHERE name = ?').get(name)
    if (!row) return res.status(404).json({ success: false, message: '部门不存在' })
    if (row.builtin) return res.status(400).json({ success: false, message: '内置部门不可删除' })
    db.prepare('DELETE FROM departments WHERE name = ?').run(name)
    res.json({ success: true, message: '已删除部门：' + name })
  })
  router.get('/api/admin/vehicles/departments', authMiddleware, (req, res) => {
    const rows = db.prepare("SELECT department FROM vehicles WHERE department IS NOT NULL AND department <> ''").all()
    const set = new Set()
    rows.forEach(r => String(r.department || '').split(/[,，]/).forEach(x => { x = x.trim(); if (x) set.add(x) }))
    res.json({ success: true, data: [...set].sort() })
  })

  // 4. 车辆列表
  function isVehicleValid(v) {
    if (!v.validUntil) return null
    const endStr = v.validUntil.includes('~') ? v.validUntil.split('~')[1] : v.validUntil
    const end = new Date(String(endStr).replace(/-/g, '/') + ' 23:59:59').getTime()
    if (isNaN(end)) return null
    return Date.now() <= end
  }
  router.get('/api/admin/vehicles', authMiddleware, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 10))
    const dept = String(req.query.department || '').trim()
    const keyword = String(req.query.keyword || '').trim()
    const validity = String(req.query.validity || '').trim()
    let where = '', params = []
    if (dept) { where = ' WHERE department LIKE ?'; params.push('%' + dept + '%') }
    if (validity === 'long' || validity === 'temp' || validity === 'expired') {
      const endExpr = "CASE WHEN validUntil LIKE '%~%' THEN substr(validUntil, instr(validUntil,'~')+1) ELSE validUntil END"
      let cond
      if (validity === 'long') cond = "(validUntil IS NULL OR validUntil = '')"
      else if (validity === 'expired') cond = "(validUntil IS NOT NULL AND validUntil <> '' AND date(" + endExpr + ") < date('now','localtime'))"
      else cond = "(validUntil IS NOT NULL AND validUntil <> '' AND date(" + endExpr + ") >= date('now','localtime'))"
      where += (where ? ' AND' : ' WHERE') + ' ' + cond
    }
    if (keyword) {
      const kw = '%' + keyword + '%'
      where += (where ? ' AND' : ' WHERE') + ' (plateNo LIKE ? OR owner LIKE ? OR phone LIKE ?)'
      params.push(kw, kw, kw)
    }
    const totalRow = db.prepare('SELECT COUNT(*) AS c FROM vehicles' + where).get(...params)
    const total = totalRow.c
    const rows = db.prepare('SELECT * FROM vehicles' + where + ' ORDER BY id DESC LIMIT ? OFFSET ?').all(...params, pageSize, (page - 1) * pageSize)
    const data = rows.map(v => ({
      ...v,
      photoUrl: v.photo ? `${config.baseUrl(req)}/api/vehicles/${v.id}/photo` : null,
      valid: isVehicleValid(v)
    }))
    res.json({ success: true, data, total, page, pageSize })
  })

  // 按车牌查重（新增车辆时实时提示）
  router.get('/api/admin/vehicles/check', authMiddleware, (req, res) => {
    const plate = normalizePlate(String(req.query.plate || ''))
    if (!plate) return res.json({ success: true, exists: false })
    const row = db.prepare('SELECT id, plateNo, owner, department, validUntil FROM vehicles WHERE plateNo = ?').get(plate)
    if (!row) return res.json({ success: true, exists: false })
    res.json({ success: true, exists: true, data: {
      id: row.id, plateNo: row.plateNo, owner: row.owner, department: row.department, validUntil: row.validUntil
    }})
  })

  // 5. 单独上传车辆照片
  router.post('/api/admin/vehicles/photo', authMiddleware, upload.single('photo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '未收到图片' })
    // 透明 PNG 自动合成主色渐变底，输出不透明图（安卓 APP / 移动端统一显示）
    await flattenIfTransparent(req.file.path)
    res.json({ success: true, url: `${config.baseUrl(req)}/uploads/${req.file.filename}` })
  })

  // 6. 新增/编辑车辆
  router.post('/api/admin/vehicles', authMiddleware, upload.single('photo'), async (req, res) => {
    const b = req.body || {}
    const plateNo = normalizePlate(b.plateNo)
    if (!plateNo) return res.status(400).json({ success: false, message: '车牌号不能为空' })
    const plateKey = toPlateKey(plateNo)
    const photo = req.file ? `${config.baseUrl(req)}/uploads/${req.file.filename}` : (b.photo || null)
    if (req.file) await flattenIfTransparent(req.file.path)
    const editId = b.id ? parseInt(b.id) : null
    // 编辑车辆仅限 超级管理员 / 普通管理员；普通用户只能新增，不能编辑
    if (editId && req.admin.role !== 'admin' && req.admin.role !== 'manager') {
      return res.status(403).json({ success: false, message: '权限不足：编辑车辆需管理员权限' })
    }
    const existing = db.prepare('SELECT * FROM vehicles WHERE plateKey = ?').get(plateKey)
    const department = String(b.department || '').split(/[,，]/).map(s => s.trim()).filter(Boolean).join(',')
    const validUntil = String(b.validUntil || '').trim() || null
    if (editId) {
      const old = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(editId)
      if (!old) return res.status(404).json({ success: false, message: '车辆不存在，无法编辑' })
      if (existing && existing.id !== editId) {
        return res.status(409).json({ success: false, message: '该车牌已存在，请勿重复添加' })
      }
      const finalPhoto = req.file ? photo : (b.photo !== undefined ? b.photo : (old.photo || null))
      db.prepare(`UPDATE vehicles SET plateNo=?, plateKey=?, owner=?, phone=?, department=?, remark=?, photo=?, validUntil=?, updatedAt=? WHERE id=?`)
        .run(plateNo, plateKey, b.owner || '', b.phone || '', department, b.remark || '', finalPhoto, validUntil, nowLocal(), editId)
    } else {
      if (existing) {
        return res.status(409).json({ success: false, message: '该车牌已存在，请勿重复添加' })
      }
      db.prepare(`INSERT INTO vehicles (plateNo, plateKey, owner, phone, department, remark, photo, validUntil, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(plateNo, plateKey, b.owner || '', b.phone || '', department, b.remark || '', photo, validUntil, nowLocal(), nowLocal())
    }
    ctx.addSysLog(editId ? '编辑车辆' : '新增车辆', plateNo, editId ? null : ('车主：' + (b.owner || '')), (req.admin && req.admin.username) || (req.user && req.user.username) || '未知', req.ip)
    res.json({ success: true, message: '保存成功' })
  })
  // 6.0 批量新增车辆（多行表单 / 批量输入，后端仅接收已解析的数组）
  // conflict 策略：skip(默认，跳过已存在) / update(覆盖已存在) / force(强制新增重复记录)
  router.post('/api/admin/vehicles/batch-create', ...roleGate('admin', 'manager', 'user'), (req, res) => {
    const body = req.body || {}
    let items = body.items
    const conflict = (body.conflict === 'update' || body.conflict === 'force') ? body.conflict : 'skip'
    if (!Array.isArray(items)) return res.status(400).json({ success: false, message: '数据格式错误' })
    items = items.slice(0, 1000)
    if (!items.length) return res.status(400).json({ success: false, message: '未解析到任何车辆数据' })
    const added = [], skipped = [], updated = [], errors = [], conflictPlates = []
    const seenKeys = new Set()
    for (const it of items) {
      const plateNo = normalizePlate(it.plateNo || it.车牌号 || it.车牌 || '')
      if (!plateNo) { errors.push('车牌号为空，已跳过'); continue }
      const plateKey = toPlateKey(plateNo)
      if (seenKeys.has(plateKey)) { skipped.push(plateNo); continue }   // 本次批量内重复
      const existing = db.prepare('SELECT id FROM vehicles WHERE plateKey = ?').get(plateKey)
      if (existing) {
        conflictPlates.push(plateNo)
        if (conflict === 'skip') { skipped.push(plateNo); continue }    // 命中数据库已有数据
        const department = String(it.department || it.部门 || '').split(/[,，]/).map(s => s.trim()).filter(Boolean).join(',')
        const validUntil = String(it.validUntil || it.有效期 || '').trim() || null
        if (conflict === 'update') {
          // 覆盖更新已有记录（保留原照片）
          db.prepare(`UPDATE vehicles SET owner=?, phone=?, department=?, remark=?, validUntil=?, updatedAt=? WHERE id=?`)
            .run(String(it.owner || it.车主 || '').trim(), String(it.phone || it.手机号 || '').trim(),
              department, String(it.remark || it.备注 || '').trim(), validUntil, nowLocal(), existing.id)
          updated.push(plateNo); seenKeys.add(plateKey); continue
        }
        // force：允许重复插入
      }
      const department = String(it.department || it.部门 || '').split(/[,，]/).map(s => s.trim()).filter(Boolean).join(',')
      const validUntil = String(it.validUntil || it.有效期 || '').trim() || null
      db.prepare(`INSERT INTO vehicles (plateNo, plateKey, owner, phone, department, remark, photo, validUntil, createdAt, updatedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(plateNo, plateKey, String(it.owner || it.车主 || '').trim(), String(it.phone || it.手机号 || '').trim(),
          department, String(it.remark || it.备注 || '').trim(), null, validUntil, nowLocal(), nowLocal())
      seenKeys.add(plateKey)
      added.push(plateNo)
    }
    const op = (req.admin && req.admin.username) || (req.user && req.user.username) || '未知'
    ctx.addSysLog('批量新增车辆', null,
      `新增 ${added.length} 条` + (updated.length ? `，更新 ${updated.length} 条` : '') + (skipped.length ? `，跳过 ${skipped.length} 条` : '') + (errors.length ? `，忽略无效 ${errors.length} 条` : ''),
      op, req.ip)
    res.json({
      success: true,
      message: `新增 ${added.length} 条` + (updated.length ? `，更新 ${updated.length} 条` : '') + (skipped.length ? `，跳过 ${skipped.length} 条` : '') + (errors.length ? `，忽略无效 ${errors.length} 条` : ''),
      added: added.length, updated: updated.length, skipped: skipped.length, errors: errors.length,
      conflictPlates
    })
  })

  // 6. 删除车辆
  router.delete('/api/admin/vehicles/:id', ...roleGate('admin', 'manager'), (req, res) => {
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id)
    if (!v) return res.status(404).json({ success: false, message: '车辆不存在' })
    if (v.photo && v.photo.includes('/uploads/')) {
      const f = path.join(ctx.uploadDir, path.basename(v.photo))
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id)
    ctx.addSysLog('删除车辆', v.plateNo, null, req.admin.username, req.ip)
    res.json({ success: true, message: '删除成功' })
  })

  // 6.1 批量删除车辆
  router.post('/api/admin/vehicles/batch-delete', ...roleGate('admin', 'manager'), (req, res) => {
    const body = req.body || {}
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => n > 0) : []
    if (!ids.length) return res.status(400).json({ success: false, message: '未选择任何车辆' })
    const placeholders = ids.map(() => '?').join(',')
    const rows = db.prepare(`SELECT * FROM vehicles WHERE id IN (${placeholders})`).all(...ids)
    for (const v of rows) {
      if (v.photo && v.photo.includes('/uploads/')) {
        const f = path.join(ctx.uploadDir, path.basename(v.photo))
        if (fs.existsSync(f)) { try { fs.unlinkSync(f) } catch (e) {} }
      }
    }
    db.prepare(`DELETE FROM vehicles WHERE id IN (${placeholders})`).run(...ids)
    ctx.addSysLog('批量删除车辆', null, `删除 ${rows.length} 辆：${rows.map(r => r.plateNo).join('、')}`, req.admin.username, req.ip)
    res.json({ success: true, message: `已删除 ${rows.length} 辆车` })
  })

  // 7. 退出登录
  router.post('/api/admin/logout', authMiddleware, (req, res) => {
    const op = req.admin.username || 'admin'
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(req.admin.token)
    ctx.addSysLog('退出登录', op, null, op, req.ip)
    res.json({ success: true })
  })

  // 7.5 修改管理员密码
  router.post('/api/admin/change-password', authMiddleware, (req, res) => {
    const { oldPassword, newPassword } = req.body || {}
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, message: '新密码至少 6 位' })
    if (req.admin.username !== config.ADMIN_USERNAME) return res.status(403).json({ success: false, message: '无权限' })
    const oldOk = config.ADMIN_PASSWORD_HASH
      ? verifyPassword(oldPassword, config.ADMIN_PASSWORD_HASH)
      : (config.ADMIN_PASSWORD && oldPassword === config.ADMIN_PASSWORD)
    if (!oldOk) return res.status(401).json({ success: false, message: '旧密码错误' })
    const hashed = hashPassword(newPassword)
    config.dbSet('ADMIN_PASSWORD_HASH', hashed)
    config.dbSet('ADMIN_PASSWORD', '')
    // 使管理员旧会话立即失效，强制重新登录
    try { db.prepare("DELETE FROM user_sessions WHERE username = ?").run(config.ADMIN_USERNAME) } catch (e) {}
    ctx.addSysLog('修改密码', config.ADMIN_USERNAME, null, config.ADMIN_USERNAME, req.ip)
    res.json({ success: true, message: '密码已修改，请重新登录' })
  })

  // 8.1 普通用户管理（管理员创建 / 查看 / 删除 / 重置密码）
  router.get('/api/admin/users', ...roleGate('admin', 'manager'), (req, res) => {
    const rows = db.prepare("SELECT id, username, name, phone, role, remark, strftime('%Y-%m-%d %H:%M:%S', CAST(createdAt AS TEXT)) AS createdAt FROM users ORDER BY id DESC").all()
    // 超级管理员（admin）不在 users 表，作为只读虚拟行并入列表，禁止编辑/删除
    const adminVirtual = { id: 0, username: 'admin', name: '超级管理员', phone: '', role: 'admin', remark: '内置超级管理员，不可编辑/删除', createdAt: '', isAdmin: true }
    res.json({ success: true, data: [adminVirtual, ...rows] })
  })
  // 在线设备：列出所有有效用户会话（含来源 IP、设备、登录时间），用于用户管理页展示
  router.get('/api/admin/user-sessions', ...roleGate('admin', 'manager'), (req, res) => {
    const now = new Date().toLocaleString('sv')
    const rows = db.prepare(
      `SELECT s.token, s.userId, s.username, s.ip, s.ua,
              strftime('%Y-%m-%d %H:%M:%S', CAST(s.createdAt AS TEXT)) AS loginAt,
              s.expireAt
       FROM user_sessions s
       WHERE datetime(s.expireAt) >= datetime(?)
       ORDER BY s.userId ASC, datetime(s.createdAt) ASC`
    ).all(now)
    const list = rows.map(r => ({
      token: r.token,
      userId: r.userId,
      username: r.username,
      ip: r.ip || '',
      ua: r.ua || '',
      device: parseDevice(r.ua || ''),
      loginAt: r.loginAt || '',
      expireAt: r.expireAt || ''
    }))
    res.json({ success: true, data: { maxDevices: config.MAX_USER_DEVICES || 3, sessions: list } })
  })
  // 强制下线某设备会话
  router.delete('/api/admin/user-sessions/:token', ...roleGate('admin', 'manager'), (req, res) => {
    const token = req.params.token
    const row = db.prepare('SELECT username FROM user_sessions WHERE token = ?').get(token)
    if (!row) return res.json({ success: true, message: '该会话已不存在' })
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token)
    ctx.addSysLog('强制下线', row.username, '踢出设备会话', req.admin.username, req.ip)
    res.json({ success: true, message: '已强制下线' })
  })
  router.post('/api/admin/users', ...roleGate('admin', 'manager'), (req, res) => {
    const username = String((req.body && req.body.username) || '').trim()
    const password = String((req.body && req.body.password) || '')
    const name = String((req.body && req.body.name) || '').trim()
    const phone = String((req.body && req.body.phone) || '').trim()
    const remark = String((req.body && req.body.remark) || '').trim()
    // 角色：仅允许 admin/manager 创建用户时指定，普通用户不可越权；缺省为 user
    let role = String((req.body && req.body.role) || 'user').trim()
    if (role !== 'admin' && role !== 'manager' && role !== 'user') role = 'user'
    if (!username) return res.status(400).json({ success: false, message: '账号不能为空' })
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) return res.status(400).json({ success: false, message: '账号限 2-20 位字母/数字/中文/下划线' })
    if (password.length < 6) return res.status(400).json({ success: false, message: '初始密码至少 6 位' })
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ success: false, message: '手机号格式不正确' })
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ success: false, message: '该账号已存在' })
    if (phone && db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) return res.status(409).json({ success: false, message: '该手机号已绑定其他账号' })
    const info = db.prepare('INSERT INTO users (username, password_hash, role, name, phone, remark, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(username, hashPassword(password), role, name || null, phone || null, remark, nowLocal(), nowLocal())
    ctx.addSysLog('创建用户', username, '角色：' + role + (name ? '，姓名：' + name : ''), req.admin.username, req.ip)
    res.json({ success: true, message: '用户已创建', id: info.lastInsertRowid })
  })
  // 编辑用户（admin 虚拟行 id=0 不可编辑）
  router.put('/api/admin/users/:id', ...roleGate('admin', 'manager'), (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.status(400).json({ success: false, message: '内置管理员不可编辑' })
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!u) return res.status(404).json({ success: false, message: '用户不存在' })
    const name = String((req.body && req.body.name) || '').trim()
    const phone = String((req.body && req.body.phone) || '').trim()
    const remark = String((req.body && req.body.remark) || '').trim()
    const password = String((req.body && req.body.password) || '')
    let role = String((req.body && req.body.role) || u.role).trim()
    if (role !== 'admin' && role !== 'manager' && role !== 'user') role = u.role
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ success: false, message: '手机号格式不正确' })
    if (password && password.length < 6) return res.status(400).json({ success: false, message: '新密码至少 6 位' })
    db.prepare('UPDATE users SET name = ?, phone = ?, remark = ?, role = ?, updatedAt = ? WHERE id = ?')
      .run(name || null, phone || null, remark, role, nowLocal(), id)
    if (password) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), id)
      db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(id) // 改密后强制重新登录
    }
    ctx.addSysLog('编辑用户', u.username, '角色：' + role + (password ? '，已重置密码' : ''), req.admin.username, req.ip)
    res.json({ success: true, message: '用户已更新' + (password ? '，该用户需重新登录' : '') })
  })
  router.get('/api/admin/users/:id', ...roleGate('admin', 'manager'), (req, res) => {
    const id = Number(req.params.id)
    if (!id) return res.json({ success: true, data: { id: 0, username: 'admin', name: '超级管理员', phone: '', role: 'admin', remark: '内置超级管理员，不可编辑/删除' } })
    const u = db.prepare('SELECT id, username, name, phone, role, remark FROM users WHERE id = ?').get(id)
    if (!u) return res.status(404).json({ success: false, message: '用户不存在' })
    res.json({ success: true, data: u })
  })
  router.delete('/api/admin/users/:id', ...roleGate('admin', 'manager'), (req, res) => {
    const id = Number(req.params.id)
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!u) return res.status(404).json({ success: false, message: '用户不存在' })
    db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(id)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    ctx.addSysLog('删除用户', u.username, null, req.admin.username, req.ip)
    res.json({ success: true, message: '已删除用户：' + (u.name || u.username) })
  })
  router.post('/api/admin/users/reset-password', ...roleGate('admin', 'manager'), (req, res) => {
    const id = Number((req.body && req.body.id))
    const password = String((req.body && req.body.password) || '')
    if (!password || password.length < 6) return res.status(400).json({ success: false, message: '新密码至少 6 位' })
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!u) return res.status(404).json({ success: false, message: '用户不存在' })
    db.prepare('UPDATE users SET password_hash = ?, updatedAt = ? WHERE id = ?').run(hashPassword(password), nowLocal(), id)
    db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(id)
    ctx.addSysLog('重置密码', u.username, null, req.admin.username, req.ip)
    res.json({ success: true, message: '密码已重置，该用户需重新登录' })
  })

  // 8. 系统设置
  const SETTING_FIELDS = [
    { key: 'BAIDU_API_KEY', label: '百度 OCR API Key', placeholder: '', secret: true },
    { key: 'BAIDU_SECRET_KEY', label: '百度 OCR Secret Key', placeholder: '', secret: true },
    { key: 'TENCENT_SECRET_ID', label: '腾讯云 SecretId', placeholder: '', secret: true },
    { key: 'TENCENT_SECRET_KEY', label: '腾讯云 SecretKey', placeholder: '', secret: true },
    { key: 'ALIYUN_ACCESS_KEY_ID', label: '阿里云 AccessKeyId', placeholder: '', secret: true },
    { key: 'ALIYUN_ACCESS_KEY_SECRET', label: '阿里云 AccessKeySecret', placeholder: '', secret: true },
    { key: 'ALIYUN_REGION', label: '阿里云 Region', placeholder: 'cn-shanghai', secret: false },
    { key: 'HUAWEI_AK', label: '华为云 Ak', placeholder: '', secret: true },
    { key: 'HUAWEI_SK', label: '华为云 Sk', placeholder: '', secret: true },
    { key: 'HUAWEI_PROJECT_ID', label: '华为云 ProjectId', placeholder: '', secret: false },
    { key: 'HUAWEI_REGION', label: '华为云 Region', placeholder: 'cn-north-4', secret: false },
    { key: 'CUSTOM_OCR_URL', label: '自定义 OCR 接口 URL', placeholder: 'https://your-api.com/recognize', secret: false },
    { key: 'CUSTOM_OCR_METHOD', label: '自定义 OCR 请求方法', placeholder: 'POST', secret: false },
    { key: 'CUSTOM_OCR_HEADERS', label: '自定义 OCR 请求头（JSON）', placeholder: '{"Authorization":"Bearer xxx"}', secret: true },
    { key: 'CUSTOM_OCR_BODY_TEMPLATE', label: '自定义 OCR 请求体模板', placeholder: '{"image":"{{base64}}"}', secret: false },
    { key: 'CUSTOM_OCR_PLATE_FIELD', label: '自定义 OCR 车牌字段', placeholder: 'plateNo', secret: false },
    { key: 'CUSTOM_OCR_CONFIDENCE_FIELD', label: '自定义 OCR 置信度字段', placeholder: 'confidence', secret: false },
    { key: 'CUSTOM_OCR_COLOR_FIELD', label: '自定义 OCR 颜色字段', placeholder: 'color', secret: false },
    { key: 'COMPANY_NAME', label: '公司名称', placeholder: '如：乾明车牌识别系统 / XX公司', secret: false },
    { key: 'ICP_NO', label: 'ICP 备案号', placeholder: '如：粤ICP备XXXXXXXX号', secret: false },
    { key: 'POLICE_NO', label: '公安备案号', placeholder: '如：粤公网安备XXXXXXXX号', secret: false },
    { key: 'POLICE_URL', label: '公安备案链接', placeholder: 'https://beian.mps.gov.cn/#/query/webSearch', secret: false, hideInForm: true },
    { key: 'LOGO_URL', label: '站点 LOGO', placeholder: '/static/images/logo.png', secret: false, image: true },
    { key: 'LOGO_ICON_URL', label: 'LOGO-纯图标（菜单/页脚）', placeholder: '/static/images/logo.png', secret: false, image: true },
    { key: 'LOGO_HORIZONTAL_URL', label: 'LOGO-横版（图标+公司名）', placeholder: '/static/images/logo2.png', secret: false, image: true },
    { key: 'LOGO_VERTICAL_URL', label: 'LOGO-竖版（图标在上+公司名）', placeholder: '/static/images/logo3.png', secret: false, image: true },
    { key: 'POLICE_ICON_URL', label: '公安备案图标', placeholder: '/static/images/police.png', secret: false, image: true, hideInForm: true }
  ]
  function maskSecret(v) {
    v = v || ''
    if (!v) return ''
    if (v.length <= 6) return '••••••'
    return v.slice(0, 4) + '••••••' + v.slice(-4)
  }
  router.get('/api/admin/settings', ...roleGate('admin', 'manager'), (req, res) => {
    const data = SETTING_FIELDS.map(f => ({
      key: f.key,
      label: f.label,
      secret: !!f.secret,
      image: !!f.image,
      hideInForm: !!f.hideInForm,
      // 优先读数据库 settings 表（已保存的值）；无记录时回退到 config 中的 getter/.env
      value: f.secret ? maskSecret(config.dbGet(f.key, config[f.key] || '')) : (config.dbGet(f.key, config[f.key] || '') || '')
    }))
    res.json({ success: true, data })
  })
  router.post('/api/admin/settings', ...roleGate('admin', 'manager'), (req, res) => {
    const body = req.body || {}
    for (const f of SETTING_FIELDS) {
      if (f.key in body) {
        const val = String(body[f.key] || '').trim()
        if (f.secret && !val) continue
        config.dbSet(f.key, val)
      }
    }
    ctx.addSysLog('保存系统设置', null, '已更新 ' + Object.keys(body).filter(k => k in body).join('、'), req.admin.username, req.ip)
    res.json({ success: true, message: '已保存，配置即时生效' })
  })

  // 9. 站点图片资源上传
  router.post('/api/admin/upload', ...roleGate('admin', 'manager'), upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ success: false, message: '请选择图片' })
    // 透明 PNG 自动合成主色渐变底（LOGO / 图标等），保证 APP 图标/开屏等展示统一
    await flattenIfTransparent(req.file.path)
    const dest = path.join(ctx.ASSETS_DIR, req.file.filename)
    fs.copyFileSync(req.file.path, dest)
    fs.unlinkSync(req.file.path)
    const url = `/uploads/assets/${req.file.filename}`
    res.json({ success: true, url })
  })

  return router
}
