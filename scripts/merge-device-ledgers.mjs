#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA = 'codex.lifecycle.ledger.v1';
const SOURCES = ['ccSwitch', 'codeburnIncrement'];
const COMPONENT_KEYS = [
  'freshInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'totalTokens',
];
const UNKNOWN_LABELS = new Set(['', '历史未归属', '历史未归类']);

function usage() {
  return `Usage:
  node merge-device-ledgers.mjs \\
    --ledger mac=/absolute/path/to/codex-lifecycle-ledger.json \\
    --ledger windows=/absolute/path/to/codex-lifecycle-ledger.json \\
    [--project-alias-map /absolute/path/to/project-aliases.json] \\
    --output /absolute/path/to/merged-lifecycle-ledger.json

Each --ledger label must be unique. Source ledgers are opened read-only and are
never modified. The merged output remains compatible with ${SCHEMA}.`;
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const ledgerSpecs = [];
  let outputPath = null;
  let projectAliasMapPath = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (arg !== '--ledger' && arg !== '--output' && arg !== '--project-alias-map') {
      fail(`Unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${arg}`);
    index += 1;

    if (arg === '--ledger') ledgerSpecs.push(parseLedgerSpec(value));
    else if (arg === '--project-alias-map') {
      if (projectAliasMapPath !== null) fail('--project-alias-map may only be provided once');
      if (!path.isAbsolute(value)) fail('--project-alias-map must be an absolute path');
      projectAliasMapPath = path.resolve(value);
    } else {
      if (outputPath !== null) fail('--output may only be provided once');
      outputPath = path.resolve(value);
    }
  }

  if (ledgerSpecs.length === 0) fail('At least one --ledger label=/absolute/path is required');
  if (!outputPath) fail('Missing required option: --output');

  const labels = new Set();
  for (const spec of ledgerSpecs) {
    if (labels.has(spec.label)) fail(`Duplicate device label: ${spec.label}`);
    labels.add(spec.label);
  }
  return { ledgerSpecs, outputPath, projectAliasMapPath };
}

function parseLedgerSpec(value) {
  const separator = value.indexOf('=');
  if (separator <= 0 || separator === value.length - 1) {
    fail(`Invalid --ledger value: ${value}; expected label=/absolute/path`);
  }
  const label = value.slice(0, separator).trim();
  const ledgerPath = value.slice(separator + 1);
  if (!label || label.length > 64 || /[\u0000-\u001f\u007f]/u.test(label)) {
    fail('Device labels must contain 1–64 printable characters');
  }
  if (!path.isAbsolute(ledgerPath)) fail(`Ledger path for ${label} must be absolute`);
  return { label, ledgerPath: path.resolve(ledgerPath) };
}

function assertReadableSource(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fail(`Ledger ${label} is not readable: ${error.message}`);
  }
  if (!stat.isFile()) fail(`Ledger ${label} is not a file`);
}

function canonicalPathForComparison(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    const parent = path.dirname(filePath);
    let canonicalParent;
    try {
      canonicalParent = fs.realpathSync(parent);
    } catch {
      canonicalParent = path.resolve(parent);
    }
    return path.join(canonicalParent, path.basename(filePath));
  }
}

function readLedger(spec) {
  assertReadableSource(spec.ledgerPath, spec.label);
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(spec.ledgerPath, 'utf8'));
  } catch (error) {
    fail(`Unable to parse ledger ${spec.label}: ${error.message}`);
  }
  if (ledger?.schema !== SCHEMA) {
    fail(`Ledger ${spec.label} has unsupported schema: ${String(ledger?.schema ?? 'missing')}`);
  }
  if (!Array.isArray(ledger.records)) fail(`Ledger ${spec.label} does not contain a records array`);
  if (ledger.eventContract?.eventLevelReliable === true && !Array.isArray(ledger.events)) {
    fail(`Ledger ${spec.label} claims reliable event data but does not contain an events array`);
  }
  assertTimezone(ledger.timezone, `Ledger ${spec.label} timezone`);
  return { ...spec, ledger };
}

function printableText(value, label, maximumLength = 4096) {
  const result = textOrNull(value);
  if (!result || result.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(result)) {
    fail(`${label} must contain 1–${maximumLength} printable characters`);
  }
  return result;
}

function readProjectAliasMap(filePath) {
  if (!filePath) return new Map();
  assertReadableSource(filePath, 'project alias map');
  let document;
  try {
    document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Unable to parse project alias map: ${error.message}`);
  }
  if (document?.schema !== 'codex.project.aliases.v1' || !Array.isArray(document.aliases)) {
    fail('Project alias map must use schema codex.project.aliases.v1 with an aliases array');
  }
  const aliases = new Map();
  document.aliases.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`Project alias aliases[${index}] must be an object`);
    }
    const device = printableText(entry.device, `Project alias aliases[${index}].device`, 64);
    const project = printableText(entry.project, `Project alias aliases[${index}].project`);
    const alias = printableText(entry.alias, `Project alias aliases[${index}].alias`, 80);
    if (/[\\/]/u.test(alias)) {
      fail(`Project alias aliases[${index}].alias must not contain / or \\`);
    }
    const key = `${device}\u0000${project}`;
    if (aliases.has(key) && aliases.get(key) !== alias) {
      fail(`Project alias map has conflicting aliases for device=${device}, project=${project}`);
    }
    aliases.set(key, alias);
  });
  return aliases;
}

function assertTimezone(timezone, label) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    fail(`${label} is not a valid IANA timezone`);
  }
}

function integer(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return number;
}

function number(value, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) fail(`${label} must be a non-negative finite number`);
  return Object.is(result, -0) ? 0 : result;
}

function textOrNull(value) {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result || null;
}

function exactTimestamp(value, label) {
  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) fail(`${label} is not a valid timestamp`);
  return { epochMs, iso: new Date(epochMs).toISOString() };
}

function projectFingerprint(value, label) {
  const normalized = textOrNull(value);
  if (normalized === null) return null;
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail(`${label} must be a 64-character lowercase SHA-256 digest; raw repository identities are not accepted`);
  }
  return normalized;
}

function stableEventId(value, label) {
  const normalized = printableText(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail(`${label} must be a 64-character lowercase SHA-256 digest`);
  }
  return normalized;
}

function normalizeRecord(record, device, index) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    fail(`Ledger ${device} records[${index}] must be an object`);
  }
  const timestamp = exactTimestamp(record.timestamp, `Ledger ${device} records[${index}].timestamp`);
  const source = textOrNull(record.source);
  if (!SOURCES.includes(source)) {
    fail(`Ledger ${device} records[${index}].source must be ccSwitch or codeburnIncrement`);
  }
  const normalized = {
    timestamp: timestamp.iso,
    timestampMs: timestamp.epochMs,
    sessionId: textOrNull(record.sessionId),
    model: textOrNull(record.model),
    project: textOrNull(record.project),
    rawProject: textOrNull(record.project),
    projectFingerprint: projectFingerprint(record.projectFingerprint, `Ledger ${device} records[${index}].projectFingerprint`),
    projectResolutionRank: 0,
    activity: textOrNull(record.activity),
    cost: number(record.cost ?? 0, `Ledger ${device} records[${index}].cost`),
    calls: integer(record.calls ?? 0, `Ledger ${device} records[${index}].calls`),
    input: integer(record.input ?? 0, `Ledger ${device} records[${index}].input`),
    cacheRead: integer(record.cacheRead ?? 0, `Ledger ${device} records[${index}].cacheRead`),
    output: integer(record.output ?? 0, `Ledger ${device} records[${index}].output`),
    cacheWrite: integer(record.cacheWrite ?? 0, `Ledger ${device} records[${index}].cacheWrite`),
    source,
    device,
    inputOrder: index,
  };
  normalized.totalTokens = safeSum([
    normalized.input,
    normalized.cacheRead,
    normalized.output,
    normalized.cacheWrite,
  ], `Ledger ${device} records[${index}] Token total`);
  return normalized;
}

function safeSum(values, label) {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) fail(`${label} exceeds JavaScript's safe integer range`);
  }
  return total;
}

