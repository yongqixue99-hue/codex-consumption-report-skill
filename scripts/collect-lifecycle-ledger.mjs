#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'codex.lifecycle.ledger.v1';
const EVENT_SCHEMA = 'codex.lifecycle.event.v1';
const SOURCE_CC = 'ccSwitch';
const SOURCE_CODEBURN = 'codeburnIncrement';
const UNKNOWN_KEY = '\u0000unattributed';
const HISTORICAL_UNATTRIBUTED = '历史未归属';
const SESSION_META_MAX_LINE_BYTES = 8 * 1024 * 1024;
const SESSION_META_READ_CHUNK_BYTES = 64 * 1024;
const COMPONENT_KEYS = [
  'freshInputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'totalTokens',
];
const require = createRequire(import.meta.url);
let databaseSyncConstructor;

function usage() {
  return `Usage:
  node collect-lifecycle-ledger.mjs \\
    --codeburn /absolute/path/codeburn.export.v2.json \\
    [--cc-db /absolute/path/cc-switch.db] \\
    --output /absolute/path/lifecycle-ledger.json \\
    --timezone Asia/Shanghai

The collector is read-only with respect to both sources. It combines all persisted
CC Switch Codex request rows through that database's latest created_at second with
strictly newer CodeBurn records. Without --cc-db it includes every CodeBurn record.
It never reads or emits prompts or source code.`;
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const key = arg.slice(2);
    if (!['codeburn', 'cc-db', 'output', 'timezone'].includes(key)) {
      fail(`Unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${arg}`);
    values.set(key, value);
    index += 1;
  }

  for (const key of ['codeburn', 'output', 'timezone']) {
    if (!values.has(key)) fail(`Missing required option: --${key}`);
  }

  return {
    codeburnPath: resolveUserPath(values.get('codeburn')),
    ccDbPath: values.has('cc-db') ? resolveUserPath(values.get('cc-db')) : null,
    outputPath: resolveUserPath(values.get('output')),
    timezone: values.get('timezone'),
  };
}

function resolveUserPath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return path.resolve(value);
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

function assertReadableFile(filePath, label) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    fail(`${label} is not readable at ${filePath}: ${error.message}`);
  }
  if (!stat.isFile()) fail(`${label} is not a file: ${filePath}`);
}

function assertTimezone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
  } catch {
    fail(`Invalid IANA timezone: ${timezone}`);
  }
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Unable to parse ${label} JSON at ${filePath}: ${error.message}`);
  }
}

function getDatabaseSyncConstructor() {
  if (databaseSyncConstructor !== undefined) return databaseSyncConstructor;
  try {
    const sqlite = require('node:sqlite');
    databaseSyncConstructor = typeof sqlite.DatabaseSync === 'function' ? sqlite.DatabaseSync : null;
  } catch (error) {
    if (['ERR_UNKNOWN_BUILTIN_MODULE', 'ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error?.code)) {
      databaseSyncConstructor = null;
    } else {
      fail(`Unable to load node:sqlite: ${error.message}`);
    }
  }
  return databaseSyncConstructor;
}

function runNodeSqliteJson(DatabaseSync, databasePath, sql) {
  let database;
  try {
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      allowExtension: false,
    });
    return database.prepare(sql).all();
  } catch (error) {
    fail(`node:sqlite read-only query failed: ${error.message}`);
  } finally {
    if (database) database.close();
  }
}

function runSqliteCliJson(databasePath, sql) {
  const result = spawnSync('sqlite3', ['-readonly', '-json', databasePath, sql], {
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error) fail(`Unable to run sqlite3: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`sqlite3 exited with status ${result.status}: ${result.stderr.trim()}`);
  }
  const output = result.stdout.trim();
  if (!output) return [];
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`Unable to parse sqlite3 JSON output: ${error.message}`);
  }
}

function runSqliteJson(databasePath, sql) {
  const DatabaseSync = getDatabaseSyncConstructor();
  return DatabaseSync
    ? runNodeSqliteJson(DatabaseSync, databasePath, sql)
    : runSqliteCliJson(databasePath, sql);
}

function nonNegativeInteger(value, label) {
  const number = value === null || value === undefined || value === '' ? 0 : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail(`${label} must be a non-negative safe integer; received ${String(value)}`);
  }
  return number;
}

function nonNegativeNumber(value, label) {
  const number = value === null || value === undefined || value === '' ? 0 : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    fail(`${label} must be a non-negative finite number; received ${String(value)}`);
  }
  return number;
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

