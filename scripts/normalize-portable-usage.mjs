#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { extname, resolve } from "node:path";

const PORTABLE_SCHEMA = "codex.portable.usage.v1";
const OUTPUT_SCHEMA = "codeburn.export.v2";
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_RECORDS = 100_000;
const MAX_DATE_SPAN_DAYS = 366;
const UUID_PATTERN = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu;
const OPAQUE_IDENTIFIER_PATTERN = /^(?:[0-9a-f]{24,}|[A-Za-z0-9_-]{48,})$/u;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/iu;
const FORBIDDEN_FIELD_PATTERN = /(?:prompt|message|content|source[_-]?code|email|account[_-]?id|host(?:name)?|api[_-]?key|secret|password)/iu;
const ALLOWED_JSON_ROOT_FIELDS = new Set(["schema", "generatedAt", "timezone", "synthetic", "records"]);
const ALLOWED_RECORD_FIELDS = new Set([
  "rowId",
  "row_id",
  "timestamp",
  "project",
  "session",
  "sessionId",
  "session_id",
  "model",
  "activity",
  "category",
  "inputTokens",
  "input_tokens",
  "outputTokens",
  "output_tokens",
  "cacheReadTokens",
  "cache_read_tokens",
  "cacheWriteTokens",
  "cache_write_tokens",
  "estimatedCostUsd",
  "estimated_cost_usd",
  "cost_usd",
  "calls",
]);
const ALLOWED_CSV_HEADERS = new Set([
  "row_id",
  "timestamp",
  "project",
  "session",
  "session_id",
  "model",
  "activity",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "estimated_cost_usd",
  "cost_usd",
  "calls",
]);

function usage() {
  return `Usage:
  node normalize-portable-usage.mjs --input <usage.json|usage.jsonl|usage.csv> --output <codeburn-export.json> [--timezone Asia/Shanghai]

JSON input must use schema ${PORTABLE_SCHEMA}. CSV columns:
  timestamp,project,session,model,activity,input_tokens,output_tokens,
  cache_read_tokens,cache_write_tokens,estimated_cost_usd,calls`;
}

