# Codex Consumption Report Skill

一个专门分析 Codex Token 消耗的 Codex Skill。它将官方账户 Token 活动与本机或多设备可恢复的调用明细分开呈现，生成可筛选的离线 HTML 报告，并可选导出 PDF 与 PNG。

> An offline, date-led Codex usage report that keeps official account totals separate from device-local attribution.

## 能做什么

- 按日期展示 Codex 官方账户 Token 总量、每日变化和峰值。
- 从 CC Switch 历史账本与 CodeBurn 增量重建本地调用明细。
- 分析输入、输出、缓存读取、项目、模型、任务类型、会话与调用时段。
- 支持日期区间筛选、单日和最近 7 天等短周期视图。
- 支持 Mac、Windows 等多设备账本合并，并进行事件级去重。
- 支持匿名合成演示，以及显式提供的脱敏 JSON、JSONL、CSV；无需登录账户即可进行 portable 演示。
- 生成单文件离线 HTML；浏览器可用时同时生成 PDF、PNG 和布局 QA 截图。
- 默认使用会话假名，报告中不嵌入提示词、代码、原始 UUID 或用户绝对路径。

## 数据口径

报告明确区分两层数据：

1. **官方账户层**：来自已登录 Codex 账户的官方累计与每日 Token 活动。
2. **本地解释层**：来自已导入设备的 CC Switch 与 CodeBurn，用于解释 Token 花在了哪些项目、模型、会话和时段。

官方接口不提供设备或项目拆分，因此不能把“官方总量与本地重建值之差”直接归因给某台设备、已删除任务或某个项目。报告中的成本是按公开 API 价格进行的等价估算，不是 Codex 订阅账单，也不表示剩余额度。

## 安装

需要 Node.js 20.11 或更高版本；生命周期账本建议使用 Node.js 22.5 或更高版本。自动采集 CodeBurn 还需要 npm/npx。PDF 与 PNG 渲染为可选功能，需要 Playwright 和 Chrome、Chromium 或 Edge。

```bash
git clone https://github.com/yongqixue99-hue/codex-consumption-report-skill.git \
  ~/.codex/skills/generate-codex-consumption-report
```

重新启动 Codex 后，可以直接提出：

```text
使用 $generate-codex-consumption-report 分析我的 Codex Token 消耗，生成完整报告。
```

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

## 匿名演示与竞赛模式

portable 模式与本机完整版隔离，只处理包内匿名 fixture 或显式提供的脱敏文件，不自动发现账户、设备或本地数据库：

```bash
node scripts/generate-competition-report.mjs \
  --demo \
  --output-dir "/absolute/dedicated/output/directory" \
  --timezone "Asia/Shanghai"
```

将 `--demo` 改为 `--input "/absolute/path/portable-usage.json"` 即可分析脱敏 JSON、JSONL 或 CSV。stdout 是单一 `codex.consumption.run-result.v1` JSON；核心摘要位于 `replyMarkdown`，交互 HTML 是次级产物。输入格式与限制见 [竞赛模式说明](references/competition-mode.md)。

讯飞比赛使用独立白名单打包器，避免把通用采集、浏览器渲染、仓库元数据或私有报告带入 ZIP：

```bash
node scripts/package-competition.mjs \
  --source . \
  --output "/absolute/release/generate-codex-consumption-report-iflytek.zip"
```

提交文案、演示提示和人工发布门槛见 [讯飞提交包](docs/iflytek-submission-kit.md)。

## 隐私与磁盘占用

- 在 POSIX 系统上，输出目录使用 `0700`，文件使用 `0600`；Windows 应放在当前用户私有的 NTFS 目录中。
- `compressed` 是推荐保留模式：保留可复验的 `.json.gz`，但显著降低磁盘占用。
- `report-only` 仅保留报告与内容哈希，体积最小，但后续独立复验需要重新采集数据。
- 原始与压缩账本可能包含本地路径或标识，不应提交到公开仓库。

## 许可证

赛事专项改造及本次上传前的公开基线 commit `94a72c6ddf8685a5b4541cb453260df0a8c39570` 使用 [Apache License 2.0](LICENSE)，已经授予的许可保持不变。讯飞竞赛包采用组合权利索引：BG 基线、post-baseline 竞赛增量和第三方组件分别说明，详见 `competition/iflytek/LICENSE.txt` 及包内 `competition-ip/` 清单；不能仅凭包中出现 Apache-2.0 全文就把竞赛增量误归为该公开基线中的 Apache 资产。内置 ECharts、d3、zrender 与 tslib 的许可见 [NOTICE](NOTICE) 和 `assets/vendor/echarts/`；生成的独立 HTML 会嵌入全部适用许可文本。
