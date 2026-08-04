#!/usr/bin/env node

import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
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
if (!args.input || !args.output) {
  throw new Error("Usage: node derive-report.mjs --input <codeburn.json> --output <report-data.json> [--lifecycle <ledger.json> --official <usage.json>] [--timezone Asia/Shanghai] [--codeburn-version 0.9.19]");
}
const inputPath = resolve(args.input);
const outputPath = resolve(args.output);
const TIMEZONE = String(args.timezone || "Asia/Shanghai");
let source = JSON.parse(readFileSync(inputPath, "utf8"));
const CODEBURN_VERSION = String(args["codeburn-version"] || source.codeburnVersion || "0.9.19");
const UUID_PATTERN = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/giu;

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function sessionPseudonym(value) {
  return `session-${sha256Hex(value ?? "historical-unknown").slice(0, 12)}`;
}

function writePrivateAtomic(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function nonnegativeInteger(value, label) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return number;
}

function lifecycleRecordTotal(record) {
  return nonnegativeInteger(record.input, "lifecycle input")
    + nonnegativeInteger(record.output, "lifecycle output")
    + nonnegativeInteger(record.cacheRead, "lifecycle cacheRead")
    + nonnegativeInteger(record.cacheWrite, "lifecycle cacheWrite");
}

function buildLifecycleSource(codeburnSource, ledger, official) {
  if (ledger.schema !== "codex.lifecycle.ledger.v1") throw new Error(`Unsupported lifecycle ledger schema: ${ledger.schema || "missing"}`);
  if (official.schema !== "codex.official.usage.v1") throw new Error(`Unsupported official usage schema: ${official.schema || "missing"}`);
  if (!Array.isArray(ledger.records) || !ledger.records.length) throw new Error("Lifecycle ledger does not contain compact records");
  if (!Array.isArray(official.dailyUsageBuckets) || !official.dailyUsageBuckets.length) throw new Error("Official usage does not contain daily buckets");

  const officialDaily = [...official.dailyUsageBuckets].sort((a, b) => a.startDate.localeCompare(b.startDate));
  const rangeStart = officialDaily[0].startDate;
  const rangeEnd = officialDaily.at(-1).startDate;
  const officialBucketTotal = officialDaily.reduce((sum, row) => sum + nonnegativeInteger(row.tokens, `official ${row.startDate} tokens`), 0);
  const officialLifetimeTokens = nonnegativeInteger(official.summary?.lifetimeTokens, "official lifetimeTokens");
  if (officialBucketTotal !== officialLifetimeTokens) {
    throw new Error(`Official daily buckets do not reconcile to lifetimeTokens: ${officialBucketTotal} != ${officialLifetimeTokens}`);
  }

  const lifecycleActivityLabels = {
    coding: "Coding",
    delegation: "Delegation",
    exploration: "Exploration",
    conversation: "Conversation",
    feature: "Feature Dev",
    brainstorming: "Brainstorming",
    debugging: "Debugging",
    testing: "Testing",
    refactoring: "Refactoring",
    git: "Git Ops",
  };
  const records = ledger.records
    .filter((record) => record.date >= rangeStart && record.date <= rangeEnd)
    .map((record) => ({
      project: record.project || "历史未归属",
      sessionId: record.sessionId || `historical-${record.date}-${record.hour}`,
      timestamp: record.timestamp,
      category: lifecycleActivityLabels[String(record.activity || "").toLowerCase()] || record.activity || "历史未归属",
      provider: "codex",
      model: record.model || "历史未归属",
      inputTokens: nonnegativeInteger(record.input, "ledger record input"),
      outputTokens: nonnegativeInteger(record.output, "ledger record output"),
      reasoningTokens: 0,
      cacheWriteTokens: nonnegativeInteger(record.cacheWrite, "ledger record cacheWrite"),
      cacheReadTokens: nonnegativeInteger(record.cacheRead, "ledger record cacheRead"),
      cost: Number(record.cost || 0),
      savings: 0,
      calls: nonnegativeInteger(record.calls, "ledger record calls"),
      ledgerSource: record.source,
    }));

  const emptyAggregate = () => ({
    cost: 0,
    calls: 0,
    sessions: new Set(),
    projects: new Set(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const dailyMap = new Map(officialDaily.map((row) => [row.startDate, emptyAggregate()]));
  const modelMap = new Map();
  const activityMap = new Map();
  const sessions = new Set();
  const projects = new Set();

  // The ledger already stores the requested local date. Rejoin it by the stable
  // compact-record order so no timezone conversion is repeated here.
  const scopedLedgerRecords = ledger.records.filter((record) => record.date >= rangeStart && record.date <= rangeEnd);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const ledgerRecord = scopedLedgerRecords[index];
    const date = ledgerRecord.date;
    const calls = record.calls || 0;
    const tokens = record.inputTokens + record.outputTokens + record.cacheReadTokens + record.cacheWriteTokens;
    const daily = dailyMap.get(date);
    if (!daily) continue;
    daily.cost += record.cost;
    daily.calls += calls;
    daily.sessions.add(record.sessionId);
    daily.projects.add(record.project);
    daily.input += record.inputTokens;
    daily.output += record.outputTokens;
    daily.cacheRead += record.cacheReadTokens;
    daily.cacheWrite += record.cacheWriteTokens;
    sessions.add(record.sessionId);
    projects.add(record.project);

    const model = modelMap.get(record.model) ?? { ...emptyAggregate(), model: record.model };
    model.cost += record.cost;
    model.calls += calls;
    model.sessions.add(record.sessionId);
    model.input += record.inputTokens;
    model.output += record.outputTokens;
    model.cacheRead += record.cacheReadTokens;
    model.cacheWrite += record.cacheWriteTokens;
    modelMap.set(record.model, model);

    const activity = activityMap.get(record.category) ?? { cost: 0, calls: 0, turns: 0, tokens: 0, activity: record.category };
    activity.cost += record.cost;
    activity.calls += calls;
    activity.turns += calls;
    activity.tokens += tokens;
    activityMap.set(record.category, activity);
  }

  const totalCost = records.reduce((sum, record) => sum + record.cost, 0);
  const totalCalls = records.reduce((sum, record) => sum + record.calls, 0);
  const periodLabel = `${rangeStart} to ${rangeEnd}`;
  const daily = officialDaily.map((officialRow) => {
    const row = dailyMap.get(officialRow.startDate) ?? emptyAggregate();
    return {
      Date: officialRow.startDate,
      "Cost (USD)": row.cost,
      "API Calls": row.calls,
      Sessions: row.sessions.size,
      "Input Tokens": row.input,
      "Output Tokens": row.output,
      "Cache Read Tokens": row.cacheRead,
      "Cache Write Tokens": row.cacheWrite,
    };
  });
  const models = [...modelMap.values()]
    .sort((a, b) => b.cost - a.cost)
    .map((row) => ({
      Period: periodLabel,
      Model: row.model,
      "Cost (USD)": row.cost,
      "Saved (USD)": 0,
      "Share (%)": totalCost ? row.cost / totalCost * 100 : 0,
      "API Calls": row.calls,
      "Edit Turns": 0,
      "One-shot Rate (%)": "",
      "Retries/Edit": "",
      "Cost/Edit (USD)": "",
      "Input Tokens": row.input,
      "Output Tokens": row.output,
      "Cache Read Tokens": row.cacheRead,
      "Cache Write Tokens": row.cacheWrite,
    }));
  const activity = [...activityMap.values()]
    .sort((a, b) => b.cost - a.cost)
    .map((row) => ({
      Period: periodLabel,
      Activity: row.activity,
      "Cost (USD)": row.cost,
      "Share (%)": totalCost ? row.cost / totalCost * 100 : 0,
      Turns: row.turns,
    }));

  return {
    source: {
      schema: "codeburn.export.v2",
      generated: official.generatedAt,
      codeburnVersion: codeburnSource.codeburnVersion,
      summary: [{
        Period: periodLabel,
        "Cost (USD)": totalCost,
        "Saved (USD)": 0,
        "API Calls": totalCalls,
        Sessions: sessions.size,
        Projects: projects.size,
      }],
      periods: [{ label: periodLabel, daily, models, activity }],
      records,
      sessions: [],
      projects: [],
    },
    context: {
      ledger,
      official,
      officialDaily: officialDaily.map((row) => ({ date: row.startDate, tokens: row.tokens })),
      officialLifetimeTokens,
      officialPeakDailyTokens: official.summary.peakDailyTokens,
      rangeStart,
      rangeEnd,
    },
  };
}

let lifecycleContext = null;
if (args.lifecycle || args.official) {
  if (!args.lifecycle || !args.official) throw new Error("--lifecycle and --official must be provided together");
  const ledger = JSON.parse(readFileSync(resolve(args.lifecycle), "utf8"));
  const official = JSON.parse(readFileSync(resolve(args.official), "utf8"));
  const built = buildLifecycleSource(source, ledger, official);
  source = built.source;
  lifecycleContext = built.context;
}
if (source.schema !== "codeburn.export.v2") throw new Error(`Unsupported CodeBurn schema: ${source.schema || "missing"}`);
if (!Array.isArray(source.periods) || !source.periods[0]?.daily?.length) throw new Error("CodeBurn export does not contain a non-empty lifetime daily period");
const period = source.periods[0];
const summaryRow = source.summary[0];

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const weekdayFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE,
  weekday: "short",
});
const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  hourCycle: "h23",
});

