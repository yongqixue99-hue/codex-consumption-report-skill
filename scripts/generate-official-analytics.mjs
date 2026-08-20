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

const AUDIT_SCHEMA = "codex.official.analytics.audit.v1";
const MANIFEST_SCHEMA = "codex.official.analytics.manifest.v1";
const OUTPUT_MARKER = ".codex-official-analytics-output";
const OUTPUT_MARKER_SCHEMA = "codex.official.analytics.output.v1";
const VALUE_OPTIONS = new Set([
  "usage-input",
  "skills-input",
  "plugins-input",
  "output-dir",
  "from",
  "to",
  "timezone",
]);
const BOOLEAN_OPTIONS = new Set(["replace-output"]);
const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|cookies|set-cookie|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|apikey|password|secret|email|account[-_]?id|user[-_]?id|workspace[-_]?id|organization[-_]?id|org[-_]?id)$/i;
const CREDENTIAL_VALUE_PATTERN = /(?:authorization\s*[:=]|proxy-authorization\s*[:=]|set-cookie\s*[:=]|bearer\s+[a-z0-9._~-]{12,}|(?:access|refresh|session)[-_]?token\s*[:=])/iu;
const ENDPOINTS = {
  usage: "daily-workspace-usage-counts",
  skills: "daily-skill-usage-metrics",
  plugins: "daily-plugin-usage-metrics",
};

function fail(message) {
  process.stderr.write(`Official analytics audit failed: ${message}\n`);
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
  if (!args["usage-input"] || !args["output-dir"]) {
    throw new Error("Usage: node generate-official-analytics.mjs --usage-input <daily-workspace-usage-counts.json> [--skills-input <daily-skill-usage-metrics.json>] [--plugins-input <daily-plugin-usage-metrics.json>] --output-dir <directory>");
  }
  return args;
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function safeNonnegativeInteger(value, label, defaultValue = undefined) {
  const candidate = value == null && defaultValue !== undefined ? defaultValue : value;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return candidate;
}

function safeLabel(value, label, maximumLength = 180) {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /[\r\n\t]/u.test(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  if (CREDENTIAL_VALUE_PATTERN.test(normalized)) throw new Error(`${label} contains credential-like text`);
  return normalized;
}

function optionalLabel(value, label, fallback) {
  if (value == null || value === "") return fallback;
  return safeLabel(value, label);
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

function readSanitizedJson(path, endpoint) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${endpoint} input must be a JSON object response body`);
  }
  const sensitiveKeys = findSensitiveKeys(parsed);
  if (sensitiveKeys.length) {
    throw new Error(`${endpoint} input contains sensitive or identity fields that are not needed: ${sensitiveKeys.slice(0, 8).join(", ")}`);
  }
  if (CREDENTIAL_VALUE_PATTERN.test(JSON.stringify(parsed))) {
    throw new Error(`${endpoint} input contains credential-like text`);
  }
  return parsed;
}

function normalizeGroupBy(value, endpoint) {
  const groupBy = value ?? "day";
  if (groupBy !== "day" && groupBy !== "week") {
    throw new Error(`${endpoint} supports only group_by=day or group_by=week; received ${groupBy}`);
  }
  return groupBy;
}

function normalizeModel(row, date, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${date}.models[${index}] is invalid`);
  return {
    model: safeLabel(row.model, `${date}.models[${index}].model`, 96),
    threads: safeNonnegativeInteger(row.threads, `${date}.models[${index}].threads`, 0),
    turns: safeNonnegativeInteger(row.turns, `${date}.models[${index}].turns`, 0),
  };
}

function clientDisplayName(clientId) {
  const known = {
    CODEX_DESKTOP_APP: "Desktop App",
    CODEX_WORK_WEB: "Web",
    CODEX_WEB: "Web",
    CODEX_CLI: "CLI",
    CODEX_EXEC: "Exec",
    CODEX_IDE: "IDE Extension",
  };
  return known[clientId] ?? clientId.replace(/^CODEX_/u, "").toLocaleLowerCase().split("_").map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`).join(" ");
}

function normalizeClient(row, date, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${date}.clients[${index}] is invalid`);
  const clientId = safeLabel(row.client_id, `${date}.clients[${index}].client_id`, 128);
  return {
    clientId,
    displayName: clientDisplayName(clientId),
    threads: safeNonnegativeInteger(row.threads, `${date}.clients[${index}].threads`, 0),
    turns: safeNonnegativeInteger(row.turns, `${date}.clients[${index}].turns`, 0),
  };
}

