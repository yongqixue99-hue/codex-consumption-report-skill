---
name: generate-codex-consumption-report
description: Generate a polished Codex Token consumption report, audit Codex credits, or summarize the official Analytics page's turns, models, clients, Skill invocations, and Plugin calls from sanitized response JSON. Use when the user asks where Codex Tokens or estimated cost went, wants lifecycle/monthly/custom-period or Mac-and-Windows analysis, asks whether credits or weekly allowance look correct, investigates Fast mode, needs credits-to-Token conversion, requests official activity tables and charts, audits coverage after deleted threads, or wants offline HTML/PDF/PNG/SVG artifacts. This skill is Codex-only; it must not present estimated cost as subscription billing, claim an inferred quota as confirmed, convert activity counts into credits, allocate total credits from zero-valued model rows, or assign an official-versus-local difference to a device or deleted thread.
license: Apache-2.0
---

# Generate Codex Consumption Report

Produce a self-contained interactive HTML report whose narrative starts with official account Token activity by date, then explains the Token detail reconstructed from the devices actually imported. When credits are requested, add a separate validated credits audit with full tables and an SVG summary. Treat requests for an “overall,” “complete,” or “comprehensive” Codex usage report as a report bundle: include the credits audit whenever a sanitized `daily-workspace-usage-counts` response is available in scope. When the user asks about the Analytics page's turns, models, clients, Skills, or Plugins, add the official activity companion. Treat official account Token activity, official activity analytics, device-local explanatory detail, and webpage credits as four distinct layers. Keep every collection step read-only. Saved inputs and outputs must remain sanitized and contain no identity or credential fields.

## Resolve the run

1. When no input is supplied, default to the most complete current-device source hierarchy: official account usage for the headline and daily account series; CC Switch's persistent ledger plus only the strictly post-cutoff CodeBurn increment for local lifecycle reconstruction; current CodeBurn records for project, task, session, and hour attribution; and the `cwd` in a surviving Codex `session_meta` row as a project-only fallback when CodeBurn has no mapping.
2. Treat an explicit CodeBurn `codeburn.export.v2` JSON as a self-contained local snapshot. Do not silently mix it with the current machine's lifecycle history. Add `--enrich-lifecycle` only when that combination is explicitly intended and the export is a current full-lifecycle snapshot.
3. If the official or CC Switch sources are unavailable, fall back to the CodeBurn snapshot and label the report as current local data rather than complete account history. A missing/deleted local session can make this fallback materially lower than the account total.
4. For a multi-device report, collect the official account layer once, then import local detail separately for each device. Expect the official layer to include activity from Mac and Windows only when they used the same signed-in Codex account, but do not claim a device split because the official source exposes none. Never sum copies of the official total.
5. Require a sanitized user-defined alias such as `mac-main` or `win-main` for every imported device. A device that was not imported is outside local-detail coverage, not a zero-usage device. Read [references/multi-device.md](references/multi-device.md) before collecting or merging cross-device data.
6. Default to the full lifecycle and the user's current timezone. Use a dedicated output directory. The generator marks directories it owns and refuses a non-empty unrelated directory unless `--replace-output` was deliberately supplied. Never place output over a broad workspace root.
7. Generate HTML first. Render PDF and PNG when browser dependencies are available or the user asks for those formats. Do not generate video.
8. When the user asks about credits or Fast mode, read [references/credits-audit.md](references/credits-audit.md). Generate the Token report and credits audit as sibling deliverables when both are requested. For an overall/complete/comprehensive report, include both by default when the sanitized Credits response is already supplied or available in the task scope. If it is unavailable, finish the Token report and explicitly say that Credits was not included and that only the `daily-workspace-usage-counts` Response JSON is needed; do not silently omit it or ask for credentials. Do not merge credits into the API-equivalent dollar estimate or force the two sources to reconcile.
9. When the user asks about the official Analytics page, turns, model/client activity, Skill invocations, or Plugin calls, read [references/official-analytics.md](references/official-analytics.md). Use only copied Response JSON, keep activity counts separate from credits and Tokens, and do not request administrator API credentials.

Do not block on an unspecified date range: use the full lifecycle. Do not block on an unspecified timezone: use the current environment timezone, falling back to `Asia/Shanghai` only when it cannot be determined.

## Use portable competition mode

