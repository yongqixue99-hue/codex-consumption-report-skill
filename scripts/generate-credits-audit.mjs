#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";

process.umask(0o077);

const AUDIT_SCHEMA = "codex.credits.audit.v1";
const MANIFEST_SCHEMA = "codex.credits.audit.manifest.v1";
const OUTPUT_MARKER = ".codex-credits-audit-output";
const OUTPUT_MARKER_SCHEMA = "codex.credits.audit.output.v1";
const RATE_CARD_VERIFIED_AT = "2026-08-19";
const RATE_CARD_URL = "https://learn.chatgpt.com/docs/pricing";
const FAST_MODE_URL = "https://learn.chatgpt.com/docs/agent-configuration/speed";

const RATE_CARD = [
  { model: "GPT-5.6 Sol", input: 125, cachedInput: 12.5, output: 750 },
  { model: "GPT-5.6 Terra", input: 50, cachedInput: 5, output: 300 },
  { model: "GPT-5.6 Luna", input: 5, cachedInput: 0.5, output: 30 },
  { model: "GPT-5.5", input: 125, cachedInput: 12.5, output: 750 },
  { model: "GPT-5.4", input: 62.5, cachedInput: 6.25, output: 375 },
];

const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|cookies|set-cookie|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|apikey|password|secret|email|account[-_]?id)$/i;
const VALUE_OPTIONS = new Set([
  "input",
  "output-dir",
  "remaining-percent",
  "reset-at",
  "from",
  "to",
  "timezone",
]);
const BOOLEAN_OPTIONS = new Set(["replace-output"]);

function fail(message) {
  process.stderr.write(`Credits audit failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      args[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    args[key] = value;
    index += 1;
  }
  if (!args.input || !args["output-dir"]) {
    throw new Error("Usage: node generate-credits-audit.mjs --input <response.json> --output-dir <directory> [--remaining-percent 41] [--reset-at <ISO date>] [--from YYYY-MM-DD] [--to YYYY-MM-DD]");
  }
  return args;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function finiteNonnegative(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function safeNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function optionalSafeNonnegativeInteger(value, label) {
  if (value === null || value === undefined) return 0;
  return safeNonnegativeInteger(value, label);
}

function findSensitiveKeys(value, path = "$", found = []) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveKeys(item, `${path}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) found.push(`${path}.${key}`);
    findSensitiveKeys(child, `${path}.${key}`, found);
  }
  return found;
}

function normalizeModel(row, date, index) {
  if (!row || typeof row !== "object") throw new Error(`${date}.models[${index}] is invalid`);
  const model = String(row.model ?? "").trim();
  if (!model || model.length > 96 || /[\r\n\t]/.test(model)) {
    throw new Error(`${date}.models[${index}].model is invalid`);
  }
  return {
    model,
    credits: finiteNonnegative(Number(row.credits ?? 0), `${date}.models[${index}].credits`),
    threads: optionalSafeNonnegativeInteger(row.threads, `${date}.models[${index}].threads`),
    turns: optionalSafeNonnegativeInteger(row.turns, `${date}.models[${index}].turns`),
  };
}

function normalizeDailyRow(row, index) {
  if (!row || typeof row !== "object") throw new Error(`data[${index}] is invalid`);
  if (!validDate(row.date)) throw new Error(`data[${index}].date is invalid`);
  const totals = row.totals;
  if (!totals || typeof totals !== "object") throw new Error(`${row.date}.totals is missing`);

  const cachedTextInputTokens = safeNonnegativeInteger(
    totals.cached_text_input_tokens,
    `${row.date}.totals.cached_text_input_tokens`,
  );
  const uncachedTextInputTokens = safeNonnegativeInteger(
    totals.uncached_text_input_tokens,
    `${row.date}.totals.uncached_text_input_tokens`,
  );
  const textOutputTokens = safeNonnegativeInteger(
    totals.text_output_tokens,
    `${row.date}.totals.text_output_tokens`,
  );
  const textTotalTokens = safeNonnegativeInteger(
    totals.text_total_tokens,
    `${row.date}.totals.text_total_tokens`,
  );
  const componentTotal = cachedTextInputTokens + uncachedTextInputTokens + textOutputTokens;
  if (!Number.isSafeInteger(componentTotal) || componentTotal !== textTotalTokens) {
    throw new Error(`${row.date} Token identity failed: cached + uncached + output (${componentTotal}) != total (${textTotalTokens})`);
  }

  const models = Array.isArray(row.models)
    ? row.models.map((model, modelIndex) => normalizeModel(model, row.date, modelIndex))
    : [];

  return {
    date: row.date,
    credits: finiteNonnegative(Number(totals.credits), `${row.date}.totals.credits`),
    cachedTextInputTokens,
    uncachedTextInputTokens,
    textOutputTokens,
    textTotalTokens,
    threads: safeNonnegativeInteger(totals.threads, `${row.date}.totals.threads`),
    turns: safeNonnegativeInteger(totals.turns, `${row.date}.totals.turns`),
    models,
  };
}