function fingerprint(record) {
  return JSON.stringify([
    record.timestamp,
    record.sessionId,
    record.model,
    record.source,
    record.calls,
    record.cost,
    record.input,
    record.cacheRead,
    record.output,
    record.cacheWrite,
  ]);
}

function coarseOverlapFingerprint(record) {
  return JSON.stringify([
    record.timestamp,
    record.sessionId,
    record.model,
    record.source,
  ]);
}

function isSpecific(value) {
  const normalized = textOrNull(value);
  return normalized !== null
    && !UNKNOWN_LABELS.has(normalized)
    && !/^历史未归(?:属|类)(?:\s*·|$)/u.test(normalized);
}

function displayFragment(value, fallback = '项目') {
  const normalized = textOrNull(value)?.replace(/[\\/]+/gu, ' · ')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || fallback;
}

function projectBasename(project) {
  const normalized = textOrNull(project)?.replace(/\\/gu, '/').replace(/\/+$/gu, '');
  if (!normalized) return null;
  return displayFragment(normalized.slice(normalized.lastIndexOf('/') + 1));
}

function shortFingerprint(fingerprint) {
  const normalized = textOrNull(fingerprint) ?? '';
  const compact = normalized.replace(/[^a-z0-9]/giu, '').toLowerCase();
  return compact.length >= 6
    ? compact.slice(0, 6)
    : crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 6);
}

function resolveProjectLabels(items, aliases) {
  const fingerprintBasenames = new Map();
  const basenameFingerprints = new Map();
  const fingerprintAliases = new Map();
  for (const item of items) {
    const rawProject = textOrNull(item.rawProject);
    const explicitAlias = rawProject ? aliases.get(`${item.device}\u0000${rawProject}`) : null;
    if (explicitAlias && item.projectFingerprint) {
      if (fingerprintAliases.has(item.projectFingerprint)
          && fingerprintAliases.get(item.projectFingerprint) !== explicitAlias) {
        fail(`Project fingerprint ${item.projectFingerprint} has conflicting explicit aliases`);
      }
      fingerprintAliases.set(item.projectFingerprint, explicitAlias);
    }
    if (!isSpecific(item.rawProject) || !item.projectFingerprint) continue;
    const basename = projectBasename(item.rawProject) ?? '项目';
    if (!fingerprintBasenames.has(item.projectFingerprint)) fingerprintBasenames.set(item.projectFingerprint, new Set());
    fingerprintBasenames.get(item.projectFingerprint).add(basename);
    if (!basenameFingerprints.has(basename)) basenameFingerprints.set(basename, new Set());
    basenameFingerprints.get(basename).add(item.projectFingerprint);
  }

  const fingerprintLabels = new Map();
  for (const [fingerprint, basenames] of fingerprintBasenames) {
    const basename = [...basenames].sort((left, right) => left.localeCompare(right))[0] ?? '项目';
    const hasConflict = basenames.size > 1 || (basenameFingerprints.get(basename)?.size ?? 0) > 1;
    fingerprintLabels.set(
      fingerprint,
      hasConflict ? `${basename} · ${shortFingerprint(fingerprint)}` : basename,
    );
  }

  return items.map((item) => {
    const rawProject = textOrNull(item.rawProject);
    const explicitAlias = rawProject ? aliases.get(`${item.device}\u0000${rawProject}`) : null;
    if (explicitAlias) return { ...item, project: explicitAlias, projectResolutionRank: 3 };
    if (item.projectFingerprint && fingerprintAliases.has(item.projectFingerprint)) {
      return {
        ...item,
        project: fingerprintAliases.get(item.projectFingerprint),
        projectResolutionRank: 3,
      };
    }
    if (rawProject && item.projectFingerprint) {
      const label = fingerprintLabels.get(item.projectFingerprint)
        ?? `${projectBasename(rawProject) ?? '项目'} · ${shortFingerprint(item.projectFingerprint)}`;
      return { ...item, project: label, projectResolutionRank: 2 };
    }
    const safeDevice = displayFragment(item.device, '未知设备');
    if (rawProject && isSpecific(rawProject)) {
      return {
        ...item,
        project: `${projectBasename(rawProject) ?? '项目'} · ${safeDevice}`,
        projectResolutionRank: 1,
      };
    }
    return { ...item, project: `历史未归属 · ${safeDevice}`, projectResolutionRank: 0 };
  });
}

function deviceScopedFallback(value, device, kind) {
  return isSpecific(value) ? textOrNull(value) : `${kind} · ${device}`;
}

function attributionScore(record) {
  return (record.projectResolutionRank ?? Number(isSpecific(record.project))) * 2
    + Number(isSpecific(record.activity));
}

function choosePreferred(candidates) {
  const ordered = [...candidates].sort((left, right) =>
    attributionScore(right) - attributionScore(left)
    || Number(isSpecific(right.project)) - Number(isSpecific(left.project))
    || left.deviceOrder - right.deviceOrder
    || left.inputOrder - right.inputOrder);
  const selected = { ...ordered[0] };
  if (!isSpecific(selected.project)) {
    selected.project = ordered.find((candidate) => isSpecific(candidate.project))?.project ?? selected.project;
  }
  if (!isSpecific(selected.activity)) {
    selected.activity = ordered.find((candidate) => isSpecific(candidate.activity))?.activity ?? selected.activity;
  }
  return selected;
}

