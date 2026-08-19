#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function fail(message) {
  process.stderr.write(`Official analytics validation failed: ${message}\n`);
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

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function hasCredentialLikeText(text) {
  return /(?:authorization\s*[:=]|proxy-authorization\s*[:=]|set-cookie\s*[:=]|bearer\s+[a-z0-9._~-]{12,}|(?:access|refresh|session)[-_]?token\s*[:=])/iu.test(text);
}

function validateDimension(rows, key, summaryTurns) {
  check(Array.isArray(rows), `${key} rows are missing`);
  for (const row of rows) {
    check(typeof row.displayName === "string" && row.displayName.length > 0, `${key} display name is invalid`);
    check(isNonnegativeInteger(row.threadsDailySum), `${key} threads daily sum is invalid`);
    check(isNonnegativeInteger(row.turns), `${key} turns is invalid`);
    check(isNonnegativeInteger(row.activeBuckets), `${key} active buckets is invalid`);
    close(row.turnShare, summaryTurns > 0 ? row.turns / summaryTurns : 0, 1e-12, `${key} turn share`);
  }
}

function validateToolRows(rows, label, expectedTotal, supplied) {
  check(Array.isArray(rows), `${label} rows are missing`);
  if (!supplied) {
    check(rows.length === 0, `${label} rows must be empty when the response was not supplied`);
    check(expectedTotal === null, `${label} total must be null when the response was not supplied`);
    return;
  }
  check(isNonnegativeInteger(expectedTotal), `${label} total is invalid`);
  for (const row of rows) {
    check(typeof row.name === "string" && row.name.length > 0, `${label} name is invalid`);
    check(typeof row.displayName === "string" && row.displayName.length > 0, `${label} display name is invalid`);
    check(isNonnegativeInteger(row.invocations), `${label} invocation count is invalid`);
    check(isNonnegativeInteger(row.activeBuckets), `${label} active buckets is invalid`);
    close(row.share, expectedTotal > 0 ? row.invocations / expectedTotal : 0, 1e-12, `${label} share`);
  }
  check(sum(rows, (row) => row.invocations) === expectedTotal, `${label} aggregate diverged from the summary`);
}

