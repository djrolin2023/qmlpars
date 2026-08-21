# 内部车辆识别 - 自建后端服务

![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)

将原本依赖「微信云开发」的云函数，迁移为可运行在自有服务器（如群晖）上的 Node.js 服务。

## 许可证

本项目基于 **GNU Affero General Public License v3.0 (AGPL-3.0)** 发布。

AGPL-3.0 在 GPL 基础上包含**网络使用条款**：即使您不分发本软件，只要将其作为网络服务（如本系统的 Web 后台与小程序后端）提供给他人使用，您也必须向使用者提供完整的对应源代码。

- 完整条款见仓库根目录 [`LICENSE`](./LICENSE) 文件。
- 若您基于本项目实施修改并提供网络服务，请同样以 AGPL-3.0 开源您的改动。

## 数据合规说明

本系统设计为**本地私有部署**，对个人信息处理遵循以下原则：

- **数据本地存储**：车辆信息（车牌、车主、电话、部门等）与识别记录仅存储于部署方自有服务器的本地 SQLite 数据库（`data/vehicles.db`），不依赖任何第三方云数据库。
- **不对外传输**：除调用您自行配置的 OCR 服务（如百度车牌识别）所需的图片字节外，系统不会将车辆/人员数据上传至任何外部平台或第三方服务器。
- **部署方责任**：由于本系统处理个人敏感信息（车牌、电话等），部署者须自行确保符合所在地个人信息保护相关法律法规（如《个人信息保护法》），包括获取数据主体授权、限制访问权限、落实安全措施等。
- **最小化收集**：建议仅收集业务必需字段，并妥善保管 `.env` 与数据库文件，避免泄露。

数据库使用 SQLite，OCR 使用百度车牌识别（免费额度 1000 次/月），无需任何云厂商付费服务。