function normalizeUsageResponse(parsed) {
  const groupBy = normalizeGroupBy(parsed.group_by, ENDPOINTS.usage);
  if (!Array.isArray(parsed.data) || parsed.data.length === 0) {
    throw new Error(`${ENDPOINTS.usage} must contain a non-empty data array`);
  }
  const rows = parsed.data.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`data[${index}] is invalid`);
    if (!validDate(row.date)) throw new Error(`data[${index}].date is invalid`);
    if (!row.totals || typeof row.totals !== "object" || Array.isArray(row.totals)) {
      throw new Error(`${row.date}.totals is missing`);
    }
    return {
      date: row.date,
      threads: safeNonnegativeInteger(row.totals.threads, `${row.date}.totals.threads`),
      turns: safeNonnegativeInteger(row.totals.turns, `${row.date}.totals.turns`),
      models: Array.isArray(row.models) ? row.models.map((item, itemIndex) => normalizeModel(item, row.date, itemIndex)) : [],
      clients: Array.isArray(row.clients) ? row.clients.map((item, itemIndex) => normalizeClient(item, row.date, itemIndex)) : [],
    };
  }).sort((left, right) => left.date.localeCompare(right.date));
  requireUniqueDates(rows, ENDPOINTS.usage);
  return { groupBy, rows };
}

function normalizeToolResponse(parsed, kind) {
  const endpoint = ENDPOINTS[kind];
  const groupBy = normalizeGroupBy(parsed.group_by, endpoint);
  if (!Array.isArray(parsed.data)) throw new Error(`${endpoint} must contain a data array`);
  const listKey = kind === "skills" ? "skill_usage_overviews" : "plugin_usage_overviews";
  const rows = parsed.data.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${endpoint}.data[${index}] is invalid`);
    if (!validDate(row.date)) throw new Error(`${endpoint}.data[${index}].date is invalid`);
    if (!Array.isArray(row[listKey])) throw new Error(`${endpoint}.${row.date}.${listKey} must be an array`);
    const items = row[listKey].map((item, itemIndex) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${endpoint}.${row.date}.${listKey}[${itemIndex}] is invalid`);
      const nameKey = kind === "skills" ? "skill_name" : "plugin_name";
      const name = safeLabel(item[nameKey], `${endpoint}.${row.date}.${listKey}[${itemIndex}].${nameKey}`);
      const displayName = optionalLabel(item.display_name, `${endpoint}.${row.date}.${listKey}[${itemIndex}].display_name`, name);
      const pluginId = kind === "plugins" && item.plugin_id != null
        ? safeLabel(item.plugin_id, `${endpoint}.${row.date}.${listKey}[${itemIndex}].plugin_id`)
        : null;
      return {
        name,
        displayName,
        pluginId,
        invocations: safeNonnegativeInteger(item.invocation_counts, `${endpoint}.${row.date}.${listKey}[${itemIndex}].invocation_counts`),
      };
    });
    return { date: row.date, items };
  }).sort((left, right) => left.date.localeCompare(right.date));
  requireUniqueDates(rows, endpoint);
  return { groupBy, rows };
}