function validate() {
  const args = parseArgs(process.argv.slice(2));
  const auditText = readFileSync(args.audit, "utf8");
  const markdown = readFileSync(args.markdown, "utf8");
  const svg = readFileSync(args.svg, "utf8");
  const html = readFileSync(args.html, "utf8");
  const audit = JSON.parse(auditText);

  check(audit.schema === "codex.official.analytics.audit.v1", "unexpected audit schema");
  check(Array.isArray(audit.daily) && audit.daily.length > 0, "daily rows are missing");
  check(Array.isArray(audit.validation?.checks), "validation checks are missing");
  check(Array.isArray(audit.validation?.warnings), "validation warnings are missing");
  check(audit.source?.groupBy === "day" || audit.source?.groupBy === "week", "group_by is invalid");
  check(audit.source?.endpoints?.usage?.supplied === true, "usage response must be supplied");

  const dates = audit.daily.map((row) => row.date);
  check(audit.source.rangeStart === dates[0], "range start diverged from daily data");
  check(audit.source.rangeEnd === dates.at(-1), "range end diverged from daily data");
  check(new Set(dates).size === dates.length, "daily dates are not unique");
  check(dates.every((date, index) => index === 0 || dates[index - 1] < date), "daily dates are not ordered");

  const skillsSupplied = audit.source.endpoints.skills.supplied === true;
  const pluginsSupplied = audit.source.endpoints.plugins.supplied === true;
  check(audit.source.endpoints.usage.bucketsInRange === audit.daily.length, "usage bucket count diverged");
  check(!skillsSupplied || audit.source.endpoints.skills.bucketsInRange === audit.daily.length, "Skill bucket count diverged");
  check(!pluginsSupplied || audit.source.endpoints.plugins.bucketsInRange === audit.daily.length, "Plugin bucket count diverged");
  for (const row of audit.daily) {
    check(/^\d{4}-\d{2}-\d{2}$/u.test(row.date), `${row.date} is not a valid date bucket`);
    check(isNonnegativeInteger(row.threads), `${row.date} threads is invalid`);
    check(isNonnegativeInteger(row.turns), `${row.date} turns is invalid`);
    check(skillsSupplied ? isNonnegativeInteger(row.skillInvocations) : row.skillInvocations === null, `${row.date} Skill count is invalid`);
    check(pluginsSupplied ? isNonnegativeInteger(row.pluginCalls) : row.pluginCalls === null, `${row.date} Plugin count is invalid`);
  }

  check(audit.summary.buckets === audit.daily.length, "bucket count diverged");
  check(sum(audit.daily, (row) => row.threads) === audit.summary.threadsDailySum, "thread daily sum diverged");
  check(sum(audit.daily, (row) => row.turns) === audit.summary.turns, "turn total diverged");
  close(
    audit.summary.averageTurnsPerDailyThread,
    audit.summary.threadsDailySum > 0 ? audit.summary.turns / audit.summary.threadsDailySum : 0,
    1e-12,
    "average turns per daily thread",
  );
  if (skillsSupplied) {
    check(sum(audit.daily, (row) => row.skillInvocations) === audit.summary.skillInvocations, "daily Skill total diverged");
  } else {
    check(audit.summary.skillInvocations === null, "missing Skill response must produce a null total");
  }
  if (pluginsSupplied) {
    check(sum(audit.daily, (row) => row.pluginCalls) === audit.summary.pluginCalls, "daily Plugin total diverged");
  } else {
    check(audit.summary.pluginCalls === null, "missing Plugin response must produce a null total");
  }

  validateDimension(audit.models, "model", audit.summary.turns);
  validateDimension(audit.clients, "client", audit.summary.turns);
  validateToolRows(audit.skills, "Skill", audit.summary.skillInvocations, skillsSupplied);
  validateToolRows(audit.plugins, "Plugin", audit.summary.pluginCalls, pluginsSupplied);
  check(audit.summary.modelSeries === audit.models.length, "model series count diverged");
  check(audit.summary.clientSeries === audit.clients.length, "client series count diverged");
  check(audit.summary.skillSeries === audit.skills.length, "Skill series count diverged");
  check(audit.summary.pluginSeries === audit.plugins.length, "Plugin series count diverged");

  for (const date of dates) {
    check(markdown.includes(date), `Markdown omits date ${date}`);
    check(svg.includes(date), `SVG omits date ${date}`);
    check(html.includes(date), `HTML omits date ${date}`);
  }
  check(markdown.includes("| 日期 | threads（日值） | turns | Skill 激活 | Plugin calls |"), "Markdown daily table is missing");
  check(markdown.includes("## 按模型统计"), "Markdown model table is missing");
  check(markdown.includes("## 按客户端统计"), "Markdown client table is missing");
  check(markdown.includes("## Skills"), "Markdown Skills table is missing");
  check(markdown.includes("## Plugins"), "Markdown Plugins table is missing");
  check(svg.startsWith("<?xml") && svg.includes("<svg"), "SVG is invalid");
  check(!/<script\b/iu.test(svg), "SVG unexpectedly contains script");
  check(/<!doctype html>/iu.test(html), "HTML doctype is missing");
  check(!/(?:src|href)=["']https?:\/\//iu.test(html), "HTML has a remote runtime dependency");
  for (const text of [auditText, markdown, svg, html]) {
    check(!hasCredentialLikeText(text), "an output contains credential-like text");
  }

  process.stdout.write(`${JSON.stringify({
    status: "valid",
    schema: audit.schema,
    range: { start: audit.source.rangeStart, end: audit.source.rangeEnd },
    dailyRows: audit.daily.length,
    turns: audit.summary.turns,
    skillInvocations: audit.summary.skillInvocations,
    pluginCalls: audit.summary.pluginCalls,
  })}\n`);
}

try {
  validate();
} catch (error) {
  fail(error instanceof Error ? error.message : "unknown error");
}
