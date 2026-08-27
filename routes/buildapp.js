// APP 离线打包构建接口（管理员）
// 流程：接收 应用名 / 服务器地址 / 图标 / 开屏图 → 拷贝 H5 资源 → 写 app-config.js
//       → sharp 生成各密度图标与 splash → 生成/复用 keystore → 改写 capacitor 配置与原生清单
//       → 执行 cap sync + gradle assembleRelease → 输出 app/downloads/cn.qmlpars.com.v<版本>.apk
module.exports = function (ctx) {
  const express = require('express')
  const fs = require('fs')
  const fsp = require('fs/promises')
  const path = require('path')
  const { execFile, spawn } = require('child_process')
  const { router, authMiddleware } = ctx

  const ROOT = ctx.root
  const APP_DIR = path.join(ROOT, 'android-app')
  const WWW_DIR = path.join(ROOT, 'web', 'android')
  const APP_OUT_DIR = path.join(ROOT, 'app', 'downloads')
  const KEYSTORE = path.join(APP_DIR, 'qianming.keystore')
  const VERSION_FILE = path.join(ROOT, 'version.json')
  const BUILD_CONFIG = path.join(ROOT, 'buildapp.config.json')

  // 构建状态（单机串行，避免并发打包）
  let building = false
  let lastBuild = null
  let progressTimer = null
  // 设置当前进度百分比（0-100），平滑模式下可安全重复调用
  function setProgress(p) {
    if (!lastBuild) return
    p = Math.max(0, Math.min(100, Math.round(p)))
    // 只允许前进，避免 gradle 日志抖动导致回退
    if (p >= (lastBuild.progress || 0)) lastBuild.progress = p
  }
  // gradle 阶段平滑递增：从 from 到 to，每 intervalMs 步进 step
  function startSmoothProgress(from, to, step, intervalMs) {
    setProgress(from)
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = setInterval(() => {
      if (!lastBuild) { clearInterval(progressTimer); return }
      const cur = lastBuild.progress || from
      if (cur >= to) { clearInterval(progressTimer); return }
      setProgress(Math.min(to, cur + step))
    }, intervalMs)
  }
  function stopSmoothProgress() {
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null }
  }

  function readVersion() {
    try {
      const j = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'))
      return j.version || '0.0.0'
    } catch (e) { return '0.0.0' }
  }
  // 将 SemVer 版本号转为整数 versionCode（主*10000 + 次*100 + 修订），供 gradle 注入
  function versionToCode(v) {
    const parts = String(v || '0.0.0').split('.').map(n => parseInt(n, 10) || 0)
    while (parts.length < 3) parts.push(0)
    return (parts[0] * 10000 + parts[1] * 100 + parts[2]) || 1
  }
  // 写 version.json（构建任务采用前端传入的版本号时同步更新）
  async function writeVersion(v) {
    try {
      const cur = (() => { try { return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8')) } catch (_) { return {} } })()
      cur.version = v
      await fsp.writeFile(VERSION_FILE, JSON.stringify(cur, null, 2) + '\n')
    } catch (_) {}
  }
  // 版本号校验：推荐 SemVer 三段式（主版本.次版本.修订号），如 1.0.0
  function isValidVersion(v) { return /^\d+\.\d+\.\d+$/.test(String(v || '').trim()) }

  function haveAndroidSDK() {
    // install.sh 将构建链固定安装到 /opt/android-sdk；后端由 systemd + env -i 启动，
    // 进程可能拿不到 shell 层（profile.d）的变量，这里统一兜底默认路径，
    // 与后台构建任务中的兜底逻辑保持一致
    process.env.ANDROID_HOME = process.env.ANDROID_HOME || '/opt/android-sdk'
    process.env.ANDROID_SDK_ROOT = process.env.ANDROID_SDK_ROOT || '/opt/android-sdk'
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
    if (!sdk) return { ok: false, reason: '未设置 ANDROID_HOME / ANDROID_SDK_ROOT 环境变量' }
    if (!fs.existsSync(sdk)) return { ok: false, reason: 'Android SDK 目录不存在: ' + sdk + '，请先在有 Android SDK 的机器执行 install.sh 完成构建链安装' }
    if (!fs.existsSync(path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'))) {
      return { ok: false, reason: 'Android SDK 不完整（缺少 cmdline-tools/sdkmanager）: ' + sdk + '，请先执行 install.sh 完成构建链安装' }
    }
    return { ok: true, sdk }
  }

  // 确保 keystore 存在（自签名）
  function ensureKeystore(password, uploadedPath) {
    return new Promise((resolve, reject) => {
      // 用户上传了自有 keystore：直接复制到固定路径使用（密码由表单提供，不入库）
      if (uploadedPath) {
        if (!fs.existsSync(uploadedPath)) return reject(new Error('上传的 keystore 文件不存在'))
        try { fs.copyFileSync(uploadedPath, KEYSTORE) } catch (e) { return reject(new Error('复制 keystore 失败：' + e.message)) }
        log('使用上传的自有签名证书')
        return resolve(KEYSTORE)
      }
      if (fs.existsSync(KEYSTORE)) return resolve(KEYSTORE)
      const args = ['-genkey', '-v', '-keystore', KEYSTORE, '-alias', 'qianming',
        '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
        '-storepass', password, '-keypass', password,
        '-dname', 'CN=Qianming, OU=Qianming, O=Qianming, L=CN, S=CN, C=CN']
      execFile('keytool', args, (err) => {
        if (err) {
          // 友好提示：常见于 JDK 未安装 / JAVA_HOME 未设置
          const hint = (err.code === 'ENOENT')
            ? '（未找到 keytool，请先安装 JDK 并配置 JAVA_HOME 后重试）'
            : '（请确认已安装 JDK 且 JAVA_HOME 配置正确）'
          return reject(new Error('生成 keystore 失败: ' + err.message + ' ' + hint))
        }
        resolve(KEYSTORE)
      })
    })
  }

  async function copyDir(src, dest) {
    await fsp.mkdir(dest, { recursive: true })
    const entries = await fsp.readdir(src, { withFileTypes: true })
    for (const e of entries) {
      const s = path.join(src, e.name)
      const d = path.join(dest, e.name)
      if (e.isDirectory()) await copyDir(s, d)
      else await fsp.copyFile(s, d)
    }
  }

  // 用 sharp 生成各密度图标/splash
  async function genAssets(iconBuf, splashBuf) {
    let sharp
    try { sharp = require('sharp') } catch (e) { return { ok: false, err: '未安装 sharp 依赖' } }
    const densities = [
      { name: 'mdpi', scale: 1 }, { name: 'hdpi', scale: 1.5 }, { name: 'xhdpi', scale: 2 },
      { name: 'xxhdpi', scale: 3 }, { name: 'xxxhdpi', scale: 4 }
    ]
    const resBase = path.join(APP_DIR, 'android', 'app', 'src', 'main', 'res')
    try {
      // 图标：自适应前景 108dp 内，输出各密度 mipmap-*
      if (iconBuf) {
        // SVG 输入需指定渲染密度，否则可能尺寸过小/空白
        const isSvg = /^\s*<svg/i.test(iconBuf.toString('utf8').slice(0, 256))
        const iconPipe = isSvg ? sharp(iconBuf, { density: 256 }) : sharp(iconBuf)
        for (const d of densities) {
          const sz = Math.round(48 * d.scale) // 基准 48dp 图标
          const out = path.join(resBase, 'mipmap-' + d.name, 'ic_launcher.png')
          await fsp.mkdir(path.dirname(out), { recursive: true })
          await iconPipe.clone().resize(sz, sz).png().toFile(out)
          const outR = path.join(resBase, 'mipmap-' + d.name, 'ic_launcher_round.png')
          await iconPipe.clone().resize(sz, sz).png().toFile(outR)
          // 自适应图标前景（Android 8+）：透明背景，居中 108dp 可见区
          // launcher 圆形 mask 会裁切边缘，故按 132x132（108+24 安全区）画布居中贴 logo
          const fgInner = Math.round(108 * d.scale)
          const fgOuter = Math.round(132 * d.scale)
          const fgOut = path.join(resBase, 'mipmap-' + d.name, 'ic_launcher_foreground.png')
          const logoBuf = await iconPipe.clone().resize(fgInner, fgInner, { fit: 'contain', background: { r:0, g:0, b:0, alpha:0 } }).png().toBuffer()
          const off = Math.round((fgOuter - fgInner) / 2)
          await sharp({
            create: { width: fgOuter, height: fgOuter, channels: 4, background: { r:0, g:0, b:0, alpha:0 } }
          }).composite([{ input: logoBuf, left: off, top: off }]).png().toFile(fgOut)
        }
        // 自适应图标背景颜色（与深色 splash 背景协调）
        const bgXml = '<?xml version="1.0" encoding="utf-8"?>\n<resources><color name="ic_launcher_background">#0f172a</color></resources>\n'
        await fsp.writeFile(path.join(resBase, 'values', 'ic_launcher_background.xml'), bgXml)
      }
      // 开屏：各密度 drawable 全屏（按常见分辨率）
      if (splashBuf) {
        const isSvg = /^\s*<svg/i.test(splashBuf.toString('utf8').slice(0, 256))
        const splashPipe = isSvg ? sharp(splashBuf, { density: 256 }) : sharp(splashBuf)
        const splashSizes = [
          { name: 'drawable', w: 480, h: 800 }, { name: 'drawable-hdpi', w: 720, h: 1280 },
          { name: 'drawable-xhdpi', w: 960, h: 1600 }, { name: 'drawable-xxhdpi', w: 1440, h: 2560 }
        ]
        for (const s of splashSizes) {
          const out = path.join(resBase, s.name, 'splash.png')
          await fsp.mkdir(path.dirname(out), { recursive: true })
          await splashPipe.clone().resize(s.w, s.h, { fit: 'cover' }).png().toFile(out)
        }
      }
      return { ok: true }
    } catch (e) { return { ok: false, err: e.message } }
  }

  // 构造子进程干净环境：清掉 CodeBuddy 注入的 LD_LIBRARY_PATH 等污染变量
  function buildCleanEnv() {
    const keep = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TZ', 'NODE_ENV',
                  'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT', 'ANDROID_NDK_ROOT',
                  'GRADLE_USER_HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
                  'http_proxy', 'https_proxy', 'no_proxy']
    const env = {}
    for (const k of keep) if (process.env[k] != null) env[k] = process.env[k]
    // 强制把 JAVA_HOME/bin / SDK 工具目录加进 PATH（去重）
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const pathParts = (env.PATH || '').split(pathSep).filter(Boolean)
    const prepend = []
    if (env.JAVA_HOME) prepend.push(env.JAVA_HOME + '/bin')
    if (env.ANDROID_SDK_ROOT) {
      prepend.push(env.ANDROID_SDK_ROOT + '/cmdline-tools/latest/bin')
      prepend.push(env.ANDROID_SDK_ROOT + '/platform-tools')
    }
    env.PATH = [...prepend, ...pathParts].join(pathSep)
    // 显式清空 LD_LIBRARY_PATH（防止宿主环境注入的污染）
    env.LD_LIBRARY_PATH = ''
    return env
  }

  function run(cmd, args, cwd, onLog) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, { cwd, env: buildCleanEnv() })
      let buf = ''
      p.stdout.on('data', d => { buf += d; if (onLog) onLog(d.toString()) })
      p.stderr.on('data', d => { buf += d; if (onLog) onLog(d.toString()) })
      p.on('close', code => code === 0 ? resolve(buf) : reject(new Error('命令失败(' + code + '): ' + buf.slice(-800))))
    })
  }

  // 写 app-config.js（服务器地址写死）。同时写入 __API_BASE__，二者须一致，
  // 否则前端 API 前缀会回退到 location.origin（capacitor 假域名），导致打包后识别/查询按钮失效。
  async function writeAppConfig(serverUrl) {
    const url = (serverUrl || '').replace(/\/+$/, '')
    const js = 'window.__API_BASE__=' + JSON.stringify(url) + ';\n'
      + 'window.APP_CONFIG=' + JSON.stringify({ serverUrl: url, buildAt: new Date().toISOString() }) + ';\n'
    // web/h5 页面引用 ./app-config.js，即 www/app-config.js（与拷贝目录一致，已扁平化去掉 cpsb 层）
    await fsp.writeFile(path.join(WWW_DIR, 'app-config.js'), js)
  }

  // 在 HTML 的 <head> 最前插入 app-config.js，使 js/common.js 运行前 __API_BASE__ 已就绪
  async function injectAppConfig(htmlPath) {
    if (!fs.existsSync(htmlPath)) return
    let s = await fsp.readFile(htmlPath, 'utf8')
    if (/app-config\.js/.test(s)) return // 已注入则跳过
    s = s.replace(/(<head[^>]*>)/i, '$1\n  <script src="./app-config.js"></script>')
    await fsp.writeFile(htmlPath, s)
  }

  // APP 内页面运行在 https://localhost/ 下（已扁平化去掉 /cpsb 层），login.html 的 fallback
  // 相对路径 'index.html' 在该上下文会被解析成 /login/index.html（报 ERR）。
  // 这里只对打包副本（www/js/common.js）做修正，不动 web/h5 源文件：
  // 把 redirect 的默认回退从相对路径 'index.html' 改为绝对路径 '/index.html'。
  async function fixCpsbRedirect() {
    const jsPath = path.join(WWW_DIR, 'js', 'common.js')
    if (!fs.existsSync(jsPath)) return
    let s = await fsp.readFile(jsPath, 'utf8')
    // 1) doLogin 返回：getQuery('redirect') || 'index.html'  → '/index.html'
    s = s.replace(
      /return \{ok:true, redirect: getQuery\('redirect'\) \|\| 'index\.html'\};/,
      "return {ok:true, redirect: getQuery('redirect') || '/index.html'};"
    )
    // 2) 自动登录分支：params.get('redirect')||'index.html'  → '/index.html'
    s = s.replace(
      /const redirect=params\.get\('redirect'\)\|\|'index\.html';/,
      "let redirect=params.get('redirect')||'/index.html';"
    )
    await fsp.writeFile(jsPath, s)
  }

  // 改写 capacitor.config.ts（应用名/包名/启动参数）
  async function writeCapacitorConfig(appName, appId, splash) {
    const bg = (splash && splash.bg) || '#0f172a'
    const dur = (splash && splash.duration) || 3000
    const tpl = `import { CapacitorConfig } from '@capacitor/cli';
const config: CapacitorConfig = {
  appId: ${JSON.stringify(appId)},
  appName: ${JSON.stringify(appName)},
  webDir: 'www',
  server: { androidScheme: 'https' },
  plugins: { SplashScreen: { launchShowDuration: ${dur}, backgroundColor: ${JSON.stringify(bg)}, androidScaleType: 'CENTER_CROP' } }
};
export default config;
`
    await fsp.writeFile(path.join(APP_DIR, 'capacitor.config.ts'), tpl)
  }

  // 改写 AndroidManifest 包名无关，主要是 application 标签；包名改 gradle namespace
  async function writeGradleConfig(appId, version) {
    const gradle = path.join(APP_DIR, 'android', 'app', 'build.gradle')
    let s = await fsp.readFile(gradle, 'utf8')
    s = s.replace(/namespace\s+["'][^"']+["']/, `namespace "${appId}"`)
    s = s.replace(/applicationId\s+["'][^"']+["']/, `applicationId "${appId}"`)
    // 把传入的版本号写入 gradle，避免系统安装页/APP 内始终显示 1.0
    const versionName = version || readVersion() || '1.0.0'
    const [major = 1, minor = 0, patch = 0] = String(versionName).split('.').map(n => parseInt(n, 10) || 0)
    const versionCode = Math.min(2147483647, major * 10000 + minor * 100 + patch)
    s = s.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
    s = s.replace(/versionName\s+["'][^"']*["']/, `versionName "${versionName}"`)
    await fsp.writeFile(gradle, s)
  }

  // 根据权限/方向/沉浸式重写 AndroidManifest.xml
  async function writeManifest(permissions, orientation, immersive) {
    const manifestPath = path.join(APP_DIR, 'android', 'app', 'src', 'main', 'AndroidManifest.xml')
    let m = await fsp.readFile(manifestPath, 'utf8')

    // 1) 权限块：保留 INTERNET，按配置追加其余权限
    const allPerms = new Set(['android.permission.INTERNET'])
    ;(permissions || []).forEach(p => {
      const map = {
        CAMERA: 'android.permission.CAMERA',
        INTERNET: 'android.permission.INTERNET',
        READ_EXTERNAL_STORAGE: 'android.permission.READ_EXTERNAL_STORAGE',
        WRITE_EXTERNAL_STORAGE: 'android.permission.WRITE_EXTERNAL_STORAGE',
        ACCESS_FINE_LOCATION: 'android.permission.ACCESS_FINE_LOCATION',
        ACCESS_COARSE_LOCATION: 'android.permission.ACCESS_COARSE_LOCATION'
      }
      if (map[p]) allPerms.add(map[p])
    })
    const permBlock = [...allPerms].map(p => '    <uses-permission android:name="' + p + '" />').join('\n')
    m = m.replace(/<!-- Permissions -->[\s\S]*?<\/manifest>/, '<!-- Permissions -->\n' + permBlock + '\n</manifest>')

    // 2) 屏幕方向
    const orientMap = { portrait: 'portrait', landscape: 'landscape', sensor: 'sensor' }
    const screenOri = orientMap[orientation] || 'portrait'
    m = m.replace(/\s+android:screenOrientation="[^"]*"/, '')
    m = m.replace(/(<activity\b[^>]*?)(\/>|>)/, (full, head, tail) => {
      if (head.includes('android:name=".MainActivity"')) {
        return head + ' android:screenOrientation="' + screenOri + '"' + tail
      }
      return full
    })

    // 3) 沉浸式状态栏：通过 theme 指向全屏主题
    if (immersive) {
      m = m.replace(/android:theme="@style\/AppTheme.NoActionBarLaunch"/g,
        'android:theme="@style/AppTheme.Immersive"')
    }

    // 4) 允许明文流量（http）：内网/校园服务器多为 http，Android 9+ 默认禁止明文，
    //    否则 APP 内所有请求（含登录）会被静默拦截，表现为"无法登录且无报错"
    if (!/android:usesCleartextTraffic=/.test(m)) {
      m = m.replace(/(<application\b)/, '$1 android:usesCleartextTraffic="true"')
    }
    await fsp.writeFile(manifestPath, m)
  }

  // 读取已保存的打包配置（供前端回填，避免每次重填）。不返回密码等敏感字段。
  router.get('/api/admin/buildapp/config', authMiddleware, async (req, res) => {
    try {
      if (!fs.existsSync(BUILD_CONFIG)) return res.json({ success: true, config: null })
      const cfg = JSON.parse(await fsp.readFile(BUILD_CONFIG, 'utf8'))
      res.json({ success: true, config: cfg })
    } catch (e) {
      res.json({ success: true, config: null })
    }
  })

  // 保存打包配置（仅持久化填写内容，不触发构建）。用于"下次打开自动回填"
  router.post('/api/admin/buildapp/config', authMiddleware, ctx.upload.none(), async (req, res) => {
    try {
      const c = req.body || {}
      const appName = (c.appName || '').trim()
      const appId = (c.appId || '').trim()
      const serverUrl = (c.serverUrl || '').trim()
      const splashBg = (c.splashBg || '#0f172a').trim()
      const splashDuration = parseInt((c.splashDuration || '3000').trim(), 10) || 3000
      const orientation = (c.orientation || 'portrait').trim()
      const immersive = c.immersive === '1' || c.immersive === 'true' || c.immersive === true
      let permissions = []
      try { permissions = JSON.parse(c.permissions || '[]') } catch (_) {}
      await fsp.writeFile(BUILD_CONFIG, JSON.stringify({
        appName, appId, serverUrl,
        splash: { bg: splashBg, duration: splashDuration },
        orientation, immersive, permissions,
        signing: { useUploadedKeystore: false, keyAlias: (c.keyAlias || 'qianming') },
        updatedAt: new Date().toISOString()
      }, null, 2) + '\n')
      res.json({ success: true, message: '配置已保存' })
    } catch (e) {
      res.status(500).json({ success: false, message: '保存失败：' + e.message })
    }
  })

  router.post('/api/admin/buildapp', authMiddleware,   ctx.upload.fields([
    { name: 'icon', maxCount: 1 }, { name: 'splash', maxCount: 1 }, { name: 'keystore', maxCount: 1 }
  ]), async (req, res) => {
    if (building) return res.status(409).json({ success: false, message: '已有打包任务进行中，请稍候' })
    const sdk = haveAndroidSDK()
    if (!sdk.ok) return res.status(400).json({ success: false, message: '构建环境未就绪：' + sdk.reason + '。请先在有 Android SDK 的机器执行 install.sh 完成构建链安装。' })

    const appName = (req.body.appName || '乾明车牌识别').trim()
    const appId = (req.body.appId || 'cn.qmlpars.com').trim()
    const serverUrl = (req.body.serverUrl || '').trim()
    if (!serverUrl) return res.status(400).json({ success: false, message: '请填写服务器地址' })

    // 新增打包配置项（权限/模块/启动/方向等）
    const splashBg = (req.body.splashBg || '#0f172a').trim()
    const splashDuration = parseInt((req.body.splashDuration || '3000').trim(), 10) || 3000
    const orientation = (req.body.orientation || 'portrait').trim()
    const immersive = req.body.immersive === '1' || req.body.immersive === 'true'
    let permissions = []
    try { permissions = JSON.parse(req.body.permissions || '[]') } catch (_) {}

    // 签名证书：支持上传自有 keystore（用于上架应用商店），否则自动生成自签名证书
    const uploadedKeystore = req.files && req.files.keystore && req.files.keystore[0]
    const keystoreStorePass = (req.body.keystoreStorePass || '').trim()
    const keystoreKeyAlias = (req.body.keystoreKeyAlias || '').trim()
    const keystoreKeyPass = (req.body.keystoreKeyPass || '').trim()
    let useUploadedKeystore = false
    let keyAlias = 'qianming'
    if (uploadedKeystore) {
      if (!keystoreStorePass || !keystoreKeyAlias || !keystoreKeyPass) {
        building = false
        return res.status(400).json({ success: false, message: '已上传签名证书，请完整填写 store 密码、key 别名与 key 密码' })
      }
      useUploadedKeystore = true
      keyAlias = keystoreKeyAlias
    }

    // 版本号：优先采用前端传入（用户在打包页编辑后的），否则读 version.json
    let version = (req.body.version || '').trim()
    if (version && !isValidVersion(version)) {
      return res.status(400).json({ success: false, message: '版本号格式不合法，应为 SemVer 三段式（主版本.次版本.修订号），如 1.0.0' })
    }
    if (!version) version = readVersion()
    // 同步更新到 version.json，使系统版本号与本次一致
    if (version) await writeVersion(version)

    // 持久化打包配置（供前端源码视图/下次构建复用）
    try {
      await fsp.writeFile(BUILD_CONFIG, JSON.stringify({
        appName, appId, version, serverUrl,
        splash: { bg: splashBg, duration: splashDuration },
        orientation, immersive, permissions,
        signing: { useUploadedKeystore, keyAlias },
        updatedAt: new Date().toISOString()
      }, null, 2) + '\n')
    } catch (_) {}
    // 自签证书密码：不硬编码默认值，未配置时随机生成并入库（避免开源泄露固定口令）
    let signStorePass = keystoreStorePass
    let signKeyPass = keystoreKeyPass
    if (!useUploadedKeystore) {
      const existing = ctx.config.dbGet('BUILD_KEYSTORE_PASS')
      if (existing) {
        signStorePass = existing
        signKeyPass = existing
      } else {
        const generated = require('crypto').randomBytes(12).toString('base64')
        ctx.config.dbSet('BUILD_KEYSTORE_PASS', generated)
        signStorePass = generated
        signKeyPass = generated
      }
    }

    building = true
    lastBuild = { status: 'running', appName, serverUrl, version, logs: [], startedAt: new Date().toISOString(), builtAt: new Date().toISOString(), iconUrl: getIconUrl() }
    const log = (m) => { if (lastBuild) lastBuild.logs.push(m) }

    // 后台异步执行，立即返回已接受
    res.json({ success: true, data: { message: '已接受打包任务', version } })

    ;(async () => {
      try {
        // 注入构建链环境（群晖上 JDK/SDK 由 install.sh 安装到固定路径）
        process.env.ANDROID_HOME = process.env.ANDROID_HOME || '/opt/android-sdk'
        process.env.ANDROID_SDK_ROOT = process.env.ANDROID_SDK_ROOT || '/opt/android-sdk'
        // JAVA_HOME 探测优先级：已有环境变量 → /opt/jdk17 → 系统 update-alternatives → 常见发行版路径
        if (!process.env.JAVA_HOME || !fs.existsSync(process.env.JAVA_HOME + '/bin/java')) {
          const candidates = ['/opt/jdk17', '/usr/lib/jvm/default-java',
            '/usr/lib/jvm/java-17-openjdk', '/usr/lib/jvm/java-17-openjdk-amd64',
            '/usr/lib/jvm/java-17-openjdk-arm64']
          let found = ''
          for (const c of candidates) { if (fs.existsSync(c + '/bin/java')) { found = c; break } }
          if (!found && fs.existsSync('/usr/lib/jvm')) {
            const dirs = fs.readdirSync('/usr/lib/jvm').filter(d => /17/.test(d))
            for (const d of dirs) {
              const p = '/usr/lib/jvm/' + d
              if (fs.existsSync(p + '/bin/java')) { found = p; break }
            }
          }
          if (!found) {
            // 尝试用 which java 反推
            try {
              const javaBin = require('child_process').execSync('readlink -f $(command -v java)', { encoding: 'utf8' }).trim()
              if (javaBin) found = require('path').dirname(require('path').dirname(javaBin))
            } catch (_) {}
          }
          if (found) process.env.JAVA_HOME = found
        }
        if (!process.env.JAVA_HOME || !fs.existsSync(process.env.JAVA_HOME + '/bin/java')) {
          throw new Error('未找到 JDK17，请先运行 install.sh 安装安卓构建链（需要 JDK 17）')
        }
        log('JAVA_HOME=' + process.env.JAVA_HOME + '，ANDROID_SDK_ROOT=' + process.env.ANDROID_SDK_ROOT)
        setProgress(5)
        log('开始准备 H5 资源...')
        await fsp.rm(WWW_DIR, { recursive: true, force: true })
        await fsp.mkdir(WWW_DIR, { recursive: true })
        // APP 界面与 WEB 端完全一致：直接打包 web/h5 整目录到 www（扁平化，不再嵌 cpsb 层），
        // h5 页面内已统一使用相对路径（./css、./js 等），WEB 端 /cpsb 路由与 APP 端 / 根均可正确解析。
        // 仅额外注入 app-config.js 提供服务器地址，并把 /static 资源带进来（离线不 404）。
        await copyDir(path.join(ROOT, 'web', 'h5'), WWW_DIR)
        if (fs.existsSync(path.join(ROOT, 'static', 'images'))) {
          await copyDir(path.join(ROOT, 'static', 'images'), path.join(WWW_DIR, 'static', 'images'))
        }
        // 在入口页与登录页的 <head> 最前注入 app-config.js，确保 js/common.js 读取 __API_BASE__ 前已就绪
        await injectAppConfig(path.join(WWW_DIR, 'index.html'))
        await injectAppConfig(path.join(WWW_DIR, 'login.html'))
        await injectAppConfig(path.join(WWW_DIR, 'logout.html'))
        // 仅修正打包副本：把 login 回退相对路径改为 /index.html（APP 端根，不影响 web/h5 源）
        await fixCpsbRedirect()
        // 引导首页（buildIndexHtml 内部跳转 index.html，扁平化后页面直接在根）
        await fsp.writeFile(path.join(WWW_DIR, 'index.html'), buildIndexHtml(appName))
        await writeAppConfig(serverUrl)
        log('H5 资源已拷贝（web/h5 → www，已扁平化去掉 cpsb 层，与 WEB 端一致）')
        // 复制包源位于 web/android；Capacitor 仍读取 android-app/www，这里同步过去
        const CAP_WWW = path.join(APP_DIR, 'www')
        await fsp.rm(CAP_WWW, { recursive: true, force: true })
        await copyDir(WWW_DIR, CAP_WWW)
        log('已同步复制包到 android-app/www（Capacitor 打包目录）')
        setProgress(20)

        log('生成图标/开屏资源...')
        let iconBuf = req.files && req.files.icon && req.files.icon[0] ? req.files.icon[0].buffer : null
        let splashBuf = req.files && req.files.splash && req.files.splash[0] ? req.files.splash[0].buffer : null
        // 未上传则使用项目默认图标（优先 app.png，其次 logo3.png、logo.png）
        if (!iconBuf) {
          for (const name of ['app.png', 'logo3.png', 'logo.png']) {
            const p = path.join(ROOT, 'static', 'images', name)
            if (fs.existsSync(p)) { iconBuf = await fsp.readFile(p); break }
          }
        }
        if (!splashBuf) {
          // 开屏缺失：优先使用专门的开屏图（splash.png），其次 logo3.png、logo.png；
          // 都不能用时才回退到图标本身，避免"图标被当成开屏"导致图标/开屏混淆。
          for (const name of ['splash.png', 'logo3.png', 'logo.png']) {
            const p = path.join(ROOT, 'static', 'images', name)
            if (fs.existsSync(p)) { splashBuf = await fsp.readFile(p); break }
          }
          if (!splashBuf && iconBuf) splashBuf = iconBuf
        }
        const assetR = await genAssets(iconBuf, splashBuf)
        if (!assetR.ok) throw new Error('生成图标/开屏失败: ' + assetR.err)
        log('图标/开屏已生成')
        setProgress(35)
        // 若用户上传了图标，将其另存为 web 可访问的 app-icon.png（落地页 Hero 卡片使用）
        try {
          const userIcon = req.files && req.files.icon && req.files.icon[0]
          if (userIcon && userIcon.buffer) {
            await fsp.writeFile(path.join(ROOT, 'static', 'images', 'app-icon.png'), userIcon.buffer)
            log('用户图标已保存为 app-icon.png')
          }
        } catch (e) { log('保存 app-icon.png 失败：' + e.message) }

        log('准备签名证书...')
        await ensureKeystore(signStorePass, useUploadedKeystore ? uploadedKeystore.path : null)
        // 自有 keystore 的密码由本次表单提供，不入库；自动生成的已在上文生成时入库
        log('keystore 就绪' + (useUploadedKeystore ? '（自有证书）' : '（自动生成）'))
        setProgress(45)

        log('写入工程配置...')
        await writeCapacitorConfig(appName, appId, { bg: splashBg, duration: splashDuration })
        await writeGradleConfig(appId, version)
        await writeManifest(permissions, orientation, immersive)
        log('工程配置已写入')
        setProgress(55)

        log('执行 cap sync...')
        await run(path.join(APP_DIR, 'node_modules', '.bin', 'cap'), ['sync', 'android'], APP_DIR, log)
        log('cap sync 完成')
        setProgress(62)

        log('执行 gradle 打包 (assembleRelease)...')
        const gradleCmd = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
        const gradleHome = path.join(ROOT, '.gradle_cache')
        await fsp.mkdir(gradleHome, { recursive: true })
        // gradle 阶段耗时最长：平滑递增进度，避免卡在固定百分比
        // 上限设 99，保证 100% 只在真正复制 APK 完成后出现
        startSmoothProgress(62, 99, 2, 1500)
        await run(gradleCmd, ['assembleRelease',
          '--gradle-user-home=' + gradleHome,
          '-PVERSION_CODE=' + versionToCode(version),
          '-PVERSION_NAME=' + version,
          '-Pandroid.injected.signing.store.file=' + KEYSTORE,
          '-Pandroid.injected.signing.store.password=' + signStorePass,
          '-Pandroid.injected.signing.key.alias=' + keyAlias,
          '-Pandroid.injected.signing.key.password=' + signKeyPass
        ], path.join(APP_DIR, 'android'), log)
        stopSmoothProgress()
        log('gradle 打包完成')

        const apkSrc = path.join(APP_DIR, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
        if (!fs.existsSync(apkSrc)) throw new Error('未找到生成的 APK: ' + apkSrc)
        await fsp.mkdir(APP_OUT_DIR, { recursive: true })
        const outName = appId + '.v' + version + '.apk'
        const outPath = path.join(APP_OUT_DIR, outName)
        await fsp.copyFile(apkSrc, outPath)
        lastBuild.outName = outName
        lastBuild.appId = appId
        lastBuild.outPath = outPath
        lastBuild.status = 'success'
        setProgress(100)
        log('APK 已输出: ' + outPath)
      } catch (e) {
        stopSmoothProgress()
        lastBuild.status = 'failed'
        lastBuild.error = e.message
        log('构建失败: ' + e.message)
      } finally {
        building = false
      }
    })()
  })

  // 查询构建状态/进度
  router.get('/api/admin/buildapp/status', authMiddleware, (req, res) => {
    res.json({ success: true, data: { building, last: lastBuild } })
  })

  // 公开：最新可用 APK（供下载页使用）
  function latestFromDisk() {
    try {
      if (!fs.existsSync(APP_OUT_DIR)) return null
      const files = fs.readdirSync(APP_OUT_DIR).filter(f => f.toLowerCase().endsWith('.apk'))
      if (!files.length) return null
      let best = null, bestTime = -1
      for (const f of files) {
        const st = fs.statSync(path.join(APP_OUT_DIR, f))
        if (st.mtimeMs > bestTime) { bestTime = st.mtimeMs; best = f }
      }
      if (!best) return null
      const st = fs.statSync(path.join(APP_OUT_DIR, best))
      const version = best.includes('.v') ? best.split('.v')[1].replace(/\.apk$/i, '') : ''
      return { outName: best, version, size: st.size, appName: '', serverUrl: '', builtAt: st.mtime.toISOString(), iconUrl: getIconUrl() }
    } catch (_) { return null }
  }
  // 当前 APP 图标 URL：用户上传过则为 app-icon.png，否则回退 app.png（再回退 logo.png）
  function getIconUrl() {
    const uploaded = path.join(ROOT, 'static', 'images', 'app-icon.png')
    if (fs.existsSync(uploaded)) return '/static/images/app-icon.png'
    if (fs.existsSync(path.join(ROOT, 'static', 'images', 'app.png'))) return '/static/images/app.png'
    return '/static/images/logo.png'
  }
  router.get('/api/buildapp/latest', (req, res) => {
    // 优先用内存中最近一次成功构建；重启服务后回退到磁盘最新文件
    if (lastBuild && lastBuild.status === 'success' && lastBuild.outPath && fs.existsSync(lastBuild.outPath)) {
      return res.json({
        success: true,
        data: {
          outName: lastBuild.outName,
          version: lastBuild.version,
          size: fs.statSync(lastBuild.outPath).size,
          appName: lastBuild.appName,
          serverUrl: lastBuild.serverUrl,
          builtAt: lastBuild.builtAt,
          iconUrl: lastBuild.iconUrl || getIconUrl()
        }
      })
    }
    const disk = latestFromDisk()
    if (disk) return res.json({ success: true, data: disk })
    res.json({ success: false, data: null })
  })

  // 公开历史安装包列表（落地页使用，不鉴权）
  router.get('/api/buildapp/history', (req, res) => {
    try {
      if (!fs.existsSync(APP_OUT_DIR)) return res.json({ success: true, data: [] })
      const list = fs.readdirSync(APP_OUT_DIR)
        .filter(f => f.toLowerCase().endsWith('.apk'))
        .map(f => {
          const st = fs.statSync(path.join(APP_OUT_DIR, f))
          return {
            name: f,
            size: st.size,
            appId: f.includes('.v') ? f.split('.v')[0] : f,
            version: f.includes('.v') ? f.split('.v')[1].replace(/\.apk$/i, '') : '',
            builtAt: st.mtime.toISOString()
          }
        })
        .sort((a, b) => new Date(b.builtAt) - new Date(a.builtAt))
      res.json({ success: true, data: list })
    } catch (e) {
      res.status(500).json({ success: false, message: '读取历史安装包失败：' + e.message })
    }
  })

  // 公开：生成二维码 PNG（落地页扫码下载用）。url 必填，size 可选（像素，默认 200）
  // 二维码中心合成 logo 图标（用项目已装的 sharp），纠错级别 H 保证可扫。
  let qrcodeLib = null
  function getQrLib() {
    if (qrcodeLib !== null) return qrcodeLib
    try { qrcodeLib = require('qr-image') } catch (_) { qrcodeLib = false }
    return qrcodeLib
  }
  let logoBufCache = null
  async function getLogoBuf() {
    if (logoBufCache !== null) return logoBufCache
    try {
      logoBufCache = await fsp.readFile(path.join(__dirname, '..', 'static', 'images', 'logo.png'))
    } catch (_) {
      logoBufCache = false
    }
    return logoBufCache
  }
  router.get('/api/buildapp/qrcode', async (req, res) => {
    const url = (req.query.url || '').trim()
    const size = Math.max(80, Math.min(parseInt(req.query.size, 10) || 200, 800))
    if (!url) return res.status(400).send('missing url')
    if (url.length > 1024) return res.status(400).send('url too long')
    const qr = getQrLib()
    if (!qr) return res.status(503).send('qrcode library not available')
    try {
      // 1) 生成二维码 PNG 缓冲（纠错 H，容错约 30%，足以容纳中心图标）
      const qrPng = await new Promise((resolve, reject) => {
        const chunks = []
        const png = qr.image(url, { type: 'png', size: size / 25, margin: 1, errorCorrectionLevel: 'H' })
        png.on('data', c => chunks.push(c))
        png.on('end', () => resolve(Buffer.concat(chunks)))
        png.on('error', reject)
      })
      // 2) 尝试在中心合成 logo（失败则回退纯二维码）
      const logoBuf = await getLogoBuf()
      let outPng = qrPng
      if (logoBuf) {
        try {
          const meta = await sharp(qrPng).metadata()
          const qrW = meta.width, qrH = meta.height
          const iconSize = Math.round(Math.min(qrW, qrH) * 0.22) // 中心图标约占 22%
          const pad = Math.round(iconSize * 0.16)                 // 图标外留白边
          const box = iconSize + pad * 2
          const icon = await sharp(logoBuf)
            .resize(iconSize, iconSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .png()
            .toBuffer()
          const whiteBg = await sharp({
            create: { width: box, height: box, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
          }).composite([{ input: icon, gravity: 'center' }]).png().toBuffer()
          outPng = await sharp(qrPng)
            .composite([{ input: whiteBg, left: Math.round((qrW - box) / 2), top: Math.round((qrH - box) / 2) }])
            .png()
            .toBuffer()
        } catch (_) { /* 合成失败则用纯二维码 */ }
      }
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=300')
      res.send(outPng)
    } catch (e) {
      res.status(500).send('qrcode failed: ' + e.message)
    }
  })

  // 下载 APK（仅管理员）
  router.get('/api/admin/buildapp/download', authMiddleware, (req, res) => {
    if (!lastBuild || lastBuild.status !== 'success' || !lastBuild.outPath) {
      return res.status(404).json({ success: false, message: '尚无可用 APK' })
    }
    res.download(lastBuild.outPath, lastBuild.outName)
  })

  // 历史安装包列表（仅管理员）：返回 app/downloads 目录下所有 APK
  router.get('/api/admin/buildapp/apks', authMiddleware, (req, res) => {
    try {
      if (!fs.existsSync(APP_OUT_DIR)) return res.json({ success: true, data: [] })
      const list = fs.readdirSync(APP_OUT_DIR)
        .filter(f => f.toLowerCase().endsWith('.apk'))
        .map(f => {
          const st = fs.statSync(path.join(APP_OUT_DIR, f))
          return {
            name: f,
            size: st.size,
            // 从文件名解析 appId 与版本：<appId>.v<version>.apk
            appId: f.includes('.v') ? f.split('.v')[0] : f,
            version: f.includes('.v') ? f.split('.v')[1].replace(/\.apk$/i, '') : '',
            builtAt: st.mtime.toISOString()
          }
        })
        .sort((a, b) => new Date(b.builtAt) - new Date(a.builtAt))
      res.json({ success: true, data: list })
    } catch (e) {
      res.status(500).json({ success: false, message: '读取历史安装包失败：' + e.message })
    }
  })

  // 下载指定历史安装包（仅管理员），路径穿越防护
  router.get('/api/admin/buildapp/apks/:name', authMiddleware, (req, res) => {
    const name = path.basename(req.params.name) // 防目录穿越
    const filePath = path.join(APP_OUT_DIR, name)
    if (!fs.existsSync(filePath) || !name.toLowerCase().endsWith('.apk')) {
      return res.status(404).json({ success: false, message: '安装包不存在' })
    }
    res.download(filePath, name)
  })

  // 公开下载指定历史安装包（落地页 / 扫码下载用，无需登录），路径穿越防护
  router.get('/api/buildapp/download/:name', (req, res) => {
    const name = path.basename(req.params.name) // 防目录穿越
    const filePath = path.join(APP_OUT_DIR, name)
    if (!fs.existsSync(filePath) || !name.toLowerCase().endsWith('.apk')) {
      return res.status(404).json({ success: false, message: '安装包不存在' })
    }
    res.download(filePath, name)
  })

  // 删除指定历史安装包（仅管理员），同步删除服务器文件；防目录穿越
  router.delete('/api/admin/buildapp/apks/:name', authMiddleware, (req, res) => {
    const name = path.basename(req.params.name) // 防目录穿越
    const filePath = path.join(APP_OUT_DIR, name)
    if (!name.toLowerCase().endsWith('.apk') || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, message: '安装包不存在' })
    }
    try {
      // 删除前判断是否当前 latest（最新下载）指向的文件
      const isLatest = !!(lastBuild && lastBuild.outPath === filePath)
      fs.unlinkSync(filePath)
      // 若删除的是当前 latest 指向的文件，清空 latest 引用避免脏数据
      if (isLatest) {
        lastBuild.outPath = null
        lastBuild.status = 'deleted'
      }
      res.json({ success: true, message: '已删除 ' + name, isLatest: isLatest })
    } catch (e) {
      res.status(500).json({ success: false, message: '删除失败：' + e.message })
    }
  })

  // 下载当前签名证书（仅管理员）。首次访问若证书不存在会先自动生成
  router.get('/api/admin/buildapp/keystore', authMiddleware, async (req, res) => {
    try {
      const pass = ctx.config.dbGet('BUILD_KEYSTORE_PASS') || 'Qm@2026!Sign#K3y'
      if (!fs.existsSync(KEYSTORE)) {
        await ensureKeystore(pass, null)
        ctx.config.dbSet('BUILD_KEYSTORE_PASS', pass)
      }
      if (!fs.existsSync(KEYSTORE)) return res.status(500).json({ success: false, message: '证书生成失败' })
      res.download(KEYSTORE, 'qianming.keystore')
    } catch (e) {
      res.status(500).json({ success: false, message: '获取证书失败：' + e.message })
    }
  })

  // 一键生成自签名证书（仅管理员）。可指定别名/密码；未提供密码时随机生成（不再使用固定默认值）
  router.post('/api/admin/buildapp/keystore/generate', authMiddleware, async (req, res) => {
    try {
      const alias = (req.body.alias || 'qianming').trim()
      // 不回退到固定明文密码：未提供则随机生成，避免开源仓库泄露可复用口令
      const storePass = (req.body.storePass || '').trim() || require('crypto').randomBytes(12).toString('base64')
      const keyPass = (req.body.keyPass || '').trim() || storePass
      if (!/^[A-Za-z0-9_-]+$/.test(alias)) {
        return res.status(400).json({ success: false, message: '别名只能包含字母/数字/下划线/连字符' })
      }
      // 生成前先备份已存在的证书，避免误覆盖导致旧包无法升级
      if (fs.existsSync(KEYSTORE)) {
        const bak = KEYSTORE + '.bak'
        try { fs.copyFileSync(KEYSTORE, bak) } catch (_) {}
      }
      await new Promise((resolve, reject) => {
        const args = ['-genkey', '-v', '-keystore', KEYSTORE, '-alias', alias,
          '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
          '-storepass', storePass, '-keypass', keyPass,
          '-dname', 'CN=Qianming, OU=Qianming, O=Qianming, L=CN, S=CN, C=CN']
        execFile('keytool', args, (err) => err ? reject(new Error('生成 keystore 失败: ' + err.message)) : resolve())
      })
      ctx.config.dbSet('BUILD_KEYSTORE_PASS', storePass)
      ctx.config.dbSet('BUILD_KEYSTORE_ALIAS', alias)
      res.json({ success: true, alias, storePass, keyPass, message: '签名证书已生成，请务必立即下载备份并妥善保存密码' })
    } catch (e) {
      res.status(500).json({ success: false, message: '生成失败：' + e.message })
    }
  })

  // APP 直接复用 WEB 端页面，入口重定向到 web/h5 的车牌识别页（与 WEB 端一致）
  function buildIndexHtml(appName) {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${appName}</title>
<meta http-equiv="refresh" content="0;url=index.html">
<script>location.href='index.html';</script>
</head>
<body></body>
</html>`
  }

  return router
}