function createDateFormatter(timezone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  });
  return (epochMs) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]),
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  };
}

function serializeRecord(record, localDate) {
  const { date, hour } = localDate(record.timestampMs);
  return {
    date,
    timestamp: record.timestamp,
    hour,
    sessionId: record.sessionId,
    model: record.model,
    project: deviceScopedFallback(record.project, record.device, '历史未归属'),
    projectFingerprint: record.projectFingerprint ?? null,
    activity: isSpecific(record.activity) ? textOrNull(record.activity) : '历史未归类',
    cost: roundedCost(record.cost),
    calls: record.calls,
    input: record.input,
    cacheRead: record.cacheRead,
    output: record.output,
    cacheWrite: record.cacheWrite,
    source: record.source,
    device: record.device,
  };
}

function roundedCost(value) {
  return Number(value.toFixed(9));
}

function emptyComponents() {
  return {
    freshInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function createAggregate() {
  return {
    calls: 0,
    costUsd: 0,
    components: emptyComponents(),
    firstMs: null,
    lastMs: null,
    sourceCalls: Object.fromEntries(SOURCES.map((source) => [source, 0])),
    sourceTokens: Object.fromEntries(SOURCES.map((source) => [source, 0])),
  };
}

function addRecord(aggregate, record) {
  aggregate.calls = safeSum([aggregate.calls, record.calls], 'Merged call total');
  aggregate.costUsd += record.cost;
  const values = {
    freshInputTokens: record.input,
    cacheReadTokens: record.cacheRead,
    cacheWriteTokens: record.cacheWrite,
    outputTokens: record.output,
    totalTokens: record.input + record.cacheRead + record.cacheWrite + record.output,
  };
  for (const key of COMPONENT_KEYS) {
    aggregate.components[key] = safeSum(
      [aggregate.components[key], values[key]],
      `Merged ${key}`,
    );
  }
  aggregate.firstMs = aggregate.firstMs === null ? record.timestampMs : Math.min(aggregate.firstMs, record.timestampMs);
  aggregate.lastMs = aggregate.lastMs === null ? record.timestampMs : Math.max(aggregate.lastMs, record.timestampMs);
  aggregate.sourceCalls[record.source] = safeSum(
    [aggregate.sourceCalls[record.source], record.calls],
    `Merged ${record.source} calls`,
  );
  aggregate.sourceTokens[record.source] = safeSum(
    [aggregate.sourceTokens[record.source], values.totalTokens],
    `Merged ${record.source} Tokens`,
  );
}

function serializeAggregate(aggregate) {
  return {
    calls: aggregate.calls,
    costUsd: roundedCost(aggregate.costUsd),
    components: { ...aggregate.components },
    firstAt: aggregate.firstMs === null ? null : new Date(aggregate.firstMs).toISOString(),
    lastAt: aggregate.lastMs === null ? null : new Date(aggregate.lastMs).toISOString(),
    sources: Object.fromEntries(SOURCES.map((source) => [source, {
      calls: aggregate.sourceCalls[source],
      totalTokens: aggregate.sourceTokens[source],
    }])),
  };
}

function summarize(records, predicate = () => true) {
  const aggregate = createAggregate();
  for (const record of records) if (predicate(record)) addRecord(aggregate, record);
  return serializeAggregate(aggregate);
}

function nextDate(date) {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  return cursor.toISOString().slice(0, 10);
}

function aggregateDaily(records) {
  if (records.length === 0) return [];
  const buckets = new Map();
  for (const record of records) {
    if (!buckets.has(record.date)) buckets.set(record.date, createAggregate());
    addRecord(buckets.get(record.date), record);
  }
  const dates = [...buckets.keys()].sort();
  const rows = [];
  for (let date = dates[0]; date <= dates.at(-1); date = nextDate(date)) {
    rows.push({ date, ...serializeAggregate(buckets.get(date) ?? createAggregate()) });
  }
  return rows;
}

function aggregateModels(records) {
  const buckets = new Map();
  for (const record of records) {
    const key = record.model ?? '\u0000unattributed';
    if (!buckets.has(key)) buckets.set(key, { aggregate: createAggregate(), sessions: new Set() });
    const bucket = buckets.get(key);
    addRecord(bucket.aggregate, record);
    if (record.sessionId) bucket.sessions.add(record.sessionId);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    model: key === '\u0000unattributed' ? null : key,
    attributed: key !== '\u0000unattributed',
    sessionCount: bucket.sessions.size,
    ...serializeAggregate(bucket.aggregate),
  })).sort((left, right) =>
    right.components.totalTokens - left.components.totalTokens
    || String(left.model).localeCompare(String(right.model)));
}

function aggregateSessions(records) {
  const buckets = new Map();
  for (const record of records) {
    const key = record.sessionId ?? '\u0000unattributed';
    if (!buckets.has(key)) buckets.set(key, { aggregate: createAggregate(), models: new Set() });
    const bucket = buckets.get(key);
    addRecord(bucket.aggregate, record);
    if (record.model) bucket.models.add(record.model);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    sessionId: key === '\u0000unattributed' ? null : key,
    attributed: key !== '\u0000unattributed',
    models: [...bucket.models].sort(),
    ...serializeAggregate(bucket.aggregate),
  })).sort((left, right) =>
    right.components.totalTokens - left.components.totalTokens
    || String(left.sessionId).localeCompare(String(right.sessionId)));
}

function coverageFor(records, predicate) {
  let totalCalls = 0;
  let attributedCalls = 0;
  let totalTokens = 0;
  let attributedTokens = 0;
  for (const record of records) {
    totalCalls = safeSum([totalCalls, record.calls], 'Coverage call total');
    totalTokens = safeSum([totalTokens, record.totalTokens], 'Coverage Token total');
    if (predicate(record)) {
      attributedCalls = safeSum([attributedCalls, record.calls], 'Attributed call total');
      attributedTokens = safeSum([attributedTokens, record.totalTokens], 'Attributed Token total');
    }
  }
  return {
    attributedCalls,
    unattributedCalls: totalCalls - attributedCalls,
    totalCalls,
    callCoverageRatio: totalCalls === 0 ? null : attributedCalls / totalCalls,
    attributedTokens,
    unattributedTokens: totalTokens - attributedTokens,
    totalTokens,
    tokenCoverageRatio: totalTokens === 0 ? null : attributedTokens / totalTokens,
  };
}

function cutoffEpochSeconds(cutoff) {
  const value = cutoff?.ccSwitchMaxCreatedAtEpochSeconds;
  if (value === null || value === undefined) return null;
  return integer(value, 'ccSwitchMaxCreatedAtEpochSeconds');
}