function addComponents(target, source) {
  for (const key of COMPONENT_KEYS) {
    const next = target[key] + source[key];
    if (!Number.isSafeInteger(next)) fail(`Token total exceeds JavaScript's safe integer range for ${key}`);
    target[key] = next;
  }
  return target;
}

function copyComponents(components) {
  return Object.fromEntries(COMPONENT_KEYS.map((key) => [key, components[key]]));
}

function componentsFromCcRow(row) {
  const inputTokens = nonNegativeInteger(row.input_tokens, 'CC Switch input_tokens');
  const cacheReadTokens = nonNegativeInteger(row.cache_read_tokens, 'CC Switch cache_read_tokens');
  const outputTokens = nonNegativeInteger(row.output_tokens, 'CC Switch output_tokens');
  if (cacheReadTokens > inputTokens) {
    fail(`CC Switch cache_read_tokens exceeds input_tokens at created_at=${row.created_at}`);
  }
  return {
    freshInputTokens: inputTokens - cacheReadTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function componentsFromCodeburnRecord(record, index) {
  const freshInputTokens = nonNegativeInteger(record.inputTokens, `CodeBurn records[${index}].inputTokens`);
  const cacheReadTokens = nonNegativeInteger(record.cacheReadTokens, `CodeBurn records[${index}].cacheReadTokens`);
  const cacheWriteTokens = nonNegativeInteger(record.cacheWriteTokens, `CodeBurn records[${index}].cacheWriteTokens`);
  const outputTokens = nonNegativeInteger(record.outputTokens, `CodeBurn records[${index}].outputTokens`);
  return {
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    totalTokens: freshInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens,
  };
}

function cleanDimension(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeSessionId(value) {
  const text = cleanDimension(value);
  if (!text) return null;
  const uuid = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return uuid ? uuid[1].toLowerCase() : text;
}

function normalizeRepositoryIdentity(value) {
  let repository = cleanDimension(value);
  if (!repository) return null;
  repository = repository.replaceAll('\\', '/');

  let identity = null;
  const scpStyle = !repository.includes('://')
    && !/^[a-z]:\//i.test(repository)
    ? repository.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/)
    : null;

  if (scpStyle) {
    identity = `${scpStyle[1]}/${scpStyle[2]}`;
  } else {
    try {
      const url = new URL(repository.startsWith('//') ? `ssh:${repository}` : repository);
      const host = `${url.hostname}${url.port ? `:${url.port}` : ''}`;
      identity = `${host}/${url.pathname.replace(/^\/+/, '')}`;
    } catch {
      identity = repository
        .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
        .replace(/^[^@/]+@(?=[^/]+\/)/, '')
        .replace(/[?#].*$/, '');
    }
  }

  identity = identity
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/g, '')
    .toLowerCase();
  return identity || null;
}

function repositoryFingerprint(value) {
  const identity = normalizeRepositoryIdentity(value);
  return identity ? createHash('sha256').update(identity, 'utf8').digest('hex') : null;
}

function eventIdFromParts(parts) {
  return createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');
}

function eventTokenVector(components) {
  return COMPONENT_KEYS.map((key) => components[key]);
}

function ccEventId(requestId, timestampMsValue, sessionId, model, components) {
  return eventIdFromParts([
    requestId,
    new Date(timestampMsValue).toISOString(),
    sessionId,
    model,
    ...eventTokenVector(components),
  ]);
}

function codeburnEventId(timestampMsValue, sessionId, model, components) {
  return eventIdFromParts([
    new Date(timestampMsValue).toISOString(),
    sessionId,
    model,
    ...eventTokenVector(components),
  ]);
}

function buildCodeburnMetadata(records) {
  const metadata = [];
  let nonCodexRecordsSkipped = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.provider && String(record.provider).toLowerCase() !== 'codex') {
      nonCodexRecordsSkipped += 1;
      continue;
    }
    metadata.push({
      index,
      timestampMs: timestampMs(record.timestamp, `CodeBurn records[${index}].timestamp`),
      sessionId: normalizeSessionId(record.sessionId),
      model: cleanDimension(record.model),
      project: cleanDimension(record.project),
      activity: cleanDimension(record.category),
      costUsd: nonNegativeNumber(record.cost, `CodeBurn records[${index}].cost`),
      components: componentsFromCodeburnRecord(record, index),
    });
  }
  return { metadata, nonCodexRecordsSkipped };
}

function addAttributionCandidate(sessionBucket, dimension, value, weight) {
  if (!value) return;
  const candidates = sessionBucket[dimension];
  const current = candidates.get(value) ?? { tokens: 0, calls: 0 };
  current.tokens += weight;
  current.calls += 1;
  candidates.set(value, current);
}

function selectAttributionCandidate(candidates) {
  return [...candidates.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens || b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
    [0]?.[0] ?? null;
}

function buildSessionAttribution(metadata) {
  const candidatesBySession = new Map();
  for (const item of metadata) {
    if (!item.sessionId) continue;
    if (!candidatesBySession.has(item.sessionId)) {
      candidatesBySession.set(item.sessionId, { project: new Map(), activity: new Map() });
    }
    const sessionBucket = candidatesBySession.get(item.sessionId);
    addAttributionCandidate(sessionBucket, 'project', item.project, item.components.totalTokens);
    addAttributionCandidate(sessionBucket, 'activity', item.activity, item.components.totalTokens);
  }

  return new Map([...candidatesBySession.entries()].map(([sessionId, candidates]) => [
    sessionId,
    {
      project: selectAttributionCandidate(candidates.project),
      activity: selectAttributionCandidate(candidates.activity),
    },
  ]));
}

function isCodexSessionLogPath(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return /\/(?:archived_sessions|sessions)\//i.test(normalized)
    && /^rollout-.*\.jsonl$/i.test(basename);
}

function sessionIdFromRolloutPath(filePath) {
  const normalized = String(filePath).replaceAll('\\', '/');
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.jsonl$/i, '');
  return normalizeSessionId(basename);
}

function readSessionMetaProjection(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r');
    const chunks = [];
    let bytesCollected = 0;
    let completeLine = false;

    while (bytesCollected < SESSION_META_MAX_LINE_BYTES) {
      const remaining = SESSION_META_MAX_LINE_BYTES - bytesCollected;
      const buffer = Buffer.allocUnsafe(Math.min(SESSION_META_READ_CHUNK_BYTES, remaining));
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        completeLine = true;
        break;
      }

      const slice = buffer.subarray(0, bytesRead);
      const newlineIndex = slice.indexOf(0x0a);
      if (newlineIndex >= 0) {
        chunks.push(slice.subarray(0, newlineIndex));
        completeLine = true;
        break;
      }

      chunks.push(slice);
      bytesCollected += bytesRead;
    }

    if (!completeLine) return null;
    const firstLine = Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').trim();
    if (!firstLine) return null;

    const row = JSON.parse(firstLine);
    if (row?.type !== 'session_meta' || !row.payload || typeof row.payload !== 'object') return null;

    // Deliberately project only attribution fields from the first session_meta row.
    // No prompt, source-code, instruction, tool, or later rollout content is read,
    // retained, or emitted. The remote itself is immediately reduced to a hash.
    return {
      sessionId: normalizeSessionId(row.payload.id) ?? sessionIdFromRolloutPath(filePath),
      project: cleanDimension(row.payload.cwd),
      projectFingerprint: repositoryFingerprint(row.payload.git?.repository_url),
    };
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function collectSessionMetaProjects(databasePath) {
  const projectsBySession = new Map();
  const fingerprintsBySession = new Map();
  const tableRows = runSqliteJson(
    databasePath,
    "SELECT name FROM sqlite_master WHERE type='table' AND name='session_log_sync';",
  );
  const tableAvailable = tableRows.length > 0;
  const syncRows = runSqliteJson(
    databasePath,
    tableAvailable ? 'SELECT file_path FROM session_log_sync ORDER BY file_path;' : 'SELECT NULL AS file_path WHERE 0;',
  );
  const stats = {
    tableAvailable,
    indexedPaths: syncRows.length,
    codexPaths: 0,
    existingFiles: 0,
    missingFiles: 0,
    sessionMetaRowsParsed: 0,
    sessionMetaRowsSkipped: 0,
    projectMappingsDiscovered: 0,
    repositoryFingerprintsDiscovered: 0,
    duplicateMappings: 0,
    conflictingMappings: 0,
    duplicateFingerprints: 0,
    conflictingFingerprints: 0,
    projectSessionsRecovered: 0,
    ccSwitchRowsRecovered: 0,
    ccSwitchTokensRecovered: 0,
  };

  for (const row of syncRows) {
    const filePath = cleanDimension(row.file_path);
    if (!filePath || !isCodexSessionLogPath(filePath)) continue;
    stats.codexPaths += 1;

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      stats.missingFiles += 1;
      continue;
    }
    if (!stat.isFile()) {
      stats.missingFiles += 1;
      continue;
    }
    stats.existingFiles += 1;

    const metadata = readSessionMetaProjection(filePath);
    if (!metadata?.sessionId || (!metadata.project && !metadata.projectFingerprint)) {
      stats.sessionMetaRowsSkipped += 1;
      continue;
    }
    stats.sessionMetaRowsParsed += 1;

    if (metadata.project) {
      const existingProject = projectsBySession.get(metadata.sessionId);
      if (existingProject === undefined) {
        projectsBySession.set(metadata.sessionId, metadata.project);
      } else if (existingProject === metadata.project) stats.duplicateMappings += 1;
      else stats.conflictingMappings += 1;
    }

    if (metadata.projectFingerprint) {
      const existingFingerprint = fingerprintsBySession.get(metadata.sessionId);
      if (existingFingerprint === undefined) {
        fingerprintsBySession.set(metadata.sessionId, metadata.projectFingerprint);
      } else if (existingFingerprint === metadata.projectFingerprint) stats.duplicateFingerprints += 1;
      else stats.conflictingFingerprints += 1;
    }
  }

  stats.projectMappingsDiscovered = projectsBySession.size;
  stats.repositoryFingerprintsDiscovered = fingerprintsBySession.size;
  return { projectsBySession, fingerprintsBySession, stats };
}