function parseArgs(argv) {
  const args = {};
  const valueOptions = new Set(["input", "output", "timezone"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (key === "trusted-demo") {
      args[key] = true;
      continue;
    }
    if (!valueOptions.has(key)) throw new Error(`Unknown option: --${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    args[key] = value;
    index += 1;
  }
  if (!args.input || !args.output) throw new Error(usage());
  return args;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/u, ""));
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field");
  row.push(field.replace(/\r$/u, ""));
  if (row.some((value) => value !== "")) rows.push(row);
  if (rows.length < 2) throw new Error("CSV must contain a header and at least one data row");
  const headers = rows[0].map((value, index) => String(value).replace(/^\uFEFF/u, "").trim());
  if (new Set(headers).size !== headers.length) throw new Error("CSV contains duplicate headers");
  for (const header of headers) {
    if (!ALLOWED_CSV_HEADERS.has(header)) throw new Error(`CSV header is not allowed: ${header}`);
  }
  for (const required of ["timestamp", "project", "model", "activity", "calls"]) {
    if (!headers.includes(required)) throw new Error(`CSV is missing required header: ${required}`);
  }
  if (!headers.includes("session") && !headers.includes("session_id")) {
    throw new Error("CSV is missing required header: session");
  }
  if (!["estimated_cost_usd", "cost_usd"].some((header) => headers.includes(header))) {
    throw new Error("CSV is missing required header: estimated_cost_usd");
  }
  if (!["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].some((header) => headers.includes(header))) {
    throw new Error("CSV must include at least one Token component header");
  }
  return rows.slice(1).map((values, rowIndex) => {
    if (values.length !== headers.length) {
      throw new Error(`CSV row ${rowIndex + 2} has ${values.length} fields; expected ${headers.length}`);
    }
    return Object.fromEntries(headers.map((header, index) => [header, values[index]]));
  });
}

function finiteNumber(value, label) {
  const number = typeof value === "string" && value.trim() === "" ? 0 : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function safeInteger(value, label, fallback = 0) {
  const normalized = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return normalized;
}

function requiredText(value, label, maximumLength = 100) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  if (text.length > maximumLength) throw new Error(`${label} exceeds ${maximumLength} characters`);
  if (/\p{Cc}/u.test(text)) throw new Error(`${label} contains a control character`);
  return text;
}

function safeProject(value, label) {
  const text = requiredText(value, label, 80);
  if (UUID_PATTERN.test(text)) throw new Error(`${label} must not contain a raw UUID`);
  if (EMAIL_PATTERN.test(text)) throw new Error(`${label} must not contain an email address`);
  if (/^(?:file:|https?:|\/|[A-Za-z]:[\\/])|[\\/]/iu.test(text)) {
    throw new Error(`${label} must be a sanitized alias, not a local path`);
  }
  return text;
}

function safeLabel(value, label, maximumLength) {
  const text = requiredText(value, label, maximumLength);
  if (UUID_PATTERN.test(text)) throw new Error(`${label} must not contain a raw UUID`);
  if (EMAIL_PATTERN.test(text)) throw new Error(`${label} must not contain an email address`);
  if (/^(?:file:|https?:|\/|[A-Za-z]:[\\/])/iu.test(text)) throw new Error(`${label} must not contain a path or URL`);
  return text;
}

function timestamp(value, label) {
  const text = requiredText(value, label, 60);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} is not a valid ISO timestamp`);
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/u.test(text)) throw new Error(`${label} must include an explicit UTC offset`);
  return new Date(milliseconds).toISOString();
}

function getSingle(row, label, ...keys) {
  const present = keys.filter((key) => Object.hasOwn(row, key));
  if (present.length > 1) throw new Error(`${label} uses more than one alias: ${present.join(", ")}`);
  return present.length ? row[present[0]] : undefined;
}

function normalizeRecord(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`records[${index}] must be an object`);
  for (const key of Object.keys(row)) {
    if (FORBIDDEN_FIELD_PATTERN.test(key)) throw new Error(`records[${index}] contains forbidden field: ${key}`);
    if (!ALLOWED_RECORD_FIELDS.has(key)) throw new Error(`records[${index}] contains an unknown field: ${key}`);
  }
  const recordTimestamp = timestamp(getSingle(row, `records[${index}].timestamp`, "timestamp"), `records[${index}].timestamp`);
  const sessionId = safeLabel(getSingle(row, `records[${index}].session`, "session", "sessionId", "session_id"), `records[${index}].session`, 100);
  if (OPAQUE_IDENTIFIER_PATTERN.test(sessionId)) {
    throw new Error(`records[${index}].session must be a short sanitized alias, not an opaque identifier`);
  }
  const rowIdValue = getSingle(row, `records[${index}].rowId`, "rowId", "row_id");
  const rowId = rowIdValue === undefined ? null : safeLabel(rowIdValue, `records[${index}].rowId`, 100);
  const normalized = {
    project: safeProject(getSingle(row, `records[${index}].project`, "project"), `records[${index}].project`),
    sessionId,
    timestamp: recordTimestamp,
    category: safeLabel(getSingle(row, `records[${index}].activity`, "activity", "category"), `records[${index}].activity`, 60),
    provider: "codex",
    model: safeLabel(getSingle(row, `records[${index}].model`, "model"), `records[${index}].model`, 100),
    inputTokens: safeInteger(getSingle(row, `records[${index}].inputTokens`, "inputTokens", "input_tokens"), `records[${index}].inputTokens`),
    outputTokens: safeInteger(getSingle(row, `records[${index}].outputTokens`, "outputTokens", "output_tokens"), `records[${index}].outputTokens`),
    reasoningTokens: 0,
    cacheReadTokens: safeInteger(getSingle(row, `records[${index}].cacheReadTokens`, "cacheReadTokens", "cache_read_tokens"), `records[${index}].cacheReadTokens`),
    cacheWriteTokens: safeInteger(getSingle(row, `records[${index}].cacheWriteTokens`, "cacheWriteTokens", "cache_write_tokens"), `records[${index}].cacheWriteTokens`),
    cost: finiteNumber(getSingle(row, `records[${index}].estimatedCostUsd`, "estimatedCostUsd", "estimated_cost_usd", "cost_usd"), `records[${index}].estimatedCostUsd`),
    savings: 0,
    calls: safeInteger(getSingle(row, `records[${index}].calls`, "calls"), `records[${index}].calls`),
  };
  if (normalized.calls < 1) throw new Error(`records[${index}].calls must be at least 1`);
  const tokens = normalized.inputTokens + normalized.outputTokens + normalized.cacheReadTokens + normalized.cacheWriteTokens;
  if (tokens < 1) throw new Error(`records[${index}] must contain at least one Token`);
  return { rowId, record: normalized };
}

