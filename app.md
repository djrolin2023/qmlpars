# APP 打包相关改动记录

本文档记录安卓离线打包（Capacitor 工程 `android-app/` + 前端源 `app/`）相关的所有改动，便于后续维护与二次构建。

## 一、目录结构说明

| 路径 | 作用 |
|------|------|
| `android-app/` | Capacitor 安卓工程（图标/开屏 res、AndroidManifest、gradle、capacitor.config.ts） |
| `app/` | **打包前端源**（识别页 `app-cpsb.html`、车辆查询页 `app-vehicles.html`、样式 `css/`） |
| `web/cpsb/` | 浏览器端移动页（与 `app/` 同源，科技感样式以此为准） |
| `static/images/logo.png` | 默认 APP 图标 |
| `static/images/logo3.png` | 默认开屏图 |
| `buildapp.config.json` | 每次打包的配置落盘（权限/模块/启动参数等） |

> 后端打包入口 `routes/buildapp.js`：`build()` 流程为
> 拷贝 `app/` → 覆盖 `web/cpsb/css` → 生成图标/开屏 → keystore → 写 capacitor/gradle/manifest 配置 → `cap sync` → gradle 打包 → 输出 APK。

## 二、科技感配色（玻璃拟态 + 网格光晕 + 蓝青霓虹）

全站统一设计令牌（见 `web/cpsb/css/base.css`、后端 `admin/css/base.css`）：

- 主色渐变：`linear-gradient(135deg, #1890FF → #36CFC9)`
- 深色底：`#0B1118`，叠加淡蓝网格（32px）+ 三处径向光晕
- 玻璃令牌：`--glass: rgba(29,39,51,.55)`、`--glass-border: rgba(120,200,255,.18)`、`--neon: #00D4FF`
- 卡片/侧栏/模态框/表单：`backdrop-filter: blur` + 渐变描边 + 发光阴影

**已同步到打包源**：`app/css/base.css` 与 `app/css/app.css` 已与 `web/cpsb/css` 及 `android-app/www/app/css` 保持一致（打包产物即为此源，确保 APP 显示与浏览器移动端一致）。

## 三、透明 PNG 自动合成渐变背景

文件：`image.js`（后端公共模块）

- 上传图片时（`/api/admin/vehicles/photo`、`/api/admin/vehicles`、`/api/admin/upload`），调用 `flattenIfTransparent()`。
- 逻辑：用 `sharp` 检测 PNG 是否含实际透明像素（alpha 通道最小值 < 255）；若有，将原图合成到 `linear-gradient(135deg, #1890FF → #36CFC9)` 渐变底上，覆盖存为不透明 PNG。
- 目的：安卓 APP / 移动端展示透明图片（Logo、车辆照片等）时不再出现"透明洞穿 / 黑块"。

## 四、APP 图标与开屏图

默认素材：`logo.png`（图标）、`logo3.png`（开屏）。用户可在后台"APP 打包"页上传覆盖。

打包时 `genAssets` 逻辑（`routes/buildapp.js` 内 `genAssets()`）会：
- 图标：生成各密度 `ic_launcher.png` / `ic_launcher_round.png`（legacy）+ `ic_launcher_foreground.png`（自适应前景，logo 居中留安全边距）；背景色 `ic_launcher_background.xml` 改为 `#0F1419`。
- 开屏：按 `CENTER_CROP` 缩放裁剪 `logo3.png` 填满各 `drawable-port-*/splash.png`。

## 五、APP 打包页面（后台 `web/admin/buildapp.html`）

升级为**多分类配置面板**（左侧分类导航 + 右侧详情），与 HBuilder/uni-app manifest 编辑器风格一致：

| 分类 | 内容 |
|------|------|
| 基础配置 | 应用名（自动生成反向域名包名）、包名、版本号、服务器地址 |
| 图标配置 | 图标上传（预览 + 进度），默认 `logo.png` |
| 启动界面 | 开屏上传（默认 `logo3.png`）+ 背景色 + 显示时长 |
| 权限配置 | 摄像头 / 网络 / 存储 / 定位 开关 |
| 其它设置 | 屏幕方向（竖/横/传感器）、沉浸式状态栏 |
| 源码视图 | 实时生成打包配置 JSON 预览 |