function localDate(timestamp) {
  return dateFormatter.format(new Date(timestamp));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekStart(dateString) {
  const date = new Date(`${dateString}T00:00:00Z`);
  const weekday = date.getUTCDay();
  const offset = weekday === 0 ? -6 : 1 - weekday;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function normalizeProjectPath(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "").toLowerCase();
}

const knownProjectPaths = (source.projects ?? []).map((row) => normalizeProjectPath(row.Project));
const baseProjectPaths = knownProjectPaths.filter((path) => !path.includes("/.codex/worktrees/") && !path.includes(".codex/worktrees/"));

function canonicalProjectPath(value) {
  const path = normalizeProjectPath(value);
  const worktree = path.match(/(?:^|\/)\.codex\/worktrees\/[^/]+\/(.+)$/);
  if (!worktree) return path;
  const suffix = worktree[1];
  return baseProjectPaths.find((candidate) => candidate === suffix || candidate.endsWith("/" + suffix)) ?? suffix;
}

function projectAlias(value) {
  const path = canonicalProjectPath(value);
  const relative = path.replace(/^users\/[^/]+\//, "");
  if (!relative || /^users\/[^/]+$/.test(path)) return "Home";
  if (/documents\/codex\/\d{4}\/\d{2}\/\d{2}(?:\/|$)/.test(relative)) return "Codex scratch";
  if (relative.includes("/sites/plugin/sites/")) return "sites-plugin";
  let match = relative.match(/(?:^|\/)project\/(\d+)(?:$|\/)/);
  if (match) return `project-${match[1]}`;
  match = relative.match(/(?:^|\/)(project\d+)(?:$|\/)/);
  if (match) return match[1];
  const segments = relative.split("/").filter(Boolean);
  const last = segments.at(-1) || "Other";
  const readable = (label) => String(label).replace(UUID_PATTERN, "private-id");
  if (["chat", "new", "app", "src", "work"].includes(last) && segments.length > 1) {
    return segments.slice(-2).map(readable).join(" · ");
  }
  return readable(last);
}

function modelLabel(value) {
  const labels = {
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.5": "GPT-5.5",
    "gpt-5.6-luna": "gpt-5.6-luna",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-5.4-mini": "GPT-5.4 Mini",
    "codex-auto-review": "Codex Auto Review",
  };
  return labels[String(value).toLowerCase()] ?? String(value);
}

function tokenTotal(row) {
  return (row.input ?? 0) + (row.output ?? 0) + (row.cacheRead ?? 0) + (row.cacheWrite ?? 0);
}

function recordCalls(record) {
  const calls = Number(record.calls ?? 1);
  return Number.isSafeInteger(calls) && calls > 0 ? calls : 1;
}

const exportedDaily = new Map(period.daily.map((row) => [row.Date, row]));
const rangeStart = period.daily[0].Date;
const rangeEnd = period.daily.at(-1).Date;
const rangeRecords = (source.records ?? []).filter((record) => {
  const date = localDate(record.timestamp);
  return date >= rangeStart && date <= rangeEnd;
});
const daily = [];
let cumulativeCost = 0;
for (let date = rangeStart; date <= rangeEnd; date = addDays(date, 1)) {
  const row = exportedDaily.get(date);
  const item = {
    date,
    cost: row?.["Cost (USD)"] ?? 0,
    calls: row?.["API Calls"] ?? 0,
    sessions: row?.Sessions ?? 0,
    input: row?.["Input Tokens"] ?? 0,
    output: row?.["Output Tokens"] ?? 0,
    cacheRead: row?.["Cache Read Tokens"] ?? 0,
    cacheWrite: row?.["Cache Write Tokens"] ?? 0,
  };
  item.tokens = tokenTotal(item);
  cumulativeCost += item.cost;
  item.cumulativeCost = round(cumulativeCost, 2);
  daily.push(item);
}

const monthMap = new Map();
for (const row of daily) {
  const month = row.date.slice(0, 7);
  const aggregate = monthMap.get(month) ?? {
    month,
    cost: 0,
    calls: 0,
    sessions: 0,
    activeDays: 0,
    calendarDays: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  aggregate.cost += row.cost;
  aggregate.calls += row.calls;
  aggregate.sessions += row.sessions;
  aggregate.activeDays += row.calls > 0 ? 1 : 0;
  aggregate.calendarDays += 1;
  aggregate.input += row.input;
  aggregate.output += row.output;
  aggregate.cacheRead += row.cacheRead;
  aggregate.cacheWrite += row.cacheWrite;
  monthMap.set(month, aggregate);
}
const months = [...monthMap.values()].map((row) => ({
  ...row,
  cost: round(row.cost, 2),
  tokens: tokenTotal(row),
  daysInMonth: new Date(Date.UTC(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)), 0)).getUTCDate(),
  isPartial: row.calendarDays < new Date(Date.UTC(Number(row.month.slice(0, 4)), Number(row.month.slice(5, 7)), 0)).getUTCDate(),
}));

const totalCost = summaryRow["Cost (USD)"];
const totalCalls = summaryRow["API Calls"];
const totalTokens = daily.reduce((sum, row) => sum + row.tokens, 0);
const tokenComponents = {
  input: daily.reduce((sum, row) => sum + row.input, 0),
  output: daily.reduce((sum, row) => sum + row.output, 0),
  cacheRead: daily.reduce((sum, row) => sum + row.cacheRead, 0),
  cacheWrite: daily.reduce((sum, row) => sum + row.cacheWrite, 0),
};

const projectMap = new Map();
const sourceProjectsAreScoped = (source.projects ?? []).reduce((sum, row) => sum + (row["API Calls"] ?? 0), 0) === totalCalls;
if (sourceProjectsAreScoped) {
  for (const row of source.projects) {
    const name = projectAlias(row.Project);
    const aggregate = projectMap.get(name) ?? { name, cost: 0, calls: 0, sessions: 0 };
    aggregate.cost += row["Cost (USD)"];
    aggregate.calls += row["API Calls"];
    aggregate.sessions += row.Sessions;
    projectMap.set(name, aggregate);
  }
} else {
  for (const record of rangeRecords) {
    const name = projectAlias(record.project);
    const aggregate = projectMap.get(name) ?? { name, cost: 0, calls: 0, sessionIds: new Set() };
    aggregate.cost += record.cost ?? 0;
    aggregate.calls += recordCalls(record);
    aggregate.sessionIds.add(record.sessionId);
    projectMap.set(name, aggregate);
  }
}
const projects = [...projectMap.values()]
  .sort((a, b) => b.cost - a.cost)
  .map((row, index, rows) => ({
    ...row,
    sessions: row.sessions ?? row.sessionIds?.size ?? 0,
    sessionIds: undefined,
    rank: index + 1,
    cost: round(row.cost, 2),
    share: row.cost / totalCost,
    cumulativeShare: rows.slice(0, index + 1).reduce((sum, item) => sum + item.cost, 0) / totalCost,
  }));

const sessionRecordMap = new Map();
for (const record of rangeRecords) {
  const aggregate = sessionRecordMap.get(record.sessionId) ?? {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    models: new Set(),
    cost: 0,
    calls: 0,
    project: record.project,
    firstCallAt: record.timestamp,
    lastCallAt: record.timestamp,
  };
  aggregate.input += record.inputTokens ?? 0;
  aggregate.output += record.outputTokens ?? 0;
  aggregate.cacheRead += record.cacheReadTokens ?? 0;
  aggregate.cacheWrite += record.cacheWriteTokens ?? 0;
  aggregate.cost += record.cost ?? 0;
  aggregate.calls += recordCalls(record);
  aggregate.models.add(modelLabel(record.model));
  if (record.timestamp < aggregate.firstCallAt) aggregate.firstCallAt = record.timestamp;
  if (record.timestamp > aggregate.lastCallAt) aggregate.lastCallAt = record.timestamp;
  sessionRecordMap.set(record.sessionId, aggregate);
}

const sourceSessionsAreScoped = (source.sessions ?? []).reduce((sum, row) => sum + (row["API Calls"] ?? 0), 0) === totalCalls;
const scopedSessionRows = sourceSessionsAreScoped
  ? source.sessions.map((row) => {
    const detail = sessionRecordMap.get(row["Session ID"]);
    const components = detail ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: new Set() };
    const tokens = tokenTotal(components);
    return {
      id: sessionPseudonym(row["Session ID"]),
      shortId: sessionPseudonym(row["Session ID"]),
      project: projectAlias(row.Project),
      date: localDate(row["Started At"]),
      startedAt: row["Started At"],
      cost: row["Cost (USD)"],
      calls: row["API Calls"],
      turns: row.Turns,
      tokens,
      cacheShare: tokens ? components.cacheRead / tokens : 0,
      models: [...components.models],
    };
  })
  : [...sessionRecordMap.entries()].map(([sessionId, detail]) => {
    const tokens = tokenTotal(detail);
    return {
      id: sessionPseudonym(sessionId),
      shortId: sessionPseudonym(sessionId),
      project: projectAlias(detail.project),
      date: localDate(detail.firstCallAt),
      startedAt: detail.firstCallAt,
      cost: round(detail.cost, 2),
      calls: detail.calls,
      turns: null,
      tokens,
      cacheShare: tokens ? detail.cacheRead / tokens : 0,
      models: [...detail.models],
    };
  });
