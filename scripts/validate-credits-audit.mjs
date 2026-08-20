#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  process.stderr.write(`Credits audit validation failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const allowed = new Set(["audit", "markdown", "svg", "html"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    args[key] = resolve(value);
    index += 1;
  }
  for (const key of allowed) {
    if (!args[key]) throw new Error(`--${key} is required`);
    if (!existsSync(args[key])) throw new Error(`missing ${key}: ${args[key]}`);
  }
  return args;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function close(left, right, tolerance, message) {
  check(Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance, `${message}: ${left} != ${right}`);
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function formatOneDecimal(value) {
  return new Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTokenQuantity(value) {
  if (Math.abs(value) >= 100_000_000) return `${formatOneDecimal(value / 100_000_000)}亿`;
  if (Math.abs(value) >= 10_000) return `${formatOneDecimal(value / 10_000)}万`;
  return formatOneDecimal(value);
}

function hasCredentialLikeText(text) {
  return /(?:authorization\s*[:=]|proxy-authorization\s*[:=]|set-cookie\s*[:=]|bearer\s+[a-z0-9._~-]{12,}|(?:access|refresh|session)[-_]?token\s*[:=])/iu.test(text);
}

function validate() {
  const args = parseArgs(process.argv.slice(2));
  const auditText = readFileSync(args.audit, "utf8");
  const markdown = readFileSync(args.markdown, "utf8");
  const svg = readFileSync(args.svg, "utf8");
  const html = readFileSync(args.html, "utf8");
  const audit = JSON.parse(auditText);

  check(audit.schema === "codex.credits.audit.v1", "unexpected audit schema");
  check(Array.isArray(audit.daily) && audit.daily.length > 0, "daily rows are missing");
  check(Array.isArray(audit.models), "model rows are missing");
  check(Array.isArray(audit.validation?.checks), "validation checks are missing");
  check(Array.isArray(audit.validation?.warnings), "validation warnings are missing");
  check(audit.source.rangeStart === audit.daily[0].date, "range start diverged from daily data");
  check(audit.source.rangeEnd === audit.daily.at(-1).date, "range end diverged from daily data");
  const dates = audit.daily.map((row) => row.date);
  check(new Set(dates).size === dates.length, "daily dates are not unique");
  check(dates.every((date, index) => index === 0 || dates[index - 1] < date), "daily dates are not ordered");

  for (const row of audit.daily) {
    check(Number.isSafeInteger(row.cachedTextInputTokens) && row.cachedTextInputTokens >= 0, `${row.date} cached input is invalid`);
    check(Number.isSafeInteger(row.uncachedTextInputTokens) && row.uncachedTextInputTokens >= 0, `${row.date} uncached input is invalid`);
    check(Number.isSafeInteger(row.textOutputTokens) && row.textOutputTokens >= 0, `${row.date} output is invalid`);
    check(Number.isSafeInteger(row.textTotalTokens) && row.textTotalTokens >= 0, `${row.date} total is invalid`);
    check(row.cachedTextInputTokens + row.uncachedTextInputTokens + row.textOutputTokens === row.textTotalTokens, `${row.date} Token identity failed`);
    check(typeof row.credits === "number" && Number.isFinite(row.credits) && row.credits >= 0, `${row.date} credits is invalid`);
  }

  close(sum(audit.daily, (row) => row.credits), audit.summary.credits, 1e-8, "credit total");
  check(sum(audit.daily, (row) => row.cachedTextInputTokens) === audit.summary.cachedTextInputTokens, "cached input total diverged");
  check(sum(audit.daily, (row) => row.uncachedTextInputTokens) === audit.summary.uncachedTextInputTokens, "uncached input total diverged");
  check(sum(audit.daily, (row) => row.textOutputTokens) === audit.summary.textOutputTokens, "output total diverged");
  check(sum(audit.daily, (row) => row.textTotalTokens) === audit.summary.textTotalTokens, "Token total diverged");
  check(sum(audit.daily, (row) => row.threads) === audit.summary.threadsDailySum, "thread daily sum diverged");
  check(sum(audit.daily, (row) => row.turns) === audit.summary.turns, "turn total diverged");
  check(audit.summary.cachedTextInputTokens + audit.summary.uncachedTextInputTokens + audit.summary.textOutputTokens === audit.summary.textTotalTokens, "summary Token identity failed");

  const expectedSolReference = (
    audit.summary.uncachedTextInputTokens * 125
    + audit.summary.cachedTextInputTokens * 12.5
    + audit.summary.textOutputTokens * 750
  ) / 1_000_000;
  close(audit.summary.solStandardReferenceCredits, expectedSolReference, 1e-8, "Sol Standard reference credits");
  if (audit.summary.quotaInference?.pointEstimateCredits != null) {
    close(
      audit.summary.quotaInference.pointEstimateCredits,
      audit.summary.credits / (audit.summary.quotaInference.consumedPercent / 100),
      1e-8,
      "quota point estimate",
    );
  }

  check(audit.rates?.standardCreditsPerMillionTokens?.length >= 3, "rate card is missing");
  const sol = audit.rates.standardCreditsPerMillionTokens.find((row) => row.model === "GPT-5.6 Sol");
  check(sol?.input === 125 && sol?.cachedInput === 12.5 && sol?.output === 750, "Sol rate card is invalid");
  close(sol.tokensPerCredit.input, 8_000, 1e-10, "Sol input conversion");
  close(sol.tokensPerCredit.cachedInput, 80_000, 1e-10, "Sol cached conversion");
  close(sol.tokensPerCredit.output, 4_000 / 3, 1e-10, "Sol output conversion");
  const referralFast = audit.rates.referral250SolEquivalents.find((row) => row.mode.includes("Fast"));
  check(referralFast?.uncachedInputTokens === 800_000 && referralFast?.cachedInputTokens === 8_000_000, "250-credit Fast conversion is invalid");

  for (const date of dates) {
    check(markdown.includes(date), `Markdown omits date ${date}`);
    check(svg.includes(date), `SVG omits date ${date}`);
    check(html.includes(date), `HTML omits date ${date}`);
  }
  const summaryTokenDisplays = [
    formatTokenQuantity(audit.summary.textTotalTokens),
    formatTokenQuantity(audit.summary.cachedTextInputTokens),
    formatTokenQuantity(audit.summary.uncachedTextInputTokens),
    formatTokenQuantity(audit.summary.textOutputTokens),
  ];
  for (const display of summaryTokenDisplays) {
    check(markdown.includes(display), `Markdown omits compact Token display ${display}`);
    check(html.includes(display), `HTML omits compact Token display ${display}`);
  }
  check(svg.includes(formatTokenQuantity(audit.summary.textTotalTokens)), "SVG omits compact Token total");
  for (const row of audit.daily) {
    for (const value of [row.cachedTextInputTokens, row.uncachedTextInputTokens, row.textOutputTokens, row.textTotalTokens]) {
      const display = formatTokenQuantity(value);
      check(markdown.includes(display), `Markdown omits daily compact Token display ${display}`);
      check(html.includes(display), `HTML omits daily compact Token display ${display}`);
    }
  }
  const visibleSvgRows = audit.daily.length <= 12 ? audit.daily : audit.daily.slice(-12);
  for (const row of visibleSvgRows) {
    for (const value of [row.cachedTextInputTokens, row.uncachedTextInputTokens, row.textOutputTokens, row.textTotalTokens]) {
      const display = formatTokenQuantity(value);
      check(svg.includes(display), `SVG omits visible compact Token display ${display}`);
    }
  }
  check(markdown.includes("| 日期 | credits | 缓存输入 | 非缓存输入 |"), "Markdown daily table is missing");
  check(markdown.includes("Token 大数使用“万/亿”并统一保留 1 位小数"), "Markdown compact-display note is missing");
  check(markdown.includes("250 credits 折算为 Sol Token"), "Markdown referral conversion table is missing");
  check(svg.startsWith("<?xml") && svg.includes("<svg"), "SVG is invalid");
  check(!/<script\b/iu.test(svg), "SVG unexpectedly contains script");
  check(/<!doctype html>/iu.test(html), "HTML doctype is missing");
  check(!/(?:src|href)=["']https?:\/\//iu.test(html), "HTML has a remote runtime dependency");
  check(html.includes('.num{text-align:center}'), "HTML numeric columns are not centered");
  check(html.includes('<th class="num">活跃日期</th>'), "HTML model numeric headers are not centered");
  for (const text of [auditText, markdown, svg, html]) {
    check(!hasCredentialLikeText(text), "an output contains credential-like text");
  }

  process.stdout.write(`${JSON.stringify({
    status: "valid",
    schema: audit.schema,
    range: { start: audit.source.rangeStart, end: audit.source.rangeEnd },
    dailyRows: audit.daily.length,
    credits: audit.summary.credits,
    tokens: audit.summary.textTotalTokens,
  })}\n`);
}

try {
  validate();
} catch (error) {
  fail(error instanceof Error ? error.message : "unknown error");
}