When the environment has no signed-in Codex installation, when the user asks for an anonymous demonstration, or when they explicitly supply a sanitized portable JSON, JSONL, or CSV file, use the isolated competition runner instead of the lifecycle collector:

```bash
node "$SKILL_DIR/scripts/generate-competition-report.mjs" \
  --demo \
  --output-dir "/absolute/dedicated/output/directory" \
  --timezone "Asia/Shanghai"
```

Replace `--demo` with `--input "/absolute/path/portable-usage.json"` for explicit data. Never fall back from an invalid upload to demo data or local collection. Treat portable `activity` labels and API-equivalent cost as input-provided fields, not CodeBurn inference or subscription billing. Return the runner's `replyMarkdown` before the HTML artifact. Read [references/competition-mode.md](references/competition-mode.md) before packaging or adapting this path for a competition platform.

## Audit credits and Fast mode

Use the credits audit for the JSON response body copied from the browser request named `daily-workspace-usage-counts`. Never ask for or accept Headers, Cookies, Authorization, a HAR file, email, account ID, or access tokens. The endpoint is an internal webpage interface rather than a documented public API, so fail on unfamiliar fields instead of guessing.

Run:

```bash
node "$SKILL_DIR/scripts/generate-credits-audit.mjs" \
  --input "/absolute/path/daily-workspace-usage-counts.json" \
  --output-dir "/absolute/dedicated/credits-audit-directory" \
  --remaining-percent 41 \
  --reset-at "2026-08-16T18:00:00+08:00" \
  --timezone "Asia/Shanghai"
```

Use `--from` and `--to` when only part of the response belongs to the current reset window. The generator validates every daily Token identity, rejects common sensitive keys, creates complete daily/model/rate/conversion tables, writes an SVG summary, and runs `validate-credits-audit.mjs` before reporting success. Do not hand over artifacts if that validation fails.

Interpret `totals.credits` as the already charged amount. Do not multiply it by Fast again. Use `models` only to summarize model appearance and threads/turns when `models[].credits` is zero; never fabricate a credit allocation. Label a pool derived from `used credits / consumed percentage` as approximate, disclose integer-percentage rounding and mid-day reset uncertainty, and never compare it to an unofficial community number as though that number were a published entitlement.

When the user wants Token consumption and credits in one workflow, generate both:

1. `codex-consumption-report.html` for official Token history plus local explanatory detail;
2. `codex-credits-audit.html`, `.md`, and `.svg` for charged credits, Fast interpretation, tables, and quota approximation.

Lead with the two links and explain that they are companion layers rather than one interchangeable accounting system.

If the user asks only for Token consumption, generate only the Token report. If they ask only for a Credits audit, generate only the Credits artifacts. “Overall,” “complete,” and “comprehensive” mean the companion bundle when the required sanitized inputs are available; the Credits report remains a separate sibling HTML rather than being embedded into the Token report.

## Audit official activity analytics

Use this companion for the three response bodies copied from the official Codex Analytics page. `daily-workspace-usage-counts` is required; `daily-skill-usage-metrics` and `daily-plugin-usage-metrics` are optional. Never ask for or accept Headers, Cookies, Authorization, browser storage, a HAR file, email, account ID, user ID, or access tokens.

Run:

```bash
node "$SKILL_DIR/scripts/generate-official-analytics.mjs" \
  --usage-input "/absolute/path/daily-workspace-usage-counts.json" \
  --skills-input "/absolute/path/daily-skill-usage-metrics.json" \
  --plugins-input "/absolute/path/daily-plugin-usage-metrics.json" \
  --output-dir "/absolute/dedicated/official-analytics-directory" \
  --timezone "Asia/Shanghai"
```

The generator requires matching date buckets and `group_by` values, validates all aggregates, and produces `.html`, `.md`, `.svg`, normalized `.json`, and a hash manifest. Missing optional responses remain “not provided,” never zero. Treat the three request names as internal dashboard interfaces whose schema may change, not as a stable public API. Do not convert turns, daily thread sums, Skill invocations, or Plugin calls into credits or Tokens.

## Generate the report

Use Node.js 20.11 or newer; Node.js 22.5 or newer is recommended for lifecycle collection because it includes `node:sqlite`. On Node 20.11–22.4, a `sqlite3` executable is required for CC Switch enrichment. Automatic collection also needs `npx`/npm for pinned CodeBurn 0.9.19. Browser rendering is optional and needs Playwright plus Chrome, Chromium, or Edge; HTML generation does not.