function cutoffAppendMs(cutoff) {
  const value = cutoff?.codeburnAppendAfter;
  if (value === null || value === undefined) return null;
  return exactTimestamp(value, 'codeburnAppendAfter').epochMs;
}

function aggregateCutoff(inputs) {
  const ccValues = inputs.map(({ ledger }) => cutoffEpochSeconds(ledger.cutoff)).filter((value) => value !== null);
  const appendValues = inputs.map(({ ledger }) => cutoffAppendMs(ledger.cutoff)).filter((value) => value !== null);
  const ccMax = ccValues.length ? Math.max(...ccValues) : null;
  const appendMax = appendValues.length ? Math.max(...appendValues) : null;
  return {
    ccSwitchMaxCreatedAtEpochSeconds: ccMax,
    ccSwitchMaxCreatedAt: ccMax === null ? null : new Date(ccMax * 1000).toISOString(),
    codeburnAppendAfter: appendMax === null ? null : new Date(appendMax).toISOString(),
    rule: 'Cutoffs are applied independently by device. Aggregate fields retain the latest non-null cutoff for schema compatibility; see deviceCutoffs.',
  };
}

function summaryExtrema(inputs, summaryKey) {
  const firstValues = [];
  const lastValues = [];
  for (const input of inputs) {
    const summary = input.ledger.sourceSummaries?.[summaryKey];
    const firstValue = summary?.firstAt ?? (summaryKey === 'combined' ? input.ledger.range?.firstAt : null);
    const lastValue = summary?.lastAt ?? (summaryKey === 'combined' ? input.ledger.range?.lastAt : null);
    if (firstValue !== null && firstValue !== undefined) {
      firstValues.push(exactTimestamp(firstValue, `${input.label} ${summaryKey} firstAt`).epochMs);
    }
    if (lastValue !== null && lastValue !== undefined) {
      lastValues.push(exactTimestamp(lastValue, `${input.label} ${summaryKey} lastAt`).epochMs);
    }
  }
  return {
    firstAt: firstValues.length ? new Date(Math.min(...firstValues)).toISOString() : null,
    lastAt: lastValues.length ? new Date(Math.max(...lastValues)).toISOString() : null,
  };
}

function sourceSummary(records, source, inputs, useInputExtrema = true) {
  const summary = {
    ...summarize(records, (record) => record.source === source),
    ...(useInputExtrema ? summaryExtrema(inputs, source) : {}),
  };
  if (source === 'ccSwitch') {
    return {
      persistedRows: summary.calls,
      observedCacheCreationTokens: summary.components.cacheWriteTokens,
      tokenSemantics: 'totalTokens = freshInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens',
      ...summary,
    };
  }
  return {
    exportSchema: 'merged-device-ledgers',
    recordsSelected: summary.calls,
    tokenSemantics: 'totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens',
    ...summary,
  };
}

function sumInputLedger(ledger) {
  const components = emptyComponents();
  let calls = 0;
  let costUsd = 0;
  for (let index = 0; index < ledger.records.length; index += 1) {
    const record = ledger.records[index];
    const input = integer(record.input ?? 0, `records[${index}].input`);
    const cacheRead = integer(record.cacheRead ?? 0, `records[${index}].cacheRead`);
    const cacheWrite = integer(record.cacheWrite ?? 0, `records[${index}].cacheWrite`);
    const output = integer(record.output ?? 0, `records[${index}].output`);
    calls = safeSum([calls, integer(record.calls ?? 0, `records[${index}].calls`)], 'Device calls');
    costUsd += number(record.cost ?? 0, `records[${index}].cost`);
    const values = {
      freshInputTokens: input,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      totalTokens: input + cacheRead + cacheWrite + output,
    };
    for (const key of COMPONENT_KEYS) {
      components[key] = safeSum([components[key], values[key]], `Device ${key}`);
    }
  }
  return { calls, costUsd: roundedCost(costUsd), components };
}

function eventComponent(event, directKey, componentKey, label) {
  const direct = event[directKey];
  const canonicalDirect = event[componentKey];
  const nested = event.components?.[componentKey];
  const declared = [direct, canonicalDirect, nested].filter((value) => value !== undefined);
  if (new Set(declared.map(Number)).size > 1) {
    fail(`${label}.${directKey} conflicts with ${componentKey}`);
  }
  return integer(direct ?? canonicalDirect ?? nested ?? 0, `${label}.${directKey}`);
}

function provenanceValues(value, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  return value.map((entry, index) => printableText(entry, `${label}[${index}]`, 128));
}

function normalizeEvent(event, device, deviceOrder, index) {
  const label = `Ledger ${device} events[${index}]`;
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail(`${label} must be an object`);
  const eventId = stableEventId(event.eventId, `${label}.eventId`);
  const timestamp = exactTimestamp(event.occurredAt ?? event.timestamp, `${label}.occurredAt`);
  const source = textOrNull(event.source);
  if (!SOURCES.includes(source)) fail(`${label}.source must be ccSwitch or codeburnIncrement`);
  const calls = integer(event.calls ?? 1, `${label}.calls`);
  if (calls !== 1) fail(`${label}.calls must equal 1 for event-level input`);
  const input = eventComponent(event, 'input', 'freshInputTokens', label);
  const cacheRead = eventComponent(event, 'cacheRead', 'cacheReadTokens', label);
  const cacheWrite = eventComponent(event, 'cacheWrite', 'cacheWriteTokens', label);
  const output = eventComponent(event, 'output', 'outputTokens', label);
  const totalTokens = safeSum([input, cacheRead, cacheWrite, output], `${label} Token total`);
  if (event.components?.totalTokens !== undefined || event.totalTokens !== undefined) {
    if (event.components?.totalTokens !== undefined && event.totalTokens !== undefined
        && Number(event.components.totalTokens) !== Number(event.totalTokens)) {
      fail(`${label}.totalTokens conflicts with components.totalTokens`);
    }
    const declaredTotal = integer(event.totalTokens ?? event.components.totalTokens, `${label}.totalTokens`);
    if (declaredTotal !== totalTokens) fail(`${label}.components.totalTokens does not equal its Token components`);
  }
  const provenanceDevices = provenanceValues(event.provenance?.devices, `${label}.provenance.devices`);
  const provenanceSources = provenanceValues(event.provenance?.sources, `${label}.provenance.sources`);
  for (const provenanceSource of provenanceSources) {
    if (!SOURCES.includes(provenanceSource)) fail(`${label}.provenance.sources contains unsupported source ${provenanceSource}`);
  }
  return {
    eventId,
    timestamp: timestamp.iso,
    timestampMs: timestamp.epochMs,
    sessionId: textOrNull(event.sessionId),
    model: textOrNull(event.model),
    project: textOrNull(event.project ?? event.projectAlias),
    rawProject: textOrNull(event.project ?? event.projectAlias),
    projectFingerprint: projectFingerprint(
      event.projectFingerprint ?? event.repositoryFingerprint,
      `${label}.projectFingerprint`,
    ),
    projectResolutionRank: 0,
    activity: textOrNull(event.activity ?? event.task),
    cost: number(event.cost ?? event.costUsd ?? 0, `${label}.cost`),
    calls: 1,
    input,
    cacheRead,
    cacheWrite,
    output,
    totalTokens,
    source,
    device,
    deviceOrder,
    inputOrder: index,
    provenanceDevices: new Set([...provenanceDevices, device]),
    provenanceSources: new Set([...provenanceSources, source]),
    sourceEventIds: new Set([
      eventId,
      ...(Array.isArray(event.sourceEventIds)
        ? event.sourceEventIds.map((value, sourceIndex) => stableEventId(value, `${label}.sourceEventIds[${sourceIndex}]`))
        : []),
    ]),
  };
}

