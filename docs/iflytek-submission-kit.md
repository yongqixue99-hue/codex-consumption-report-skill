# 讯飞“数据智能分析与应用 Skill”提交包

状态日期：2026-08-04（Asia/Shanghai）

## 提交定位

表单作品名必须与 ZIP 根目录 `SKILL.md` 的 `name` 完全一致：

```text
generate-codex-consumption-report
```

展示名称：

```text
Codex Token 分析报告
```

一句话说明：

> 对匿名演示数据或用户显式提供的脱敏 JSON、JSONL、CSV 进行 Codex Token 用量分析，在对话中直接返回日期、Token、调用、会话、峰值与集中度摘要，并生成可筛选的离线交互报告。

建议标签：`数据分析`、`Codex`、`Token`、`CSV`、`可视化`、`离线报告`

## 可直接用于作品介绍的正文

该 Skill 用于解释 Codex Token 在日期、项目、模型、任务类型、会话和调用时段上的分布。评审可以直接运行包内匿名合成演示，也可以上传已经脱敏的 JSON、JSONL 或 CSV。运行后，Skill 会先在对话中返回可核验的核心指标，再生成一份自包含的交互式 HTML 报告。

竞赛运行链只处理显式输入，不依赖评审环境中的 Codex 登录状态或个人数据库。输入会经过字段白名单、时间戳、数值、重复记录、路径、UUID、邮箱和敏感字段检查。上传原文件的留存由平台或调用方管理；runner 只读，不删除或修改原文件，也不把原文件复制进发布产物。runner 创建的标准化数据和派生中间文件位于私有临时目录，并在成功或失败后的 `finally` 阶段删除。输出不包含提示词、代码、原始会话别名或主机绝对路径。

报告不把 API 等价估算成本表述为 Codex 订阅账单，也不推测峰值或集中度的原因。日期、Token 组件、调用、项目、模型、任务、会话和时段视图来自同一份标准化事实表，并通过确定性校验对账。

## 与评分项的对应关系

| 评分方向 | 已实现证据 |
| --- | --- |
| 稳定与可部署 | 包内匿名 demo；显式输入模式；单一 JSON 输出协议；失败不回退；原子发布；离线 HTML |
| 创新与应用价值 | 面向 AI 编程 Token 的日期、项目、模型、会话和缓存构成分析；把总量转为可核验明细 |
| 结果质量 | 对话摘要与交互图表共用同一派生数据；固定黄金指标；异常只陈述统计证据 |
| 技术设计 | normalize → derive → build → validate 四段确定性流水线；portable 运行链与本机完整版隔离 |
| 工程文档 | 输入契约、隐私边界、错误协议、评测黄金值、已知限制和许可文件随包提供 |
| 安全合规 | 无远程运行依赖；不自动发现账户/设备；输入白名单；密钥与隐私扫描；第三方许可证闭环 |

## 原创性佐证边界

赛题 FAQ 要求核心 Skill 自研内容不少于 50%，但当前公开规则没有说明比例按功能模块、文件、有效代码行或 ZIP 字节计算。正式填写比例前先取得赛事方书面口径，不能把未修改的 ECharts 压缩文件体积直接当成结论，也不能无依据宣称已经达标。

可以核验的功能分工如下：

| 范围 | 作用 | 性质 |
| --- | --- | --- |
| `normalize-portable-usage.mjs` | 输入字段、时间戳、数值、重复记录和隐私白名单 | 自研核心 |
| `generate-competition-report.mjs` | demo/上传模式、失败关闭、私有中间文件、原子发布和对话摘要 | 自研核心 |
| `derive-report.mjs`、`build-report.mjs`、`validate-report.mjs` | 指标派生、HTML 构建和确定性对账；文件含公开基线及本次 portable 增量 | 自研核心，需按 diff 区分新旧边界 |
| `report.template.html` | 日期筛选、八类图表编排、来源和限制说明 | 自研报告设计，含公开基线及本次增量 |
| ECharts / zrender / d3 / tslib | 浏览器图形渲染与随分发辅助代码 | 未修改第三方依赖，不负责数据校验、指标计算、隐私、摘要或打包 |

佐证材料使用 Git baseline→候选包 diff、逐文件 SHA-256、有效代码行统计和功能演示，不把第三方 minified 文件混入自研代码行统计；最终按赛事方书面确认的口径重新计算。

## 评审演示话术

无文件演示：

```text
请用匿名演示数据生成一份 Codex Token 消耗报告，先告诉我统计日期、Token 总量、调用、会话、峰值日期、项目集中度和缓存读取占比，再生成交互式报告。
```

