#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) args[key] = true;
    else { args[key] = value; index += 1; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.source || !args.data || !args.report) {
  throw new Error("Usage: node validate-report.mjs --source <codeburn.json> --data <report-data.json> --report <report.html>");
}
const skillRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(args.source);
const dataPath = resolve(args.data);
const reportPath = resolve(args.report);
function firstExisting(...paths) {
  const found = paths.find((path) => existsSync(path));
  if (!found) throw new Error(`Required distribution notice is missing: ${paths.join(" or ")}`);
  return found;
}
const packagedProjectLicensePath = resolve(skillRoot, "licenses/LICENSE-Apache-2.0.txt");
const distributionNoticePaths = [
  firstExisting(resolve(skillRoot, "LICENSE.txt"), resolve(skillRoot, "LICENSE")),
  ...(existsSync(packagedProjectLicensePath) ? [packagedProjectLicensePath] : []),
  firstExisting(resolve(skillRoot, "NOTICE.txt"), resolve(skillRoot, "NOTICE")),
  resolve(skillRoot, "assets/vendor/echarts/LICENSE.txt"),
  resolve(skillRoot, "assets/vendor/echarts/NOTICE.txt"),
  firstExisting(
    resolve(skillRoot, "assets/vendor/echarts/licenses/LICENSE-d3.txt"),
    resolve(skillRoot, "assets/vendor/echarts/licenses/LICENSE-d3"),
  ),
  firstExisting(
    resolve(skillRoot, "assets/vendor/echarts/licenses/LICENSE-zrender.txt"),
    resolve(skillRoot, "assets/vendor/echarts/licenses/LICENSE-zrender"),
  ),
  firstExisting(
    resolve(skillRoot, "assets/vendor/echarts/licenses/LICENSE-tslib.txt"),
    resolve(skillRoot, "assets/vendor/echarts/licenses/LICENSE-tslib"),
  ),
  firstExisting(
    resolve(skillRoot, "assets/vendor/echarts/licenses/CopyrightNotice-tslib.txt"),
    resolve(skillRoot, "assets/vendor/echarts/licenses/CopyrightNotice-tslib"),
  ),
];
const SESSION_PSEUDONYM_PATTERN = /^session-[0-9a-f]{12}$/;
const UUID_PATTERN = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu;

function sessionPseudonym(value) {
  return `session-${createHash("sha256").update(String(value ?? "historical-unknown")).digest("hex").slice(0, 12)}`;
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function close(actual, expected, tolerance, label) {
  check(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
}

for (const file of [sourcePath, dataPath, reportPath, ...distributionNoticePaths]) {
  check(existsSync(file), `Missing required file: ${file}`);
}
if (args.lifecycle || args.official) {
  check(Boolean(args.lifecycle && args.official), "--lifecycle and --official must be provided together");
  check(existsSync(resolve(args.lifecycle)), `Missing lifecycle ledger: ${args.lifecycle}`);
  check(existsSync(resolve(args.official)), `Missing official usage: ${args.official}`);
}

const source = JSON.parse(readFileSync(sourcePath, "utf8"));
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const report = readFileSync(reportPath, "utf8");
const staticMarkup = report.slice(0, report.indexOf("<script"));
for (const noticePath of distributionNoticePaths) {
  check(report.includes(readFileSync(noticePath, "utf8").trimEnd()), `HTML report omits distribution notice ${noticePath}`);
}
const localDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: data.meta.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
const localWeekdayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: data.meta.timezone, weekday: "short" });
const localHourFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: data.meta.timezone, hour: "2-digit", hourCycle: "h23" });
const lifecycleMode = Boolean(args.lifecycle && args.official);
const lifecycle = lifecycleMode ? JSON.parse(readFileSync(resolve(args.lifecycle), "utf8")) : null;
const official = lifecycleMode ? JSON.parse(readFileSync(resolve(args.official), "utf8")) : null;
const rangeRecords = lifecycleMode
  ? lifecycle.records.filter((record) => record.date >= data.meta.rangeStart && record.date <= data.meta.rangeEnd).map((record) => ({
      project: record.project,
      sessionId: record.sessionId,
      timestamp: record.timestamp,
      category: record.activity,
      model: record.model,
      inputTokens: record.input,
      outputTokens: record.output,
      reasoningTokens: 0,
      cacheReadTokens: record.cacheRead,
      cacheWriteTokens: record.cacheWrite,
      cost: record.cost,
      calls: record.calls,
    }))
  : source.records.filter((record) => {
      const date = localDateFormatter.format(new Date(record.timestamp));
      return date >= data.meta.rangeStart && date <= data.meta.rangeEnd;
    });