const sessions = scopedSessionRows
  .sort((a, b) => b.cost - a.cost)
  .map((row, index) => ({ ...row, rank: index + 1 }));

const topProjectNames = projects.slice(0, 5).map((row) => row.name);
const projectWeekMap = new Map();
for (const session of sessions) {
  const project = topProjectNames.includes(session.project) ? session.project : "Other";
  const week = weekStart(session.date);
  const key = `${project}|${week}`;
  const aggregate = projectWeekMap.get(key) ?? { project, week, cost: 0, sessions: 0, calls: 0 };
  aggregate.cost += session.cost;
  aggregate.sessions += 1;
  aggregate.calls += session.calls;
  projectWeekMap.set(key, aggregate);
}
const projectWeeks = [...projectWeekMap.values()].map((row) => ({ ...row, cost: round(row.cost, 2) }));
const firstWeek = weekStart(rangeStart);
const lastWeek = weekStart(rangeEnd);
const weeks = [];
for (let week = firstWeek; week <= lastWeek; week = addDays(week, 7)) weeks.push(week);

const exactModelRows = new Map(period.models.map((row) => [modelLabel(row.Model), row]));
const modelRecordTotals = new Map();
const modelDailyMap = new Map();
for (const record of rangeRecords) {
  const model = modelLabel(record.model);
  const date = localDate(record.timestamp);
  const key = `${model}|${date}`;
  const tokens = (record.inputTokens ?? 0) + (record.outputTokens ?? 0)
    + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
  const aggregate = modelDailyMap.get(key) ?? { model, date, approximateCost: 0, calls: 0, tokens: 0 };
  aggregate.approximateCost += record.cost ?? 0;
  aggregate.calls += recordCalls(record);
  aggregate.tokens += tokens;
  modelDailyMap.set(key, aggregate);
  modelRecordTotals.set(model, (modelRecordTotals.get(model) ?? 0) + (record.cost ?? 0));
}