function readAndNormalizeInput(inputPath) {
  const parsed = JSON.parse(readFileSync(inputPath, "utf8"));
  const sensitiveKeys = findSensitiveKeys(parsed);
  if (sensitiveKeys.length) {
    throw new Error(`input contains sensitive or identity fields that are not needed: ${sensitiveKeys.slice(0, 8).join(", ")}`);
  }
  const rows = Array.isArray(parsed) ? parsed : parsed.data;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("input must be the JSON response body containing a non-empty data array");
  }
  if (!Array.isArray(parsed) && parsed.group_by != null && parsed.group_by !== "day") {
    throw new Error(`only day-grouped data is supported; received group_by=${parsed.group_by}`);
  }
  const normalized = rows.map(normalizeDailyRow).sort((left, right) => left.date.localeCompare(right.date));
  const dates = normalized.map((row) => row.date);
  if (new Set(dates).size !== dates.length) throw new Error("input contains duplicate dates");
  return normalized;
}

function parseRemainingPercent(value) {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--remaining-percent must be between 0 and 100");
  }
  return parsed;
}

function parseResetAt(value) {
  if (value === undefined) return null;
  if (!Number.isFinite(Date.parse(value))) throw new Error("--reset-at must be a parseable date/time");
  return String(value);
}

function validateTimezone(value) {
  const timezone = value || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`invalid IANA timezone: ${timezone}`);
  }
  return timezone;
}