const recordCalls = (record) => Number(record.calls ?? 1);
const sourceSummary = lifecycleMode ? {
  "Cost (USD)": sum(rangeRecords, (record) => record.cost ?? 0),
  "API Calls": sum(rangeRecords, recordCalls),
  Sessions: new Set(rangeRecords.map((record) => record.sessionId)).size,
} : source.summary[0];
const rangeSessionCount = new Set(rangeRecords.map((record) => record.sessionId)).size;
const tokenFields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

const rawSessionIds = new Set();
const rememberRawSessionId = (value) => {
  if (value !== null && value !== undefined && String(value).length > 0) rawSessionIds.add(String(value));
};
for (const record of source.records ?? []) rememberRawSessionId(record.sessionId);
for (const session of source.sessions ?? []) rememberRawSessionId(session["Session ID"]);
if (lifecycleMode) {
  for (const record of lifecycle.records ?? []) rememberRawSessionId(record.sessionId);
  for (const event of lifecycle.events ?? []) rememberRawSessionId(event.sessionId);
  for (const session of lifecycle.sessions ?? []) rememberRawSessionId(session.sessionId);
}

const dataText = JSON.stringify(data);
check(!UUID_PATTERN.test(dataText), "Derived report data contains a UUID-shaped identifier");
check(!UUID_PATTERN.test(report), "HTML report contains a UUID-shaped identifier");
for (const rawSessionId of rawSessionIds) {
  check(!dataText.includes(rawSessionId), `Derived report data exposes raw session ID ${rawSessionId}`);
  check(!report.includes(rawSessionId), `HTML report exposes raw session ID ${rawSessionId}`);
}
if (process.platform !== "win32") {
  check((statSync(dataPath).mode & 0o777) === 0o600, "Derived report data permissions are not 0600");
  check((statSync(reportPath).mode & 0o777) === 0o600, "HTML report permissions are not 0600");
}