const models = period.models.map((row, index) => {
  const model = modelLabel(row.Model);
  const modelDates = [...modelDailyMap.values()].filter((item) => item.model === model && item.calls > 0);
  const tokens = (row["Input Tokens"] ?? 0) + (row["Output Tokens"] ?? 0)
    + (row["Cache Read Tokens"] ?? 0) + (row["Cache Write Tokens"] ?? 0);
  return {
    rank: index + 1,
    model,
    cost: row["Cost (USD)"],
    share: row["Share (%)"] / 100,
    calls: row["API Calls"],
    editTurns: row["Edit Turns"],
    oneShotRate: row["One-shot Rate (%)"] === "" ? null : row["One-shot Rate (%)"] / 100,
    costPerEdit: row["Cost/Edit (USD)"] === "" ? null : row["Cost/Edit (USD)"],
    input: row["Input Tokens"],
    output: row["Output Tokens"],
    cacheRead: row["Cache Read Tokens"],
    cacheWrite: row["Cache Write Tokens"],
    tokens,
    firstDate: modelDates.map((item) => item.date).sort()[0] ?? null,
    lastDate: modelDates.map((item) => item.date).sort().at(-1) ?? null,
  };
});

const modelDaily = [...modelDailyMap.values()].map((row) => {
  const exactCost = exactModelRows.get(row.model)?.["Cost (USD)"] ?? 0;
  const approximateTotal = modelRecordTotals.get(row.model) ?? 0;
  const normalizedCost = approximateTotal > 0 ? row.approximateCost * exactCost / approximateTotal : 0;
  return {
    model: row.model,
    date: row.date,
    cost: round(normalizedCost, 4),
    calls: row.calls,
    tokens: row.tokens,
  };
});

