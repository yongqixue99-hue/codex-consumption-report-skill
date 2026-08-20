# Codex Consumption Report Skill

一个同时分析 Codex Token 消耗、核对 Credits、整理官网 Analytics 活动数据的 Codex Skill。它将官方账户 Token、官网活动统计、本机或多设备可恢复的调用明细、网页 Credits 四种口径分开呈现，生成可筛选的离线报告、完整数字表和可分享图表。

> An offline, date-led Codex usage report that keeps official account totals separate from device-local attribution.

## 能做什么

- 按日期展示 Codex 官方账户 Token 总量、每日变化和峰值。
- 从已登录的官方 Analytics 页面自动获取脱敏响应，核对 `daily-workspace-usage-counts` 中的 credits、Token 分项、threads 与 turns。
- 汇总官网 Analytics 页的模型、客户端、turns、Skill 激活和 Plugin 调用情况。
- 解释 Fast 模式倍率，生成官方费率表、1 credit 换算表和 250 credits 的 Sol 等价表。
- 结合页面剩余百分比，给出带取整区间与重置边界提示的周总额度近似值。
- 从 CC Switch 历史账本与 CodeBurn 增量重建本地调用明细。
- 分析输入、输出、缓存读取、项目、模型、任务类型、会话与调用时段。
- 支持日期区间筛选、单日和最近 7 天等短周期视图。
- 支持 Mac、Windows 等多设备账本合并，并进行事件级去重。
- 生成单文件离线 HTML；浏览器可用时同时生成 PDF、PNG 和布局 QA 截图。
- 默认使用会话假名，报告中不嵌入提示词、代码、原始 UUID 或用户绝对路径。

## 数据口径

报告明确区分四层数据：

1. **官方账户层**：来自已登录 Codex 账户的官方累计与每日 Token 活动。
2. **官方活动层**：自动采集或手动导入官网 Analytics 页的脱敏 JSON 响应，用于整理 turns、模型/客户端、Skill 激活和 Plugin 调用表。
3. **本地解释层**：来自已导入设备的 CC Switch 与 CodeBurn，用于解释 Token 花在了哪些项目、模型、会话和时段。
4. **Credits 核对层**：来自浏览器用量页中自动采集或手动导入的 `daily-workspace-usage-counts` 纯 JSON 响应，用于核对已计入的 credits、Fast 与额度近似值。

四层数据不会被强行混算。turns、Skill 激活和 Plugin 调用不能换算为 credits 或 Token。官方接口不提供设备或项目拆分，因此不能把“官方总量与本地重建值之差”直接归因给某台设备、已删除任务或某个项目。报告中的成本是按公开 API 价格进行的等价估算，不是 Codex 订阅账单；Credits 也不是美元。通过页面百分比反推的周额度只是近似值。

交付规则如下：

- 只要求 Token 消耗分析：生成主 Token 报告；
- 只要求 Credits 核对：只生成 Credits HTML、Markdown、SVG 与审计 JSON；
- 要求“整体、完整、综合报告”：默认同时生成主 Token 报告与独立的 Credits 核对报告；未提供 JSON 时优先从已登录浏览器自动采集。只有浏览器控制不可用或尚未登录时，才会提示用户处理。

Credits 核对报告是主报告的并列文件，不嵌进同一个 HTML，以免把 Token、credits 和估算成本混成一个口径。

## 安装

需要 Node.js 20.11 或更高版本；生命周期账本建议使用 Node.js 22.5 或更高版本。自动采集 CodeBurn 还需要 npm/npx。Analytics 一句话自动取数需要 Codex 的浏览器控制能力，以及一个已经登录 `chatgpt.com` 的浏览器会话；它不会读取或保存 Cookie、令牌和请求头。PDF 与 PNG 渲染为可选功能，需要 Playwright 和 Chrome、Chromium 或 Edge。

```bash
git clone https://github.com/yongqixue99-hue/codex-consumption-report-skill.git \
  ~/.codex/skills/generate-codex-consumption-report
```

重新启动 Codex 后，可以直接提出：

```text
使用 $generate-codex-consumption-report 分析我的 Codex Token 消耗，生成完整报告。
```

也可以直接说：

```text
使用 $generate-codex-consumption-report 核对我的 Codex credits，解释 Fast，并把每日数字做成表格和图。
```

最短可以只说：

```text
查看 Credits 报告
```

当前任务已有有效报告时会直接打开；没有报告，或者你说“刷新 Credits 报告”时，会自动打开已登录的官方 Analytics 页面取数、校验并生成。正常情况下不需要用户提供 Response JSON。

## 命令行生成

```bash
node scripts/generate-report.mjs \
  --output-dir "/absolute/output/directory" \
  --timezone "Asia/Shanghai" \
  --retention compressed
```

如需 PDF 与 PNG，加上 `--render`。如只分析已有 CodeBurn 导出：

```bash
node scripts/generate-report.mjs \
  --input "/absolute/path/codeburn-export.json" \
  --output-dir "/absolute/output/directory" \
  --timezone "Asia/Shanghai" \
  --retention compressed
```

