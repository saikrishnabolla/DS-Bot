# Office 文档

- 日期：2026-10-27
- 相关：Issue #613；[Bot 运行配置](2026-10-10-bot-runtime.md)

## 为什么

Bot 要能直接处理 .docx/.pptx/.xlsx：打开看结构、检查包健康、定点改内容。Cue 提供包级工具：稳定 id 的结构读取、关系和内容类型检查、跨 run 的定点编辑、修订接受/拒绝、页面对象的盒模型和拼图巡检。

## Cue 打包了什么

`ds-bot` 包含：

- 单文件 Node CLI `office.js`
- `office` 和 `office-tools` 两个技能
- `src/office/` 下的源码和测试

## ds-bot 自己的命令行（`office.js`）

打进 npm 包的单文件 CLI，依赖 Node 内建模块和打包进去的 XML 解析库。退出码：0 成功、1 仍有 finding、2 用法或失败；`--json` 时输出 `{"ok":true,"data":…}` / `{"ok":false,"error":{…}}`（finding 在 `data.findings` 里，ok 仍为 true）。编辑默认另存（`-o`），`--in-place` 才原地写。

- `unpack`/`pack`：把包解成可读 XML（`pack` 还原排版空白并跑 `check --against`）
- `check [--against] [--fix]`：只查会让 Office 拒开或弹修复的问题——XML 良构、内容类型完整、内部关系可达、r:id 引用存在、pptx 形状/幻灯片 id、docx docPr/paraId、`xml:space`、批注 id 一致。`--against` 只看新引入的问题；`--fix` 修安全的几类
- `docx read [--changes]`：正文块按 `p1…`/`t1…` 编号，页眉页脚、脚注尾注、批注及其锚点；修订默认按接受显示，`--changes` 用 `{+插入 (作者)+}` 这类内联标记
- `docx fields`：简单/复杂域的指令与当前结果
- `docx edit --ops`：原子批量 ops——跨 run `replace`（保留起始 run 格式、不进删除文本、正则带 `$1`）、`set_cell`、`set_field`、`insert`、`delete`、`comment`、`accept_changes`/`reject_changes`
- `pptx inventory`：页面尺寸、主题字体、每页每个形状（id/名/类/占位符/英寸盒——含组的坐标变换和布局/母版占位符继承）/逐段文本与 run 字体字号/图片媒体
- `pptx layout [--autofit]`：文本框相交、跑出页面的 finding；`--autofit` 写 `a:normAutofit`；盒内溢出要渲染才能看到
- `pptx slides --order`：按现位置重排，重复位置=复制（slide+rels+备注页+图表+内嵌工作簿），略过的=删除，再跑 clean
- `pptx clean [--dry-run]`：不在 sldIdLst 的页、不可达部件、悬空关系/Override、无引用媒体（docx/xlsx 通用）
- `xlsx inventory` / `xlsx read --sheet [--range]`：工作表状态/维度/单元格与公式计数/合并/表/图、定义名、错误单元格与其公式、无缓存值提示；网格化读出缓存值、公式、ISO 日期
- `sheet`：渲染页拼成标页码的 contact sheet（纯 JS PNG 编解码）

## 两个技能

由 Cue 运行时注册（provider `ds-bot-office`，仅在 `skills` 服务可用时生效）：

- `office`（rank 550）：把结构读取、包检查和定点编辑指给 `office-tools`。
- `office-tools`（rank 600）：说明命令选择、Word/PowerPoint/Excel 工作流、收尾标准和新 deck 的排版规则。加载时追加 `{"officeTools":{"node","cli"}}`：优先使用 `DS_BOT_OFFICE_NODE`，普通 Node 宿主使用 `process.execPath`，否则要求 `load_workspace_dependencies` 提供 Node；都不可用时明确说明命令不可用。`cli` 是 `ds-bot/office.js` 的绝对路径，在 asar 中映射到 `app.asar.unpacked`。

## 各运行面的运行时

- 普通 Node 宿主和 Docker：使用宿主的 Node 运行 `office.js`。
- 桌面应用：使用配置的 Office Node；没有时由 `load_workspace_dependencies` 提供。两者都没有时，命令不可用。
- Web 客户端：命令在拥有文件和 Node 的主机上运行，不在浏览器里运行。

## 不做的

- 不做模板/母题生成；排版规则写成技能文本
- 不做 XSD 校验——`check` 只覆盖「Office 拒开/弹修复」这一档
- `accept_changes`/`reject_changes` 不处理嵌套在字段指令里的修订，也不处理 `w:numberingChange` 的内容回滚（编号变更只去标记不还原编号）

## 更新 Office 工具时

修改 `src/office/` 后，在 `ds-bot/` 运行 `npm run build` 重建 `office.js`，再运行 Office 测试和打包检查。