function eventCoreFingerprint(event) {
  return JSON.stringify([
    event.timestamp,
    event.source,
    event.sessionId,
    event.model,
    event.input,
    event.cacheRead,
    event.cacheWrite,
    event.output,
    event.cost,
  ]);
}

function sameEventTokenPayload(left, right) {
  return left.input === right.input
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite
    && left.output === right.output;
}

function mergeEventCandidates(candidates, crossSource = false) {
  const preferredAttribution = choosePreferred(candidates);
  const numeric = crossSource
    ? [...candidates].sort((left, right) =>
      Number(right.source === 'ccSwitch') - Number(left.source === 'ccSwitch')
      || left.deviceOrder - right.deviceOrder
      || left.inputOrder - right.inputOrder)[0]
    : preferredAttribution;
  const provenanceDevices = new Set();
  const provenanceSources = new Set();
  const sourceEventIds = new Set();
  for (const candidate of candidates) {
    for (const device of candidate.provenanceDevices) provenanceDevices.add(device);
    for (const source of candidate.provenanceSources) provenanceSources.add(source);
    for (const sourceEventId of candidate.sourceEventIds) sourceEventIds.add(sourceEventId);
  }
  return {
    ...numeric,
    device: preferredAttribution.device,
    project: preferredAttribution.project,
    rawProject: preferredAttribution.rawProject,
    projectFingerprint: preferredAttribution.projectFingerprint,
    projectResolutionRank: preferredAttribution.projectResolutionRank,
    activity: isSpecific(preferredAttribution.activity) ? preferredAttribution.activity : null,
    provenanceDevices,
    provenanceSources,
    sourceEventIds,
  };
}

function lowerBoundTimestamp(events, timestampMs) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (events[middle].timestampMs < timestampMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nearbyOpposite(events, timestampMs, maximum = 2) {
  const result = [];
  let index = lowerBoundTimestamp(events, timestampMs - 10_000);
  while (index < events.length && events[index].timestampMs <= timestampMs + 10_000) {
    result.push(events[index]);
    if (result.length >= maximum) break;
    index += 1;
  }
  return result;
}

function crossSourceDeduplicate(events) {
  const groups = new Map();
  for (const event of events) {
    const key = JSON.stringify([event.sessionId, event.model]);
    if (!groups.has(key)) groups.set(key, { ccSwitch: [], codeburnIncrement: [] });
    groups.get(key)[event.source].push(event);
  }
  const pairByEventId = new Map();
  const ambiguityKeys = new Set();
  for (const [groupKey, group] of groups) {
    group.ccSwitch.sort((left, right) => left.timestampMs - right.timestampMs || left.eventId.localeCompare(right.eventId));
    group.codeburnIncrement.sort((left, right) => left.timestampMs - right.timestampMs || left.eventId.localeCompare(right.eventId));
    for (const source of SOURCES) {
      const oppositeSource = source === 'ccSwitch' ? 'codeburnIncrement' : 'ccSwitch';
      for (const event of group[source]) {
        const nearby = nearbyOpposite(group[oppositeSource], event.timestampMs);
        if (nearby.length === 0) continue;
        const candidate = nearby[0];
        const strict = nearby.length === 1
          && Math.abs(event.timestampMs - candidate.timestampMs) <= 1_500
          && sameEventTokenPayload(event, candidate);
        if (!strict) {
          ambiguityKeys.add(`${groupKey}\u0000${event.eventId}`);
          continue;
        }
        const reciprocal = nearbyOpposite(group[source], candidate.timestampMs);
        if (reciprocal.length !== 1 || reciprocal[0].eventId !== event.eventId) {
          ambiguityKeys.add(`${groupKey}\u0000${event.eventId}`);
          continue;
        }
        pairByEventId.set(event.eventId, candidate.eventId);
      }
    }
  }
  if (ambiguityKeys.size > 0) {
    fail(`${ambiguityKeys.size} ambiguous cross-source event candidate(s) found within 10 seconds; merge stopped without writing output`);
  }

  const byId = new Map(events.map((event) => [event.eventId, event]));
  const consumed = new Set();
  const selected = [];
  let duplicatesRemoved = 0;
  for (const event of events) {
    if (consumed.has(event.eventId)) continue;
    const candidateId = pairByEventId.get(event.eventId);
    if (!candidateId) {
      consumed.add(event.eventId);
      selected.push(event);
      continue;
    }
    if (pairByEventId.get(candidateId) !== event.eventId) {
      fail('Cross-source candidate pairing was not mutually unique');
    }
    const candidate = byId.get(candidateId);
    if (!candidate) fail(`Cross-source candidate ${candidateId} is missing`);
    consumed.add(event.eventId);
    consumed.add(candidateId);
    selected.push(mergeEventCandidates([event, candidate], true));
    duplicatesRemoved += 1;
  }
  return { events: selected, duplicatesRemoved };
}

function componentTotalsForEvents(events) {
  const components = emptyComponents();
  for (const event of events) {
    components.freshInputTokens = safeSum([components.freshInputTokens, event.input], 'Event input audit');
    components.cacheReadTokens = safeSum([components.cacheReadTokens, event.cacheRead], 'Event cache-read audit');
    components.cacheWriteTokens = safeSum([components.cacheWriteTokens, event.cacheWrite], 'Event cache-write audit');
    components.outputTokens = safeSum([components.outputTokens, event.output], 'Event output audit');
    components.totalTokens = safeSum([components.totalTokens, event.totalTokens], 'Event total audit');
  }
  return components;
}

function subtractComponents(left, right, label) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => {
    const value = left[key] - right[key];
    if (!Number.isSafeInteger(value) || value < 0) fail(`${label}.${key} is not a valid non-negative audit difference`);
    return [key, value];
  }));
}