function localDate(value, timezone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function emptyAggregate() {
  return {
    cost: 0,
    calls: 0,
    sessions: new Set(),
    projects: new Set(),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

function addRecord(aggregate, record) {
  aggregate.cost += record.cost;
  aggregate.calls += record.calls;
  aggregate.sessions.add(record.sessionId);
  aggregate.projects.add(record.project);
  aggregate.input += record.inputTokens;
  aggregate.output += record.outputTokens;
  aggregate.cacheRead += record.cacheReadTokens;
  aggregate.cacheWrite += record.cacheWriteTokens;
}

function outputTotal(row) {
  return row.input + row.output + row.cacheRead + row.cacheWrite;
}

function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function buildCodeBurnExport(input, records, timezone, trustedDemo) {
  records.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const total = emptyAggregate();
  const dailyMap = new Map();
  const modelMap = new Map();
  const activityMap = new Map();
  const projectMap = new Map();
  const sessionMap = new Map();

  for (const record of records) {
    addRecord(total, record);
    const date = localDate(record.timestamp, timezone);
    const daily = dailyMap.get(date) ?? emptyAggregate();
    addRecord(daily, record);
    dailyMap.set(date, daily);
    const model = modelMap.get(record.model) ?? emptyAggregate();
    addRecord(model, record);
    modelMap.set(record.model, model);
    const activity = activityMap.get(record.category) ?? emptyAggregate();
    addRecord(activity, record);
    activityMap.set(record.category, activity);
    const project = projectMap.get(record.project) ?? emptyAggregate();
    addRecord(project, record);
    projectMap.set(record.project, project);
    const session = sessionMap.get(record.sessionId) ?? {
      ...emptyAggregate(),
      project: record.project,
      startedAt: record.timestamp,
    };
    addRecord(session, record);
    if (record.timestamp < session.startedAt) session.startedAt = record.timestamp;
    sessionMap.set(record.sessionId, session);
  }
  if (total.cost <= 0) throw new Error("Portable input must include a positive estimated_cost_usd total");
  const dates = [...dailyMap.keys()].sort();
  const rangeStart = dates[0];
  const rangeEnd = dates.at(-1);
  const periodLabel = `${rangeStart} to ${rangeEnd}`;
  const daily = dates.map((date) => {
    const row = dailyMap.get(date);
    return {
      Date: date,
      "Cost (USD)": round(row.cost),
      "API Calls": row.calls,
      Sessions: row.sessions.size,
      "Input Tokens": row.input,
      "Output Tokens": row.output,
      "Cache Read Tokens": row.cacheRead,
      "Cache Write Tokens": row.cacheWrite,
    };
  });
  const models = [...modelMap.entries()]
    .sort((left, right) => right[1].cost - left[1].cost)
    .map(([model, row]) => ({
      Period: periodLabel,
      Model: model,
      "Cost (USD)": round(row.cost),
      "Saved (USD)": 0,
      "Share (%)": round(row.cost / total.cost * 100),
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
  const activity = [...activityMap.entries()]
    .sort((left, right) => right[1].cost - left[1].cost)
    .map(([name, row]) => ({
      Period: periodLabel,
      Activity: name,
      "Cost (USD)": round(row.cost),
      "Share (%)": round(row.cost / total.cost * 100),
      Turns: row.calls,
    }));
  const projects = [...projectMap.entries()]
    .sort((left, right) => right[1].cost - left[1].cost)
    .map(([project, row]) => ({
      Project: project,
      "Cost (USD)": round(row.cost),
      "API Calls": row.calls,
      Sessions: row.sessions.size,
    }));
  const sessions = [...sessionMap.entries()]
    .sort((left, right) => right[1].cost - left[1].cost)
    .map(([sessionId, row]) => ({
      "Session ID": sessionId,
      Project: row.project,
      "Started At": row.startedAt,
      "Cost (USD)": round(row.cost),
      "API Calls": row.calls,
      Turns: row.calls,
    }));
  const generated = input.generatedAt ? timestamp(input.generatedAt, "generatedAt") : records.at(-1).timestamp;
  return {
    schema: OUTPUT_SCHEMA,
    generated,
    codeburnVersion: "portable-1",
    competition: {
      sourceSchema: PORTABLE_SCHEMA,
      portableInput: true,
      syntheticData: trustedDemo,
      sourceLabel: trustedDemo ? "匿名合成演示数据" : "导入的脱敏 Codex 用量数据",
      timezone,
    },
    summary: [{
      Period: periodLabel,
      "Cost (USD)": round(total.cost),
      "Saved (USD)": 0,
      "API Calls": total.calls,
      Sessions: total.sessions.size,
      Projects: total.projects.size,
    }],
    periods: [{ label: periodLabel, daily, models, activity }],
    records,
    sessions,
    projects,
    portableAudit: {
      recordRows: records.length,
      calls: total.calls,
      tokens: outputTotal(total),
      estimatedCostUsd: round(total.cost),
      rangeStart,
      rangeEnd,
    },
  };
}

function writeAtomic(path, contents) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

const args = parseArgs(process.argv.slice(2));
const inputPath = resolve(args.input);
const outputPath = resolve(args.output);
if (statSync(inputPath).size > MAX_INPUT_BYTES) throw new Error(`Input exceeds ${MAX_INPUT_BYTES} bytes`);
const extension = extname(inputPath).toLowerCase();
let input;
if (extension === ".csv") {
  input = { schema: PORTABLE_SCHEMA, records: parseCsv(readFileSync(inputPath, "utf8")), synthetic: false };
} else if (extension === ".jsonl") {
  const records = readFileSync(inputPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`JSONL line ${index + 1} is invalid: ${error.message}`);
      }
    });
  input = { schema: PORTABLE_SCHEMA, records, synthetic: false };
} else if (extension === ".json") {
  input = JSON.parse(readFileSync(inputPath, "utf8"));
} else {
  throw new Error("Portable input must use .json, .jsonl, or .csv");
}
if (input.schema !== PORTABLE_SCHEMA) throw new Error(`Expected schema ${PORTABLE_SCHEMA}; received ${String(input.schema || "missing")}`);
for (const key of Object.keys(input)) {
  if (!ALLOWED_JSON_ROOT_FIELDS.has(key)) throw new Error(`Portable input contains an unknown top-level field: ${key}`);
}
if (!Array.isArray(input.records) || input.records.length < 1) throw new Error("Portable input must contain at least one record");
if (input.records.length > MAX_RECORDS) throw new Error(`Portable input exceeds ${MAX_RECORDS} records`);
const timezone = String(args.timezone || input.timezone || "Asia/Shanghai");
try {
  new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
} catch {
  throw new Error(`Invalid IANA timezone: ${timezone}`);
}
const normalizedRows = input.records.map(normalizeRecord);
const rowIds = new Map();
const recordKeys = new Set();
for (const [index, normalizedRow] of normalizedRows.entries()) {
  const { rowId, record } = normalizedRow;
  if (rowId !== null) {
    if (rowIds.has(rowId)) throw new Error(`records[${index}].rowId duplicates an earlier rowId`);
    rowIds.set(rowId, index);
  }
  const key = JSON.stringify(record);
  if (recordKeys.has(key)) throw new Error(`records[${index}] exactly duplicates an earlier normalized record; combine repeated calls explicitly`);
  recordKeys.add(key);
}
const records = normalizedRows.map((row) => row.record);
let earliestTimestamp = Number.POSITIVE_INFINITY;
let latestTimestamp = Number.NEGATIVE_INFINITY;
for (const record of records) {
  const milliseconds = Date.parse(record.timestamp);
  if (milliseconds < earliestTimestamp) earliestTimestamp = milliseconds;
  if (milliseconds > latestTimestamp) latestTimestamp = milliseconds;
}
const dateSpanDays = Math.floor((latestTimestamp - earliestTimestamp) / 86400000) + 1;
if (dateSpanDays > MAX_DATE_SPAN_DAYS) throw new Error(`Portable input spans more than ${MAX_DATE_SPAN_DAYS} days`);
const trustedDemo = args["trusted-demo"] === true;
if (trustedDemo && input.synthetic !== true) throw new Error("The bundled demo must declare synthetic: true");
const output = buildCodeBurnExport(input, records, timezone, trustedDemo);
writeAtomic(outputPath, `${JSON.stringify(output, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  schema: "codex.portable.normalize-result.v1",
  status: "complete",
  syntheticData: output.competition.syntheticData,
  rows: records.length,
  calls: output.portableAudit.calls,
  tokens: output.portableAudit.tokens,
  range: `${output.portableAudit.rangeStart}..${output.portableAudit.rangeEnd}`,
}, null, 2)}\n`);
