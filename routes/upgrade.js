// 系统在线升级（基于 git 拉取，GitHub 为主、Gitee 为备用）
// 升级策略：
//   1) 检测：git fetch 主远端 -> 比对本地 HEAD 与 origin/main 的落后提交数，>0 即有更新
//   2) 升级：git stash（保留本地改动）-> git pull -> git stash pop -> npm install -> 重启
// 所有 git 命令以参数数组方式调用（execFileSync），避免 shell 注入；接口需管理员鉴权。
module.exports = function (ctx) {
  const fs = require('fs')
  const path = require('path')
  const { execFileSync } = require('child_process')
  const { router, authMiddleware } = ctx

  const ROOT = __dirname.replace(/[/\\]routes$/, '')
  const VERSION_FILE = path.join(ROOT, 'version.json')
  const BACKUP_DIR = path.join(ROOT, 'web', 'backup')
  const DB_PATH = process.env.DB_PATH || path.join(ROOT, 'data', 'vehicles.db')

  // 升级前自动做一次数据库快照（仅兜底，不加密），存放到 backup/auto-<时间戳>/
  function autoBackupDb() {
    try {
      if (!fs.existsSync(DB_PATH)) return
      fs.mkdirSync(BACKUP_DIR, { recursive: true })
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const dest = path.join(BACKUP_DIR, 'auto-' + ts)
      fs.mkdirSync(dest, { recursive: true })
      for (const f of [DB_PATH, DB_PATH + '-shm', DB_PATH + '-wal']) {
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dest, path.basename(f)))
      }
      console.log('[qmlpars] 升级前自动快照已生成: ' + dest)
    } catch (e) {
      console.error('[qmlpars] 升级前自动快照失败（不阻断升级）:', e.message)
    }
  }
  const BRANCH = 'main'
  const GH_REMOTE = 'origin'        // 默认 origin = GitHub
  const GH_URL = 'git@github.com:djrolin2023/qmlpars.git'
  const GITEE_REMOTE = 'gitee'
  const GITEE_URL = 'git@gitee.com:dj_rolin/qmlpars.git'

  function readLocalVersion() {
    try {
      const j = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))
      return { version: j.version || '', updatedAt: j.updatedAt || '' }
    } catch (e) {
      return { version: '', updatedAt: '' }
    }
  }

  function runGit(args, timeout = 60000) {
    return execFileSync('git', args, { cwd: ROOT, timeout, stdio: ['ignore', 'pipe', 'pipe'] })
      .toString()
      .trim()
  }

  // 确保存在可用的远端（主用 origin，不可达则追加 gitee 备用）
  function ensureRemotes() {
    let remotes = ''
    try { remotes = runGit(['remote']) } catch (e) { remotes = '' }
    const list = remotes.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    if (!list.includes(GH_REMOTE)) {
      // origin 不存在则补上 GitHub
      try { runGit(['remote', 'add', GH_REMOTE, GH_URL]) } catch (e) {}
    }
    if (!list.includes(GITEE_REMOTE)) {
      try { runGit(['remote', 'add', GITEE_REMOTE, GITEE_URL]) } catch (e) {}
    }
  }

  // 依次尝试 fetch 某个远端，成功返回该远端名
  function tryFetch(remote) {
    try {
      runGit(['fetch', remote, BRANCH], 60000)
      return remote
    } catch (e) {
      return null
    }
  }

  // 将前端传入的 source 映射到 git 远端名；'gitee' -> gitee 远端，其余 -> github(origin)
  function resolveRemote(source) {
    return (source === 'gitee') ? GITEE_REMOTE : GH_REMOTE
  }
  // 远端名 -> 展示标签
  function remoteLabel(remote) {
    return remote === GITEE_REMOTE ? 'Gitee' : (remote === GH_REMOTE ? 'GitHub' : remote)
  }

  // 取远端最新提交日期（用于显示"最后更新于"）
  function remoteCommitDate(remote) {
    try { return runGit(['log', remote + '/' + BRANCH, '-1', '--pretty=%ci']) } catch (e) { return '' }
  }

  function behindCount(remote) {
    try {
      const out = runGit(['rev-list', 'HEAD..' + remote + '/' + BRANCH, '--count'])
      return parseInt(out, 10) || 0
    } catch (e) {
      return 0
    }
  }

  // ---------- 检测是否有更新 ----------
  router.get('/api/admin/upgrade/check', authMiddleware, (req, res) => {
    const local = readLocalVersion()
    let result = {
      success: true,
      current: local.version,
      updatedAt: local.updatedAt,
      hasUpdate: false,
      behind: 0,
      latest: local.version,
      notes: '',
      remote: '',
      checkedAt: new Date().toISOString()
    }
    try {
      ensureRemotes()
      const wantRemote = resolveRemote(req.query.source)
      const remote = tryFetch(wantRemote)
      if (!remote) {
        // 所选来源不可达：返回无更新（网络问题），不报错打断前端
        result.remote = remoteLabel(wantRemote)
        return res.json(result)
      }
      const behind = behindCount(remote)
      const infoDate = remoteCommitDate(remote)
      result.remote = remoteLabel(remote)
      result.behind = behind
      result.hasUpdate = behind > 0
      result.latest = local.version // 真实版本号仍取本地 version.json（远端版本需拉取后更新）
      const verLabel = '乾明车辆识别系统 V' + (local.version || '?')
      const dateLabel = '最后更新于 ' + (infoDate || local.updatedAt || '未知')
      result.notes = verLabel + '\n' + dateLabel
    } catch (e) {
      // 检测失败不阻断，仅返回无更新
      result.error = e.message
    }
    res.json(result)
  })

  // ---------- 执行升级 ----------
  router.post('/api/admin/upgrade/do', authMiddleware, async (req, res) => {
    // 先尝试 stash + pull；若已是最新则直接返回
    try {
      ensureRemotes()
      const wantRemote = resolveRemote((req.body && req.body.source) || '')
      const remote = tryFetch(wantRemote)
      if (!remote) {
        return res.status(502).json({ success: false, message: '无法连接所选的 ' + remoteLabel(wantRemote) + '，请检查服务器网络或 SSH 密钥，或改用另一来源' })
      }
      const behind = behindCount(remote)
      if (behind <= 0) {
        return res.json({ success: true, message: '已经是最新版本，无需升级', restarted: false })
      }

      // 0) 升级前自动快照数据库（兜底，防升级异常导致数据丢失）
      autoBackupDb()

      // 1) 暂存本地未提交改动（保护管理员在本机改过的文件）
      let stashed = false
      try {
        const status = runGit(['status', '--porcelain'])
        if (status.trim()) {
          runGit(['stash', 'push', '-m', 'qmlpars-auto-upgrade'])
          stashed = true
        }
      } catch (e) { /* 无改动或 stash 失败，继续 */ }

      // 2) 拉取远端
      runGit(['pull', remote, BRANCH], 120000)

      // 3) 恢复本地改动（冲突则保留 stash 并提示人工处理）
      if (stashed) {
        try {
          runGit(['stash', 'pop'], 30000)
        } catch (e) {
          // 冲突：保留 stash，避免覆盖远端更新；记录提示
          return res.json({
            success: true,
            message: '代码已更新，但本地改动与更新存在冲突，已保留在 git stash 中，请手动处理（git stash pop）后重启。',
            restarted: true
          })
        }
      }

      // 4) 依赖变更（失败不致命，继续执行）
      try { runGit(['show', remote + '/' + BRANCH + ':package.json'], 120000); } catch (e) {}
      try {
        execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, timeout: 180000, stdio: 'ignore' })
      } catch (e) { /* npm 安装失败不阻断重启 */ }

      // 5) 同步 version.json 中的更新时间（用远端最新提交时间）
      try {
        const infoDate = remoteCommitDate(remote)
        const j = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))
        if (infoDate) {
          j.updatedAt = infoDate.slice(0, 10)
          fs.writeFileSync(VERSION_FILE, JSON.stringify(j, null, 2))
        }
      } catch (e) {}

      // 6) 返回成功并退出进程，由 pm2 / 守护进程自动重启
      res.json({ success: true, message: '升级完成，系统将在数秒后自动重启，请刷新重新登录', restarted: true })
      setTimeout(() => { try { process.exit(0) } catch (e) {} }, 1500)
    } catch (e) {
      res.status(500).json({ success: false, message: '升级失败：' + e.message })
    }
  })

  return router
}