function assertComponentsEqual(left, right, label) {
  for (const key of COMPONENT_KEYS) {
    if (left[key] !== right[key]) fail(`${label}: ${key} differs (${left[key]} != ${right[key]})`);
  }
}

function serializeEvent(event) {
  const sourceEventIds = [...event.sourceEventIds].sort();
  const serialized = {
    eventId: event.eventId,
    occurredAt: event.timestamp,
    source: event.source,
    sessionId: event.sessionId,
    model: event.model,
    project: event.project,
    projectFingerprint: event.projectFingerprint ?? null,
    activity: isSpecific(event.activity) ? event.activity : '历史未归类',
    costUsd: roundedCost(event.cost),
    components: {
      freshInputTokens: event.input,
      cacheReadTokens: event.cacheRead,
      cacheWriteTokens: event.cacheWrite,
      outputTokens: event.output,
      totalTokens: event.totalTokens,
    },
    provenance: {
      devices: [...event.provenanceDevices].sort(),
      sources: [...event.provenanceSources].sort(),
    },
  };
  if (sourceEventIds.length > 1 || sourceEventIds[0] !== event.eventId) {
    serialized.sourceEventIds = sourceEventIds;
  }
  return serialized;
}

function compactEventsToRecords(events, localDate) {
  const buckets = new Map();
  for (const event of events) {
    const record = serializeRecord(event, localDate);
    record.calls = 1;
    const key = JSON.stringify([
      record.date,
      record.hour,
      record.sessionId,
      record.model,
      record.project,
      record.activity,
      record.source,
      record.device,
    ]);
    if (!buckets.has(key)) {
      buckets.set(key, record);
      continue;
    }
    const bucket = buckets.get(key);
    if (record.timestamp < bucket.timestamp) bucket.timestamp = record.timestamp;
    bucket.calls = safeSum([bucket.calls, 1], 'Compacted event calls');
    bucket.input = safeSum([bucket.input, record.input], 'Compacted event input');
    bucket.cacheRead = safeSum([bucket.cacheRead, record.cacheRead], 'Compacted event cache read');
    bucket.cacheWrite = safeSum([bucket.cacheWrite, record.cacheWrite], 'Compacted event cache write');
    bucket.output = safeSum([bucket.output, record.output], 'Compacted event output');
    bucket.cost += record.cost;
  }
  return [...buckets.values()].map((record) => ({ ...record, cost: roundedCost(record.cost) }));
}

function buildEventLedger(inputs, timezone, aliases) {
  const rawEvents = [];
  const inputAudits = [];
  for (let deviceOrder = 0; deviceOrder < inputs.length; deviceOrder += 1) {
    const input = inputs[deviceOrder];
    const events = input.ledger.events.map((event, index) =>
      normalizeEvent(event, input.label, deviceOrder, index));
    const eventComponents = componentTotalsForEvents(events);
    const compactSummary = sumInputLedger(input.ledger);
    if (compactSummary.calls !== events.length) {
      fail(`Ledger ${input.label} event audit failed: records contain ${compactSummary.calls} calls but events contain ${events.length}`);
    }
    assertComponentsEqual(compactSummary.components, eventComponents, `Ledger ${input.label} event audit failed`);
    for (const event of events) rawEvents.push(event);
    inputAudits.push({
      device: input.label,
      calls: events.length,
      components: eventComponents,
      compactRecords: input.ledger.records.length,
    });
  }

  const resolvedEvents = resolveProjectLabels(rawEvents, aliases);
  const exactGroups = new Map();
  for (const event of resolvedEvents) {
    if (!exactGroups.has(event.eventId)) exactGroups.set(event.eventId, []);
    exactGroups.get(event.eventId).push(event);
  }
  const exactSelected = [];
  let exactDuplicatesRemoved = 0;
  for (const [eventId, candidates] of exactGroups) {
    const cores = new Set(candidates.map(eventCoreFingerprint));
    if (cores.size !== 1) fail(`Conflicting core payloads found for eventId ${eventId}`);
    exactSelected.push(mergeEventCandidates(candidates));
    exactDuplicatesRemoved += candidates.length - 1;
  }
  const crossResult = crossSourceDeduplicate(exactSelected);
  const selected = crossResult.events.sort((left, right) =>
    left.timestampMs - right.timestampMs
    || left.source.localeCompare(right.source)
    || left.eventId.localeCompare(right.eventId));

  const inputComponents = componentTotalsForEvents(resolvedEvents);
  const afterExactComponents = componentTotalsForEvents(exactSelected);
  const outputComponents = componentTotalsForEvents(selected);
  const exactRemovedComponents = subtractComponents(inputComponents, afterExactComponents, 'Exact duplicate audit');
  const crossSourceRemovedComponents = subtractComponents(afterExactComponents, outputComponents, 'Cross-source audit');
  const expectedCalls = resolvedEvents.length - exactDuplicatesRemoved - crossResult.duplicatesRemoved;
  if (selected.length !== expectedCalls) fail('Event call audit failed after deduplication');

  const localDate = createDateFormatter(timezone);
  const records = compactEventsToRecords(selected, localDate);
  const recordsForAggregation = records.map((record) => ({
    ...record,
    timestampMs: Date.parse(record.timestamp),
    totalTokens: record.input + record.cacheRead + record.cacheWrite + record.output,
  }));
  const combined = summarize(recordsForAggregation);
  if (combined.calls !== selected.length) fail('Output record call audit failed');
  assertComponentsEqual(combined.components, outputComponents, 'Output record Token audit failed');
  const daily = aggregateDaily(recordsForAggregation);
  const devices = inputs.map((input) => {
    const audit = inputAudits.find((item) => item.device === input.label);
    return {
      device: input.label,
      timezone: input.ledger.timezone,
      ledgerGeneratedAt: textOrNull(input.ledger.generatedAt),
      inputRecords: input.ledger.records.length,
      inputEvents: input.ledger.events.length,
      inputCalls: audit.calls,
      inputComponents: { ...audit.components },
      retainedEventsWithProvenance: selected.filter((event) => event.provenanceDevices.has(input.label)).length,
    };
  });
  const deviceCutoffs = inputs.map((input) => ({ device: input.label, cutoff: input.ledger.cutoff ?? null }));

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    timezone,
    cutoff: aggregateCutoff(inputs),
    deviceCutoffs,
    range: {
      firstAt: combined.firstAt,
      lastAt: combined.lastAt,
      firstLocalDate: daily[0]?.date ?? null,
      lastLocalDate: daily.at(-1)?.date ?? null,
      calendarDays: daily.length,
      activeDays: daily.filter((row) => row.calls > 0).length,
    },
    sourceSummaries: {
      ccSwitch: sourceSummary(recordsForAggregation, 'ccSwitch', inputs, false),
      codeburnIncrement: sourceSummary(recordsForAggregation, 'codeburnIncrement', inputs, false),
      combined,
    },
    components: { ...combined.components },
    daily,
    records,
    events: selected.map(serializeEvent),
    eventContract: {
      eventLevelReliable: true,
      granularity: 'event',
      callsPerEvent: 1,
      corePayloadFields: [
        'occurredAt', 'source', 'sessionId', 'model',
        'freshInputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens',
        'cost',
      ],
    },
    models: aggregateModels(recordsForAggregation),
    sessions: aggregateSessions(recordsForAggregation),
    attributionCoverage: {
      model: coverageFor(recordsForAggregation, (record) => Boolean(record.model)),
      session: coverageFor(recordsForAggregation, (record) => Boolean(record.sessionId)),
      project: coverageFor(recordsForAggregation, (record) => isSpecific(record.project)),
      activity: coverageFor(recordsForAggregation, (record) => isSpecific(record.activity)),
    },
    devices,
    deduplication: {
      inputRecords: inputs.reduce((total, input) => total + input.ledger.records.length, 0),
      retainedRecords: records.length,
      inputEvents: resolvedEvents.length,
      retainedEvents: selected.length,
      duplicateRecordsRemoved: exactDuplicatesRemoved + crossResult.duplicatesRemoved,
      duplicateEventsRemoved: exactDuplicatesRemoved + crossResult.duplicatesRemoved,
      exactDuplicatesRemoved,
      crossSourceDuplicatesRemoved: crossResult.duplicatesRemoved,
      ambiguousCrossSourceCandidates: 0,
      ambiguityCount: 0,
      granularity: 'event',
      recordsAreCompactAggregates: true,
      eventLevelReliable: true,
      exactEventIdRule: 'Equal eventId values require identical occurredAt, source, session, model, Token components, and cost; provenance and the most specific attribution are merged.',
      crossSourceRule: 'CC Switch and CodeBurn events merge only for a mutually unique one-to-one candidate with equal session, model, and Token components within 1500 ms; any unmatched or non-unique cross-source candidate within 10 seconds stops the merge.',
      tokenAudit: {
        inputCalls: resolvedEvents.length,
        inputComponents,
        exactDuplicatesRemoved,
        exactRemovedComponents,
        crossSourceDuplicatesRemoved: crossResult.duplicatesRemoved,
        crossSourceRemovedComponents,
        outputCalls: selected.length,
        outputComponents,
        deviceInputs: inputAudits,
        verified: true,
      },
    },
    warnings: [],
    attributionMethod: {
      projectIdentity: 'Explicit device+project alias, then equal sanitized project fingerprint, otherwise a device-scoped basename label.',
      fallbackProject: '历史未归属 · <device>',
      fallbackActivity: '历史未归类',
      duplicateAttribution: 'Retain the most specific project and activity while preserving all event provenance.',
    },
    recoverableDimensions: {
      model: SOURCES,
      session: SOURCES,
      project: ['explicit-alias', 'project-fingerprint', 'device-ledger-attribution'],
      activity: ['device-ledger-attribution'],
      device: ['event-provenance'],
    },
  };
}

