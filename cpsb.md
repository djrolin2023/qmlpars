# cpsb 项目总览（接手必读）

> 本文档面向「更换 CodeBuddy 账号 / 新接手维护」的人。读完即可掌握项目全貌、部署方式、关键坑点。
> 更细的 APP 打包改动见同目录 `app.md`。

## 一、项目是什么

内部车辆识别小程序后端 + 前端（车牌识别 / 车辆管理 / 识别记录）。
- 名称：`qmlpars-vehicle-server`（车牌识别 qmlpars）
- 部署机：**群晖（Synology）**，运行于 `/volume1/web/jyedu`
- 对外域名：`jyedu.wl.gd.cn`
- 技术栈：Node.js + Express + better-sqlite3 + sharp（图片处理）+ Capacitor（安卓 APP 打包）

## 二、目录结构

| 路径 | 作用 |
|------|------|
| `index.js` | 服务入口。加载 dotenv、挂载各路由、静态托管、CORS、错误处理 |
| `config.js` | 配置中心：端口、管理员账号、百度/腾讯 OCR key、baseUrl 自适应（读 settings 表，回退 .env） |
| `db.js` | better-sqlite3 连接（库路径来自 .env `DB_PATH`） |
| `auth.js` | 管理员登录鉴权、token、密码哈希 |
| `ocr.js` / `plate.js` | 车牌识别（百度/腾讯 OCR 通道） |
| `image.js` | 图片处理（透明 PNG 合成渐变底，见 app.md 三） |
| `routes/` | 路由模块：`admin.js`（后台+静态）、`public.js`（公开识别接口）、`buildapp.js`（APP 打包）、`backup.js`（备份）、`upgrade.js`（在线升级 git 拉取） |
| `web/` | 前端：`web/admin/`（后台管理）、`web/cpsb/`（移动端车牌识别页）、`web/app/`（APP 落地页） |
| `app/` | **APP 打包前端源**（拷贝进安卓工程） |
| `android-app/` | Capacitor 安卓工程（gradle / manifest / res） |
| `static/` | 静态素材（logo.png 图标、logo3.png 开屏、提示音等） |
| `app-out/` | 打包产物 APK 输出目录 |
| `buildapp.config.json` | 打包配置落盘（每次打包写入） |
| `version.json` | 前端版本号（构建页读取展示） |
| `start.sh` | 启动/守护脚本（依赖 pm2，应用名 `qmlpars`） |
| `install.sh` | 安装/依赖脚本 |
| `.env` | 环境变量（端口、DB_PATH、OCR key、BASE_URL 等）。**重启即固定**，改完需重启 |

## 三、运行与重启（最重要）

- 服务端口：**7081**（pm2 应用名 `qmlpars`）
- 启动/重启：`bash start.sh`（内部 `pm2 restart qmlpars`）
- 停止：`pm2 stop qmlpars`
- 查看：`pm2 list`
- **改了后端代码（routes/、index.js、config.js 等）后，必须 `pm2 restart qmlpars` 才能生效**，
  否则线上走旧代码（会表现为诡异的 HTML 404 / 接口不对）。这是最常见的坑，见 `app.md` 第九节。

## 四、前端/后端约定

- 前端全局 `API`：`web/admin/js/common.js` 中 `const API = ''`（空串，走同源），
  `web/cpsb/js/common.js` 中 `API = location.origin` 自适应。不要误以为缺前缀。
- 后台登录 token：请求头 `x-admin-token`（admin 页）；公开接口用 `x-user-token`。
- CORS：后端自实现（`index.js`），`CORS_ORIGIN` 默认 `*`；APP（Capacitor，源 `https://localhost`）也能跨域。

## 五、关键功能模块

1. **车牌识别**：`plate.js` + `ocr.js`，百度 OCR 主、腾讯 OCR 备。配置在 `config.js`（读 settings 表）。
2. **车辆管理 / 识别记录**：后台 `web/admin`（车辆增删改查、批量删除、日志查询、部门、用户、系统设置）。
3. **APP 离线打包**：`routes/buildapp.js` + `web/admin/buildapp.html`。
   - APP 直接复用 WEB 端 `web/cpsb` 整页（无"模块配置"裁剪，车牌识别/车辆管理/识别记录均为内置）。
   - 支持：图标/开屏上传、基础配置、权限、屏幕方向、沉浸式、签名证书一键生成（keytool）。
   - 打包时真正注入 AndroidManifest / capacitor.config.ts，并执行 `cap sync` + gradle 出 APK。
   - 配置可「保存配置」落盘 `buildapp.config.json`，下次打开自动回填（见 buildapp.html 加载逻辑）。
   - 详细见 `app.md`。
4. **数据备份/恢复**：`routes/backup.js`。
5. **在线升级**：`routes/upgrade.js`（git pull 拉取更新）。

## 六、账号安全

- 默认后台账号 `admin / admin`（弱口令，建议更换）。
- 账号存 SQLite（`data/vehicles.db` 的 users / admin_sessions 表）。
- 改密码：`/api/admin/change-password` 接口，或数据库更新哈希（`auth.js` 的 `hashPassword`）。

## 七、已知坑点速查

| 现象 | 原因 | 解决 |
|------|------|------|
| 接口报 `Unexpected token '<'` / 拿到 HTML | 路由未注册/服务未重启/被反向代理当静态文件 | 先 `pm2 restart qmlpars`；确认路由路径与挂载前缀 |
| 改了后端不生效 | 没重启 | `bash start.sh` |
| `curl`/`node` 报 `GLIBCXX_3.4.xx not found` | codebuddy IDE 注入的 `libstdc++` 污染 PATH | 用 `env -i PATH=/usr/local/bin:/usr/bin:/bin LD_LIBRARY_PATH= node xxx.js` |
| APP 页面与 WEB 端不一致 | 打包源 `app/` 的 css 未同步 `web/cpsb/css` | 同步 `app/css` 与 `web/cpsb/css`（见 app.md 二） |
| 透明图片黑块/洞穿 | PNG 含透明像素 | `image.js` 已自动合成渐变底（`#1890FF→#36CFC9`） |
| 服务器地址带/不带斜杠打不开 | 后端 baseUrl 已自适应 + 前端容错 | 确认 serverUrl 容错逻辑（buildapp.html + config.baseUrl） |

## 八、环境工具提示

- 不要用 codebuddy 自带的 `node`/`curl` 跑本项目脚本——会被 IDE 注入的库路径污染。
- 干净运行示例（探测本机接口）：
  ```bash
  cat > /tmp/probe.js <<'EOF'
  fetch('http://127.0.0.1:7081/你的接口', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
    .then(async r => { const t = await r.text(); console.log('STATUS', r.status, 'CTYPE', r.headers.get('content-type')); console.log(t.slice(0,400)); })
    .catch(e => console.log('ERR', e.message))
  EOF
  env -i PATH=/usr/local/bin:/usr/bin:/bin LD_LIBRARY_PATH= node /tmp/probe.js
  ```
- pm2 路径通常在 `/usr/local/bin/pm2`；`PM2_HOME` 默认 `/root/.pm2`。

---
最后更新：2026-08-24（本次修复一键生成签名证书路由 404；整理项目总览供换账号接手）