Resolve this Skill's directory as `SKILL_DIR`, then run. Use compressed retention for normal delivery so the validated raw JSON remains recoverable without occupying its full on-disk size:

```bash
node "$SKILL_DIR/scripts/generate-report.mjs" \
  --output-dir "/absolute/output/directory" \
  --timezone "Asia/Shanghai" \
  --retention compressed
```

For a supplied export:

```bash
node "$SKILL_DIR/scripts/generate-report.mjs" \
  --input "/absolute/path/codeburn-export.json" \
  --output-dir "/absolute/output/directory" \
  --timezone "Asia/Shanghai" \
  --retention compressed
```

For a verified merge of device ledgers produced by the current collector:

```bash
node "$SKILL_DIR/scripts/merge-device-ledgers.mjs" \
  --ledger mac=/absolute/path/mac-ledger.json \
  --ledger windows=/absolute/path/windows-ledger.json \
  --project-alias-map /absolute/path/project-aliases.json \
  --output /absolute/path/merged-ledger.json
```

The current collector writes one stable event per call as well as compact report rows. Require `deduplication.eventLevelReliable === true`, `deduplication.granularity === "event"`, and a verified Token audit before using a merged ledger in a report. Exact event IDs are collapsed with provenance. A strict one-to-one CC Switch/CodeBurn match may also be collapsed when session, model, every Token component, and timestamp agree; any ambiguous candidate stops the merge. The merger retains a compact-only diagnostic fallback for old ledgers, but the report generator rejects that fallback because it cannot guarantee cross-device deduplication.

Generate a cross-device report directly from those ledgers with one official source:

```bash
node "$SKILL_DIR/scripts/generate-report.mjs" \
  --device-ledger mac=/absolute/path/mac-ledger.json \
  --device-ledger windows=/absolute/path/windows-ledger.json \
  --project-alias-map /absolute/path/project-aliases.json \
  --official-input /absolute/path/codex-official-usage.json \
  --output-dir "/absolute/output/directory" \
  --timezone "Asia/Shanghai" \
  --retention compressed
```

Omit `--official-input` only when the aggregation computer can collect the signed-in account source itself. The generator counts it once and refuses old compact-only ledgers, conflicting event IDs, ambiguous cross-source candidates, or mixed report timezones.

For automatic official collection, the collector checks `--codex-bin`, `CODEX_CONSUMPTION_CODEX_BIN`, `codex`, `codex.exe`, or `codex.cmd` on `PATH`, then known macOS ChatGPT/Codex app locations. Automatic discovery tries each distinct executable until an app server returns valid usage; an explicitly supplied path or environment override fails fast instead of silently switching binaries. Use `--codex-bin "C:\\path\\to\\codex.cmd"` or its POSIX equivalent when discovery is not sufficient.

This explicit-input command is local-only by default. To intentionally enrich a current full-lifecycle export with the persistent ledger and official account usage, add `--enrich-lifecycle`. A previously sanitized official snapshot may be reused reproducibly with `--official-input /absolute/path/codex-official-usage.json`; it is accepted in single-device mode only together with lifecycle enrichment. To force local-only behavior during automatic collection, add `--local-only`.

For automatic custom-period collection, add `--from YYYY-MM-DD` and optionally `--to YYYY-MM-DD`. This produces a local-only period report; use the full lifecycle report's interactive date selector when an official-account comparison is required. Without `--from`, the collector uses `1970-01-01` so CodeBurn returns every currently retained local record rather than its default “Today” period. With `--input`, the date range comes from that export's `periods[0].daily`; do not combine `--input` with `--from` or `--to`. Create a period-scoped export instead.

The generator must complete all deterministic stages:

- collect and sanitize official account usage when lifecycle enrichment is active;
- reconstruct the local lifecycle ledger as `CC Switch baseline ∪ strictly post-cutoff CodeBurn increment`;
- recover project-only attribution from surviving `session_meta.cwd` without reading prompts or code, while keeping CodeBurn mappings authoritative;
- derive `codex-consumption-data.json`;
- build the offline `codex-consumption-report.html`;
- validate source cutoffs, official daily reconciliation, lifecycle totals, dates, compact facts, calls, sessions, Token components, attribution coverage, cost groupings, embedded runtime, and placeholders.

Do not hand over a report when validation fails.

Choose one retention mode:

- `--retention full` keeps the four validated JSON intermediates as private `0600` files and is best for immediate independent validation.
- `--retention compressed` validates first, then stores those files as `.json.gz`; this is the normal delivery choice.
- `--retention report-only` validates first, records content hashes in the manifest, then removes the JSON intermediates. Use it only when minimum disk usage matters more than later revalidation.

On POSIX systems, the self-contained HTML, manifest, source files, and rendered artifacts are written as `0600` inside `0700` output directories. On Windows, place output in a current-user private NTFS directory because access follows inherited Windows ACLs rather than POSIX mode bits. The manifest contains relative artifact names rather than host paths. Report data and HTML contain stable `session-<12 hex>` pseudonyms, never raw source session IDs. Raw or compressed source ledgers can still contain local paths and identifiers and must remain local. The HTML embeds the Skill, ECharts, d3, zrender, and tslib distribution notices so it remains license-complete when shared by itself.

To rerun validation independently:

```bash
node "$SKILL_DIR/scripts/validate-report.mjs" \
  --source "/absolute/output/directory/codex-consumption-source.json" \
  --lifecycle "/absolute/output/directory/codex-lifecycle-ledger.json" \
  --official "/absolute/output/directory/codex-official-usage.json" \
  --data "/absolute/output/directory/codex-consumption-data.json" \
  --report "/absolute/output/directory/codex-consumption-report.html"
```

Omit `--lifecycle` and `--official` only for a local-only report. For compressed retention, decompress the four `.json.gz` files into a private temporary directory before running this command. Report-only retention requires regeneration for independent validation.

## Render and inspect

The HTML is the primary deliverable and does not require a server. For screenshots and A4 PDF:

1. Call the workspace dependency locator to find its Node runtime and Playwright `node_modules`.
2. Run the renderer with that runtime:

```bash
NODE_PATH="/resolved/node_modules" \
  "/resolved/node" "$SKILL_DIR/scripts/render-report.cjs" \
  --report "/absolute/output/directory/codex-consumption-report.html" \
  --output-dir "/absolute/output/directory"
```

Pass `--chrome` only when automatic browser discovery fails. The renderer stages all artifacts before replacing a prior valid render and updates an existing report manifest only after success. It refuses unrelated non-empty output directories unless `--replace-output` is deliberate. The renderer does not create MP4 or other video files.

Inspect at minimum:

- cover and first date chart at 1440 px;
- every desktop chart capture in `qa/`;
- the 390 px mobile timeline, Token chart, session chart, and rhythm chart;
- the PDF pages containing the date, session, and rhythm charts.

Fix clipped labels, repeated date ticks, document-level overflow, incomplete SVGs, or print-width errors before delivery. Horizontal scrolling inside collapsed precision tables is intentional on mobile; document-level overflow is not.

## Preserve the report contract