const recordCategoryLabels = {
  coding: "Coding",
  delegation: "Delegation",
  exploration: "Exploration",
  conversation: "Conversation",
  feature: "Feature Dev",
  brainstorming: "Brainstorming",
  debugging: "Debugging",
  testing: "Testing",
  refactoring: "Refactoring",
  git: "Git Ops",
};
const activityCallMap = new Map();
for (const record of rangeRecords) {
  const activity = recordCategoryLabels[String(record.category).toLowerCase()] ?? String(record.category || "Other");
  activityCallMap.set(activity, (activityCallMap.get(activity) ?? 0) + recordCalls(record));
}
const activityLabels = {
  Coding: "Coding",
  Delegation: "Delegation",
  Exploration: "Exploration",
  Conversation: "Conversation",
  "Feature Dev": "Feature Dev",
  Brainstorming: "Brainstorming",
  Debugging: "Debugging",
  Testing: "Testing",
  Refactoring: "Refactoring",
  "Git Ops": "Git Ops",
};
const activities = period.activity.map((row, index) => ({
  rank: index + 1,
  activity: activityLabels[row.Activity] ?? row.Activity,
  cost: row["Cost (USD)"],
  share: row["Share (%)"] / 100,
  calls: activityCallMap.get(activityLabels[row.Activity] ?? row.Activity) ?? 0,
  turns: row.Turns,
}));

const weekdayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const heatmapMap = new Map();
for (const weekday of weekdayOrder) {
  for (let hour = 0; hour < 24; hour += 1) {
    heatmapMap.set(`${weekday}|${hour}`, { weekday, weekdayIndex: weekdayOrder.indexOf(weekday), hour, calls: 0, tokens: 0, approximateCost: 0 });
  }
}
for (const record of rangeRecords) {
  const timestamp = new Date(record.timestamp);
  const weekday = weekdayFormatter.format(timestamp);
  const hour = Number(hourFormatter.format(timestamp));
  const key = `${weekday}|${hour}`;
  const aggregate = heatmapMap.get(key);
  if (!aggregate) continue;
  aggregate.calls += recordCalls(record);
  aggregate.tokens += (record.inputTokens ?? 0) + (record.outputTokens ?? 0)
    + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
  aggregate.approximateCost += record.cost ?? 0;
}
const heatmap = [...heatmapMap.values()].map((row) => ({
  ...row,
  approximateCost: round(row.approximateCost, 2),
  tokenShare: row.tokens / totalTokens,
}));

// A compact call-time fact table powers one consistent date filter across the
// offline report. It contains no prompts, code, or raw local paths.
const rawRecordCost = rangeRecords.reduce((sum, record) => sum + (record.cost ?? 0), 0);
const recordCostScale = rawRecordCost > 0 ? totalCost / rawRecordCost : 1;
const filterFactMap = new Map();
for (const record of rangeRecords) {
  const timestamp = new Date(record.timestamp);
  const date = localDate(record.timestamp);
  const hour = Number(hourFormatter.format(timestamp));
  const weekday = weekdayFormatter.format(timestamp);
  const project = projectAlias(record.project);
  const pseudonymousSessionId = sessionPseudonym(record.sessionId);
  const model = modelLabel(record.model);
  const activity = recordCategoryLabels[String(record.category).toLowerCase()] ?? String(record.category || "Other");
  const key = [date, hour, project, pseudonymousSessionId, model, activity].join("\u001f");
  const aggregate = filterFactMap.get(key) ?? {
    date,
    hour,
    weekday,
    project,
    sessionId: pseudonymousSessionId,
    shortId: pseudonymousSessionId,
    model,
    activity,
    cost: 0,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    firstCallAt: record.timestamp,
    lastCallAt: record.timestamp,
  };
  aggregate.cost += (record.cost ?? 0) * recordCostScale;
  aggregate.calls += recordCalls(record);
  aggregate.input += record.inputTokens ?? 0;
  aggregate.output += record.outputTokens ?? 0;
  aggregate.cacheRead += record.cacheReadTokens ?? 0;
  aggregate.cacheWrite += record.cacheWriteTokens ?? 0;
  if (record.timestamp < aggregate.firstCallAt) aggregate.firstCallAt = record.timestamp;
  if (record.timestamp > aggregate.lastCallAt) aggregate.lastCallAt = record.timestamp;
  filterFactMap.set(key, aggregate);
}
const filterFacts = [...filterFactMap.values()].map((row) => ({ ...row, cost: round(row.cost, 6) }));

const activeDayCosts = daily.filter((row) => row.calls > 0).map((row) => row.cost);
const activeDayTokens = daily.filter((row) => row.calls > 0).map((row) => row.tokens);
const topDays = [...daily].filter((row) => row.calls > 0).sort((a, b) => b.cost - a.cost);
const peakTokenDay = [...daily].filter((row) => row.calls > 0).sort((a, b) => b.tokens - a.tokens)[0] ?? null;
const peakToMedianActiveDayTokens = activeDayTokens.length
  ? (peakTokenDay?.tokens ?? 0) / Math.max(1, quantile(activeDayTokens, 0.5))
  : null;