- **后端服务**：本目录（`index.js` 等），部署于 `https://jyedu.wl.gd.cn`。
- **项目仓库**：[github.com/djrolin2023/qmlpars](https://github.com/djrolin2023/qmlpars)（AGPL-3.0）
- **PC 管理后台**：`/admin` 页面（车辆增删改查、识别日志、系统设置、改密码）。
- **微信小程序**：见 `miniprogram/` 子目录（拍照识别、车牌查询）。

## 目录结构

```
server/
├── index.js        # 主服务 + 全部 API 路由
├── config.js       # 配置（读取环境变量）
├── db.js           # SQLite 初始化建表
├── ocr.js          # 百度 OCR 车牌识别
├── plate.js        # 车牌归一化
├── package.json
├── .env.example    # 环境变量示例
└── data/           # 运行时生成的 SQLite 数据库（不提交）
└── uploads/        # 运行时上传的车辆照片（不提交）
```

## 本地运行

```bash
cd server
npm install
# 复制并填写配置
cp .env.example .env
node index.js
```

默认监听 `http://localhost:7080`（可通过环境变量 `PORT` 覆盖）。

## API 列表

| 方法 | 路径 | 说明 | 鉴权 |
| --- | --- | --- | --- |
| POST | `/api/recognize` | 上传图片识别车牌并返回车辆匹配 | 否 |
| GET | `/api/vehicles/search?plate=` | 按车牌查询是否内部车辆 | 否 |
| POST | `/api/admin/login` | 管理员登录，返回 token | 否 |
| GET | `/api/admin/vehicles` | 车辆列表 | token |
| POST | `/api/admin/vehicles` | 新增/编辑车辆（可带照片） | token |
| DELETE | `/api/admin/vehicles/:id` | 删除车辆 | token |
| POST | `/api/admin/logout` | 退出登录 | token |
| GET | `/api/admin/logs` | 识别记录（最近 200 条） | token |
| GET | `/uploads/:file` | 访问上传的图片（**需管理员 token**，避免车辆照片被公开枚举） | token |
| GET | `/api/vehicles/:id/photo` | 车辆照片访问（公开，经文件直发，不暴露存储路径） | 否 |
| GET | `/admin` | PC 端管理页面（登录后使用） | 否（页面内接口需 token） |
| POST | `/api/admin/change-password` | 修改管理员密码（写入 .env 持久化） | token |
| GET | `/api/admin/settings` | 读取系统设置（域名/OCR 密钥等） | token |
| POST | `/api/admin/settings` | 保存系统设置（写入 .env） | token |
| POST | `/api/admin/restart` | 重启服务（保存配置后生效） | token |

## 配置说明（环境变量）

见 `.env.example`。

- **百度 OCR**：配置 `BAIDU_API_KEY` / `BAIDU_SECRET_KEY` 启用（车牌识别主通道）。
- **腾讯云 OCR**：配置 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` 启用（备用通道），`TENCENT_REGION` 默认 `ap-guangzhou`。
- **识别策略**：由 `OCR_PROVIDER`（值 `baidu` 或 `tencent`）决定优先通道，主通道失败时**自动切换另一通道兜底**；仅配置其一也可单独工作。
- 以上配置均可在 PC 后台「系统设置」Tab 内自助填写并保存（敏感字段以掩码显示，留空即不修改）。

## 群晖部署

1. SSH 进入群晖，按上方「本地运行」用 pm2 启动服务（监听 `7080`）。
2. 在群晖「反向代理」新建规则：`jyedu.wl.gd.cn`（HTTPS 443）→ `localhost:7081`（HTTP）。
3. 验证：`curl https://jyedu.wl.gd.cn/api/vehicles/search?plate=Test123` 返回 JSON 即正常。
4. 浏览器打开 `https://jyedu.wl.gd.cn/admin` 进入 PC 管理后台（登录后使用）。

## 独立服务器部署（install.sh 一键脚本）

适用于全新服务器（Debian / Ubuntu / CentOS / RHEL 等，脚本会自动识别发行版与包管理器）。

1. 下载 `qmlpars.tar.gz`（GitHub Release：<https://github.com/djrolin2023/qmlpars/releases>）与 `install.sh`，放到同目录；或把 `QMLPARS_PKG_URL` 指向可下载地址。
2. 执行：

   ```bash
   bash install.sh
   ```

3. 按提示输入**访问域名或服务器 IP** 与**安装目录**（默认 `/opt/qmlpars`）。
4. 脚本会自动完成：安装 Node.js ≥22、npm 依赖、`systemd` 服务注册、nginx 反代、域名模式下申请 Let's Encrypt 证书。
5. 完成后访问 `http://<域名或IP>/admin`（HTTPS 模式下自动跳转）。

> 说明：`install.sh` 兼容 apt（Debian/Ubuntu）、dnf/yum（CentOS/RHEL 系）、zypper/pacman/apk 等包管理器，未识别的系统会明确报错退出。

### PC 管理后台功能
- **登录/退出**：管理员账号登录，token 存浏览器 localStorage。
- **车辆管理**：列表展示、按车牌搜索、新增/编辑（含照片上传）、删除。数据与小程序端互通（同一 SQLite）。
- **识别记录**：查看最近 200 条识别日志（时间/车牌/来源/置信度/结果）。
- **修改密码**：右上角「修改密码」，输入旧/新密码后**以加盐 SHA-256 哈希写入 `.env`**（`ADMIN_PASSWORD_HASH`，不可逆），明文 `ADMIN_PASSWORD` 会被清空；修改后自动退出重新登录。

### 密码存储安全
- 密码不再以明文落盘：`.env` 中存 `ADMIN_PASSWORD_HASH=salt:hash`，即使文件泄露也无法还原明文。
- 首次用明文 `ADMIN_PASSWORD` 登录后会**自动迁移**为哈希并清除明文。
- 验证使用 `crypto.timingSafeEqual` 防时序侧信道。