function writeLedger(outputPath, ledger) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, outputPath);
  fs.chmodSync(outputPath, 0o600);
}

function printLedgerSummary(outputPath, ledger) {
  process.stdout.write(`${JSON.stringify({
    output: outputPath,
    schema: ledger.schema,
    devices: ledger.devices.map((device) => device.device),
    inputRecords: ledger.deduplication.inputRecords,
    retainedRecords: ledger.deduplication.retainedRecords,
    duplicateRecordsRemoved: ledger.deduplication.duplicateRecordsRemoved,
    eventLevelReliable: ledger.deduplication.eventLevelReliable,
    possibleAmbiguousOverlapGroups: ledger.deduplication.possibleAmbiguousOverlapGroups ?? 0,
    calls: ledger.sourceSummaries.combined.calls,
    components: ledger.components,
    range: ledger.range,
  }, null, 2)}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputs = options.ledgerSpecs.map(readLedger);
  const aliases = readProjectAliasMap(options.projectAliasMapPath);
  const outputCanonical = canonicalPathForComparison(options.outputPath);
  for (const input of inputs) {
    if (canonicalPathForComparison(input.ledgerPath) === outputCanonical) {
      fail(`Output path must not overwrite source ledger ${input.label}`);
    }
  }
  if (options.projectAliasMapPath
      && canonicalPathForComparison(options.projectAliasMapPath) === outputCanonical) {
    fail('Output path must not overwrite the project alias map');
  }

  const inputTimezones = new Set(inputs.map((input) => input.ledger.timezone));
  if (inputTimezones.size !== 1) {
    fail(`All compact device ledgers must use the same timezone; received ${[...inputTimezones].join(', ')}`);
  }
  const timezone = inputs[0].ledger.timezone;

  const eventMode = inputs.every((input) =>
    input.ledger.eventContract?.eventLevelReliable === true && Array.isArray(input.ledger.events));
  if (eventMode) {
    const ledger = buildEventLedger(inputs, timezone, aliases);
    writeLedger(options.outputPath, ledger);
    printLedgerSummary(options.outputPath, ledger);
    return;
  }

  const localDate = createDateFormatter(timezone);
  const groups = new Map();
  const coarseOverlapGroups = new Map();
  const deviceStats = new Map();
  const compactByDevice = inputs.map((input, deviceOrder) =>
    input.ledger.records.map((record, index) => ({
      ...normalizeRecord(record, input.label, index),
      deviceOrder,
    })));
  const resolvedCompact = resolveProjectLabels(compactByDevice.flat(), aliases);
  const resolvedCompactByDevice = inputs.map((_, deviceOrder) =>
    resolvedCompact.filter((record) => record.deviceOrder === deviceOrder));

  for (let deviceOrder = 0; deviceOrder < inputs.length; deviceOrder += 1) {
    const input = inputs[deviceOrder];
    const occurrences = new Map();
    const normalized = resolvedCompactByDevice[deviceOrder];
    deviceStats.set(input.label, {
      inputRecords: normalized.length,
      inputSummary: sumInputLedger(input.ledger),
      retainedRecords: 0,
      duplicateMatches: 0,
    });

    for (const record of normalized) {
      const baseFingerprint = fingerprint(record);
      const occurrence = occurrences.get(baseFingerprint) ?? 0;
      occurrences.set(baseFingerprint, occurrence + 1);
      const occurrenceFingerprint = `${baseFingerprint}\u0000${occurrence}`;
      if (!groups.has(occurrenceFingerprint)) groups.set(occurrenceFingerprint, []);
      groups.get(occurrenceFingerprint).push(record);

      const coarseKey = coarseOverlapFingerprint(record);
      if (!coarseOverlapGroups.has(coarseKey)) {
        coarseOverlapGroups.set(coarseKey, { devices: new Set(), exactFingerprints: new Set(), records: 0 });
      }
      const coarseGroup = coarseOverlapGroups.get(coarseKey);
      coarseGroup.devices.add(record.device);
      coarseGroup.exactFingerprints.add(baseFingerprint);
      coarseGroup.records += 1;
    }
  }

  const ambiguousOverlapGroups = [...coarseOverlapGroups.values()].filter((group) =>
    group.devices.size > 1 && group.exactFingerprints.size > 1);
  const possibleAmbiguousOverlapRecords = ambiguousOverlapGroups.reduce(
    (total, group) => total + group.records,
    0,
  );

  const selected = [];
  let duplicateRecordsRemoved = 0;
  for (const candidates of groups.values()) {
    const preferred = choosePreferred(candidates);
    selected.push(preferred);
    deviceStats.get(preferred.device).retainedRecords += 1;
    duplicateRecordsRemoved += candidates.length - 1;
    for (const candidate of candidates) {
      if (candidate !== preferred && candidate.device !== preferred.device) {
        deviceStats.get(candidate.device).duplicateMatches += 1;
      }
    }
  }

  selected.sort((left, right) =>
    left.timestampMs - right.timestampMs
    || left.source.localeCompare(right.source)
    || left.deviceOrder - right.deviceOrder
    || left.inputOrder - right.inputOrder);
  const records = selected.map((record) => serializeRecord(record, localDate));
  const recordsForAggregation = records.map((record) => ({
    ...record,
    timestampMs: Date.parse(record.timestamp),
    totalTokens: record.input + record.cacheRead + record.cacheWrite + record.output,
  }));
  const combined = summarize(recordsForAggregation);
  const combinedWithSourceRange = { ...combined, ...summaryExtrema(inputs, 'combined') };
  const daily = aggregateDaily(recordsForAggregation);

  const devices = inputs.map((input) => {
    const stats = deviceStats.get(input.label);
    return {
      device: input.label,
      timezone: input.ledger.timezone,
      ledgerGeneratedAt: textOrNull(input.ledger.generatedAt),
      inputRecords: stats.inputRecords,
      inputCalls: stats.inputSummary.calls,
      inputComponents: stats.inputSummary.components,
      retainedRecords: stats.retainedRecords,
      duplicateMatches: stats.duplicateMatches,
    };
  });
  const deviceCutoffs = inputs.map((input) => ({
    device: input.label,
    cutoff: input.ledger.cutoff ?? null,
  }));

  const ledger = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    timezone,
    cutoff: aggregateCutoff(inputs),
    deviceCutoffs,
    range: {
      firstAt: combinedWithSourceRange.firstAt,
      lastAt: combinedWithSourceRange.lastAt,
      firstLocalDate: daily[0]?.date ?? null,
      lastLocalDate: daily.at(-1)?.date ?? null,
      calendarDays: daily.length,
      activeDays: daily.filter((row) => row.calls > 0).length,
    },
    sourceSummaries: {
      ccSwitch: sourceSummary(recordsForAggregation, 'ccSwitch', inputs),
      codeburnIncrement: sourceSummary(recordsForAggregation, 'codeburnIncrement', inputs),
      combined: combinedWithSourceRange,
    },
    components: { ...combined.components },
    daily,
    records,
    models: aggregateModels(recordsForAggregation),
    sessions: aggregateSessions(recordsForAggregation),
    attributionCoverage: {
      model: coverageFor(recordsForAggregation, (record) => Boolean(record.model)),
      session: coverageFor(recordsForAggregation, (record) => Boolean(record.sessionId)),
      project: coverageFor(recordsForAggregation, (record) => isSpecific(record.project)),
      activity: coverageFor(recordsForAggregation, (record) => isSpecific(record.activity)),
    },
    devices,
    deduplication: {
      inputRecords: inputs.reduce((total, input) => total + input.ledger.records.length, 0),
      retainedRecords: records.length,
      duplicateRecordsRemoved,
      fingerprintFields: [
        'timestamp',
        'sessionId',
        'model',
        'source',
        'calls',
        'cost',
        'input',
        'cacheRead',
        'output',
        'cacheWrite',
      ],
      excludedFingerprintFields: ['device', 'project', 'activity'],
      repeatedFingerprintRule: 'Match the nth exact fingerprint occurrence per device so same-device multiplicity is preserved.',
      attributionRule: 'Prefer the duplicate carrying the most specific project and activity labels.',
      granularity: 'compact-record',
      recordsAreCompactAggregates: true,
      eventLevelReliable: false,
      exactMatchInterpretation: 'An exact match is treated as the same compact aggregate for merge purposes; it is not proof that the underlying request events are identical.',
      hasPossibleAmbiguousOverlap: ambiguousOverlapGroups.length > 0,
      possibleAmbiguousOverlapGroups: ambiguousOverlapGroups.length,
      possibleAmbiguousOverlapRecords,
      limitation: 'Compact ledgers do not contain stable per-request event IDs. Non-identical records sharing timestamp, session, model, and source across devices are retained because their overlap cannot be judged safely; this can leave double counting when devices aggregate the same requests differently.',
    },
    warnings: [
      'Cross-device deduplication is exact only at compact-record granularity and is not event-level reliable.',
      ...(ambiguousOverlapGroups.length > 0
        ? [`${ambiguousOverlapGroups.length} cross-device compact overlap groups could not be judged safely and were retained.`]
        : []),
    ],
    attributionMethod: {
      mergedDeviceProjectAndActivity: 'For exact cross-device duplicates, retain the most specific available project and activity labels.',
      fallbackLabels: [...UNKNOWN_LABELS].filter(Boolean),
      limitation: 'Deleted local task metadata and activity performed only on an unavailable device cannot be reconstructed by this merge.',
    },
    recoverableDimensions: {
      model: SOURCES,
      session: SOURCES,
      project: ['device-ledger-attribution'],
      activity: ['device-ledger-attribution'],
      device: ['ledger-label'],
    },
  };

  writeLedger(options.outputPath, ledger);
  printLedgerSummary(options.outputPath, ledger);
}

try {
  main();
} catch (error) {
  process.stderr.write(`merge-device-ledgers: ${error.message}\n`);
  process.exitCode = 1;
}