check(source.schema === "codeburn.export.v2", "Unexpected CodeBurn source schema");
check(data.meta.schema === (lifecycleMode ? "codex.lifecycle.report.v2" : "codex.lifecycle.report.v1"), "Unexpected report-data schema");
check(typeof data.meta.officialSourceAvailable === "boolean", "Report data omits the official-source availability flag");
check(data.meta.officialSourceAvailable === lifecycleMode, "Official-source availability flag diverged from the supplied sources");
check(Boolean(data.sources?.official) === data.meta.officialSourceAvailable, "Official-source availability flag diverged from embedded source metadata");
check(report.includes(`"officialSourceAvailable":${data.meta.officialSourceAvailable}`), "HTML report omits the official-source availability flag");
check(report.includes("const HAS_OFFICIAL_SOURCE = BASE_REPORT.meta && BASE_REPORT.meta.officialSourceAvailable === true"), "HTML report does not gate source claims on the official-source flag");
check(typeof data.meta.sourceMode === "string" && data.meta.sourceMode.length > 0, "Report data omits sourceMode");
check(typeof data.meta.sourceLabel === "string" && data.meta.sourceLabel.length > 0, "Report data omits sourceLabel");
if (source.competition?.portableInput === true) {
  check(data.meta.portableInput === true, "Portable source flag did not reach report data");
  check(data.meta.sourceMode === (source.competition.syntheticData === true ? "synthetic-demo" : "portable-input"), "Portable source mode is incorrect");
  check(data.meta.syntheticData === (source.competition.syntheticData === true), "Synthetic-data flag diverged from portable source");
  check(report.includes(`"sourceMode":"${data.meta.sourceMode}"`), "HTML report omits portable source mode");
  if (data.meta.syntheticData) {
    check(report.includes('id="demoDataBadge"'), "Synthetic report omits the demo-data badge");
    check(report.includes("匿名合成演示数据"), "Synthetic report does not disclose its source");
  }
  check(source.portableAudit?.calls === sourceSummary["API Calls"], "Portable audit calls diverged from source summary");
  check(source.portableAudit?.tokens === sum(rangeRecords, (record) => tokenFields.reduce((total, field) => total + record[field], 0)), "Portable audit Tokens diverged from records");
  check(data.meta.activityClassification === "provided-by-input", "Portable activity labels are not declared as input-provided");
  check(/输入文件提供/u.test(data.meta.costDefinition), "Portable cost definition incorrectly claims a collected price source");
  check(data.diagnostics?.ruleset === "codex.portable.analysis.v1", "Portable analysis rule set is missing");
  const qualityFact = (code) => data.diagnostics?.qualityFacts?.find((fact) => fact.code === code);
  const analysisFact = (code) => data.diagnostics?.analysisFacts?.find((fact) => fact.code === code);
  const reconciliation = qualityFact("reconciliation");
  check(reconciliation?.outcome === "pass", "Portable reconciliation fact did not pass");
  check(reconciliation?.tokens === data.summary.tokens, "Portable reconciliation Token total diverged");
  check(reconciliation?.componentTokens === Object.values(data.summary.tokenComponents).reduce((total, value) => total + value, 0), "Portable reconciliation component total diverged");
  check(reconciliation?.calls === data.summary.calls, "Portable reconciliation call total diverged");
  const tokenSubtotal = (fact) => fact.input + fact.output + fact.cacheRead + fact.cacheWrite;
  const topShare = (dimension) => {
    const totals = new Map();
    for (const fact of data.filterFacts) totals.set(fact[dimension], (totals.get(fact[dimension]) ?? 0) + tokenSubtotal(fact));
    const top = [...totals.values()].sort((left, right) => right - left)[0] ?? 0;
    return data.summary.tokens ? top / data.summary.tokens : 0;
  };
  check(Math.abs(analysisFact("top-project-token-share")?.value - topShare("project")) < 1e-8, "Portable top-project Token share diverged");
  check(Math.abs(analysisFact("top-model-token-share")?.value - topShare("model")) < 1e-8, "Portable top-model Token share diverged");
  check(Math.abs(analysisFact("cache-read-token-share")?.value - data.summary.tokenComponents.cacheRead / data.summary.tokens) < 1e-8, "Portable cache-read Token share diverged");
}
check(data.meta.generatedAt === (lifecycleMode ? official.generatedAt : source.generated), "Snapshot timestamp diverged from source export");
check(/^\d{4}-\d{2}-\d{2}$/.test(data.meta.rangeStart) && /^\d{4}-\d{2}-\d{2}$/.test(data.meta.rangeEnd), "Lifecycle range is invalid");
check(data.meta.rangeStart <= data.meta.rangeEnd, "Lifecycle range is reversed");
check(data.daily.length === data.summary.calendarDays, "Daily rows do not cover every calendar day");
check(data.daily[0].date === data.meta.rangeStart, "First daily row does not match range start");
check(data.daily.at(-1).date === data.meta.rangeEnd, "Last daily row does not match range end");

if (!lifecycleMode) {
  check(data.sources === null || data.sources?.official == null, "Local-only report unexpectedly embeds an official source");
  check(data.summary.officialTokens === data.summary.tokens, "Local-only primary Token total diverged from the CodeBurn snapshot");
  check(data.officialDaily.length === data.daily.length, "Local-only primary daily series diverged in length");
  check(data.officialDaily.every((row, index) => row.date === data.daily[index].date && row.tokens === data.daily[index].tokens), "Local-only primary daily series diverged from CodeBurn daily Tokens");
  check(data.summary.reconstruction.netGapTokens === 0, "Local-only report fabricates an official-to-local gap");
  check(!/(?:官方账户|Codex Profile|账户活动接口)/u.test(staticMarkup), "Local-only report contains a visible official-source claim before runtime initialization");
  check(staticMarkup.includes('id="heroNumberLabel">Token 总量'), "Pre-runtime hero does not use a source-neutral label");
  check(staticMarkup.includes('id="metricTokensLabel">Token 总量'), "Pre-runtime KPI does not use a source-neutral label");
  check(staticMarkup.includes('id="footerSource">数据来源 · 加载中'), "Pre-runtime footer does not use a source-neutral label");
}

for (let index = 1; index < data.daily.length; index += 1) {
  const previous = new Date(data.daily[index - 1].date + "T12:00:00Z");
  const current = new Date(data.daily[index].date + "T12:00:00Z");
  check(current - previous === 86400000, `Daily series has a gap before ${data.daily[index].date}`);
}