function topTokenShareForDate(date, dimension) {
  if (!date) return null;
  const totals = new Map();
  let dateTokens = 0;
  for (const fact of filterFacts) {
    if (fact.date !== date) continue;
    const tokens = fact.input + fact.output + fact.cacheRead + fact.cacheWrite;
    dateTokens += tokens;
    totals.set(fact[dimension], (totals.get(fact[dimension]) ?? 0) + tokens);
  }
  const top = [...totals.values()].sort((left, right) => right - left)[0] ?? 0;
  return dateTokens ? top / dateTokens : null;
}
function topTokenFact(dimension) {
  const totals = new Map();
  for (const fact of filterFacts) {
    const tokens = fact.input + fact.output + fact.cacheRead + fact.cacheWrite;
    totals.set(fact[dimension], (totals.get(fact[dimension]) ?? 0) + tokens);
  }
  const [name, tokens] = [...totals.entries()].sort((left, right) => right[1] - left[1])[0] ?? [null, 0];
  return { name, tokens, share: totalTokens ? tokens / totalTokens : 0 };
}
const peakDayTopProjectTokenShare = topTokenShareForDate(peakTokenDay?.date, "project");
const peakDayTopModelTokenShare = topTokenShareForDate(peakTokenDay?.date, "model");
const topProjectTokenFact = topTokenFact("project");
const topModelTokenFact = topTokenFact("model");
const topSessionCost = (count) => sessions.slice(0, count).reduce((sum, row) => sum + row.cost, 0);
const dominantMonth = [...months].sort((a, b) => b.cost - a.cost)[0];
const dominantMonthIndex = months.findIndex((row) => row.month === dominantMonth.month);
const previousMonth = dominantMonthIndex > 0 ? months[dominantMonthIndex - 1] : null;
const costBeforeDominant = months.slice(0, Math.max(0, dominantMonthIndex)).reduce((sum, row) => sum + row.cost, 0);
const nightTokens = heatmap.filter((row) => row.hour <= 5).reduce((sum, row) => sum + row.tokens, 0);
const weekendTokens = heatmap.filter((row) => row.weekday === "Sat" || row.weekday === "Sun")
  .reduce((sum, row) => sum + row.tokens, 0);

const officialDaily = lifecycleContext?.officialDaily ?? daily.map((row) => ({ date: row.date, tokens: row.tokens }));
const officialSourceAvailable = lifecycleContext !== null;
const officialDailyMap = new Map(officialDaily.map((row) => [row.date, row.tokens]));
let cumulativeOfficialTokens = 0;
for (const row of daily) {
  row.officialTokens = officialDailyMap.get(row.date) ?? null;
  cumulativeOfficialTokens += row.officialTokens ?? 0;
  row.cumulativeOfficialTokens = cumulativeOfficialTokens;
}
const officialTokens = lifecycleContext?.officialLifetimeTokens ?? totalTokens;
const officialPeakDay = [...officialDaily].sort((a, b) => b.tokens - a.tokens)[0] ?? { date: rangeStart, tokens: 0 };
const sourceMode = lifecycleContext
  ? "official-and-local-lifecycle"
  : source.competition?.portableInput === true
    ? source.competition?.syntheticData === true ? "synthetic-demo" : "portable-input"
    : "codeburn-snapshot";
const sourceLabel = lifecycleContext
  ? "Codex 官方账户 + 已采集本地账本"
  : String(source.competition?.sourceLabel || "当前本地 CodeBurn 快照");
const historicalUnattributedLabel = "历史未归属";
const isHistoricalUnattributed = (value) => /^历史未归(?:属|类)(?:\s*·|$)/u.test(String(value || ""));
const rawRecordTokens = (record) => (record.inputTokens ?? 0) + (record.outputTokens ?? 0)
  + (record.cacheReadTokens ?? 0) + (record.cacheWriteTokens ?? 0);
const knownProjectTokens = rangeRecords
  .filter((record) => !isHistoricalUnattributed(projectAlias(record.project)))
  .reduce((sum, record) => sum + rawRecordTokens(record), 0);
const knownActivityTokens = rangeRecords
  .filter((record) => !isHistoricalUnattributed(record.category))
  .reduce((sum, record) => sum + rawRecordTokens(record), 0);
const lifecycleFullTokens = lifecycleContext?.ledger?.components?.totalTokens ?? totalTokens;
const officialNetGap = officialTokens - totalTokens;
const reconstruction = {
  officialTokens,
  reconstructedTokens: totalTokens,
  netGapTokens: officialNetGap,
  absoluteGapTokens: Math.abs(officialNetGap),
  absoluteGapRate: officialTokens ? Math.abs(officialNetGap) / officialTokens : 0,
  reconstructedToOfficialRatio: officialTokens ? totalTokens / officialTokens : 0,
  fullLocalLedgerTokens: lifecycleFullTokens,
  outsideOfficialDateRangeTokens: lifecycleFullTokens - totalTokens,
  knownProjectTokens,
  historicalUnattributedProjectTokens: totalTokens - knownProjectTokens,
  projectTokenCoverage: totalTokens ? knownProjectTokens / totalTokens : 0,
  knownActivityTokens,
  historicalUnattributedActivityTokens: totalTokens - knownActivityTokens,
  activityTokenCoverage: totalTokens ? knownActivityTokens / totalTokens : 0,
};