上传文件：

```text
请分析我上传的脱敏 Codex 用量 JSON。只展示可核验的用量与分布事实，不给优化建议，并生成可按日期筛选的 HTML 报告。
```

数据质量：

```text
请检查这份 CSV 能否安全生成报告，并告诉我日期、Token、调用和各维度是否完成对账。如果字段或隐私格式不合格，请直接指出错误，不要改用演示数据。
```

匿名 demo 的固定结果：

| 指标 | 期望值 |
| --- | ---: |
| 日期 | 2026-07-01 至 2026-07-14 |
| Token | 54,618,100 |
| 调用 | 435 |
| 会话 | 17 |
| 项目 | 4 |
| API 等价估算成本 | $91.44 |
| 峰值日 | 2026-07-08 / 14,563,800 Token |
| 缓存读取占比 | 87.5534% |
| 最大项目 Token 占比 | 65.5684% |
| 最大模型 Token 占比 | 65.5684% |

## 生成与校验提交 ZIP

在仓库根目录运行：

```bash
node scripts/package-competition.mjs \
  --source . \
  --output "/dedicated/release/generate-codex-consumption-report-iflytek.zip"

node scripts/validate-competition-package.mjs \
  "/dedicated/release/generate-codex-consumption-report-iflytek.zip"
```

打包器使用显式白名单，只将竞赛 `SKILL.md`、portable 运行脚本、匿名 fixture、必要报告资产、参考文档和许可文件写入 ZIP。通用采集、跨设备合并、浏览器渲染、仓库元数据、真实报告及研究文档均不进入包内。

当前候选包已经完成两次连续构建并得到相同摘要：

| 项目 | 当前值 |
| --- | --- |
| 文件名 | `codex-consumption-report-skill.zip` |
| SHA-256 | `4e8fe4b4e00a086bb40e3028f11b6e2956a515e3bb35f89154fb9a4dc6964479` |
| ZIP 大小 | 1,540,996 bytes |
| 解包大小 | 1,537,188 bytes |
| 文件数 | 27 |

哈希只对应当前候选包。任何进入白名单文件的修改都必须重新打包、重新验证，并以新生成的 `.sha256.txt` 为准。

## 上传与平台统计

首次提交必须从[数据智能分析与应用 Skill 赛题页](https://challenge.xfyun.cn/topic/info?type=DIA-App-Skill)的“作品提交”入口上传，而不是先在 SkillHub 单独发布，否则赛事数据可能无法绑定。

审核通过后的下载与收藏由 SkillHub 服务端统计。Skill 内不放埋点、统计 SDK 或自报热度逻辑，也不得以脚本或重复账号制造下载和收藏。

平台硬检查：ZIP 不超过 100 MB、单文件不超过 10 MB、文件不超过 500 个、`SKILL.md` 位于根目录、所有路径和扩展名满足官方白名单。当前打包器会在写出 ZIP 前后各执行一次对应检查。

## 尚需人工完成的三项发布门槛

1. 把 [iflytek-ip-confirmation-email.md](iflytek-ip-confirmation-email.md) 连同逐文件清单和最终 ZIP 哈希发给赛事方并保存书面回复。需要确认公开基线、混合改造文件、竞赛新增内容和第三方组件的权利边界，以及 FAQ 所称“核心 Skill 自研内容不少于 50%”的计算口径。现有 Apache-2.0 权利不能靠改根许可证或删库追溯撤回；泛泛回复“允许参赛”不足以确认边界。
2. 在真实 AstronClaw 中完成五条烟测：自动触发、指定 Skill、匿名 demo、上传 JSON/CSV、异常文件。网页若不能回传 HTML，至少确认聊天摘要完整可读。
3. 从赛题页上传后检查审核状态、下载一次正式包复验，并为修改和复审至少预留 24–48 小时。

赛事截止：2026-08-27 17:00。建议 8 月 24 日前完成首提，8 月 25–26 日只处理审核反馈。

官方参考：[赛题页](https://challenge.xfyun.cn/topic/info?type=DIA-App-Skill)、[Skill 开发与提交指南](https://openres.xfyun.cn/xfyundoc/2026-06-04/e8f94fb5-8626-45fe-91c3-f18130ec5348/1780542909612/Skill%E5%BC%80%E5%8F%91%E4%B8%8E%E6%8F%90%E4%BA%A4%E6%8C%87%E5%8D%97.md)、[SkillHub 审核说明](https://iflytek.github.io/skillhub/guide/review.html)。
