// 管理员接口（需鉴权）+ PC 管理端静态托管 + 站点图片上传
module.exports = function (ctx) {
  const express = require('express')
  const fs = require('fs')
  const path = require('path')
  const { router, db, config, upload, authMiddleware } = ctx
  const { normalizePlate, toPlateKey } = require('../plate')
  const { hashPassword, verifyPassword } = require('../auth')
  const { flattenIfTransparent } = require('../image')

  function nowLocal() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
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
    db.prepare('INSERT INTO login_attempts (username, success) VALUES (?,?)').run(username, ok ? 1 : 0)
    if (!ok) return res.status(401).json({ success: false, message: '管理密码错误' })

    const token = ctx.genToken()
    const expireAt = new Date(Date.now() + config.TOKEN_EXPIRE_HOURS * 3600000).toLocaleString('sv')
    db.prepare('INSERT INTO admin_sessions (token, username, expireAt) VALUES (?,?,?)').run(token, username, expireAt)
    res.json({ success: true, data: { token } })
  })

  router.get('/api/admin/me', authMiddleware, (req, res) => {
    res.json({ success: true, data: { user: req.admin.username || 'admin' } })
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
    else if (channel === 'web') { wheres.push('channel = ?'); params.push('web') }
    if (start) { wheres.push('createdAt >= ?'); params.push(start + ' 00:00:00') }
    if (end) { wheres.push('createdAt <= ?'); params.push(end + ' 23:59:59') }
    const whereSql = wheres.length ? ('WHERE ' + wheres.join(' AND ')) : ''
    const countRow = db.prepare(`SELECT COUNT(*) AS total FROM recognition_logs ${whereSql}`).get(...params)
    const total = (countRow && countRow.total) || 0
    const offset = (page - 1) * pageSize
    const rows = db.prepare(`SELECT id, plateNo, source, channel, confidence, result, image, userId, userName, CAST(createdAt AS TEXT) AS createdAt FROM recognition_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, offset)
    res.json({ success: true, data: rows, total, page, pageSize })
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
      const webTotal = (db.prepare("SELECT COUNT(*) AS c FROM recognition_logs WHERE channel = 'web'").get().c) || 0
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
  router.delete('/api/admin/logs', authMiddleware, (req, res) => {
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
    res.json({ success: true, message: '保存成功' })
  })

  // 6. 删除车辆
  router.delete('/api/admin/vehicles/:id', authMiddleware, (req, res) => {
    const v = db.prepare('SELECT * FROM vehicles WHERE id = ?').get(req.params.id)
    if (!v) return res.status(404).json({ success: false, message: '车辆不存在' })
    if (v.photo && v.photo.includes('/uploads/')) {
      const f = path.join(ctx.uploadDir, path.basename(v.photo))
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }
    db.prepare('DELETE FROM vehicles WHERE id = ?').run(req.params.id)
    res.json({ success: true, message: '删除成功' })
  })

  // 6.1 批量删除车辆
  router.post('/api/admin/vehicles/batch-delete', authMiddleware, (req, res) => {
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
    res.json({ success: true, message: `已删除 ${rows.length} 辆车` })
  })

  // 7. 退出登录
  router.post('/api/admin/logout', authMiddleware, (req, res) => {
    db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(req.admin.token)
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
    res.json({ success: true, message: '密码已修改，请重新登录' })
  })

  // 8.1 普通用户管理（管理员创建 / 查看 / 删除 / 重置密码）
  router.get('/api/admin/users', authMiddleware, (req, res) => {
    const rows = db.prepare("SELECT id, username, name, phone, role, remark, strftime('%Y-%m-%d %H:%M:%S', CAST(createdAt AS TEXT)) AS createdAt FROM users ORDER BY id DESC").all()
    res.json({ success: true, data: rows })
  })
  router.post('/api/admin/users', authMiddleware, (req, res) => {
    const username = String((req.body && req.body.username) || '').trim()
    const password = String((req.body && req.body.password) || '')
    const name = String((req.body && req.body.name) || '').trim()
    const phone = String((req.body && req.body.phone) || '').trim()
    const remark = String((req.body && req.body.remark) || '').trim()
    if (!username) return res.status(400).json({ success: false, message: '账号不能为空' })
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/.test(username)) return res.status(400).json({ success: false, message: '账号限 2-20 位字母/数字/中文/下划线' })
    if (password.length < 6) return res.status(400).json({ success: false, message: '初始密码至少 6 位' })
    if (phone && !/^1[3-9]\d{9}$/.test(phone)) return res.status(400).json({ success: false, message: '手机号格式不正确' })
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return res.status(409).json({ success: false, message: '该账号已存在' })
    if (phone && db.prepare('SELECT 1 FROM users WHERE phone = ?').get(phone)) return res.status(409).json({ success: false, message: '该手机号已绑定其他账号' })
    const info = db.prepare('INSERT INTO users (username, password_hash, role, name, phone, remark, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)')
      .run(username, hashPassword(password), 'user', name || null, phone || null, remark, nowLocal(), nowLocal())
    res.json({ success: true, message: '用户已创建', id: info.lastInsertRowid })
  })
  router.delete('/api/admin/users/:id', authMiddleware, (req, res) => {
    const id = Number(req.params.id)
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!u) return res.status(404).json({ success: false, message: '用户不存在' })
    db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(id)
    db.prepare('DELETE FROM users WHERE id = ?').run(id)
    res.json({ success: true, message: '已删除用户：' + (u.name || u.username) })
  })
  router.post('/api/admin/users/reset-password', authMiddleware, (req, res) => {
    const id = Number((req.body && req.body.id))
    const password = String((req.body && req.body.password) || '')
    if (!password || password.length < 6) return res.status(400).json({ success: false, message: '新密码至少 6 位' })
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id)
    if (!u) return res.status(404).json({ success: false, message: '用户不存在' })
    db.prepare('UPDATE users SET password_hash = ?, updatedAt = ? WHERE id = ?').run(hashPassword(password), nowLocal(), id)
    db.prepare('DELETE FROM user_sessions WHERE userId = ?').run(id)
    res.json({ success: true, message: '密码已重置，该用户需重新登录' })
  })

  // 8. 系统设置
  const SETTING_FIELDS = [
    { key: 'BAIDU_API_KEY', label: '百度 OCR API Key', placeholder: '', secret: true },
    { key: 'BAIDU_SECRET_KEY', label: '百度 OCR Secret Key', placeholder: '', secret: true },
    { key: 'TENCENT_SECRET_ID', label: '腾讯云 SecretId', placeholder: '', secret: true },
    { key: 'TENCENT_SECRET_KEY', label: '腾讯云 SecretKey', placeholder: '', secret: true },
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
  router.get('/api/admin/settings', authMiddleware, (req, res) => {
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
  router.post('/api/admin/settings', authMiddleware, (req, res) => {
    const body = req.body || {}
    for (const f of SETTING_FIELDS) {
      if (f.key in body) {
        const val = String(body[f.key] || '').trim()
        if (f.secret && !val) continue
        config.dbSet(f.key, val)
      }
    }
    res.json({ success: true, message: '已保存，配置即时生效' })
  })

  // 9. 站点图片资源上传
  router.post('/api/admin/upload', authMiddleware, upload.single('image'), async (req, res) => {
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