完整运行规则、跨设备流程和验证方式见 [SKILL.md](SKILL.md)、[多设备说明](references/multi-device.md) 与 [数据契约](references/data-contract.md)。

## Credits 核对

在 Codex 中直接说“查看 Credits 报告”即可。Skill 会优先复用已登录的 Analytics 页面，只读取页面已经发出的 `daily-workspace-usage-counts` JSON 正文，并自动提取可见的剩余百分比和重置时间。它不会读取浏览器 Cookie、存储、Authorization、请求头或 HAR。

如果运行环境没有浏览器控制能力，才使用手动回退：在 Codex 用量页打开开发者工具，只复制 `daily-workspace-usage-counts` 请求的 **Response JSON**。不要复制 Headers、Cookies、Authorization，也不要导出 HAR。然后运行：

```bash
node scripts/generate-credits-audit.mjs \
  --input "/absolute/path/daily-workspace-usage-counts.json" \
  --output-dir "/absolute/dedicated/credits-audit" \
  --remaining-percent 41 \
  --reset-at "2026-08-16T18:00:00+08:00" \
  --timezone "Asia/Shanghai"
```

输出包括：

- `codex-credits-audit.html`：完整可读报告；
- `codex-credits-audit.md`：每日、模型、费率、额度与换算表；
- `codex-credits-audit.svg`：摘要图；
- `codex-credits-audit.json`：脱敏、可复验的数据；
- `codex-credits-audit-manifest.json`：文件哈希。

读者看到的 Credits 与计算小数统一保留 1 位；Token 总量、缓存输入、非缓存输入、输出以及每日 Token 列统一使用“万/亿 + 1 位小数”。底层 JSON 仍保留未经缩写的精确数值。HTML 表格的数字表头和数字单元格统一居中，模型名称继续左对齐。

脚本会自动执行输出校验。仓库提供脱敏演示数据：

```bash
node scripts/generate-credits-audit.mjs \
  --input examples/codex-credits-demo.json \
  --output-dir /tmp/codex-credits-demo \
  --remaining-percent 41
```

详细口径见 [Credits 审计说明](references/credits-audit.md)。

## 官网 Analytics 活动统计

需要官网活动表时，Skill 会在同一个已登录的 Analytics 页面自动收集以下响应正文：

- `daily-workspace-usage-counts`（必需）；
- `daily-skill-usage-metrics`（可选）；
- `daily-plugin-usage-metrics`（可选）。

三个响应必须来自同一日期范围和同一分组。缺少可选的 Skill 或 Plugin 响应时会显示“未提供”，不会写成零。自动采集不可用时，仍可手动复制这三个 **Response JSON**；不要复制 Headers、Cookies、Authorization、浏览器存储或 HAR。然后运行：

```bash
node scripts/generate-official-analytics.mjs \
  --usage-input "/absolute/path/daily-workspace-usage-counts.json" \
  --skills-input "/absolute/path/daily-skill-usage-metrics.json" \
  --plugins-input "/absolute/path/daily-plugin-usage-metrics.json" \
  --output-dir "/absolute/dedicated/official-analytics" \
  --timezone "Asia/Shanghai"
```

输出包括完整离线 HTML、Markdown 数字表、SVG 图、规范化 JSON 与哈希清单。脚本会验证日期对齐、每日合计、模型/客户端份额、Skill/Plugin 汇总以及凭证风险。脱敏示例可以直接运行：

```bash
node scripts/generate-official-analytics.mjs \
  --usage-input examples/codex-credits-demo.json \
  --skills-input examples/codex-skills-demo.json \
  --plugins-input examples/codex-plugins-demo.json \
  --output-dir /tmp/codex-official-analytics-demo
```

详细步骤、字段含义与官方 Analytics API 的适用条件见 [官网活动统计说明](references/official-analytics.md)。

## 隐私与磁盘占用

- 在 POSIX 系统上，输出目录使用 `0700`，文件使用 `0600`；Windows 应放在当前用户私有的 NTFS 目录中。
- `compressed` 是推荐保留模式：保留可复验的 `.json.gz`，但显著降低磁盘占用。
- `report-only` 仅保留报告与内容哈希，体积最小，但后续独立复验需要重新采集数据。
- 原始与压缩账本可能包含本地路径或标识，不应提交到公开仓库。

## 许可证

本项目自有内容统一使用 [Apache License 2.0](LICENSE)。你可以在该许可条件下使用、复制、修改、分发、商用并创建二次开发版本。再发布时请保留适用的版权、`LICENSE` 和 `NOTICE` 说明，对修改过的文件做出显著说明，并继续保留第三方组件的许可文本。

报告的数据处理、指标逻辑、图表配置、组合排版与视觉设计是本项目的自研内容；当前版本同时原样分发官方 Apache ECharts 6.1.0 浏览器运行时，其中还包含 d3.js portions、zrender 和 tslib。因此这些第三方声明不能删除，详见 [NOTICE](NOTICE) 和 `assets/vendor/echarts/`。生成的独立 HTML 会嵌入全部适用许可文本。
