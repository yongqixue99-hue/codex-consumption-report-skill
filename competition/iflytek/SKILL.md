---
name: generate-codex-consumption-report
description: Analyze Codex Token usage from the bundled anonymous demo or an explicitly uploaded, sanitized JSON, JSONL, or CSV file, then return a readable in-chat summary and a self-contained interactive HTML report. Use when the user asks for Codex 用量分析、Token 消耗报告、日期趋势、项目或模型分布、缓存构成、异常峰值、数据质量检查、CSV/JSON 可视化，或要求演示一份 Codex 数据分析 Skill。This competition profile is offline and explicit-input-only; it never discovers an account or device automatically and never treats estimated API-equivalent cost as a subscription invoice or remaining quota.
license: Apache-2.0
---

# Codex Consumption Report · Competition Profile

Analyze Codex usage as a date-led data report. Return the calculated summary in the conversation first. Treat the HTML as a secondary interactive artifact.

## Choose the input mode

Use exactly one mode:

1. Use the bundled demo when the user asks for a demonstration, supplies no file, or asks what this Skill can do. The demo is anonymous synthetic data. Always say that it is not a real account.
2. Use an uploaded `.json`, `.jsonl`, or `.csv` file only when the user explicitly supplies it. The file must follow [references/portable-data-contract.md](references/portable-data-contract.md) and already use sanitized project and session aliases.

Never fall back from an invalid uploaded file to demo data. Never scan the runtime environment for account history, project folders, application databases, or other usage sources.

## Run the deterministic report pipeline

Require Node.js 20.11 or newer. Resolve this Skill directory as `SKILL_DIR`. Create a dedicated writable output directory outside the Skill source tree.

For the bundled demo:

```bash
RUN_ROOT="$(mktemp -d)"
node "$SKILL_DIR/scripts/generate-competition-report.mjs" \
  --demo \
  --output-dir "$RUN_ROOT/report" \
  --timezone "Asia/Shanghai"
```

For an uploaded portable file:

```bash
RUN_ROOT="$(mktemp -d)"
node "$SKILL_DIR/scripts/generate-competition-report.mjs" \
  --input "/path/to/uploaded/usage.json" \
  --output-dir "$RUN_ROOT/report" \
  --timezone "Asia/Shanghai"
```

The runner executes normalization, metric derivation, offline HTML construction, and deterministic reconciliation validation. Do not bypass validation or call the internal scripts individually.

## Return the result

Parse the runner's stdout as one JSON object with schema `codex.consumption.run-result.v1`.

On `status: "complete"`:

1. Return `replyMarkdown` verbatim as the main answer.
2. If the current channel supports generated-file delivery, attach the file named by `artifacts.html`. Otherwise say that the interactive HTML was generated but is not directly downloadable in this channel.
3. Do not expose an absolute runtime path, a `file://` URL, raw session aliases, or the uploaded source file.

On `status: "error"`, report `error.code` and `error.message`. Do not retry with demo data, probe another source, or invent a partial result.

The answer must describe only calculated facts: date range, Token total and components, calls, sessions, peak date, project/model concentration, cache-read share, and data-quality status. Do not generate optimization advice or causal conclusions from a statistical threshold.

The uploaded original file remains under the platform or caller's lifecycle control. This runner reads it without deleting it and never copies it into the published report directory. Only the runner-created normalized and derived intermediates live in its private temporary directory, which is removed in `finally` after either success or failure.

## Preserve the data meaning

- Every Token and estimated-cost value comes from the bundled synthetic fixture or the uploaded portable file.
- `activity` is a label supplied by the input; it is not inferred by this competition profile.
- Estimated cost is an API-equivalent estimate supplied by the input. It is not a Codex subscription charge, invoice, quota, or remaining balance.
- A spike, concentration ratio, or high cache-read share is a distribution fact, not proof of inefficiency, fault, or cause.
- The interactive report is self-contained and makes no remote runtime request.

Read [references/portable-data-contract.md](references/portable-data-contract.md) for the accepted schema and privacy rules. Read [references/evaluation-and-limitations.md](references/evaluation-and-limitations.md) when explaining evaluation behavior, platform statistics, or known runtime limits.

## License boundary

Project-authored content in this package, including the competition adaptations, is available under Apache License 2.0 and permits derivative development subject to that license. The bundled official Apache ECharts runtime and its d3.js portions, zrender, and tslib components remain under their respective licenses. Preserve `LICENSE.txt`, `NOTICE.txt`, `licenses/LICENSE-Apache-2.0.txt`, and the license files under `assets/vendor/echarts/` when redistributing the package or a derivative that contains those components.