close(data.summary.cost, sourceSummary["Cost (USD)"], 0.001, "Summary cost");
check(data.summary.calls === sourceSummary["API Calls"], "Summary calls diverged from source");
check(data.summary.sessions === sourceSummary.Sessions, "Session count diverged from source");
check(data.summary.calls === sum(rangeRecords, recordCalls), "Call count does not equal in-range raw record calls");
check(data.summary.sessions === rangeSessionCount, "Session count does not equal in-range distinct session count");

for (const [index, record] of rangeRecords.entries()) {
  for (const field of tokenFields) {
    check(Object.hasOwn(record, field), `Raw record ${index} is missing ${field}`);
    check(Number.isSafeInteger(record[field]) && record[field] >= 0, `Raw record ${index} has invalid ${field}`);
  }
  if (Object.hasOwn(record, "reasoningTokens")) {
    check(Number.isSafeInteger(record.reasoningTokens) && record.reasoningTokens >= 0, `Raw record ${index} has invalid reasoningTokens`);
    check(record.reasoningTokens <= record.outputTokens, `Raw record ${index} has reasoningTokens outside outputTokens`);
  }
}

const tokenComponentTotal = Object.values(data.summary.tokenComponents).reduce((total, value) => total + value, 0);
check(tokenComponentTotal === data.summary.tokens, "Token components do not add to total tokens");
check(sum(data.daily, (row) => row.tokens) === data.summary.tokens, "Daily Token total diverged");
check(sum(data.heatmap, (row) => row.tokens) === data.summary.tokens, "Hour heatmap Token total diverged");
check(sum(data.daily, (row) => row.calls) === data.summary.calls, "Daily call total diverged");
check(sum(data.heatmap, (row) => row.calls) === data.summary.calls, "Hour heatmap call total diverged");
check(data.heatmap.length === 7 * 24, "Heatmap is not a complete weekday-by-hour grid");
check(Array.isArray(data.filterFacts) && data.filterFacts.length > 0, "Interactive date-filter facts are missing");
check(data.filterFacts.length <= rangeRecords.length, "Interactive facts are not compacted");
check(sum(data.filterFacts, (row) => row.calls) === data.summary.calls, "Interactive fact calls diverged");
const rawTokenComponents = {
  input: sum(rangeRecords, (row) => row.inputTokens ?? 0),
  output: sum(rangeRecords, (row) => row.outputTokens ?? 0),
  cacheRead: sum(rangeRecords, (row) => row.cacheReadTokens ?? 0),
  cacheWrite: sum(rangeRecords, (row) => row.cacheWriteTokens ?? 0),
};
for (const component of ["input", "output", "cacheRead", "cacheWrite"]) {
  check(sum(data.filterFacts, (row) => row[component]) === rawTokenComponents[component], `Interactive fact ${component} Tokens diverged`);
  check(rawTokenComponents[component] === data.summary.tokenComponents[component], `Raw ${component} Tokens diverged from the report summary`);
}
const sourceModelComponents = lifecycleMode ? rawTokenComponents : {
  input: sum(source.periods[0].models, (row) => row["Input Tokens"] ?? 0),
  output: sum(source.periods[0].models, (row) => row["Output Tokens"] ?? 0),
  cacheRead: sum(source.periods[0].models, (row) => row["Cache Read Tokens"] ?? 0),
  cacheWrite: sum(source.periods[0].models, (row) => row["Cache Write Tokens"] ?? 0),
};
for (const component of ["input", "output", "cacheRead", "cacheWrite"]) {
  check(sourceModelComponents[component] === data.summary.tokenComponents[component], `Source model ${component} Tokens diverged from the report summary`);
  check(sum(data.models, (row) => row[component]) === data.summary.tokenComponents[component], `Report model ${component} Tokens diverged from the report summary`);
}
check(sum(data.models, (row) => row.tokens) === data.summary.tokens, "Report model Token total diverged");
check(sum(data.sessions, (row) => row.tokens) === data.summary.tokens, "Report session Token total diverged");
check(sum(data.sessions, (row) => row.calls) === data.summary.calls, "Report session call total diverged");
check(sum(data.activities, (row) => row.calls) === data.summary.calls, "Report activity call total diverged");