- Lead with official account Token activity and the matching cumulative official timeline when that source is available. Keep API-equivalent cost secondary.
- Keep the opening summary to one coherent official-usage strip: Token total, per-calendar-day average, single-day peak and date, and active days over selected days. Do not place reconstruction ratios, cache ratios, attribution coverage, or account/local gaps in the opening area.
- Keep the report chart-first: use compact numeric signals, short annotations, and large visual surfaces instead of paragraph-led analysis.
- On first visible use, call the monetary metric “按 API 价格估算的成本”; thereafter use the short label “估算成本”. State clearly that it is not a Codex subscription invoice.
- Separate Token volume share from cost share.
- Merge recognizable Codex worktrees with their parent project; group dated Codex scratch paths without exposing long local paths.
- Show correlation as correlation. Never claim a model switch caused a cost increase from timing alone.
- Explain that dated hour activity is model execution time, not human labor time.
- Treat official account totals and local reconstructed detail as two named layers. Filter both by the same selected calendar labels, but never force their daily values to reconcile when the official bucket timezone is not exposed.
- Use one compact local model-call-date `filterFacts` table for every local-detail view. Projects, models, task types, sessions, hours, Token composition, cost, and their tables must all come from that same local subset.
- Treat the date selector as one global report state. Every preset or custom range must recompute official headline/daily values and all local-detail charts, annotations, rankings, precision tables, and summary facts; never leave full-lifecycle values beside filtered charts.
- Adapt temporal aggregation and labels to the selected range: use daily marks with every date visible for ranges of 14 days or fewer; retain daily values but organize dense views with weekly boundaries or weekly summaries for 15–92 days; use months as the primary grain beyond 92 days. A short selected range must never retain a full-lifecycle monthly composition or month-led annotation.
- Show real local calendar dates wherever time is encoded. Project-period matrices, model-presence views, and execution-time views must label actual dates or date ranges rather than generic weekday names, ordinal weeks, or unlabeled positions. For a date-by-hour view, keep per-date totals visibly aligned with the corresponding dates.
- Apply one immutable full-range cost scale to the local fact rows so their full-range total reconciles to the selected local ledger. Filtered views must sum those already-scaled facts; never renormalize cost per selected range or per dimension.
- Never double count CC Switch history and surviving CodeBurn records. The first CodeBurn record admitted after the CC Switch cutoff must have a timestamp strictly greater than the stored cutoff.
- Collect and use the official account total exactly once, even when several devices provide local detail. Require current event-level ledgers with stable identifiers for a cross-device report. Reject compact-only inputs; never claim reliable cross-device deduplication from compact date/model/session aggregates.
- Restrict comparisons with an official account series to the dates exposed by that series. Keep local history before its first day or after its last available day as an out-of-range audit value; do not use it to close the current account total.
- Keep any official-minus-local difference separate. Do not describe it as Windows usage or deleted-thread usage, and do not distribute it across devices, projects, task types, models, sessions, dates, or Token components.
- When a local event remains but its project or task mapping was deleted, first try the surviving session's `session_meta.cwd` for project-only recovery. Preserve its Token and label any still-missing project as `历史未归属 · <设备别名>` and the task as `历史未归类`. Use `仅官方记录（无本地明细）` only for the unallocated account-level residual. Show attribution coverage and do not imply that the known-project subset represents all locally reconstructed Token.
- Merge a project across operating systems only through an explicit alias map or the same sanitized Git repository fingerprint. Never merge projects from matching folder basenames alone.
- Let chart motion play once when first revealed and respect reduced motion. Do not add chart replay buttons, global replay controls, or video previews.
- Name every percentile by its grain, such as “活跃日估算成本 P95” or “单会话估算成本 P95”; never show a bare “P95” when both appear in one report.
- Use neutral, reusable chapter titles. Put data-specific conclusions in numeric annotations instead of hard-coding claims such as “集中在少数日期”.
- Write for the report reader: avoid implementation labels, unexplained English, slogans, contrast shells such as “不是 A 而是 B”, and management jargon such as “边界”“出口”“复查线”.
- State that task types are inferred automatically by CodeBurn and are not human labels.
- End the visual narrative with a selected-range facts summary, not recommendations. Show only calculated totals, peaks, shares, and distribution facts that can be traced to the active fact subset. Do not tell the reader what to review, limit, optimize, change, or do next, and do not generate action lists from usage data.
- On desktop, provide a narrow Codex-style chapter tick rail at the left edge with a clearly marked active chapter. On mobile, remove the rail and keep a compact, horizontally scrollable text navigation at the top.

Read [references/data-contract.md](references/data-contract.md) when adapting a new CodeBurn schema, changing metrics, or reconciling a custom period. Read [references/official-analytics.md](references/official-analytics.md) for Analytics Response collection, Skills/Plugins tables, field meanings, public-API eligibility, or privacy boundaries. Read [references/multi-device.md](references/multi-device.md) for Mac/Windows collection, deleted-thread handling, event-level deduplication, or cross-OS project identity. Read [references/visual-contract.md](references/visual-contract.md) before changing the report template or chart behavior. Read [references/troubleshooting.md](references/troubleshooting.md) only when collection, rendering, or validation fails.

## License boundary

Project-authored content in this repository, including the iFLYTEK competition adaptations, is licensed under Apache License 2.0 and may be used, modified, redistributed, and incorporated into derivative projects subject to that license. The bundled official Apache ECharts runtime and its d3.js portions, zrender, and tslib components remain under their respective licenses. Preserve the project `LICENSE` and `NOTICE`, mark modified files as required by Apache-2.0, and retain every applicable file under `assets/vendor/echarts/` when redistributing those components.

## Deliver

Lead with a clickable link to `codex-consumption-report.html`. Add available PDF, full-page PNG, and manifest links second. Include three to five evidence-backed findings and the estimated-cost caveat.

Do not upload the raw snapshot, report, project metadata, or session identifiers. The raw `codex-consumption-source.json` remains local and may contain project paths and session metadata even though the report does not display prompt or code content.
