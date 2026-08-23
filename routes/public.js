// 公开接口（无需登录）：车牌识别、车辆查询、车辆照片访问
// 由 index.js 以 ctx 注入共享依赖后挂载
module.exports = function (ctx) {
  const express = require('express')
  const fs = require('fs')
  const path = require('path')
  const { router } = ctx
  const { db, config, upload, authMiddleware, userAuthMiddleware, genUserToken } = ctx
  const { hashPassword, verifyPassword } = require('../auth')
  const { normalizePlate, toPlateKey } = require('../plate')
  const { recognizeByBaidu, recognizeByTencent } = require('../ocr')

  // 用户登录（H5/APP 端）：普通用户（账号/手机号/ID）或管理员账号均可登录
  router.post('/api/auth/login', (req, res) => {
    const account = String((req.body && req.body.username) || '').trim()
    const password = String((req.body && req.body.password) || '')
    if (!account || !password) return res.status(400).json({ success: false, message: '请输入账号和密码' })

    // 登录失败锁定：防止账号/手机号被暴力破解（时间窗口直接在 SQL 内用本地时计算，避免 JS 日期格式化差异）
    const fails = db.prepare(
      "SELECT COUNT(*) AS c FROM login_attempts WHERE username = ? AND success = 0 AND createdAt > datetime('now','localtime', ? || ' minutes')"
    ).get(account, String(-config.LOCK_MINUTES))
    if (fails.c >= config.MAX_LOGIN_FAILS) {
      return res.status(429).json({ success: false, message: `失败次数过多，请 ${config.LOCK_MINUTES} 分钟后再试` })
    }

    // 1) 优先匹配普通用户表
    let user
    if (/^\d+$/.test(account)) {
      user = db.prepare('SELECT * FROM users WHERE phone = ?').get(account)
      if (!user) user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(account))
    } else {
      user = db.prepare('SELECT * FROM users WHERE username = ?').get(account)
    }
    if (user && verifyPassword(password, user.password_hash)) {
      const token = genUserToken()
      const expireAt = new Date(Date.now() + config.TOKEN_EXPIRE_HOURS * 3600000).toLocaleString('sv')
      db.prepare('INSERT INTO user_sessions (token, userId, username, expireAt) VALUES (?,?,?,?)').run(token, user.id, user.username, expireAt)
      db.prepare('INSERT INTO login_attempts (username, success) VALUES (?,?)').run(account, 1)
      return res.json({ success: true, data: { token, userId: user.id, username: user.username, name: user.name || '', role: user.role } })
    }

    // 2) 兜底：管理员账号登录（用户名固定 admin）
    if (account === 'admin') {
      let ok = false
      if (config.ADMIN_PASSWORD_HASH) ok = verifyPassword(password, config.ADMIN_PASSWORD_HASH)
      else if (config.ADMIN_PASSWORD) ok = (password === config.ADMIN_PASSWORD)
      if (ok) {
        const token = genUserToken()
        const expireAt = new Date(Date.now() + config.TOKEN_EXPIRE_HOURS * 3600000).toLocaleString('sv')
        db.prepare('INSERT INTO user_sessions (token, userId, username, expireAt) VALUES (?,?,?,?)').run(token, 0, 'admin', expireAt)
        db.prepare('INSERT INTO login_attempts (username, success) VALUES (?,?)').run(account, 1)
        return res.json({ success: true, data: { token, userId: 0, username: 'admin', name: '管理员', role: 'admin' } })
      }
    }

    db.prepare('INSERT INTO login_attempts (username, success) VALUES (?,?)').run(account, 0)
    return res.status(401).json({ success: false, message: '账号或密码错误' })
  })

  router.get('/api/auth/me', userAuthMiddleware, (req, res) => {
    if (req.user.role === 'admin' || req.user.username === 'admin') {
      return res.json({ success: true, data: { userId: 0, username: 'admin', name: '管理员', role: 'admin' } })
    }
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.userId) || {}
    res.json({ success: true, data: { userId: req.user.userId, username: req.user.username, name: u.name || '', role: req.user.role } })
  })

  router.post('/api/auth/logout', userAuthMiddleware, (req, res) => {
    db.prepare('DELETE FROM user_sessions WHERE token = ?').run(req.user.token)
    res.json({ success: true })
  })

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
  function isVehicleValid(v) {
    if (!v.validUntil) return null
    const endStr = v.validUntil.includes('~') ? v.validUntil.split('~')[1] : v.validUntil
    const end = new Date(String(endStr).replace(/-/g, '/') + ' 23:59:59').getTime()
    if (isNaN(end)) return null
    return Date.now() <= end
  }

  // 1. 车牌识别
  router.post('/api/recognize', userAuthMiddleware, upload.single('image'), async (req, res) => {
    const _t0 = Date.now()
    try {
      if (!req.file && !req.body.imageBase64 && !req.body.imageUrl) {
        return res.status(400).json({ success: false, message: '缺少图片数据' })
      }
      // 来源渠道：前端按运行容器区分（原生 APP 传 'app'，H5 网页传 'web'）；缺省兜底为 app
      const channel = (req.body.channel === 'web') ? 'web' : (req.body.channel || 'app')
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
      const opUser = req.user ? (req.user.username) : ''
      const opName = req.user && (req.user.role === 'admin' || req.user.username === 'admin')
        ? '管理员'
        : (() => { const u = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user ? req.user.userId : 0); return u ? (u.name || '') : (req.user ? req.user.username : '') })()

      let result, source, lastErr
      const channels = []
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
          ctx.logRecognition('', name, 0, '失败:' + err.message, channel, null, req.user ? req.user.userId : null, opName)
        }
      }
      if (!result) {
        console.log('[OCR] 所有通道失败: lastErr=%s', lastErr && lastErr.stack ? lastErr.stack : lastErr)
        if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path) } catch (e) {} }
        return res.status(500).json({ success: false, message: '所有识别通道均失败:' + (lastErr && lastErr.message || '') })
      }

      const plateNo = result.plateNo
      const vehicle = db.prepare('SELECT * FROM vehicles WHERE plateKey = ?').get(toPlateKey(plateNo))
      let snapFile = null
      if (req.file && fs.existsSync(req.file.path)) {
        try {
          snapFile = req.file.filename
          const dest = path.join(ctx.SNAP_DIR, snapFile)
          fs.renameSync(req.file.path, dest)
          console.log('[OCR] 抓拍保留: %s', snapFile)
        } catch (e) {
          try { fs.unlinkSync(req.file.path) } catch (e2) {}
        }
      }
      const snapImageUrl = snapFile ? `/uploads/snapshots/${snapFile}` : null
      ctx.logRecognition(plateNo, source, result.confidence, vehicle ? '命中内部车辆' : '未命中', channel, snapImageUrl, req.user ? req.user.userId : null, opName)
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
          vehicle: vehicle ? { ...vehicle, photoUrl: `${config.baseUrl(req)}/api/vehicles/${vehicle.id}/photo`, valid: isVehicleValid(vehicle) } : null
        }
      })
    } catch (err) {
      if (req.file && fs.existsSync(req.file.path)) { try { fs.unlinkSync(req.file.path) } catch (e) {} }
      res.status(500).json({ success: false, message: err.message })
    }
  })

  // 2. 车辆查询（公开）
  router.get('/api/vehicles/search', userAuthMiddleware, (req, res) => {
    try {
      const plate = req.query.plate
      if (!plate) return res.status(400).json({ success: false, message: '缺少车牌参数' })
      const plateKey = toPlateKey(plate)
      const q = plateKey
      let v = q ? db.prepare('SELECT * FROM vehicles WHERE plateKey = ?').get(q) : null
      if (!v && q && q.length >= 4) {
        const all = db.prepare('SELECT * FROM vehicles').all()
        v = all.find(row => row.plateKey && row.plateKey.includes(q)) || null
      }
      const stat = db.prepare('SELECT COUNT(*) AS cnt, MAX(createdAt) AS lastAt FROM recognition_logs WHERE plateNo = ?').get(plate || '') || { cnt: 0, lastAt: '' }
      res.json({ success: true, data: { isInternal: !!v, scanCount: stat.cnt || 0, lastScanAt: stat.lastAt || '', vehicle: v ? { ...v, photoUrl: `${config.baseUrl(req)}/api/vehicles/${v.id}/photo`, valid: isVehicleValid(v) } : null } })
    } catch (err) {
      res.status(500).json({ success: false, message: err.message })
    }
  })

  // 车辆照片访问：接受 admin token 或 user token（含 URL ?token=，便于 <img> 直接使用）
  function photoAuthMiddleware(req, res, next) {
    const token = req.query.token || req.headers['x-admin-token'] || req.headers['x-user-token']
    if (!token) return res.status(401).json({ success: false, message: '未登录' })
    const admin = db.prepare('SELECT 1 FROM admin_sessions WHERE token = ?').get(token)
    if (admin) return next()
    const user = db.prepare('SELECT 1 FROM user_sessions WHERE token = ?').get(token)
    if (user) return next()
    return res.status(401).json({ success: false, message: '登录已失效' })
  }
  router.get('/api/vehicles/:id/photo', photoAuthMiddleware, (req, res) => {
    const v = db.prepare('SELECT photo FROM vehicles WHERE id = ?').get(req.params.id)
    if (!v || !v.photo) return res.status(404).json({ success: false })
    const f = path.join(ctx.uploadDir, path.basename(v.photo))
    if (!fs.existsSync(f)) {
      try { db.prepare('UPDATE vehicles SET photo = NULL WHERE id = ?').run(req.params.id) } catch (e) {}
      return res.status(404).json({ success: false })
    }
    res.sendFile(f)
  })

  // 公开站点设置（无需登录）
  const PUBLIC_SETTING_KEYS = ['COMPANY_NAME', 'ICP_NO', 'POLICE_NO', 'POLICE_URL', 'LOGO_URL', 'POLICE_ICON_URL', 'LOGO_ICON_URL', 'LOGO_HORIZONTAL_URL', 'LOGO_VERTICAL_URL']
  const SETTING_DEFAULTS = {
    LOGO_URL: '/static/images/logo.png',
    POLICE_ICON_URL: '/static/images/police.png',
    POLICE_URL: 'https://beian.mps.gov.cn/#/query/webSearch',
    LOGO_ICON_URL: '/static/images/logo.png',
    LOGO_HORIZONTAL_URL: '/static/images/logo2.png',
    LOGO_VERTICAL_URL: '/static/images/logo3.png'
  }
  router.get('/api/settings/public', (req, res) => {
    const data = {}
    for (const k of PUBLIC_SETTING_KEYS) data[k] = config.dbGet(k, '') || (SETTING_DEFAULTS[k] || '')
    if (!data.POLICE_URL) data.POLICE_URL = 'https://beian.mps.gov.cn/#/query/webSearch'
    res.json({ success: true, data })
  })

  return router
}