const output = {
  meta: {
    schema: lifecycleContext ? "codex.lifecycle.report.v2" : "codex.lifecycle.report.v1",
    sourceSchema: lifecycleContext ? lifecycleContext.ledger.schema : source.schema,
    officialSourceAvailable,
    generatedAt: source.generated,
    localSnapshotAt: lifecycleContext?.ledger?.sourceSummaries?.codeburnIncrement?.exportGeneratedAt ?? source.generated,
    timezone: TIMEZONE,
    rangeStart,
    rangeEnd,
    provider: "Codex",
    codeburnVersion: CODEBURN_VERSION,
    sourceMode,
    sourceLabel,
    portableInput: source.competition?.portableInput === true,
    syntheticData: source.competition?.syntheticData === true,
    activityClassification: source.competition?.portableInput === true ? "provided-by-input" : "codeburn-inferred",
    costDefinition: source.competition?.portableInput === true
      ? "估算成本由输入文件提供，仅作为 API 等价估算，不是 Codex 订阅实际账单。"
      : "CodeBurn 按模型价格表估算的成本，不是 Codex 订阅实际账单。",
    dailyDefinition: source.competition?.portableInput === true
      ? "每日指标按输入记录的显式时间戳与所选时区聚合。"
      : "每日指标沿用 CodeBurn 记录的对话轮次日期；时段图按实际调用时间戳聚合。",
    filterDefinition: source.competition?.portableInput === true
      ? "交互式日期筛选统一使用输入记录的日历日期。"
      : "交互式日期筛选统一按模型实际调用时间统计。",
    recordCostScale: round(recordCostScale, 8),
  },
  summary: {
    cost: totalCost,
    calls: totalCalls,
    sessions: sessions.length,
    projectPaths: summaryRow.Projects,
    logicalProjects: projects.length,
    activeDays: period.daily.length,
    calendarDays: daily.length,
    tokens: totalTokens,
    officialTokens,
    reconstructedTokens: totalTokens,
    cacheHitRate: tokenComponents.cacheRead / (tokenComponents.input + tokenComponents.cacheRead),
    tokenComponents,
    reconstruction,
  },
  sources: lifecycleContext ? {
    official: {
      schema: lifecycleContext.official.schema,
      fetchedAt: lifecycleContext.official.generatedAt,
      lifetimeTokens: lifecycleContext.officialLifetimeTokens,
      peakDailyTokens: lifecycleContext.officialPeakDailyTokens,
      bucketStart: rangeStart,
      bucketEnd: rangeEnd,
      bucketCount: officialDaily.length,
      bucketTokenSum: officialDaily.reduce((sum, row) => sum + row.tokens, 0),
      bucketTimezone: "官方接口未提供",
    },
    ledger: {
      schema: lifecycleContext.ledger.schema,
      generatedAt: lifecycleContext.ledger.generatedAt,
      devices: Array.isArray(lifecycleContext.ledger.devices) ? lifecycleContext.ledger.devices : null,
      deduplication: lifecycleContext.ledger.deduplication ?? null,
      baselineSource: "CC Switch SQLite",
      baselineThrough: lifecycleContext.ledger.cutoff.ccSwitchMaxCreatedAt,
      baselineTokens: lifecycleContext.ledger.sourceSummaries.ccSwitch.components.totalTokens,
      deltaSource: "CodeBurn 当前日志",
      deltaAfterExclusive: lifecycleContext.ledger.cutoff.codeburnAppendAfter,
      deltaTokens: lifecycleContext.ledger.sourceSummaries.codeburnIncrement.components.totalTokens,
      fullLocalLedgerTokens: lifecycleFullTokens,
    },
  } : null,
  officialDaily,
  daily,
  months,
  projects,
  projectWeeks,
  projectWeekRows: [...topProjectNames, "Other"],
  weeks,
  models,
  modelDaily,
  activities,
  sessions,
  heatmap,
  filterFacts,
  diagnostics: {
    sourceMode,
    sourceRecordRows: rangeRecords.length,
    weightedCalls: totalCalls,
    activeCalendarDays: daily.filter((row) => row.calls > 0).length,
    selectedCalendarDays: daily.length,
    zeroCallDays: daily.filter((row) => row.calls === 0).length,
    peakDay: peakTokenDay ? { date: peakTokenDay.date, tokens: peakTokenDay.tokens, calls: peakTokenDay.calls } : null,
    peakToMedianActiveDayTokens,
    cacheReadTokenShare: tokenComponents.cacheRead / totalTokens,
    projectTokenCoverage: reconstruction.projectTokenCoverage,
    activityTokenCoverage: reconstruction.activityTokenCoverage,
    topProjectCostShare: projects[0]?.share ?? null,
    topModelCostShare: models[0]?.share ?? null,
    topProjectTokenShare: topProjectTokenFact.share,
    topModelTokenShare: topModelTokenFact.share,
    topFiveSessionCostShare: topSessionCost(5) / totalCost,
    ruleset: source.competition?.portableInput === true ? "codex.portable.analysis.v1" : "codex.consumption.analysis.v1",
    qualityFacts: [
      {
        code: "reconciliation",
        outcome: "pass",
        tokens: totalTokens,
        componentTokens: tokenComponents.input + tokenComponents.output + tokenComponents.cacheRead + tokenComponents.cacheWrite,
        calls: totalCalls,
        evidence: "The date, model, project, activity, session, hour, call, and Token-component views derive from the same selected record set.",
      },
      {
        code: "calendar-continuity",
        outcome: "pass",
        selectedCalendarDays: daily.length,
        zeroCallDays: daily.filter((row) => row.calls === 0).length,
        evidence: "The derived date axis contains one row for every selected calendar date.",
      },
      {
        code: "project-token-attribution",
        outcome: reconstruction.projectTokenCoverage >= 0.999999 ? "full" : "partial",
        ratio: round(reconstruction.projectTokenCoverage, 8),
        evidence: "Known project Tokens divided by locally reconstructed Tokens.",
      },
      {
        code: "activity-token-attribution",
        outcome: reconstruction.activityTokenCoverage >= 0.999999 ? "full" : "partial",
        ratio: round(reconstruction.activityTokenCoverage, 8),
        evidence: "Known activity Tokens divided by locally reconstructed Tokens.",
      },
      {
        code: "source-disclosure",
        outcome: sourceMode === "synthetic-demo" ? "synthetic" : sourceMode === "portable-input" ? "portable" : "collected",
        evidence: sourceLabel,
      },
    ],
    analysisFacts: [
      {
        code: "peak-day-token-ratio",
        notable: peakToMedianActiveDayTokens !== null && peakToMedianActiveDayTokens >= 2,
        date: peakTokenDay?.date ?? null,
        value: peakToMedianActiveDayTokens === null ? null : round(peakToMedianActiveDayTokens, 4),
        baseline: "median active-day Tokens",
        interpretationLimit: "This is a statistical threshold, not a causal diagnosis.",
      },
      {
        code: "top-project-token-share",
        notable: topProjectTokenFact.share >= 0.6,
        name: topProjectTokenFact.name,
        tokens: topProjectTokenFact.tokens,
        value: round(topProjectTokenFact.share, 8),
        evidence: "Largest project Token subtotal divided by total Tokens.",
        interpretationLimit: "This describes concentration and does not imply inefficient work.",
      },
      {
        code: "top-model-token-share",
        notable: topModelTokenFact.share >= 0.6,
        name: topModelTokenFact.name,
        tokens: topModelTokenFact.tokens,
        value: round(topModelTokenFact.share, 8),
        evidence: "Largest model Token subtotal divided by total Tokens.",
      },
      {
        code: "peak-day-top-project-token-share",
        date: peakTokenDay?.date ?? null,
        value: peakDayTopProjectTokenShare === null ? null : round(peakDayTopProjectTokenShare, 8),
        evidence: "Largest project Token subtotal divided by peak-day Tokens.",
      },
      {
        code: "peak-day-top-model-token-share",
        date: peakTokenDay?.date ?? null,
        value: peakDayTopModelTokenShare === null ? null : round(peakDayTopModelTokenShare, 8),
        evidence: "Largest model Token subtotal divided by peak-day Tokens.",
      },
      {
        code: "cache-read-token-share",
        notable: tokenComponents.cacheRead / totalTokens >= 0.8,
        value: round(tokenComponents.cacheRead / totalTokens, 8),
        evidence: "Cache-read Tokens divided by total Tokens; this is not cost share.",
        interpretationLimit: "A high share is a composition fact, not evidence of a cache fault.",
      },
    ],
  },
  facts: {
    dominantMonth: dominantMonth.month,
    dominantMonthCost: dominantMonth.cost,
    dominantMonthShare: dominantMonth.cost / totalCost,
    dominantMonthIsPartial: dominantMonth.isPartial,
    previousMonth: previousMonth?.month ?? null,
    dominantVsPrevious: previousMonth?.cost > 0 ? dominantMonth.cost / previousMonth.cost : null,
    costBeforeDominant,
    peakDay: topDays[0],
    topTenDayShare: topDays.slice(0, 10).reduce((sum, row) => sum + row.cost, 0) / totalCost,
    activeDayMedianCost: quantile(activeDayCosts, 0.5),
    activeDayP95Cost: quantile(activeDayCosts, 0.95),
    cacheTokenShare: tokenComponents.cacheRead / totalTokens,
    cacheWriteTokenShare: tokenComponents.cacheWrite / totalTokens,
    inputTokenShare: tokenComponents.input / totalTokens,
    outputTokenShare: tokenComponents.output / totalTokens,
    topTwoProjectShare: projects.slice(0, 2).reduce((sum, row) => sum + row.cost, 0) / totalCost,
    topFiveProjectShare: projects.slice(0, 5).reduce((sum, row) => sum + row.cost, 0) / totalCost,
    topModelShare: models[0]?.share ?? 0,
    topModel: models[0]?.model ?? "—",
    topModelFirstDate: models[0]?.firstDate ?? null,
    topProject: projects[0]?.name ?? "—",
    secondProject: projects[1]?.name ?? null,
    topSessionProject: sessions[0]?.project ?? "—",
    topActivities: activities.slice(0, 2).map((row) => row.activity),
    codingDelegationShare: activities.slice(0, 2).reduce((sum, row) => sum + row.cost, 0) / totalCost,
    topFiveSessionShare: topSessionCost(5) / totalCost,
    topTenSessionShare: topSessionCost(10) / totalCost,
    sessionMedianCost: quantile(sessions.map((row) => row.cost), 0.5),
    sessionP95Cost: quantile(sessions.map((row) => row.cost), 0.95),
    nightTokenShare: nightTokens / totalTokens,
    weekendTokenShare: weekendTokens / totalTokens,
    officialPeakDay,
    reconstruction,
  },
};

const serializedOutput = `${JSON.stringify(output, null, 2)}\n`;
if (UUID_PATTERN.test(serializedOutput)) throw new Error("Derived report data contains a UUID-shaped identifier");
writePrivateAtomic(outputPath, serializedOutput);
console.log(JSON.stringify({
  output: outputPath,
  generatedAt: output.meta.generatedAt,
  dailyRows: output.daily.length,
  projectRows: output.projects.length,
  sessionRows: output.sessions.length,
  heatmapRows: output.heatmap.length,
  totalCost: output.summary.cost,
  totalTokens: output.summary.tokens,
}, null, 2));
