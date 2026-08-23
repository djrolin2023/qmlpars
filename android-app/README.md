# QMLPARS 安卓 APP（门卫/管理员用）

把现有 H5 车辆识别页（`/cpsb/`）套壳成安卓 APP，解决「微信端每次进都要授权摄像头」的痛点。
APP 安装时一次性授予摄像头权限，之后不再弹授权；启动即打开车牌识别页。

## 原理
使用 **Capacitor** 把 WebView 指向线上 H5 地址（`server.url`），无需把 H5 打进 APP，
后端 API 通过 `location.origin` 同源自动命中，零 H5 改动。

## 构建步骤（在装有 Node + Android Studio 的机器上）

```bash
cd android-app
npm install                 # 安装 @capacitor/core / cli / android
npx cap add android         # 生成原生安卓工程（首次）
npx cap sync android        # 同步配置到安卓工程
npx cap open android        # 用 Android Studio 打开
```

在 Android Studio 里：`Build → Generate Signed Bundle / APK → APK`，按提示签名即可生成安装包。
（未签名调试版：`npx cap run android` 连真机直接装）

## 配置说明
- 线上 H5 地址：`capacitor.config.ts` 里的 `server.url`（默认指向部署后的 `/cpsb/` 页面，由打包时填写的服务器地址决定）
- 若服务器地址变更，改 `server.url` 后重新 `npx cap sync android`
- 摄像头权限：已在 `android/app/src/main/AndroidManifest.xml` 声明 `CAMERA`，安装即授予
- 应用名称 / 图标：在 `android/app/src/main/res/` 下替换（见下方「图标」）

## 图标
`android/app/src/main/res/` 下各密度 `mipmap-*` 目录放 `ic_launcher.png`（默认占位，需自行替换为企业 LOGO）。
可用 Android Studio 的 `Image Asset` 工具一键生成。

## 注意
- APP 仅作 WebView 壳，业务逻辑全在后端 H5，更新后端即生效，无需重新发版。
- 若需离线可用，可改为把 `cpsb/` 拷贝进 `android/app/src/main/assets/public/` 并去掉 `server.url`（进阶，暂不采用）。