后端 `routes/buildapp.js`：
- 新增字段接收：`splashBg`、`splashDuration`、`orientation`、`immersive`、`permissions`。
- 落盘 `buildapp.config.json`。
- `splashBg` / `splashDuration` 已写入 `capacitor.config.ts`（开屏底色与时长生效）。
- **权限 / 方向 / 沉浸式已真正注入安卓工程**（见下）。

## 六、AndroidManifest 动态注入

函数 `writeManifest(permissions, orientation, immersive)`（routes/buildapp.js）在每次 build 时重写 `android/app/src/main/AndroidManifest.xml`：

- **权限**：保留 `INTERNET`，按配置追加 `CAMERA` / `READ_EXTERNAL_STORAGE` / `ACCESS_FINE_LOCATION` 等（映射表见代码）。
- **屏幕方向**：`android:screenOrientation="portrait|landscape|sensor"` 写入 MainActivity。
- **沉浸式**：勾选时 MainActivity theme 改为 `@style/AppTheme.Immersive`（全屏主题，已在 `res/values/styles.xml` 新增）。

> 打包不含"模块配置"开关：APP 直接复用 WEB 端 `web/cpsb` 整页（车牌识别/车辆管理/识别记录均为内置模块，无需原生裁剪）。

## 七、已知注意点

1. 打包源是 `app/` 而非 `web/cpsb/` 直接打包——`buildapp.js` 第 306 行先拷贝 `app/`，第 308 行再覆盖 `web/cpsb/css`。两者 css 现已同步一致。
2. `app/` 的科技感若需更新，同步 `web/cpsb/css/base.css` 与 `app/css/base.css`（及 `android-app/www/css/base.css`）。
3. 后端上传透明合成依赖 `sharp`；若换构建机需确认 `sharp` native 可用。
4. 更换 admin 账号密码请见下文（安全相关）。

## 八、账号安全

后台管理系统默认账号 `admin / admin`（弱口令，需更换）。

- 账号数据存于 SQLite（`data/vehicles.db` 的 `admin_sessions` / 用户表）。
- 修改方式：
  - 后端提供 `/api/admin/change-password` 或直接在数据库更新密码哈希（`auth.js` 的 `hashPassword`）。
  - 前端登录页 `cpsb/login.html` 与后台 `admin/login.html` 共用 admin token 体系。
- **本次"更换账号"动作由运维在数据库/接口层执行，不在前端 UI 增加额外入口**（如需页头"切换账号"按钮可后续补 `bindLogout` 旁入口）。

## 九、本次故障：一键生成签名证书报 "Unexpected token '<'"

**现象**：后台「APP 打包」→ 签名配置 → 点「⚡ 一键生成签名证书」报错：
`生成失败: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`

**根因**：运行中的 node 服务（端口 7081，pm2 进程 `qmlpars`）是**旧代码**，
尚未加载后端新增的 `POST /api/admin/buildapp/keystore/generate` 路由。
前端 `fetch(...).then(r => r.json())` 收到的是 Express 默认 404 HTML 页
（`<!DOCTYPE html>...Cannot POST /api/admin/buildapp/keystore/generate`），
JSON 解析失败。

**修复**：`pm2 restart qmlpars` 重启服务加载新代码后，路由返回
`401 {"success":false,"message":"未登录"}`（JSON，authMiddleware 生效），问题解决。

**经验教训（重要）**：
- 凡是**新增/修改后端路由**后，必须 `pm2 restart qmlpars`（或 `bash start.sh`）让运行进程加载新代码，否则线上仍走旧路由 → 表现为诡异的 HTML 404。
- 排查"Unexpected token '<'"类错误，第一反应是"请求拿到了 HTML"——大概率是：
  (1) 路由未注册/未重启； (2) nginx/Web Station 把 `/api/*` 当静态文件拦了；
  (3) 前端 `API` 前缀拼错导致跨域/跨源 404。
- 本机 `curl` / codebuddy 自带的 `node` 会被 IDE 注入的 `libstdc++` 污染而跑不起来；
  用干净环境探测：`env -i PATH=/usr/local/bin:/usr/bin:/bin LD_LIBRARY_PATH= node /tmp/probe.js`
  （`probe.js` 里用 `fetch` 打本机 7081 接口，看 status / content-type / body 前 400 字符）。
- `web/admin/js/common.js` 中 `const API = ''`（空串，走同源）；不要误以为它缺前缀。
- 端口：**7081**（非 3000/8080 等常见端口）。pm2 应用名 `qmlpars`。