function selectRows(rows, from, to) {
  if (from && !validDate(from)) throw new Error("--from must use YYYY-MM-DD");
  if (to && !validDate(to)) throw new Error("--to must use YYYY-MM-DD");
  const rangeStart = from || rows[0].date;
  const rangeEnd = to || rows.at(-1).date;
  if (rangeStart > rangeEnd) throw new Error("--from must not be later than --to");
  const selected = rows.filter((row) => row.date >= rangeStart && row.date <= rangeEnd);
  if (!selected.length) throw new Error("selected date range does not overlap the input data");
  return { selected, rangeStart: selected[0].date, rangeEnd: selected.at(-1).date };
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function quotaInference(credits, remainingPercent) {
  if (remainingPercent === null) return null;
  const consumedPercent = 100 - remainingPercent;
  if (credits === 0 && consumedPercent === 0) {
    return {
      consumedPercent,
      pointEstimateCredits: null,
      roundingRangeCredits: null,
      estimatedRemainingCredits: null,
      status: "insufficient-data",
    };
  }
  if (consumedPercent <= 0) {
    return {
      consumedPercent,
      pointEstimateCredits: null,
      roundingRangeCredits: null,
      estimatedRemainingCredits: null,
      status: "inconsistent",
    };
  }
  const pointEstimateCredits = credits / (consumedPercent / 100);
  const minimumConsumed = Math.max(0, 100 - Math.min(100, remainingPercent + 0.5));
  const maximumConsumed = Math.min(100, 100 - Math.max(0, remainingPercent - 0.5));
  const roundingRangeCredits = minimumConsumed > 0
    ? {
        min: credits / (maximumConsumed / 100),
        max: credits / (minimumConsumed / 100),
        assumption: "dashboard percentage is rounded to the nearest whole percent",
      }
    : null;
  return {
    consumedPercent,
    pointEstimateCredits,
    roundingRangeCredits,
    estimatedRemainingCredits: pointEstimateCredits * (remainingPercent / 100),
    status: "approximate",
  };
}

function aggregateModels(rows) {
  const models = new Map();
  for (const row of rows) {
    for (const model of row.models) {
      const aggregate = models.get(model.model) ?? {
        model: model.model,
        dates: new Set(),
        threadsDailySum: 0,
        turns: 0,
        reportedCredits: 0,
      };
      aggregate.dates.add(row.date);
      aggregate.threadsDailySum += model.threads;
      aggregate.turns += model.turns;
      aggregate.reportedCredits += model.credits;
      models.set(model.model, aggregate);
    }
  }
  return [...models.values()]
    .map((row) => ({
      model: row.model,
      activeDates: row.dates.size,
      threadsDailySum: row.threadsDailySum,
      turns: row.turns,
      averageTurnsPerThreadDailySum: row.threadsDailySum > 0 ? row.turns / row.threadsDailySum : 0,
      reportedCredits: row.reportedCredits,
    }))
    .sort((left, right) => right.turns - left.turns || left.model.localeCompare(right.model));
}

function ratesWithConversions() {
  return RATE_CARD.map((row) => ({
    ...row,
    tokensPerCredit: {
      input: 1_000_000 / row.input,
      cachedInput: 1_000_000 / row.cachedInput,
      output: 1_000_000 / row.output,
    },
  }));
}

function buildAudit(rows, options) {
  const credits = sum(rows, (row) => row.credits);
  const cachedTextInputTokens = sum(rows, (row) => row.cachedTextInputTokens);
  const uncachedTextInputTokens = sum(rows, (row) => row.uncachedTextInputTokens);
  const textOutputTokens = sum(rows, (row) => row.textOutputTokens);
  const textTotalTokens = sum(rows, (row) => row.textTotalTokens);
  const threadsDailySum = sum(rows, (row) => row.threads);
  const turns = sum(rows, (row) => row.turns);
  const solStandardReferenceCredits = (
    uncachedTextInputTokens * 125
    + cachedTextInputTokens * 12.5
    + textOutputTokens * 750
  ) / 1_000_000;
  const models = aggregateModels(rows);
  const modelDetailCoverageDays = rows.filter((row) => row.models.length > 0).length;
  const modelThreadsMatch = rows.every((row) => row.models.length === 0 || sum(row.models, (model) => model.threads) === row.threads);
  const modelTurnsMatch = rows.every((row) => row.models.length === 0 || sum(row.models, (model) => model.turns) === row.turns);
  const warnings = [
    "daily-workspace-usage-counts 是网页内部接口，不是公开稳定 API；字段可能变化。",
    "totals.credits 按已计入的消耗处理；不要再把它整体乘以 Fast 倍率。",
    "models[].credits 可能为 0，不能据此把总 credits 精确分摊到各模型。",
    "threads 是每日统计值；跨日相加不等于去重后的任务数。",
  ];
  if (options.resetAt) warnings.push("重置时间可能落在一天中间；按天接口无法把重置日精确切开。额度反推因此只能是近似值。");
  if (modelDetailCoverageDays > 0 && modelDetailCoverageDays < rows.length) warnings.push(`模型明细仅覆盖 ${modelDetailCoverageDays}/${rows.length} 天；模型表不代表未覆盖日期。`);
  if (!modelThreadsMatch || !modelTurnsMatch) warnings.push("模型明细与 totals 的 threads/turns 未完全对齐；报告保留 totals 为汇总口径。");

  const daily = rows.map((row) => ({
    date: row.date,
    credits: row.credits,
    cachedTextInputTokens: row.cachedTextInputTokens,
    uncachedTextInputTokens: row.uncachedTextInputTokens,
    textOutputTokens: row.textOutputTokens,
    textTotalTokens: row.textTotalTokens,
    threads: row.threads,
    turns: row.turns,
    averageTurnsPerThread: row.threads > 0 ? row.turns / row.threads : 0,
  }));

  return {
    schema: AUDIT_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: {
      endpoint: "daily-workspace-usage-counts",
      documentedPublicApi: false,
      rangeStart: rows[0].date,
      rangeEnd: rows.at(-1).date,
      remainingPercent: options.remainingPercent,
      resetAt: options.resetAt,
      timezone: options.timezone,
    },
    summary: {
      credits,
      cachedTextInputTokens,
      uncachedTextInputTokens,
      textOutputTokens,
      textTotalTokens,
      threadsDailySum,
      turns,
      cachedTokenShare: textTotalTokens > 0 ? cachedTextInputTokens / textTotalTokens : 0,
      averageTurnsPerThreadDailySum: threadsDailySum > 0 ? turns / threadsDailySum : 0,
      modelDetailCoverageDays,
      solStandardReferenceCredits,
      chargedToSolStandardReferenceRatio: solStandardReferenceCredits > 0 ? credits / solStandardReferenceCredits : null,
      quotaInference: quotaInference(credits, options.remainingPercent),
    },
    daily,
    models,
    rates: {
      verifiedAt: RATE_CARD_VERIFIED_AT,
      pricingUrl: RATE_CARD_URL,
      fastModeUrl: FAST_MODE_URL,
      standardCreditsPerMillionTokens: ratesWithConversions(),
      fastMultipliers: [
        { models: "GPT-5.6 / GPT-5.5", multiplier: 2.5 },
        { models: "GPT-5.4", multiplier: 2 },
      ],
      referral250SolEquivalents: [
        {
          mode: "Sol Standard",
          uncachedInputTokens: 2_000_000,
          cachedInputTokens: 20_000_000,
          outputTokens: 1_000_000 / 3,
        },
        {
          mode: "Sol Fast (GPT-5.6, 2.5× credits)",
          uncachedInputTokens: 800_000,
          cachedInputTokens: 8_000_000,
          outputTokens: 400_000 / 3,
        },
      ],
    },
    validation: {
      checks: [
        { name: "日期唯一且有序", status: "pass" },
        { name: "每日 Token 分项恒等式", status: "pass" },
        { name: "敏感请求字段未进入输入", status: "pass" },
        { name: "模型明细覆盖天数", status: modelDetailCoverageDays === rows.length ? "pass" : "warning", detail: `${modelDetailCoverageDays}/${rows.length}` },
        { name: "模型 threads 与 totals 对齐", status: modelThreadsMatch ? "pass" : "warning" },
        { name: "模型 turns 与 totals 对齐", status: modelTurnsMatch ? "pass" : "warning" },
      ],
      warnings,
    },
  };
}

function formatNumber(value, maximumFractionDigits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(value);
}

function formatPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function mdEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownTable(headers, rows) {
  const header = `| ${headers.map(mdEscape).join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(mdEscape).join(" | ")} |`).join("\n");
  return [header, rule, body].filter(Boolean).join("\n");
}