function timestampMs(value, label) {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail(`${label} is not a valid timestamp: ${String(value)}`);
  return result;
}

function createLocalDateFormatter(timezone) {
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
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour),
    };
  };
}

function nextDate(date) {
  const cursor = new Date(`${date}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  return cursor.toISOString().slice(0, 10);
}

function createAggregate() {
  return {
    calls: 0,
    costUsd: 0,
    components: emptyComponents(),
    firstTimestampMs: null,
    lastTimestampMs: null,
    sourceCalls: { [SOURCE_CC]: 0, [SOURCE_CODEBURN]: 0 },
    sourceTokens: { [SOURCE_CC]: 0, [SOURCE_CODEBURN]: 0 },
  };
}

function addFact(aggregate, fact) {
  aggregate.calls += 1;
  aggregate.costUsd += fact.costUsd;
  addComponents(aggregate.components, fact.components);
  aggregate.firstTimestampMs = aggregate.firstTimestampMs === null
    ? fact.timestampMs
    : Math.min(aggregate.firstTimestampMs, fact.timestampMs);
  aggregate.lastTimestampMs = aggregate.lastTimestampMs === null
    ? fact.timestampMs
    : Math.max(aggregate.lastTimestampMs, fact.timestampMs);
  aggregate.sourceCalls[fact.source] += 1;
  aggregate.sourceTokens[fact.source] += fact.components.totalTokens;
}

function isoOrNull(epochMs) {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

function serializeAggregate(aggregate) {
  return {
    calls: aggregate.calls,
    costUsd: roundedCost(aggregate.costUsd),
    components: copyComponents(aggregate.components),
    firstAt: isoOrNull(aggregate.firstTimestampMs),
    lastAt: isoOrNull(aggregate.lastTimestampMs),
    sources: {
      [SOURCE_CC]: {
        calls: aggregate.sourceCalls[SOURCE_CC],
        totalTokens: aggregate.sourceTokens[SOURCE_CC],
      },
      [SOURCE_CODEBURN]: {
        calls: aggregate.sourceCalls[SOURCE_CODEBURN],
        totalTokens: aggregate.sourceTokens[SOURCE_CODEBURN],
      },
    },
  };
}

function serializeEvent(fact) {
  return {
    eventId: fact.eventId,
    occurredAt: new Date(fact.timestampMs).toISOString(),
    source: fact.source,
    sessionId: fact.sessionId,
    model: fact.model,
    project: fact.project,
    activity: fact.activity,
    projectFingerprint: fact.projectFingerprint,
    costUsd: fact.costUsd,
    components: copyComponents(fact.components),
  };
}

function eventCorePayload(event) {
  return JSON.stringify({
    occurredAt: event.occurredAt,
    source: event.source,
    sessionId: event.sessionId,
    model: event.model,
    costUsd: event.costUsd,
    components: event.components,
  });
}

function buildEventLedger(facts, combinedSummary) {
  const events = facts.map(serializeEvent);
  const firstCoreById = new Map();
  const countsById = new Map();
  for (const event of events) {
    if (!/^[0-9a-f]{64}$/.test(event.eventId)) fail(`Invalid eventId: ${String(event.eventId)}`);
    const core = eventCorePayload(event);
    const firstCore = firstCoreById.get(event.eventId);
    if (firstCore !== undefined && firstCore !== core) {
      fail(`eventId collision has a conflicting core payload: ${event.eventId}`);
    }
    if (firstCore === undefined) firstCoreById.set(event.eventId, core);
    countsById.set(event.eventId, (countsById.get(event.eventId) ?? 0) + 1);
  }

  const eventComponents = emptyComponents();
  let eventCostUsd = 0;
  for (const event of events) {
    addComponents(eventComponents, event.components);
    eventCostUsd += event.costUsd;
  }
  const reconciledCostUsd = roundedCost(eventCostUsd);
  const duplicateEventIds = [...countsById.values()].filter((count) => count > 1).length;
  const duplicateEventRows = [...countsById.values()].reduce((total, count) => total + Math.max(0, count - 1), 0);
  const callsExact = events.length === combinedSummary.calls;
  const componentsExact = COMPONENT_KEYS.every(
    (key) => eventComponents[key] === combinedSummary.components[key],
  );
  const costExact = reconciledCostUsd === combinedSummary.costUsd;
  if (!callsExact || !componentsExact || !costExact) {
    fail('Event-level rows do not reconcile exactly with sourceSummaries.combined');
  }

  return {
    events,
    eventContract: {
      schema: EVENT_SCHEMA,
      eventLevelReliable: true,
      oneEventPerCall: true,
      eventId: {
        digest: 'sha256',
        encoding: 'lowercase hexadecimal',
        canonicalization: 'SHA-256 of the UTF-8 JSON array of normalized identity fields; timestamps are UTC ISO-8601, absent dimensions are JSON null, and Token components are safe integers ordered as freshInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, totalTokens.',
        [SOURCE_CC]: 'request_id, UTC created_at, normalized sessionId, model, and all Token components; excludes device, project path, activity, repository fingerprint, and cost.',
        [SOURCE_CODEBURN]: 'UTC timestamp, normalized sessionId, model, and all Token components; excludes device, project path, activity, repository fingerprint, and cost.',
      },
      duplicateIds: {
        distinctEventIds: firstCoreById.size,
        duplicateEventIds,
        duplicateEventRows,
        conflictingCorePayloads: 0,
      },
      reconciliation: {
        exact: true,
        calls: {
          events: events.length,
          combined: combinedSummary.calls,
          exact: callsExact,
        },
        costUsd: {
          events: reconciledCostUsd,
          combined: combinedSummary.costUsd,
          precisionDecimals: 9,
          exact: costExact,
        },
        components: {
          events: copyComponents(eventComponents),
          combined: copyComponents(combinedSummary.components),
          exact: componentsExact,
        },
      },
    },
  };
}

function coverageFor(facts, predicate) {
  let attributedCalls = 0;
  let attributedTokens = 0;
  let totalTokens = 0;
  for (const fact of facts) {
    totalTokens += fact.components.totalTokens;
    if (predicate(fact)) {
      attributedCalls += 1;
      attributedTokens += fact.components.totalTokens;
    }
  }
  const totalCalls = facts.length;
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

function sourceSummary(facts, extra = {}) {
  const aggregate = createAggregate();
  for (const fact of facts) addFact(aggregate, fact);
  return { ...extra, ...serializeAggregate(aggregate) };
}

function aggregateDaily(facts, localDate) {
  const buckets = new Map();
  for (const fact of facts) {
    const { date } = localDate(fact.timestampMs);
    if (!buckets.has(date)) buckets.set(date, createAggregate());
    addFact(buckets.get(date), fact);
  }
  if (buckets.size === 0) return [];

  const dates = [...buckets.keys()].sort();
  const rows = [];
  for (let date = dates[0]; date <= dates.at(-1); date = nextDate(date)) {
    const aggregate = buckets.get(date) ?? createAggregate();
    rows.push({ date, ...serializeAggregate(aggregate) });
  }
  return rows;
}

function aggregateModels(facts) {
  const buckets = new Map();
  for (const fact of facts) {
    const key = fact.model ?? UNKNOWN_KEY;
    if (!buckets.has(key)) buckets.set(key, { aggregate: createAggregate(), sessionIds: new Set() });
    const bucket = buckets.get(key);
    addFact(bucket.aggregate, fact);
    if (fact.sessionId) bucket.sessionIds.add(fact.sessionId);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      model: key === UNKNOWN_KEY ? null : key,
      attributed: key !== UNKNOWN_KEY,
      sessionCount: bucket.sessionIds.size,
      ...serializeAggregate(bucket.aggregate),
    }))
    .sort((a, b) => b.components.totalTokens - a.components.totalTokens || String(a.model).localeCompare(String(b.model)));
}

function aggregateSessions(facts) {
  const buckets = new Map();
  for (const fact of facts) {
    const key = fact.sessionId ?? UNKNOWN_KEY;
    if (!buckets.has(key)) buckets.set(key, { aggregate: createAggregate(), models: new Set() });
    const bucket = buckets.get(key);
    addFact(bucket.aggregate, fact);
    if (fact.model) bucket.models.add(fact.model);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => ({
      sessionId: key === UNKNOWN_KEY ? null : key,
      attributed: key !== UNKNOWN_KEY,
      models: [...bucket.models].sort(),
      ...serializeAggregate(bucket.aggregate),
    }))
    .sort((a, b) => b.components.totalTokens - a.components.totalTokens || String(a.sessionId).localeCompare(String(b.sessionId)));
}

function aggregateCompactRecords(facts, localDate) {
  const buckets = new Map();
  for (const fact of facts) {
    const { date, hour } = localDate(fact.timestampMs);
    const project = fact.project ?? HISTORICAL_UNATTRIBUTED;
    const activity = fact.activity ?? HISTORICAL_UNATTRIBUTED;
    const key = JSON.stringify([
      date,
      hour,
      project,
      fact.sessionId,
      fact.model,
      activity,
      fact.source,
    ]);
    if (!buckets.has(key)) {
      buckets.set(key, {
        date,
        timestampMs: fact.timestampMs,
        hour,
        sessionId: fact.sessionId,
        model: fact.model,
        project,
        activity,
        cost: 0,
        calls: 0,
        input: 0,
        cacheRead: 0,
        output: 0,
        cacheWrite: 0,
        source: fact.source,
      });
    }
    const bucket = buckets.get(key);
    bucket.timestampMs = Math.min(bucket.timestampMs, fact.timestampMs);
    bucket.cost += fact.costUsd;
    bucket.calls += 1;
    bucket.input += fact.components.freshInputTokens;
    bucket.cacheRead += fact.components.cacheReadTokens;
    bucket.output += fact.components.outputTokens;
    bucket.cacheWrite += fact.components.cacheWriteTokens;
  }

  return [...buckets.values()]
    .sort((a, b) => a.timestampMs - b.timestampMs || a.source.localeCompare(b.source))
    .map((record) => ({
      date: record.date,
      timestamp: new Date(record.timestampMs).toISOString(),
      hour: record.hour,
      sessionId: record.sessionId,
      model: record.model,
      project: record.project,
      activity: record.activity,
      cost: roundedCost(record.cost),
      calls: record.calls,
      input: record.input,
      cacheRead: record.cacheRead,
      output: record.output,
      cacheWrite: record.cacheWrite,
      source: record.source,
    }));
}

function sumObservedCacheCreation(rows) {
  let total = 0;
  for (const row of rows) {
    total += nonNegativeInteger(row.cache_creation_tokens, 'CC Switch cache_creation_tokens');
    if (!Number.isSafeInteger(total)) fail('CC Switch cache creation total exceeds JavaScript safe integer range');
  }
  return total;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  assertTimezone(options.timezone);
  const outputCanonical = canonicalPathForComparison(options.outputPath);
  if (outputCanonical === canonicalPathForComparison(options.codeburnPath)) {
    fail('Output path must not overwrite the CodeBurn export');
  }
  if (options.ccDbPath && outputCanonical === canonicalPathForComparison(options.ccDbPath)) {
    fail('Output path must not overwrite the CC Switch database');
  }
  assertReadableFile(options.codeburnPath, 'CodeBurn export');
  if (options.ccDbPath) assertReadableFile(options.ccDbPath, 'CC Switch database');

  const codeburn = readJson(options.codeburnPath, 'CodeBurn export');
  if (codeburn.schema !== 'codeburn.export.v2') {
    fail(`Expected CodeBurn schema codeburn.export.v2; received ${String(codeburn.schema)}`);
  }
  if (!Array.isArray(codeburn.records)) fail('CodeBurn export does not contain a records array');
  const { metadata: codeburnMetadata, nonCodexRecordsSkipped } = buildCodeburnMetadata(codeburn.records);
  const sessionAttribution = buildSessionAttribution(codeburnMetadata);
  const sessionMetaRecovery = options.ccDbPath
    ? collectSessionMetaProjects(options.ccDbPath)
    : { projectsBySession: new Map(), fingerprintsBySession: new Map(), stats: null };
  const sessionMetaRecoveredSessions = new Set();

  const maxRows = options.ccDbPath
    ? runSqliteJson(
      options.ccDbPath,
      "SELECT MAX(created_at) AS max_created_at FROM proxy_request_logs WHERE app_type='codex';",
    )
    : [];
  const maxCreatedAtSeconds = maxRows[0]?.max_created_at === null || maxRows[0]?.max_created_at === undefined
    ? null
    : nonNegativeInteger(maxRows[0].max_created_at, 'CC Switch MAX(created_at)');
  const appendAfterMs = maxCreatedAtSeconds === null ? null : maxCreatedAtSeconds * 1000 + 999;

  const ccRows = maxCreatedAtSeconds === null || !options.ccDbPath
    ? []
    : runSqliteJson(
      options.ccDbPath,
      `SELECT request_id, created_at, model, session_id, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, total_cost_usd
         FROM proxy_request_logs
        WHERE app_type='codex' AND created_at <= ${maxCreatedAtSeconds}
        ORDER BY created_at, request_id;`,
    );

  const ccFacts = ccRows.map((row) => {
    const requestId = cleanDimension(row.request_id);
    if (!requestId) fail(`CC Switch row at created_at=${row.created_at} has no request_id`);
    const sessionId = normalizeSessionId(row.session_id);
    const mappedAttribution = sessionId ? sessionAttribution.get(sessionId) : null;
    const sessionMetaProject = !mappedAttribution?.project && sessionId
      ? sessionMetaRecovery.projectsBySession.get(sessionId) ?? null
      : null;
    const components = componentsFromCcRow(row);
    const timestampMsValue = nonNegativeInteger(row.created_at, 'CC Switch created_at') * 1000;
    const model = cleanDimension(row.model);
    if (sessionMetaProject && sessionMetaRecovery.stats) {
      sessionMetaRecoveredSessions.add(sessionId);
      sessionMetaRecovery.stats.ccSwitchRowsRecovered += 1;
      sessionMetaRecovery.stats.ccSwitchTokensRecovered += components.totalTokens;
      if (!Number.isSafeInteger(sessionMetaRecovery.stats.ccSwitchTokensRecovered)) {
        fail('Session metadata recovery Token total exceeds JavaScript safe integer range');
      }
    }
    return {
      eventId: ccEventId(requestId, timestampMsValue, sessionId, model, components),
      source: SOURCE_CC,
      timestampMs: timestampMsValue,
      model,
      sessionId,
      project: mappedAttribution?.project ?? sessionMetaProject ?? HISTORICAL_UNATTRIBUTED,
      activity: mappedAttribution?.activity ?? HISTORICAL_UNATTRIBUTED,
      projectFingerprint: sessionId
        ? sessionMetaRecovery.fingerprintsBySession.get(sessionId) ?? null
        : null,
      hasProjectAttribution: Boolean(mappedAttribution?.project || sessionMetaProject),
      hasActivityAttribution: Boolean(mappedAttribution?.activity),
      costUsd: nonNegativeNumber(row.total_cost_usd, 'CC Switch total_cost_usd'),
      components,
    };
  });
  if (sessionMetaRecovery.stats) {
    sessionMetaRecovery.stats.projectSessionsRecovered = sessionMetaRecoveredSessions.size;
  }

  const codeburnFacts = [];
  let recordsAtOrBeforeCutoff = 0;
  for (const item of codeburnMetadata) {
    if (appendAfterMs !== null && item.timestampMs <= appendAfterMs) {
      recordsAtOrBeforeCutoff += 1;
      continue;
    }
    const projectFingerprint = item.sessionId
      ? sessionMetaRecovery.fingerprintsBySession.get(item.sessionId) ?? null
      : null;
    codeburnFacts.push({
      eventId: codeburnEventId(item.timestampMs, item.sessionId, item.model, item.components),
      source: SOURCE_CODEBURN,
      timestampMs: item.timestampMs,
      model: item.model,
      sessionId: item.sessionId,
      project: item.project ?? HISTORICAL_UNATTRIBUTED,
      activity: item.activity ?? HISTORICAL_UNATTRIBUTED,
      projectFingerprint,
      hasProjectAttribution: Boolean(item.project),
      hasActivityAttribution: Boolean(item.activity),
      costUsd: item.costUsd,
      components: item.components,
    });
  }

  const facts = [...ccFacts, ...codeburnFacts].sort((a, b) => a.timestampMs - b.timestampMs);
  const combinedSummary = sourceSummary(facts);
  const { events, eventContract } = buildEventLedger(facts, combinedSummary);
  const localDate = createLocalDateFormatter(options.timezone);
  const daily = aggregateDaily(facts, localDate);

  const ledger = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    timezone: options.timezone,
    cutoff: {
      ccSwitchMaxCreatedAtEpochSeconds: maxCreatedAtSeconds,
      ccSwitchMaxCreatedAt: maxCreatedAtSeconds === null
        ? null
        : new Date(maxCreatedAtSeconds * 1000).toISOString(),
      codeburnAppendAfter: appendAfterMs === null ? null : new Date(appendAfterMs).toISOString(),
      rule: appendAfterMs === null
        ? 'CC Switch contains no Codex rows; include every Codex CodeBurn record.'
        : 'Include CodeBurn records whose timestamp is strictly greater than codeburnAppendAfter.',
    },
    range: {
      firstAt: combinedSummary.firstAt,
      lastAt: combinedSummary.lastAt,
      firstLocalDate: daily[0]?.date ?? null,
      lastLocalDate: daily.at(-1)?.date ?? null,
      calendarDays: daily.length,
      activeDays: daily.filter((row) => row.calls > 0).length,
    },
    sourceSummaries: {
      [SOURCE_CC]: sourceSummary(ccFacts, {
        persistedRows: ccRows.length,
        observedCacheCreationTokens: sumObservedCacheCreation(ccRows),
        sessionMetaProjectRecovery: sessionMetaRecovery.stats,
        tokenSemantics: 'totalTokens = input_tokens + output_tokens; freshInputTokens = input_tokens - cache_read_tokens',
      }),
      [SOURCE_CODEBURN]: sourceSummary(codeburnFacts, {
        exportSchema: codeburn.schema,
        exportGeneratedAt: cleanDimension(codeburn.generated),
        recordsScanned: codeburn.records.length,
        recordsSelected: codeburnFacts.length,
        recordsAtOrBeforeCutoff,
        nonCodexRecordsSkipped,
        tokenSemantics: 'totalTokens = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens',
      }),
      combined: combinedSummary,
    },
    eventContract,
    components: copyComponents(combinedSummary.components),
    daily,
    events,
    records: aggregateCompactRecords(facts, localDate),
    models: aggregateModels(facts),
    sessions: aggregateSessions(facts),
    attributionCoverage: {
      model: coverageFor(facts, (fact) => Boolean(fact.model)),
      session: coverageFor(facts, (fact) => Boolean(fact.sessionId)),
      project: coverageFor(facts, (fact) => fact.hasProjectAttribution),
      activity: coverageFor(facts, (fact) => fact.hasActivityAttribution),
    },
    attributionMethod: {
      ccSwitchProjectAndActivity: 'Map normalized session UUIDs to the highest-Token project and activity observed in the current CodeBurn export. When CodeBurn has no project for a CC Switch session, use payload.cwd from that session\'s surviving Codex session_meta row as a project-only fallback.',
      codeburnPriority: 'A CodeBurn project mapping always takes precedence over session_meta cwd.',
      sessionMetaSafety: 'Only the first JSONL row is parsed when it is session_meta. Only payload.id, payload.cwd, and a SHA-256 fingerprint derived from the normalized payload.git.repository_url are retained; the repository remote itself is never emitted. Activity is never inferred from cwd.',
      fallbackLabel: HISTORICAL_UNATTRIBUTED,
      limitation: 'The fallback label means the persisted row has no recoverable value for that dimension in the current CodeBurn export or surviving session metadata.',
    },
    recoverableDimensions: {
      model: [SOURCE_CC, SOURCE_CODEBURN],
      session: [SOURCE_CC, SOURCE_CODEBURN],
      project: [`${SOURCE_CC}:codeburn-session-map`, `${SOURCE_CC}:session-meta-cwd`, SOURCE_CODEBURN],
      projectFingerprint: [`${SOURCE_CC}:session-meta-git-fingerprint`, `${SOURCE_CODEBURN}:session-meta-git-fingerprint`],
      activity: [`${SOURCE_CC}:codeburn-session-map`, SOURCE_CODEBURN],
    },
  };

  const outputDirectory = path.dirname(options.outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporaryPath = `${options.outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, options.outputPath);
  fs.chmodSync(options.outputPath, 0o600);

  process.stdout.write(`${JSON.stringify({
    output: options.outputPath,
    schema: ledger.schema,
    cutoff: ledger.cutoff,
    range: ledger.range,
    calls: ledger.sourceSummaries.combined.calls,
    events: ledger.events.length,
    duplicateEventIds: ledger.eventContract.duplicateIds.duplicateEventIds,
    duplicateEventRows: ledger.eventContract.duplicateIds.duplicateEventRows,
    components: ledger.components,
    sourceCalls: {
      [SOURCE_CC]: ledger.sourceSummaries[SOURCE_CC].calls,
      [SOURCE_CODEBURN]: ledger.sourceSummaries[SOURCE_CODEBURN].calls,
    },
  }, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`collect-lifecycle-ledger: ${error.message}\n`);
  process.exitCode = 1;
}