function requireUniqueDates(rows, endpoint) {
  const dates = rows.map((row) => row.date);
  if (new Set(dates).size !== dates.length) throw new Error(`${endpoint} contains duplicate date buckets`);
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

function selectUsageRows(rows, from, to) {
  if (from && !validDate(from)) throw new Error("--from must use YYYY-MM-DD");
  if (to && !validDate(to)) throw new Error("--to must use YYYY-MM-DD");
  const rangeStart = from || rows[0].date;
  const rangeEnd = to || rows.at(-1).date;
  if (rangeStart > rangeEnd) throw new Error("--from must not be later than --to");
  const selected = rows.filter((row) => row.date >= rangeStart && row.date <= rangeEnd);
  if (!selected.length) throw new Error("selected date range does not overlap the usage input");
  return selected;
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function ratio(value, total) {
  return total > 0 ? value / total : 0;
}

function toolItemKey(item, kind) {
  if (item.name.toLocaleLowerCase() === "other") return "other";
  if (kind === "plugins" && item.pluginId) return `id:${item.pluginId}`;
  return `name:${item.name.toLocaleLowerCase()}`;
}

function aggregateToolItems(rows, kind) {
  const map = new Map();
  for (const row of rows) {
    for (const item of row.items) {
      const key = toolItemKey(item, kind);
      const aggregate = map.get(key) ?? {
        name: item.name,
        displayName: item.name.toLocaleLowerCase() === "other" ? "Other" : item.displayName,
        invocations: 0,
        activeBuckets: new Set(),
      };
      aggregate.invocations += item.invocations;
      if (item.invocations > 0) aggregate.activeBuckets.add(row.date);
      map.set(key, aggregate);
    }
  }
  const total = [...map.values()].reduce((accumulator, row) => accumulator + row.invocations, 0);
  return [...map.values()]
    .map((row) => ({
      name: row.name,
      displayName: row.displayName,
      invocations: row.invocations,
      activeBuckets: row.activeBuckets.size,
      share: ratio(row.invocations, total),
    }))
    .sort((left, right) => right.invocations - left.invocations || left.displayName.localeCompare(right.displayName));
}

function aggregateUsageDimension(rows, listKey, keyName, displayName) {
  const map = new Map();
  for (const row of rows) {
    for (const item of row[listKey]) {
      const key = item[keyName];
      const aggregate = map.get(key) ?? {
        [keyName]: key,
        displayName: displayName(item),
        threadsDailySum: 0,
        turns: 0,
        activeBuckets: new Set(),
      };
      aggregate.threadsDailySum += item.threads;
      aggregate.turns += item.turns;
      if (item.threads > 0 || item.turns > 0) aggregate.activeBuckets.add(row.date);
      map.set(key, aggregate);
    }
  }
  const totalTurns = sum(rows, (row) => row.turns);
  return [...map.values()]
    .map((row) => ({
      [keyName]: row[keyName],
      displayName: row.displayName,
      threadsDailySum: row.threadsDailySum,
      turns: row.turns,
      activeBuckets: row.activeBuckets.size,
      turnShare: ratio(row.turns, totalTurns),
    }))
    .sort((left, right) => right.turns - left.turns || left.displayName.localeCompare(right.displayName));
}

function buildAudit(usage, skills, plugins, options) {
  if (skills && skills.groupBy !== usage.groupBy) {
    throw new Error(`group_by mismatch: ${ENDPOINTS.usage}=${usage.groupBy}, ${ENDPOINTS.skills}=${skills.groupBy}`);
  }
  if (plugins && plugins.groupBy !== usage.groupBy) {
    throw new Error(`group_by mismatch: ${ENDPOINTS.usage}=${usage.groupBy}, ${ENDPOINTS.plugins}=${plugins.groupBy}`);
  }

  const usageRows = selectUsageRows(usage.rows, options.from, options.to);
  const rangeStart = usageRows[0].date;
  const rangeEnd = usageRows.at(-1).date;
  const selectedToolRows = (source) => source?.rows.filter((row) => row.date >= rangeStart && row.date <= rangeEnd) ?? [];
  const skillRows = selectedToolRows(skills);
  const pluginRows = selectedToolRows(plugins);
  const usageDates = usageRows.map((row) => row.date);
  const requireMatchingBuckets = (rows, endpoint) => {
    const dates = rows.map((row) => row.date);
    if (dates.length !== usageDates.length || dates.some((date, index) => date !== usageDates[index])) {
      throw new Error(`${endpoint} date buckets must exactly match the selected ${ENDPOINTS.usage} buckets`);
    }
  };
  if (skills) requireMatchingBuckets(skillRows, ENDPOINTS.skills);
  if (plugins) requireMatchingBuckets(pluginRows, ENDPOINTS.plugins);
  const skillByDate = new Map(skillRows.map((row) => [row.date, row.items]));
  const pluginByDate = new Map(pluginRows.map((row) => [row.date, row.items]));
  const daily = usageRows.map((row) => ({
    date: row.date,
    threads: row.threads,
    turns: row.turns,
    skillInvocations: skills ? sum(skillByDate.get(row.date) ?? [], (item) => item.invocations) : null,
    pluginCalls: plugins ? sum(pluginByDate.get(row.date) ?? [], (item) => item.invocations) : null,
  }));

  const turns = sum(daily, (row) => row.turns);
  const threadsDailySum = sum(daily, (row) => row.threads);
  const skillInvocations = skills ? sum(daily, (row) => row.skillInvocations) : null;
  const pluginCalls = plugins ? sum(daily, (row) => row.pluginCalls) : null;
  const models = aggregateUsageDimension(usageRows, "models", "model", (item) => item.model);
  const clients = aggregateUsageDimension(usageRows, "clients", "clientId", (item) => item.displayName);
  const skillTable = skills ? aggregateToolItems(skillRows, "skills") : [];
  const pluginTable = plugins ? aggregateToolItems(pluginRows, "plugins") : [];
  const modelTurnsMatch = usageRows.every((row) => row.models.length === 0 || sum(row.models, (item) => item.turns) === row.turns);
  const modelThreadsMatch = usageRows.every((row) => row.models.length === 0 || sum(row.models, (item) => item.threads) === row.threads);
  const clientTurnsMatch = usageRows.every((row) => row.clients.length === 0 || sum(row.clients, (item) => item.turns) === row.turns);
  const clientThreadsMatch = usageRows.every((row) => row.clients.length === 0 || sum(row.clients, (item) => item.threads) === row.threads);
  const warnings = [
    "这三个请求属于官网看板的内部接口，并非有稳定承诺的公开 API；字段结构变化时生成器会停止。",
    "turns 是交互轮次，不是去重任务数，也不等于手动发送次数。",
    "Skill 激活既可能是显式调用，也可能是隐式调用；它不是已安装 Skill 的数量。",
    "Plugin calls 与 Skill 激活是两种活动指标，均不得直接换算为 credits。",
    "每天的 threads 相加不是所选区间内去重后的任务总数。",
  ];
  if (!skills) warnings.push("未提供 Skills 响应；Skills 表格和总数标记为未提供。");
  if (!plugins) warnings.push("未提供 Plugins 响应；Plugins 表格和总数标记为未提供。");
  if (!modelTurnsMatch || !modelThreadsMatch) warnings.push("模型明细未完全对齐每日 totals；报告仍以每日 totals 为准。");
  if (!clientTurnsMatch || !clientThreadsMatch) warnings.push("客户端明细未完全对齐每日 totals；报告仍以每日 totals 为准。");

  return {
    schema: AUDIT_SCHEMA,
    generatedAt: new Date().toISOString(),
    source: {
      dashboard: "https://chatgpt.com/codex/cloud/settings/analytics",
      groupBy: usage.groupBy,
      rangeStart,
      rangeEnd,
      timezone: options.timezone,
      endpoints: {
        usage: { name: ENDPOINTS.usage, supplied: true, bucketsInRange: usageRows.length },
        skills: { name: ENDPOINTS.skills, supplied: Boolean(skills), bucketsInRange: skillRows.length },
        plugins: { name: ENDPOINTS.plugins, supplied: Boolean(plugins), bucketsInRange: pluginRows.length },
      },
    },
    summary: {
      buckets: daily.length,
      threadsDailySum,
      turns,
      averageTurnsPerDailyThread: threadsDailySum > 0 ? turns / threadsDailySum : 0,
      skillInvocations,
      pluginCalls,
      modelSeries: models.length,
      clientSeries: clients.length,
      skillSeries: skillTable.length,
      pluginSeries: pluginTable.length,
    },
    daily,
    models,
    clients,
    skills: skillTable,
    plugins: pluginTable,
    definitions: {
      turns: "一次对话交互轮次，通常包含用户输入以及 Agent 的回复和动作。",
      skillInvocations: "Skill 的显式或隐式激活次数，不是不同 Skill 的数量。",
      pluginCalls: "官网看板归因给已安装 Plugin 的调用次数，与 Skill 激活分开统计。",
      threadsDailySum: "每日 thread 数值之和，不是所选区间去重后的任务数量。",
    },
    validation: {
      checks: [
        { name: "每日 turns 汇总一致", status: sum(daily, (row) => row.turns) === turns ? "pass" : "fail" },
        { name: "每日 threads 汇总一致", status: sum(daily, (row) => row.threads) === threadsDailySum ? "pass" : "fail" },
        { name: "模型 turns 与 totals 对齐", status: modelTurnsMatch ? "pass" : "warning" },
        { name: "模型 threads 与 totals 对齐", status: modelThreadsMatch ? "pass" : "warning" },
        { name: "客户端 turns 与 totals 对齐", status: clientTurnsMatch ? "pass" : "warning" },
        { name: "客户端 threads 与 totals 对齐", status: clientThreadsMatch ? "pass" : "warning" },
        { name: "Skills 汇总一致", status: skills && sum(skillTable, (row) => row.invocations) === skillInvocations ? "pass" : skills ? "fail" : "not-provided" },
        { name: "Plugins 汇总一致", status: plugins && sum(pluginTable, (row) => row.invocations) === pluginCalls ? "pass" : plugins ? "fail" : "not-provided" },
      ],
      warnings,
    },
    privacy: "仅使用脱敏 Response JSON；不包含请求头、Cookies、Authorization、邮箱、账户 ID、用户 ID 或访问令牌。",
  };
}

function formatNumber(value, maximumFractionDigits = 2) {
  if (value == null) return "未提供";
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(value);
}

function formatPercent(value) {
  return `${formatNumber(value * 100, 1)}%`;
}

function markdownEscape(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.map(markdownEscape).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(markdownEscape).join(" | ")} |`),
  ].join("\n");
}

function renderMarkdown(audit) {
  const summaryRows = [
    ["统计区间", `${audit.source.rangeStart} 至 ${audit.source.rangeEnd}`],
    ["分组", audit.source.groupBy],
    ["turns", formatNumber(audit.summary.turns, 0)],
    ["threads 日累计（非去重）", formatNumber(audit.summary.threadsDailySum, 0)],
    ["平均 turns / 每日 thread", formatNumber(audit.summary.averageTurnsPerDailyThread, 2)],
    ["Skill 激活次数", formatNumber(audit.summary.skillInvocations, 0)],
    ["Plugin calls", formatNumber(audit.summary.pluginCalls, 0)],
  ];
  const sections = [
    "# Codex 官方活动分析",
    "",
    "这份报告使用 Codex Analytics 页面三类脱敏 Response JSON。它与 Credits、Token 和本地任务归因是并列的数据层，不把 turns、Skill 激活或 Plugin calls 换算成 credits。",
    "",
    "## 总览",
    "",
    markdownTable(["指标", "数值"], summaryRows),
    "",
    "## 每日活动",
    "",
    markdownTable(
      ["日期", "threads（日值）", "turns", "Skill 激活", "Plugin calls"],
      audit.daily.map((row) => [row.date, formatNumber(row.threads, 0), formatNumber(row.turns, 0), formatNumber(row.skillInvocations, 0), formatNumber(row.pluginCalls, 0)]),
    ),
    "",
    "## 按模型统计",
    "",
    markdownTable(
      ["模型", "活跃分组", "threads 日累计", "turns", "turns 占比"],
      audit.models.map((row) => [row.displayName, formatNumber(row.activeBuckets, 0), formatNumber(row.threadsDailySum, 0), formatNumber(row.turns, 0), formatPercent(row.turnShare)]),
    ),
    "",
    "## 按客户端统计",
    "",
    markdownTable(
      ["客户端", "client_id", "活跃分组", "threads 日累计", "turns", "turns 占比"],
      audit.clients.map((row) => [row.displayName, row.clientId, formatNumber(row.activeBuckets, 0), formatNumber(row.threadsDailySum, 0), formatNumber(row.turns, 0), formatPercent(row.turnShare)]),
    ),
    "",
    "## Skills",
    "",
    audit.source.endpoints.skills.supplied
      ? markdownTable(["排名", "Skill", "激活次数", "占比", "活跃分组"], audit.skills.map((row, index) => [index + 1, row.displayName, formatNumber(row.invocations, 0), formatPercent(row.share), formatNumber(row.activeBuckets, 0)]))
      : "未提供 `daily-skill-usage-metrics` Response JSON。",
    "",
    "## Plugins",
    "",
    audit.source.endpoints.plugins.supplied
      ? markdownTable(["排名", "Plugin", "调用次数", "占比", "活跃分组"], audit.plugins.map((row, index) => [index + 1, row.displayName, formatNumber(row.invocations, 0), formatPercent(row.share), formatNumber(row.activeBuckets, 0)]))
      : "未提供 `daily-plugin-usage-metrics` Response JSON。",
    "",
    "## 校验与口径",
    "",
    markdownTable(["检查", "状态"], audit.validation.checks.map((row) => [row.name, row.status])),
    "",
    ...audit.validation.warnings.map((warning) => `- ${warning}`),
    "",
  ];
  return `${sections.join("\n")}\n`;
}

function xmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function renderSvg(audit) {
  const width = 1400;
  const height = 940;
  const chartX = 92;
  const chartY = 350;
  const chartWidth = 760;
  const chartHeight = 250;
  const maxDaily = Math.max(1, ...audit.daily.flatMap((row) => [row.turns, row.skillInvocations ?? 0]));
  const step = chartWidth / Math.max(1, audit.daily.length);
  const barWidth = Math.max(3, Math.min(22, step * 0.32));
  const showEvery = Math.max(1, Math.ceil(audit.daily.length / 10));
  const dailyBars = audit.daily.map((row, index) => {
    const center = chartX + step * index + step / 2;
    const turnsHeight = row.turns / maxDaily * chartHeight;
    const skillHeight = (row.skillInvocations ?? 0) / maxDaily * chartHeight;
    const label = index % showEvery === 0 || index === audit.daily.length - 1
      ? `<text x="${center}" y="${chartY + chartHeight + 28}" class="axis" text-anchor="middle">${xmlEscape(row.date.slice(5))}</text>`
      : "";
    return `<rect x="${center - barWidth - 2}" y="${chartY + chartHeight - turnsHeight}" width="${barWidth}" height="${Math.max(1, turnsHeight)}" rx="3" fill="#1f6feb"><title>${xmlEscape(row.date)} · ${xmlEscape(row.turns)} turns</title></rect>`
      + `<rect x="${center + 2}" y="${chartY + chartHeight - skillHeight}" width="${barWidth}" height="${Math.max(row.skillInvocations == null ? 0 : 1, skillHeight)}" rx="3" fill="#f59e0b"><title>${xmlEscape(row.date)} · ${xmlEscape(row.skillInvocations ?? "未提供")} Skill 激活</title></rect>${label}`;
  }).join("");
  const topSkills = audit.skills.slice(0, 8);
  const skillMax = Math.max(1, ...topSkills.map((row) => row.invocations));
  const skillBars = topSkills.length
    ? topSkills.map((row, index) => {
      const y = 690 + index * 27;
      const bar = row.invocations / skillMax * 200;
      return `<text x="930" y="${y + 13}" class="row">${xmlEscape(row.displayName.slice(0, 24))}</text><rect x="1110" y="${y}" width="${Math.max(2, bar)}" height="16" rx="6" fill="#f59e0b"><title>${xmlEscape(row.displayName)} · ${xmlEscape(row.invocations)}</title></rect><text x="${1122 + bar}" y="${y + 13}" class="value">${xmlEscape(formatNumber(row.invocations, 0))}</text>`;
    }).join("")
    : `<text x="930" y="720" class="muted">未提供 Skills 响应或所选区间无数据</text>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">
  <title id="title">Codex 官方活动分析</title>
  <desc id="desc">${xmlEscape(audit.source.rangeStart)} 至 ${xmlEscape(audit.source.rangeEnd)} 的 turns、Skill 激活、Plugin calls、模型与客户端统计</desc>
  <style>
    .title{font:700 38px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#0f172a}.sub{font:400 17px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#64748b}.cardLabel{font:500 15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#64748b}.cardValue{font:700 30px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#0f172a}.section{font:700 21px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#0f172a}.axis{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;fill:#64748b}.row{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#334155}.value{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;fill:#334155}.muted{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;fill:#64748b}
  </style>
  <rect width="1400" height="940" fill="#f8fafc"/>
  <text x="72" y="78" class="title">Codex 官方活动分析</text>
  <text x="72" y="112" class="sub">${xmlEscape(audit.source.rangeStart)} — ${xmlEscape(audit.source.rangeEnd)} · 按${audit.source.groupBy === "day" ? "天" : "周"}分组 · 脱敏 Response JSON</text>
  ${[
    ["turns", formatNumber(audit.summary.turns, 0)],
    ["threads 日累计", formatNumber(audit.summary.threadsDailySum, 0)],
    ["Skill 激活", formatNumber(audit.summary.skillInvocations, 0)],
    ["Plugin calls", formatNumber(audit.summary.pluginCalls, 0)],
  ].map(([label, value], index) => {
    const x = 72 + index * 325;
    return `<rect x="${x}" y="160" width="285" height="112" rx="18" fill="#fff" stroke="#e2e8f0"/><text x="${x + 24}" y="198" class="cardLabel">${xmlEscape(label)}</text><text x="${x + 24}" y="246" class="cardValue">${xmlEscape(value)}</text>`;
  }).join("")}
  <text x="92" y="322" class="section">每日 turns 与 Skill 激活</text>
  <rect x="92" y="350" width="760" height="250" rx="12" fill="#fff" stroke="#e2e8f0"/>
  ${dailyBars}
  <rect x="92" y="628" width="14" height="14" rx="3" fill="#1f6feb"/><text x="114" y="640" class="row">turns</text>
  <rect x="185" y="628" width="14" height="14" rx="3" fill="#f59e0b"/><text x="207" y="640" class="row">Skill 激活</text>
  <text x="930" y="322" class="section">模型 turns</text>
  ${audit.models.slice(0, 6).map((row, index) => `<text x="930" y="${366 + index * 35}" class="row">${xmlEscape(row.displayName.slice(0, 24))}</text><text x="1320" y="${366 + index * 35}" class="value" text-anchor="end">${xmlEscape(formatNumber(row.turns, 0))} · ${xmlEscape(formatPercent(row.turnShare))}</text>`).join("")}
  <text x="930" y="660" class="section">Skills 排名</text>
  ${skillBars}
  <text x="72" y="904" class="muted">turns、Skill 激活与 Plugin calls 是不同活动口径；不得直接换算成 credits。内部网页接口可能变化，报告生成器会在陌生结构上停止。</text>
</svg>`;
}

function htmlEscape(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function htmlTable(headers, rows) {
  const body = rows.length
    ? rows.map((row) => `<tr>${row.map((cell) => `<td>${htmlEscape(cell)}</td>`).join("")}</tr>`).join("")
    : `<tr><td colspan="${headers.length}">所选区间无数据</td></tr>`;
  return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${htmlEscape(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderHtml(audit, svg) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex 官方活动分析</title>
<style>:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8fafc;color:#0f172a}*{box-sizing:border-box}body{margin:0}.page{max-width:1180px;margin:0 auto;padding:48px 24px 80px}h1{font-size:38px;margin:0 0 10px}h2{margin:44px 0 14px;font-size:24px}.lead,.muted{color:#64748b;line-height:1.7}.graphic{margin:30px 0;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;background:#fff}.graphic svg{display:block;width:100%;height:auto}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-top:26px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:18px}.label{font-size:13px;color:#64748b}.number{font-size:27px;font-weight:700;margin-top:9px}.table-wrap{overflow:auto;border:1px solid #e2e8f0;border-radius:14px;background:#fff}table{border-collapse:collapse;width:100%;min-width:660px}th,td{padding:12px 14px;border-bottom:1px solid #e2e8f0;text-align:left;font-size:14px}th{color:#475569;background:#f8fafc}tr:last-child td{border-bottom:0}.callout{border-left:4px solid #f59e0b;background:#fffbeb;padding:16px 18px;border-radius:8px;line-height:1.65}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}ul{line-height:1.7}@media(max-width:760px){.page{padding:28px 16px 60px}h1{font-size:30px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}}</style></head>
<body><main class="page"><h1>Codex 官方活动分析</h1><p class="lead">${htmlEscape(audit.source.rangeStart)} 至 ${htmlEscape(audit.source.rangeEnd)} · ${audit.source.groupBy === "day" ? "按天" : "按周"}分组 · 仅使用脱敏 Response JSON</p>
<div class="cards">${[
    ["turns", formatNumber(audit.summary.turns, 0)],
    ["threads 日累计", formatNumber(audit.summary.threadsDailySum, 0)],
    ["Skill 激活", formatNumber(audit.summary.skillInvocations, 0)],
    ["Plugin calls", formatNumber(audit.summary.pluginCalls, 0)],
  ].map(([label, value]) => `<div class="card"><div class="label">${htmlEscape(label)}</div><div class="number">${htmlEscape(value)}</div></div>`).join("")}</div>
<div class="graphic">${svg.replace(/^<\?xml[^>]*>\s*/u, "")}</div>
<div class="callout">这是一层官方活动统计：turns、Skill 激活和 Plugin calls 不能直接换算为 credits，也不能证明某一条回复使用了哪个模型或 Skill。</div>
<h2>每日活动</h2>${htmlTable(["日期", "threads（日值）", "turns", "Skill 激活", "Plugin calls"], audit.daily.map((row) => [row.date, formatNumber(row.threads, 0), formatNumber(row.turns, 0), formatNumber(row.skillInvocations, 0), formatNumber(row.pluginCalls, 0)]))}
<h2>按模型统计</h2>${htmlTable(["模型", "活跃分组", "threads 日累计", "turns", "turns 占比"], audit.models.map((row) => [row.displayName, formatNumber(row.activeBuckets, 0), formatNumber(row.threadsDailySum, 0), formatNumber(row.turns, 0), formatPercent(row.turnShare)]))}
<h2>按客户端统计</h2>${htmlTable(["客户端", "client_id", "活跃分组", "threads 日累计", "turns", "turns 占比"], audit.clients.map((row) => [row.displayName, row.clientId, formatNumber(row.activeBuckets, 0), formatNumber(row.threadsDailySum, 0), formatNumber(row.turns, 0), formatPercent(row.turnShare)]))}
<h2>Skills</h2>${audit.source.endpoints.skills.supplied ? htmlTable(["排名", "Skill", "激活次数", "占比", "活跃分组"], audit.skills.map((row, index) => [index + 1, row.displayName, formatNumber(row.invocations, 0), formatPercent(row.share), formatNumber(row.activeBuckets, 0)])) : "<p class=\"muted\">未提供 daily-skill-usage-metrics Response JSON。</p>"}
<h2>Plugins</h2>${audit.source.endpoints.plugins.supplied ? htmlTable(["排名", "Plugin", "调用次数", "占比", "活跃分组"], audit.plugins.map((row, index) => [index + 1, row.displayName, formatNumber(row.invocations, 0), formatPercent(row.share), formatNumber(row.activeBuckets, 0)])) : "<p class=\"muted\">未提供 daily-plugin-usage-metrics Response JSON。</p>"}
<h2>校验</h2>${htmlTable(["检查", "状态"], audit.validation.checks.map((row) => [row.name, row.status]))}<ul>${audit.validation.warnings.map((warning) => `<li>${htmlEscape(warning)}</li>`).join("")}</ul>
<p class="muted">${htmlEscape(audit.privacy)}</p></main></body></html>`;
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
  const auditPath = resolve(outputDirectory, "codex-official-analytics.json");
  const markdownPath = resolve(outputDirectory, "codex-official-analytics.md");
  const svgPath = resolve(outputDirectory, "codex-official-analytics.svg");
  const htmlPath = resolve(outputDirectory, "codex-official-analytics.html");
  const manifestPath = resolve(outputDirectory, "codex-official-analytics-manifest.json");
  const markerPath = resolve(outputDirectory, OUTPUT_MARKER);
  const svg = renderSvg(audit);
  const markdown = renderMarkdown(audit);
  const html = renderHtml(audit, svg);
  writePrivateAtomic(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
  writePrivateAtomic(markdownPath, markdown);
  writePrivateAtomic(svgPath, svg);
  writePrivateAtomic(htmlPath, html);
  writePrivateAtomic(markerPath, `${JSON.stringify({ schema: OUTPUT_MARKER_SCHEMA })}\n`);
  const files = [auditPath, markdownPath, svgPath, htmlPath].map((file) => ({ path: basename(file), sha256: sha256(file) }));
  const manifest = {
    schema: MANIFEST_SCHEMA,
    generatedAt: audit.generatedAt,
    range: { start: audit.source.rangeStart, end: audit.source.rangeEnd },
    files,
    privacy: audit.privacy,
  };
  writePrivateAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { auditPath, markdownPath, svgPath, htmlPath, manifestPath };
}

function validateArtifacts(artifacts) {
  const result = spawnSync(process.execPath, [
    resolve(import.meta.dirname, "validate-official-analytics.mjs"),
    "--audit", artifacts.auditPath,
    "--markdown", artifacts.markdownPath,
    "--svg", artifacts.svgPath,
    "--html", artifacts.htmlPath,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`generated artifact validation failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return JSON.parse(result.stdout);
}

function assertRegularInput(path, label) {
  if (!existsSync(path) || lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()) {
    throw new Error(`${label} must be a regular file: ${path}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const usagePath = resolve(args["usage-input"]);
  const skillsPath = args["skills-input"] ? resolve(args["skills-input"]) : null;
  const pluginsPath = args["plugins-input"] ? resolve(args["plugins-input"]) : null;
  assertRegularInput(usagePath, "--usage-input");
  if (skillsPath) assertRegularInput(skillsPath, "--skills-input");
  if (pluginsPath) assertRegularInput(pluginsPath, "--plugins-input");
  const outputDirectory = resolve(args["output-dir"]);
  const inputDirectories = [usagePath, skillsPath, pluginsPath].filter(Boolean).map(dirname);
  if (inputDirectories.includes(outputDirectory)) throw new Error("use a dedicated output directory that is different from every input file directory");

  const usage = normalizeUsageResponse(readSanitizedJson(usagePath, ENDPOINTS.usage));
  const skills = skillsPath ? normalizeToolResponse(readSanitizedJson(skillsPath, ENDPOINTS.skills), "skills") : null;
  const plugins = pluginsPath ? normalizeToolResponse(readSanitizedJson(pluginsPath, ENDPOINTS.plugins), "plugins") : null;
  const options = {
    from: args.from,
    to: args.to,
    timezone: validateTimezone(args.timezone),
  };
  const audit = buildAudit(usage, skills, plugins, options);
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