function renderMarkdown(audit) {
  const quota = audit.summary.quotaInference;
  const quotaRows = quota
    ? [
        ["页面剩余", `${formatNumber(audit.source.remainingPercent, 1)}%`],
        ["已消耗比例", `${formatNumber(quota.consumedPercent, 1)}%`],
        ["周总额度点估计", formatNumber(quota.pointEstimateCredits, 0)],
        ["整数百分比取整区间", quota.roundingRangeCredits ? `${formatNumber(quota.roundingRangeCredits.min, 0)}–${formatNumber(quota.roundingRangeCredits.max, 0)}` : "无法计算"],
        ["估计剩余 credits", formatNumber(quota.estimatedRemainingCredits, 0)],
      ]
    : [["页面剩余比例", "未提供，因此不反推周总额度"]];
  const rateRows = audit.rates.standardCreditsPerMillionTokens.map((row) => [
    row.model,
    formatNumber(row.input, 2),
    formatNumber(row.cachedInput, 2),
    formatNumber(row.output, 2),
    formatNumber(row.tokensPerCredit.input, 0),
    formatNumber(row.tokensPerCredit.cachedInput, 0),
    formatNumber(row.tokensPerCredit.output, 0),
  ]);
  const lines = [
    "# Codex Credits 核对报告",
    "",
    `统计范围：${audit.source.rangeStart} 至 ${audit.source.rangeEnd}。Credits 不是美元；它是把模型、Token、工具与速度配置折算后的用量单位。`,
    "",
    "## 汇总",
    "",
    markdownTable(["指标", "数值"], [
      ["credits", formatNumber(audit.summary.credits, 6)],
      ["Token 总量", formatNumber(audit.summary.textTotalTokens)],
      ["缓存输入 Token", formatNumber(audit.summary.cachedTextInputTokens)],
      ["非缓存输入 Token", formatNumber(audit.summary.uncachedTextInputTokens)],
      ["输出 Token", formatNumber(audit.summary.textOutputTokens)],
      ["缓存 Token 占比", formatPercent(audit.summary.cachedTokenShare, 2)],
      ["每日 threads 相加（非去重）", formatNumber(audit.summary.threadsDailySum)],
      ["turns", formatNumber(audit.summary.turns)],
      ["平均 turns / 每日 thread", formatNumber(audit.summary.averageTurnsPerThreadDailySum, 2)],
      ["假设全部按 Sol Standard 的文本 credits", formatNumber(audit.summary.solStandardReferenceCredits, 6)],
      ["实际 / Sol Standard 参照", formatNumber(audit.summary.chargedToSolStandardReferenceRatio, 4)],
    ]),
    "",
    "## 每日数字",
    "",
    markdownTable(
      ["日期", "credits", "缓存输入", "非缓存输入", "输出", "Token 总量", "threads", "turns", "turns/thread"],
      audit.daily.map((row) => [
        row.date,
        formatNumber(row.credits, 6),
        formatNumber(row.cachedTextInputTokens),
        formatNumber(row.uncachedTextInputTokens),
        formatNumber(row.textOutputTokens),
        formatNumber(row.textTotalTokens),
        formatNumber(row.threads),
        formatNumber(row.turns),
        formatNumber(row.averageTurnsPerThread, 2),
      ]),
    ),
    "",
    "## 模型统计",
    "",
    `模型表能说明已提供明细的 ${audit.summary.modelDetailCoverageDays}/${audit.daily.length} 天记录过哪些模型以及 threads/turns 分布，但不能证明某一条回复被切换，也不能用 models[].credits=0 推翻 totals.credits。`,
    "",
    markdownTable(
      ["模型", "活跃日期", "threads 日累计", "turns", "平均 turns/thread", "models[].credits"],
      audit.models.map((row) => [
        row.model,
        formatNumber(row.activeDates),
        formatNumber(row.threadsDailySum),
        formatNumber(row.turns),
        formatNumber(row.averageTurnsPerThreadDailySum, 2),
        formatNumber(row.reportedCredits, 6),
      ]),
    ),
    "",
    "## 周额度近似反推",
    "",
    markdownTable(["项目", "数值"], quotaRows),
    "",
    "公式：已观察 credits ÷ 已消耗比例。若重置发生在一天中间、截图百分比取整、统计区间不完整或请求仍在进行，结果都只能视为近似值。",
    "",
    "## 官方 Credits 费率快照",
    "",
    markdownTable(
      ["模型", "1M 非缓存输入", "1M 缓存输入", "1M 输出", "1 credit≈非缓存输入", "1 credit≈缓存输入", "1 credit≈输出"],
      rateRows,
    ),
    "",
    "## 250 credits 折算为 Sol Token",
    "",
    markdownTable(
      ["模式", "非缓存输入", "缓存输入", "输出"],
      audit.rates.referral250SolEquivalents.map((row) => [
        row.mode,
        formatNumber(row.uncachedInputTokens),
        formatNumber(row.cachedInputTokens),
        formatNumber(row.outputTokens),
      ]),
    ),
    "",
    "实际任务通常同时包含三类 Token，所以 250 credits 没有唯一的 Token 数。Fast 模式下 GPT-5.6/GPT-5.5 按 Standard 的 2.5 倍消耗 credits。",
    "",
    "## 校验",
    "",
    markdownTable(["检查项", "结果"], audit.validation.checks.map((row) => [row.name, row.status])),
    "",
    ...audit.validation.warnings.map((warning) => `- ${warning}`),
    "",
    `费率核对日期：${audit.rates.verifiedAt}。官方来源：${audit.rates.pricingUrl}；Fast：${audit.rates.fastModeUrl}。`,
    "",
  ];
  return lines.join("\n");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function renderSvg(audit) {
  const width = 1600;
  const visibleRows = audit.daily.length <= 12 ? audit.daily : audit.daily.slice(-12);
  const height = 1040 + visibleRows.length * 45;
  const maxCredits = Math.max(1, ...audit.daily.map((row) => row.credits));
  const chartX = 96;
  const chartY = 360;
  const chartWidth = 1408;
  const chartHeight = 220;
  const barStep = chartWidth / audit.daily.length;
  const barWidth = Math.max(1, barStep * 0.72);
  const quota = audit.summary.quotaInference;
  const cards = [
    ["所选 credits", formatNumber(audit.summary.credits, 2)],
    ["Token 总量", formatNumber(audit.summary.textTotalTokens)],
    ["缓存占比", formatPercent(audit.summary.cachedTokenShare, 1)],
    ["周总额度近似", quota?.pointEstimateCredits ? formatNumber(quota.pointEstimateCredits, 0) : "未提供剩余比例"],
  ];
  const cardMarkup = cards.map(([label, value], index) => {
    const x = 96 + index * 360;
    return `<rect x="${x}" y="150" width="330" height="130" rx="18" fill="#ffffff" stroke="#ded9cf"/>\n`
      + `<text x="${x + 24}" y="194" class="label">${xmlEscape(label)}</text>\n`
      + `<text x="${x + 24}" y="247" class="value">${xmlEscape(value)}</text>`;
  }).join("\n");
  const bars = audit.daily.map((row, index) => {
    const x = chartX + index * barStep + (barStep - barWidth) / 2;
    const barHeight = Math.max(2, row.credits / maxCredits * chartHeight);
    const labelEvery = Math.max(1, Math.ceil(audit.daily.length / 10));
    const label = index % labelEvery === 0 || index === audit.daily.length - 1
      ? `<text x="${x + barWidth / 2}" y="${chartY + chartHeight + 28}" class="axis" text-anchor="middle">${xmlEscape(row.date.slice(5))}</text>`
      : "";
    return `<rect x="${x}" y="${chartY + chartHeight - barHeight}" width="${barWidth}" height="${barHeight}" rx="4" fill="#1463ff">`
      + `<title>${xmlEscape(row.date)} · ${xmlEscape(formatNumber(row.credits, 6))} credits</title></rect>${label}`;
  }).join("\n");
  const tableY = 680;
  const columns = [96, 285, 485, 720, 955, 1190, 1370, 1500];
  const headers = ["日期", "credits", "缓存输入", "非缓存输入", "输出", "Token 总量", "threads", "turns"];
  const headerMarkup = headers.map((header, index) => `<text x="${columns[index]}" y="${tableY}" class="th"${index ? ' text-anchor="end"' : ""}>${xmlEscape(header)}</text>`).join("\n");
  const rowsMarkup = visibleRows.map((row, index) => {
    const y = tableY + 48 + index * 45;
    const values = [
      row.date,
      formatNumber(row.credits, 3),
      formatNumber(row.cachedTextInputTokens),
      formatNumber(row.uncachedTextInputTokens),
      formatNumber(row.textOutputTokens),
      formatNumber(row.textTotalTokens),
      formatNumber(row.threads),
      formatNumber(row.turns),
    ];
    return `<line x1="96" y1="${y + 14}" x2="1504" y2="${y + 14}" stroke="#e7e2d9"/>\n`
      + values.map((value, columnIndex) => `<text x="${columns[columnIndex]}" y="${y}" class="td"${columnIndex ? ' text-anchor="end"' : ""}>${xmlEscape(value)}</text>`).join("\n");
  }).join("\n");
  const noteY = tableY + 88 + visibleRows.length * 45;
  const rangeText = quota?.roundingRangeCredits
    ? `按 ${formatNumber(audit.source.remainingPercent, 1)}% 剩余反推：约 ${formatNumber(quota.pointEstimateCredits, 0)} credits；只考虑整数百分比取整时约 ${formatNumber(quota.roundingRangeCredits.min, 0)}–${formatNumber(quota.roundingRangeCredits.max, 0)}。`
    : "未提供页面剩余百分比，因此不反推周总 credits。";
  const truncated = audit.daily.length > visibleRows.length
    ? `<text x="96" y="${noteY - 26}" class="muted">图内仅列最近 ${visibleRows.length} 天；完整每日表见 HTML / Markdown。</text>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Codex Credits 核对报告</title>
  <desc id="desc">${xmlEscape(audit.source.rangeStart)} 至 ${xmlEscape(audit.source.rangeEnd)} 的 credits、Token 和额度近似值</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; fill:#171717; }
    .eyebrow { font-size:18px; font-weight:700; letter-spacing:2px; fill:#1463ff; }
    .title { font-size:50px; font-weight:760; }
    .subtitle { font-size:19px; fill:#5f5b54; }
    .label { font-size:18px; fill:#69645d; }
    .value { font-size:34px; font-weight:750; }
    .section { font-size:26px; font-weight:730; }
    .axis { font-size:14px; fill:#6f6b64; }
    .th { font-size:17px; font-weight:700; fill:#4d4943; }
    .td { font-size:17px; font-variant-numeric:tabular-nums; }
    .note { font-size:19px; font-weight:650; }
    .muted { font-size:16px; fill:#6f6b64; }
  </style>
  <rect width="1600" height="${height}" fill="#f7f4ee"/>
  <text x="96" y="66" class="eyebrow">CODEX · CREDITS AUDIT</text>
  <text x="96" y="122" class="title">Credits 到底有没有算对？</text>
  <text x="1504" y="118" class="subtitle" text-anchor="end">${xmlEscape(audit.source.rangeStart)} — ${xmlEscape(audit.source.rangeEnd)}</text>
  ${cardMarkup}
  <text x="96" y="330" class="section">每日 credits</text>
  <line x1="96" y1="${chartY + chartHeight}" x2="1504" y2="${chartY + chartHeight}" stroke="#bdb7ad"/>
  ${bars}
  <text x="96" y="640" class="section">每日明细</text>
  ${headerMarkup}
  ${rowsMarkup}
  ${truncated}
  <rect x="96" y="${noteY}" width="1408" height="150" rx="18" fill="#fff7ed" stroke="#f2b276"/>
  <text x="124" y="${noteY + 43}" class="note">额度反推</text>
  <text x="124" y="${noteY + 82}" class="subtitle">${xmlEscape(rangeText)}</text>
  <text x="124" y="${noteY + 119}" class="muted">Fast 会提高 credits 消耗速率；totals.credits 按已计入的消耗处理，不应再次乘以 2.5。</text>
  <text x="96" y="${height - 46}" class="muted">Credits 不是美元。内部网页接口可能变化；完整校验、模型表与换算表见 HTML / Markdown。</text>
</svg>`;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlTable(headers, rows) {
  return `<div class="table-scroll"><table><thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("")}</tr></thead>`
    + `<tbody>${rows.map((row) => `<tr>${row.map((cell, index) => `<td${index ? ' class="num"' : ""}>${htmlEscape(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function renderHtml(audit, svg) {
  const summaryRows = [
    ["credits", formatNumber(audit.summary.credits, 6)],
    ["Token 总量", formatNumber(audit.summary.textTotalTokens)],
    ["缓存输入 Token", formatNumber(audit.summary.cachedTextInputTokens)],
    ["非缓存输入 Token", formatNumber(audit.summary.uncachedTextInputTokens)],
    ["输出 Token", formatNumber(audit.summary.textOutputTokens)],
    ["缓存 Token 占比", formatPercent(audit.summary.cachedTokenShare, 2)],
    ["threads 日累计（非去重）", formatNumber(audit.summary.threadsDailySum)],
    ["turns", formatNumber(audit.summary.turns)],
    ["平均 turns / 每日 thread", formatNumber(audit.summary.averageTurnsPerThreadDailySum, 2)],
    ["Sol Standard 文本 credits 参照", formatNumber(audit.summary.solStandardReferenceCredits, 6)],
    ["实际 / Sol Standard 参照", formatNumber(audit.summary.chargedToSolStandardReferenceRatio, 4)],
  ];
  const modelRows = audit.models.map((row) => [
    row.model,
    formatNumber(row.activeDates),
    formatNumber(row.threadsDailySum),
    formatNumber(row.turns),
    formatNumber(row.averageTurnsPerThreadDailySum, 2),
    formatNumber(row.reportedCredits, 6),
  ]);
  const rateRows = audit.rates.standardCreditsPerMillionTokens.map((row) => [
    row.model,
    formatNumber(row.input, 2),
    formatNumber(row.cachedInput, 2),
    formatNumber(row.output, 2),
    formatNumber(row.tokensPerCredit.input),
    formatNumber(row.tokensPerCredit.cachedInput),
    formatNumber(row.tokensPerCredit.output),
  ]);
  const quota = audit.summary.quotaInference;
  const quotaText = quota?.pointEstimateCredits
    ? `点估计 ${formatNumber(quota.pointEstimateCredits, 0)} credits${quota.roundingRangeCredits ? `；整数百分比取整区间约 ${formatNumber(quota.roundingRangeCredits.min, 0)}–${formatNumber(quota.roundingRangeCredits.max, 0)}` : ""}。`
    : "未提供可用的剩余百分比，因此不反推周总额度。";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codex Credits 核对报告</title>
<style>
  :root{color-scheme:light;--paper:#f7f4ee;--ink:#171717;--muted:#69645d;--line:#ded9cf;--blue:#1463ff;--orange:#f26a2e}
  *{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}
  main{max-width:1440px;margin:auto;padding:32px 28px 80px}.visual{width:100%;overflow:auto;border:1px solid var(--line);background:white;border-radius:14px}.visual svg{display:block;width:100%;height:auto}
  section{margin-top:42px}h1{font-size:42px;margin:0 0 8px}h2{font-size:28px;margin:0 0 12px}p{max-width:980px;color:var(--muted)}
  .callout{padding:18px 22px;border:1px solid #f2b276;background:#fff7ed;border-radius:12px;color:var(--ink)}
  .table-scroll{overflow:auto;border:1px solid var(--line);border-radius:12px;background:#fff}table{border-collapse:collapse;width:100%;min-width:940px;font-variant-numeric:tabular-nums}th,td{padding:12px 14px;border-bottom:1px solid #ece7df;text-align:left;white-space:nowrap}th{background:#fbfaf7;font-size:14px}.num{text-align:right}
  ul{color:var(--muted)}code{background:#ebe7df;padding:2px 5px;border-radius:4px}@media(max-width:620px){main{padding:20px 14px 60px}h1{font-size:32px}}
</style></head><body><main>
  <h1>Codex Credits 核对报告</h1>
  <p>${htmlEscape(audit.source.rangeStart)} 至 ${htmlEscape(audit.source.rangeEnd)}。Credits 是用量折算单位，不是美元。</p>
  <div class="visual">${svg.replace(/^<\?xml[^>]*>\s*/u, "")}</div>
  <section><h2>汇总数字</h2>${htmlTable(["指标", "数值"], summaryRows)}</section>
  <section><h2>每日数字</h2>${htmlTable(
    ["日期", "credits", "缓存输入", "非缓存输入", "输出", "Token 总量", "threads", "turns", "turns/thread"],
    audit.daily.map((row) => [row.date, formatNumber(row.credits, 6), formatNumber(row.cachedTextInputTokens), formatNumber(row.uncachedTextInputTokens), formatNumber(row.textOutputTokens), formatNumber(row.textTotalTokens), formatNumber(row.threads), formatNumber(row.turns), formatNumber(row.averageTurnsPerThread, 2)]),
  )}</section>
  <section><h2>模型数字</h2><p>模型明细覆盖 ${htmlEscape(audit.summary.modelDetailCoverageDays)}/${htmlEscape(audit.daily.length)} 天，用于说明模型出现情况和 threads/turns 分布；不把 <code>models[].credits</code> 当成总额度。</p>${htmlTable(["模型", "活跃日期", "threads 日累计", "turns", "平均 turns/thread", "models[].credits"], modelRows)}</section>
  <section><h2>周额度近似</h2><div class="callout">${htmlEscape(quotaText)} Fast 或工具调用可能已经体现在 <code>totals.credits</code> 中，不要重复乘倍率。</div></section>
  <section><h2>官方费率与 1 credit 换算</h2>${htmlTable(["模型", "1M 非缓存输入", "1M 缓存输入", "1M 输出", "1 credit≈非缓存输入", "1 credit≈缓存输入", "1 credit≈输出"], rateRows)}</section>
  <section><h2>250 credits 的 Sol 等价量</h2>${htmlTable(["模式", "非缓存输入", "缓存输入", "输出"], audit.rates.referral250SolEquivalents.map((row) => [row.mode, formatNumber(row.uncachedInputTokens), formatNumber(row.cachedInputTokens), formatNumber(row.outputTokens)]))}<p>实际任务混合三类 Token，因此没有唯一 Token 数。</p></section>
  <section><h2>校验与限制</h2><ul>${audit.validation.warnings.map((warning) => `<li>${htmlEscape(warning)}</li>`).join("")}</ul><p>费率快照核对于 ${htmlEscape(audit.rates.verifiedAt)}；公开文档链接保留在 JSON/Markdown 中。不要上传 Headers、Cookies、Authorization 或 HAR。</p></section>
</main></body></html>`;
}

function isOwnedOutputDirectory(directory) {
  const marker = resolve(directory, OUTPUT_MARKER);
  if (!existsSync(marker) || !lstatSync(marker).isFile()) return false;
  try {
    return JSON.parse(readFileSync(marker, "utf8")).schema === OUTPUT_MARKER_SCHEMA;
  } catch {
    return false;
  }
}

function prepareOutputDirectory(directory, replaceOutput) {
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`output path must be a real directory: ${directory}`);
    if (readdirSync(directory).length && !replaceOutput && !isOwnedOutputDirectory(directory)) {
      throw new Error(`output directory is not empty and is not owned by this audit: ${directory}`);
    }
  } else {
    mkdirSync(directory, { recursive: true });
  }
  chmodSync(directory, 0o700);
}

function writePrivateAtomic(file, contents) {
  const temporary = resolve(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeArtifacts(outputDirectory, audit) {
  const auditPath = resolve(outputDirectory, "codex-credits-audit.json");
  const markdownPath = resolve(outputDirectory, "codex-credits-audit.md");
  const svgPath = resolve(outputDirectory, "codex-credits-audit.svg");
  const htmlPath = resolve(outputDirectory, "codex-credits-audit.html");
  const manifestPath = resolve(outputDirectory, "codex-credits-audit-manifest.json");
  const markerPath = resolve(outputDirectory, OUTPUT_MARKER);
  const svg = renderSvg(audit);
  const markdown = renderMarkdown(audit);
  const html = renderHtml(audit, svg);
  writePrivateAtomic(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  writePrivateAtomic(markdownPath, markdown);
  writePrivateAtomic(svgPath, svg);
  writePrivateAtomic(htmlPath, html);
  writePrivateAtomic(markerPath, `${JSON.stringify({ schema: OUTPUT_MARKER_SCHEMA })}\n`);
  const files = [auditPath, markdownPath, svgPath, htmlPath].map((file) => ({
    path: basename(file),
    sha256: sha256(file),
  }));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: audit.generatedAt,
    range: { start: audit.source.rangeStart, end: audit.source.rangeEnd },
    files,
    privacy: "sanitized totals only; no headers, cookies, authorization, account IDs, or client details",
  };
  writePrivateAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { auditPath, markdownPath, svgPath, htmlPath, manifestPath };
}

function validateArtifacts(artifacts) {
  const result = spawnSync(process.execPath, [
    resolve(import.meta.dirname, "validate-credits-audit.mjs"),
    "--audit", artifacts.auditPath,
    "--markdown", artifacts.markdownPath,
    "--svg", artifacts.svgPath,
    "--html", artifacts.htmlPath,
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`generated artifact validation failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputPath = resolve(args.input);
  if (!existsSync(inputPath) || !lstatSync(inputPath).isFile() || lstatSync(inputPath).isSymbolicLink()) {
    throw new Error(`input must be a regular file: ${inputPath}`);
  }
  const outputDirectory = resolve(args["output-dir"]);
  if (outputDirectory === resolve(inputPath) || outputDirectory === dirname(resolve(inputPath))) {
    throw new Error("use a dedicated output directory that is different from the input file's directory");
  }
  const rows = readAndNormalizeInput(inputPath);
  const { selected } = selectRows(rows, args.from, args.to);
  const options = {
    remainingPercent: parseRemainingPercent(args["remaining-percent"]),
    resetAt: parseResetAt(args["reset-at"]),
    timezone: validateTimezone(args.timezone),
  };
  const audit = buildAudit(selected, options);
  prepareOutputDirectory(outputDirectory, Boolean(args["replace-output"]));
  const artifacts = writeArtifacts(outputDirectory, audit);
  const validation = validateArtifacts(artifacts);
  process.stdout.write(`${JSON.stringify({
    status: "complete",
    outputDirectory,
    report: artifacts.htmlPath,
    markdown: artifacts.markdownPath,
    graphic: artifacts.svgPath,
    audit: artifacts.auditPath,
    manifest: artifacts.manifestPath,
    validation,
    summary: audit.summary,
  }, null, 2)}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "unknown error"));