const expectedSessions = new Map();
const pseudonymOwners = new Map();
for (const record of rangeRecords) {
  const rawId = String(record.sessionId ?? "historical-unknown");
  const pseudonym = sessionPseudonym(rawId);
  const owner = pseudonymOwners.get(pseudonym);
  check(owner === undefined || owner === rawId, `Session pseudonym collision for ${pseudonym}`);
  pseudonymOwners.set(pseudonym, rawId);
  const aggregate = expectedSessions.get(pseudonym) ?? { calls: 0, tokens: 0 };
  aggregate.calls += recordCalls(record);
  aggregate.tokens += tokenFields.reduce((total, field) => total + (record[field] ?? 0), 0);
  expectedSessions.set(pseudonym, aggregate);
}
const reportSessions = new Map();
for (const [index, session] of data.sessions.entries()) {
  check(SESSION_PSEUDONYM_PATTERN.test(String(session.id ?? "")), `Report session ${index} has an invalid pseudonym`);
  check(session.shortId === session.id, `Report session ${index} has an inconsistent shortId`);
  check(!reportSessions.has(session.id), `Report session pseudonym is duplicated: ${session.id}`);
  reportSessions.set(session.id, session);
}
check(reportSessions.size === expectedSessions.size, "Pseudonymous session count diverged from raw sessions");
for (const [pseudonym, expected] of expectedSessions) {
  const actual = reportSessions.get(pseudonym);
  check(Boolean(actual), `Expected session pseudonym is missing: ${pseudonym}`);
  check(actual.calls === expected.calls, `Session ${pseudonym} calls diverged after pseudonymization`);
  check(actual.tokens === expected.tokens, `Session ${pseudonym} Tokens diverged after pseudonymization`);
  check(report.includes(pseudonym), `HTML report omits session pseudonym ${pseudonym}`);
}
const factSessions = new Map();
for (const [index, fact] of data.filterFacts.entries()) {
  check(SESSION_PSEUDONYM_PATTERN.test(String(fact.sessionId ?? "")), `Interactive fact ${index} has an invalid session pseudonym`);
  check(fact.shortId === fact.sessionId, `Interactive fact ${index} has an inconsistent shortId`);
  const aggregate = factSessions.get(fact.sessionId) ?? { calls: 0, tokens: 0 };
  aggregate.calls += fact.calls;
  aggregate.tokens += ["input", "output", "cacheRead", "cacheWrite"].reduce((total, field) => total + fact[field], 0);
  factSessions.set(fact.sessionId, aggregate);
}
check(factSessions.size === expectedSessions.size, "Interactive pseudonymous session count diverged");
for (const [pseudonym, expected] of expectedSessions) {
  const actual = factSessions.get(pseudonym);
  check(Boolean(actual), `Interactive facts omit session pseudonym ${pseudonym}`);
  check(actual.calls === expected.calls, `Interactive session ${pseudonym} calls diverged`);
  check(actual.tokens === expected.tokens, `Interactive session ${pseudonym} Tokens diverged`);
}
const rawRecordCost = sum(rangeRecords, (row) => row.cost ?? 0);
const expectedRecordCostScale = rawRecordCost > 0 ? data.summary.cost / rawRecordCost : 1;
close(data.meta.recordCostScale, expectedRecordCostScale, 1e-8, "Interactive fact cost scale");
const factCostTolerance = Math.max(1e-6, data.filterFacts.length * 0.00000051);
close(sum(data.filterFacts, (row) => row.cost), data.summary.cost, factCostTolerance, "Interactive fact cost reconciliation");
check(data.filterFacts.every((row) => row.date >= data.meta.rangeStart && row.date <= data.meta.rangeEnd), "Interactive fact date is out of range");
const projectLabels = [
  ...data.projects.map((row) => row.name),
  ...data.sessions.map((row) => row.project),
  ...data.filterFacts.map((row) => row.project),
  ...data.projectWeeks.map((row) => row.project),
  ...(data.projectWeekRows ?? []),
  data.facts.topProject,
  data.facts.secondProject,
  data.facts.topSessionProject,
].filter((value) => value !== null && value !== undefined);
check(projectLabels.every((label) => !/[\\/]/.test(String(label))), "Derived report exposes a project path instead of a readable alias");
check(!/(?:file:\/\/|(?:^|["'])\/(?:Users|home)\/|[A-Za-z]:\\\\)/i.test(dataText), "Derived report data contains an absolute local path");

const rawTimeBuckets = new Map();
for (const record of rangeRecords) {
  const timestamp = new Date(record.timestamp);
  const date = localDateFormatter.format(timestamp);
  const weekday = localWeekdayFormatter.format(timestamp);
  const hour = Number(localHourFormatter.format(timestamp));
  const key = `${date}|${weekday}|${hour}`;
  const bucket = rawTimeBuckets.get(key) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  bucket.calls += recordCalls(record);
  bucket.input += record.inputTokens ?? 0;
  bucket.output += record.outputTokens ?? 0;
  bucket.cacheRead += record.cacheReadTokens ?? 0;
  bucket.cacheWrite += record.cacheWriteTokens ?? 0;
  bucket.cost += (record.cost ?? 0) * expectedRecordCostScale;
  rawTimeBuckets.set(key, bucket);
}

const factTimeBuckets = new Map();
for (const fact of data.filterFacts) {
  check(Number.isInteger(fact.hour) && fact.hour >= 0 && fact.hour <= 23, `Interactive fact has an invalid hour: ${fact.hour}`);
  check(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(fact.weekday), `Interactive fact has an invalid weekday: ${fact.weekday}`);
  check(Number.isInteger(fact.calls) && fact.calls > 0, "Interactive fact has an invalid call count");
  check(Number.isFinite(fact.cost) && fact.cost >= 0, "Interactive fact has an invalid cost");
  for (const component of ["input", "output", "cacheRead", "cacheWrite"]) {
    check(Number.isInteger(fact[component]) && fact[component] >= 0, `Interactive fact has invalid ${component} Tokens`);
  }
  const firstCall = new Date(fact.firstCallAt);
  const lastCall = new Date(fact.lastCallAt);
  check(Number.isFinite(firstCall.getTime()) && Number.isFinite(lastCall.getTime()) && firstCall <= lastCall, "Interactive fact call timestamps are invalid");
  for (const timestamp of [firstCall, lastCall]) {
    check(localDateFormatter.format(timestamp) === fact.date, "Interactive fact timestamp diverged from its local date");
    check(localWeekdayFormatter.format(timestamp) === fact.weekday, "Interactive fact timestamp diverged from its local weekday");
    check(Number(localHourFormatter.format(timestamp)) === fact.hour, "Interactive fact timestamp diverged from its local hour");
  }
  const key = `${fact.date}|${fact.weekday}|${fact.hour}`;
  const bucket = factTimeBuckets.get(key) ?? { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, rows: 0 };
  bucket.calls += fact.calls;
  bucket.input += fact.input;
  bucket.output += fact.output;
  bucket.cacheRead += fact.cacheRead;
  bucket.cacheWrite += fact.cacheWrite;
  bucket.cost += fact.cost;
  bucket.rows += 1;
  factTimeBuckets.set(key, bucket);
}
check(factTimeBuckets.size === rawTimeBuckets.size, "Interactive fact time buckets diverged from raw records");
for (const [key, expected] of rawTimeBuckets) {
  const actual = factTimeBuckets.get(key);
  check(Boolean(actual), `Interactive fact time bucket is missing: ${key}`);
  for (const component of ["calls", "input", "output", "cacheRead", "cacheWrite"]) {
    check(actual[component] === expected[component], `Interactive fact ${component} diverged in time bucket ${key}`);
  }
  close(actual.cost, expected.cost, Math.max(1e-6, actual.rows * 0.00000051), `Interactive fact cost diverged in time bucket ${key}`);
}

for (const [label, rows] of [
  ["daily", data.daily],
  ["months", data.months],
  ["projects", data.projects],
  ["models", data.models],
  ["activities", data.activities],
  ["sessions", data.sessions],
]) {
  close(sum(rows, (row) => row.cost), data.summary.cost, 0.1, `${label} cost reconciliation`);
}

if (lifecycleMode) {
  check(lifecycle.schema === "codex.lifecycle.ledger.v1", "Unexpected lifecycle ledger schema");
  check(official.schema === "codex.official.usage.v1", "Unexpected official usage schema");
  check(Array.isArray(official.dailyUsageBuckets) && official.dailyUsageBuckets.length > 0, "Official daily usage buckets are missing");
  const officialDates = official.dailyUsageBuckets.map((row) => row.startDate);
  check(new Set(officialDates).size === officialDates.length, "Official daily usage contains duplicate dates");
  check(officialDates.every((date, index) => index === 0 || officialDates[index - 1] < date), "Official daily usage is not strictly ordered");
  check(official.dailyUsageBuckets.every((row) => Number.isSafeInteger(row.tokens) && row.tokens >= 0), "Official daily usage contains invalid Tokens");
  const officialBucketSum = sum(official.dailyUsageBuckets, (row) => row.tokens);
  check(officialBucketSum === official.summary.lifetimeTokens, "Official daily buckets do not reconcile to lifetime Tokens");
  check(Math.max(...official.dailyUsageBuckets.map((row) => row.tokens)) === official.summary.peakDailyTokens, "Official peak daily Tokens diverged");
  check(data.sources.official.bucketTokenSum === officialBucketSum, "Embedded official bucket total diverged");
  check(data.summary.officialTokens === officialBucketSum, "Report official Tokens diverged");
  check(sum(data.officialDaily, (row) => row.tokens) === officialBucketSum, "Embedded official daily series diverged");

  const ledgerComponentTotal = lifecycle.components.freshInputTokens + lifecycle.components.cacheReadTokens
    + lifecycle.components.cacheWriteTokens + lifecycle.components.outputTokens;
  check(ledgerComponentTotal === lifecycle.components.totalTokens, "Lifecycle components do not reconcile");
  const baselineTokens = lifecycle.sourceSummaries.ccSwitch.components.totalTokens;
  const deltaTokens = lifecycle.sourceSummaries.codeburnIncrement.components.totalTokens;
  check(baselineTokens + deltaTokens === lifecycle.components.totalTokens, "Lifecycle baseline and delta do not reconcile");
  if (lifecycle.cutoff?.codeburnAppendAfter && lifecycle.cutoff?.ccSwitchMaxCreatedAt) {
    check(lifecycle.cutoff.codeburnAppendAfter > lifecycle.cutoff.ccSwitchMaxCreatedAt, "Lifecycle cutoff is not exclusive");
  }
  check(sum(lifecycle.records, (record) => record.calls) === lifecycle.sourceSummaries.combined.calls, "Lifecycle compact-record calls diverged");
  check(sum(lifecycle.records, (record) => record.input + record.output + record.cacheRead + record.cacheWrite) === lifecycle.components.totalTokens, "Lifecycle compact-record Tokens diverged");

  if (lifecycle.eventContract?.eventLevelReliable === true) {
    check(Array.isArray(lifecycle.events), "Lifecycle ledger claims event-level reliability without events");
    check(lifecycle.events.length === lifecycle.sourceSummaries.combined.calls, "Lifecycle event calls diverged");
    const eventIds = new Set();
    let eventTokens = 0;
    let eventCost = 0;
    for (const [index, event] of lifecycle.events.entries()) {
      check(/^[0-9a-f]{64}$/.test(String(event.eventId ?? "")), `Lifecycle event ${index} has an invalid eventId`);
      check(!eventIds.has(event.eventId), `Lifecycle eventId is duplicated: ${event.eventId}`);
      eventIds.add(event.eventId);
      check(Number.isFinite(Date.parse(event.occurredAt)), `Lifecycle event ${index} has an invalid occurredAt`);
      check(["ccSwitch", "codeburnIncrement"].includes(event.source), `Lifecycle event ${index} has an invalid source`);
      const components = event.components ?? {};
      for (const key of ["freshInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens"]) {
        check(Number.isSafeInteger(components[key]) && components[key] >= 0, `Lifecycle event ${index} has invalid ${key}`);
      }
      const componentTotal = components.freshInputTokens + components.cacheReadTokens
        + components.cacheWriteTokens + components.outputTokens;
      check(componentTotal === components.totalTokens, `Lifecycle event ${index} Token components diverged`);
      if (event.projectFingerprint !== null && event.projectFingerprint !== undefined) {
        check(/^[0-9a-f]{64}$/.test(String(event.projectFingerprint)), `Lifecycle event ${index} exposes an invalid project fingerprint`);
      }
      eventTokens += components.totalTokens;
      eventCost += Number(event.costUsd ?? event.cost ?? 0);
    }
    check(eventTokens === lifecycle.components.totalTokens, "Lifecycle event Tokens diverged");
    close(
      eventCost,
      lifecycle.sourceSummaries.combined.costUsd,
      Math.max(1e-6, lifecycle.events.length * 5e-10),
      "Lifecycle event cost",
    );
    check(lifecycle.eventContract.reconciliation?.exact !== false, "Lifecycle event reconciliation is not exact");
  }

  if (Array.isArray(lifecycle.devices) && lifecycle.devices.length > 0) {
    check(lifecycle.deduplication?.eventLevelReliable === true, "Cross-device lifecycle is not event-level reliable");
    check(lifecycle.deduplication?.granularity === "event", "Cross-device lifecycle has the wrong deduplication grain");
    check(lifecycle.deduplication?.tokenAudit?.verified === true, "Cross-device Token audit is not verified");
    check(lifecycle.deduplication.tokenAudit.outputCalls === lifecycle.sourceSummaries.combined.calls, "Cross-device output calls diverged");
    check(lifecycle.deduplication.tokenAudit.outputComponents.totalTokens === lifecycle.components.totalTokens, "Cross-device output Tokens diverged");
    const deviceAliases = lifecycle.devices.map((device) => device.device);
    check(new Set(deviceAliases).size === deviceAliases.length, "Cross-device aliases are not unique");
  }

  const reconstruction = data.summary.reconstruction;
  check(reconstruction.reconstructedTokens === data.summary.tokens, "Reconstructed Tokens diverged from local report Tokens");
  check(reconstruction.officialTokens === data.summary.officialTokens, "Reconstruction official Tokens diverged");
  check(reconstruction.netGapTokens === reconstruction.officialTokens - reconstruction.reconstructedTokens, "Reconstruction signed gap is invalid");
  check(reconstruction.absoluteGapTokens === Math.abs(reconstruction.netGapTokens), "Reconstruction absolute gap is invalid");
  close(reconstruction.reconstructedToOfficialRatio, reconstruction.reconstructedTokens / reconstruction.officialTokens, 1e-12, "Reconstruction ratio");
  close(reconstruction.absoluteGapRate, reconstruction.absoluteGapTokens / reconstruction.officialTokens, 1e-12, "Reconstruction gap rate");
  check(reconstruction.knownProjectTokens + reconstruction.historicalUnattributedProjectTokens === reconstruction.reconstructedTokens, "Project attribution does not reconcile to reconstructed Tokens");
  check(reconstruction.knownActivityTokens + reconstruction.historicalUnattributedActivityTokens === reconstruction.reconstructedTokens, "Activity attribution does not reconcile to reconstructed Tokens");
  close(reconstruction.projectTokenCoverage, reconstruction.knownProjectTokens / reconstruction.reconstructedTokens, 1e-12, "Project Token coverage");
  close(reconstruction.activityTokenCoverage, reconstruction.knownActivityTokens / reconstruction.reconstructedTokens, 1e-12, "Activity Token coverage");
  check(data.meta.rangeStart === officialDates[0] && data.meta.rangeEnd === officialDates.at(-1), "Report account range diverged from official buckets");
}

check(statSync(reportPath).size > 1_000_000, "Self-contained report is unexpectedly small");
check(report.includes("window.__CODEX_REPORT_READY"), "Report readiness marker is missing");
check(!report.includes("{{"), "Report contains an unreplaced template token");
check(!/<(?:script|link|img)\b[^>]*(?:src|href)=["']https?:/i.test(report), "Report contains a remote runtime dependency");
check(report.includes('<th scope="col" class="num"'), "Report does not use semantic right-aligned numeric headers");
check(report.includes("Token 总量"), "Report does not label the inclusive Token total clearly");
check(report.includes('id="compositionWrite"'), "Report omits cache-write Tokens from the composition ledger");
for (const chartId of ["timelineChart", "tokenLedger", "projectBars", "projectMatrix", "modelStrip", "activityBars", "sessionScatter", "rhythmHeat"]) {
  check(report.includes(`id="${chartId}"`), `Missing chart container: ${chartId}`);
}

const snapshotAgeHours = Math.max(0, (Date.now() - new Date(data.meta.generatedAt).getTime()) / 3_600_000);
console.log(JSON.stringify({
  status: "pass",
  snapshot: data.meta.generatedAt,
  range: `${data.meta.rangeStart}..${data.meta.rangeEnd}`,
  cost: data.summary.cost,
  calls: data.summary.calls,
  sessions: data.summary.sessions,
  tokens: data.summary.tokens,
  officialTokens: data.summary.officialTokens ?? data.summary.tokens,
  reconstruction: data.summary.reconstruction ?? null,
  tokenComponents: data.summary.tokenComponents,
  snapshotAgeHours: Number(snapshotAgeHours.toFixed(2)),
  snapshotFresh: snapshotAgeHours <= 24,
  dailyRows: data.daily.length,
  heatmapCells: data.heatmap.length,
  reportBytes: statSync(reportPath).size,
  remoteRuntimeDependencies: 0,
}, null, 2));
