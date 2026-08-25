# 车辆管理页 H5 改造记录（车牌按钮式 + 详情模态框）

> 记录时间：2026-08-25
> 背景：把 H5 车辆管理页（原信息条/列表行表格式）改为「真实车牌按钮 + 详情模态框」样式，并确认效果后落地到真实页面。

## 一、最终落地效果（已上线到真实页面）

### 1. 列表：车牌按钮式
- 每辆车渲染为一个**真实车牌外观按钮**，网格布局 `grid-template-columns: repeat(auto-fill, minmax(170px,1fr))`，一行两三个自适应。
- 车牌号自动区分颜色（根据 `plateNo` 判断）：
  - **蓝牌**（7位，小型燃油车）：蓝底白字
  - **绿牌**（新能源，8位）：绿底白字，中间用高清 PNG 标志（见下）
  - **黄牌**（挂/学/港/澳/大型车）：黄底黑字
  - **白牌**（警/使领馆/武警）：白底黑字
- 车牌号分隔：`粤B·12345`（省份 + 字母后跟圆点 + 数字）；新能源为 `粤B[标志]DF1234`。
- **强制不换行**：`.plate-no { display:inline-flex; align-items:center; white-space:nowrap; }`，避免黄牌/新能源车牌换行。
- 按钮下方显示：车主（加粗）+ 部门标签（蓝底小胶囊）。

### 2. 详情模态框（点车牌按钮弹出）
- 背景 **毛玻璃虚化**：`backdrop-filter: blur(8px)`。
- **右上角 ✕** 关闭；点击遮罩也可关闭。
- 顶部居中显示真实车牌（同列表外观，含颜色/标志）+ 下方「归属地」。
- 信息行：归属地 / 车主 / 电话 / 部门 / 有效期 / 备注。
- **右下角按钮无底色**：删除（红字 `danger-text`）+ 编辑（灰字 `ghost`）。
- 删除接原有 `delVehicle(id)`，编辑接原有 `editVehicle(id)`。

### 3. 工具栏保留
搜索 / 部门筛选 / 新增车辆 / 刷新（批量删除按钮保留但当前列表无复选框入口）。

## 二、关键文件改动

### `web/h5/h5-vehicles.html`
- 工具栏移除「视图切换按钮」（`view-switch` / `vs-btn`）。
- `#list` 从 `<table>` 改为 `<div class="plate-list" id="list">`。
- 新增详情模态框 DOM（`#detailModal`，含 `#dPlate`/`#dSub`/`#dArea`/`#dOwner`/`#dPhone`/`#dDept`/`#dValid`/`#dRemark`/`#detail-close`/`#detail-del`/`#detail-edit`）。
- CSS：删除原移动端 table 卡片样式（view-bar/view-table），替换为 `.plate-list`、`.plate-btn`、`.plate-no`（含 blue/yellow/green/white/ev-mark）、`.modal-mask`（毛玻璃）、`.detail-head`、`.d-row`、`.d-foot`、`.btn.ghost` 等。

### `web/h5/js/h5-vehicles.js`
- 新增辅助函数：
  - `plateType(plate)`：判断蓝/黄/绿/白
  - `plateHtml(plate)`：渲染真实车牌外观（绿牌插入 `<img src="/static/images/ev-plate-mark.png">`）
  - `plateArea(plate)`：归属地（复用 `plateAreas`：`plateAreas[省份] = {province, cities}`，返回 `归属地：省 · 市`）
  - `openDetail(id)` / `closeDetail()` / `initDetailModal()`：详情模态框逻辑
- `loadVehicles()`：改为渲染车牌按钮网格（不再生成 `<table>` 行）。
- 删除 `setVehicleView()` 函数及工具栏切换按钮相关逻辑。
- `updateSelCount()` 给 `check-all` 加 null 保护（列表已无复选框）。
- 初始化块：移除 `check-all` 监听，新增 `initDetailModal()` 调用。

### `static/images/ev-plate-mark.png`
- 用户提供的新能源车牌标志高清图，已保存至此路径，车牌按钮和详情框均引用。

### 清理
- 删除 3 个废弃 DEMO 页面：`vehicles-demo.html`、`vehicles-demo-form.html`、`vehicles-demo-platebtn.html`。

## 三、归属地映射数据
- `plateAreas` 来自 `web/h5/js/plate-areas.json`（省份简称 → `{province, cities}`），由 `loadPlateAreas()` 加载。
- `plateArea()` 用法：`info = plateAreas[省份]; city = info.cities[字母];` 返回 `归属地：省 · 市`。

## 四、验证
- Lint：0 错误。
- 文件均存在：`web/h5/h5-vehicles.html`、`web/h5/js/h5-vehicles.js`、`static/images/ev-plate-mark.png`。

## 五、待确认 / 可微调项
- 新能源标志在车牌上尺寸（当前 `height:14px`）可按需放大/缩小。
- 绿牌判断规则：当前用「去掉省份和·后总长8位」判为新能源；如需更严格可加「第3位必须是 D/F」。
- 归属地显示格式（是否带「归属地：」前缀）已处理：模态框顶部带前缀，详情行内只显示纯地名。

---

## 附：本次对话完整需求演进（便于接手）
1. 车牌扫描页标题/LOGO 排版对齐 logo2.png。
2. 左侧 LOGO 用 logo.png；主标题默认「乾明工作室」，用户填公司名则显示公司名；副标题固定「车牌识别系统」；底部英文固定「Qianming License Plate Recognition System」；页脚 LOGO 去掉；整体居中；副标题与主标题同行、同大小同色不抢戏。
3. 车辆列表做成表单式一行一行 → 不满意。
4. 分别做「纯列表行式」和「横向信息条」对比 → 用户认为无区别。
5. 要求新建 DEMO 页面做对比。
6. 最终方向：**车牌按钮式**——车牌号（真实车牌样式，自动区分蓝/黄/新能源）+ 车主 + 部门，点进去弹模态框显示详细资料。
7. 模态框要求：毛玻璃背景、一行两三个自适应、工具栏保留。
8. 按钮布局：右上角 ✕，右下角删除 + 编辑（无底色、编辑和删除对调位置）。
9. 车牌样式迭代：绿牌去掉→恢复绿色；圆点位置修正为 `粤B·12345`（省份后字母后，非省份后）；新能源中间用高清 PNG 标志替代圆点；解决换行/不居中问题（inline-flex + nowrap）。
10. 确认效果后落地到真实车辆管理页，并清理 DEMO。
