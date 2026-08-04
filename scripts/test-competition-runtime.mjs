#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const SKILL_ROOT = resolve(import.meta.dirname, "..");
const RUNNER = resolve(import.meta.dirname, "generate-competition-report.mjs");
const DEMO = resolve(SKILL_ROOT, "examples", "iflytek-demo-usage.json");
const EXPECTED = JSON.parse(readFileSync(resolve(SKILL_ROOT, "examples", "iflytek-demo-expected.json"), "utf8"));

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "competition-runtime-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(argv, environment = {}) {
  const result = spawnSync(process.execPath, [RUNNER, ...argv], {
    cwd: SKILL_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...environment },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "");
  const lines = result.stdout.trim().split(/\r?\n/u);
  assert.equal(lines.length, 1, "runner stdout must contain exactly one JSON line");
  return { ...result, envelope: JSON.parse(lines[0]) };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function csvFromRecords(records) {
  const headers = [
    "row_id", "timestamp", "project", "session", "model", "activity",
    "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "estimated_cost_usd", "calls",
  ];
  const rows = records.map((record, index) => [
    `row-${String(index + 1).padStart(3, "0")}`,
    record.timestamp,
    record.project,
    record.session,
    record.model,
    record.activity,
    record.inputTokens,
    record.outputTokens,
    record.cacheReadTokens,
    record.cacheWriteTokens,
    record.estimatedCostUsd,
    record.calls,
  ]);
  return `${[headers, ...rows].map((row) => row.join(",")).join("\n")}\n`;
}

function assertGolden(envelope) {
  assert.equal(envelope.schema, "codex.consumption.run-result.v1");
  assert.equal(envelope.status, "complete");
  assert.equal(envelope.summary.rangeStart, "2026-07-01");
  assert.equal(envelope.summary.rangeEnd, "2026-07-14");
  assert.equal(envelope.summary.tokens, 54_618_100);
  assert.deepEqual(envelope.summary.tokenComponents, {
    input: 5_748_000,
    output: 696_100,
    cacheRead: 47_820_000,
    cacheWrite: 354_000,
  });
  assert.equal(envelope.summary.calls, 435);
  assert.equal(envelope.summary.sessions, 17);
  assert.equal(envelope.summary.projects, 4);
  assert.equal(envelope.summary.estimatedCostUsd, 91.44);
  assert.deepEqual(envelope.summary.peakDay, { date: "2026-07-08", tokens: 14_563_800, calls: 110 });
  assert.ok(Math.abs(envelope.summary.cacheReadTokenShare - 0.8755339347212737) < 1e-12);
  assert.equal(envelope.dataQuality.find((fact) => fact.code === "reconciliation")?.outcome, "pass");
  const expectedProjection = {
    rangeStart: envelope.summary.rangeStart,
    rangeEnd: envelope.summary.rangeEnd,
    timezone: envelope.summary.timezone,
    tokens: envelope.summary.tokens,
    tokenComponents: envelope.summary.tokenComponents,
    estimatedCostUsd: envelope.summary.estimatedCostUsd,
    calls: envelope.summary.calls,
    sessions: envelope.summary.sessions,
    projects: envelope.summary.projects,
    cacheReadTokenShare: envelope.summary.cacheReadTokenShare,
    peakDay: envelope.summary.peakDay,
  };
  assert.equal(EXPECTED.schema, "codex.competition.expected-result.v1");
  assert.deepEqual(expectedProjection, EXPECTED.summary);
}

test("bundled demo produces the fixed metrics, safe envelope, and report-only artifacts", (t) => {
  const root = temporaryDirectory(t);
  const output = join(root, "report");
  const result = run(["--demo", "--output-dir", output, "--timezone", "Asia/Shanghai"]);
  assert.equal(result.status, 0);
  assertGolden(result.envelope);
  assert.deepEqual(result.envelope.source, { kind: "bundled-synthetic", synthetic: true });
  assert.match(result.envelope.replyMarkdown, /匿名合成数据/u);
  assert.match(result.envelope.replyMarkdown, /最集中的项目占 65\.6%，最集中的模型占 65\.6%/u);
  assert.deepEqual(readdirSync(output).sort(), [
    ".codex-consumption-competition-output.json",
    "codex-consumption-manifest.json",
    "codex-consumption-report.html",
  ]);
  const reportHtml = readFileSync(join(output, "codex-consumption-report.html"), "utf8");
  for (const noticePath of [
    "assets/vendor/echarts/licenses/LICENSE-d3",
    "assets/vendor/echarts/licenses/LICENSE-zrender",
    "assets/vendor/echarts/licenses/LICENSE-tslib",
    "assets/vendor/echarts/licenses/CopyrightNotice-tslib",
  ]) {
    assert.ok(
      reportHtml.includes(readFileSync(resolve(SKILL_ROOT, noticePath), "utf8").trimEnd()),
      `standalone HTML must embed ${noticePath}`,
    );
  }
  const staticMarkup = reportHtml.slice(0, reportHtml.indexOf("<script"));
  const publicText = result.stdout
    + readFileSync(join(output, "codex-consumption-manifest.json"), "utf8")
    + reportHtml;
  assert.doesNotMatch(publicText, /demo-session-|\/Users\/|\/home\/|[A-Za-z]:\\Users\\|file:\/\/|[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/iu);
  assert.doesNotMatch(staticMarkup, /CodeBurn|CC Switch|官方账户/u, "portable pre-runtime markup must remain source-neutral");
  assert.doesNotMatch(result.stdout, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.ok(statSync(join(output, "codex-consumption-report.html")).size > 500_000);
});

test("an uploaded JSON cannot mark itself as the bundled synthetic demo", (t) => {
  const root = temporaryDirectory(t);
  const input = join(root, "uploaded.json");
  const runnerTemporaryRoot = join(root, "runner-temporary");
  mkdirSync(runnerTemporaryRoot);
  const demo = JSON.parse(readFileSync(DEMO, "utf8"));
  assert.equal(demo.synthetic, true);
  writeJson(input, demo);
  const inputBefore = sha256(input);
  const output = join(root, "report");
  const result = run(["--input", input, "--output-dir", output], { TMPDIR: runnerTemporaryRoot });
  assert.equal(result.status, 0);
  assertGolden(result.envelope);
  assert.deepEqual(result.envelope.source, { kind: "uploaded-json", synthetic: false });
  assert.equal(result.envelope.summary.sourceMode, "portable-input");
  assert.doesNotMatch(result.envelope.replyMarkdown, /匿名合成/u);
  assert.match(result.envelope.replyMarkdown, /最集中的项目占 65\.6%，最集中的模型占 65\.6%/u);
  assert.equal(sha256(input), inputBefore, "the caller-managed upload must remain unchanged");
  assert.deepEqual(readdirSync(runnerTemporaryRoot), [], "runner-created private intermediates must be removed");
  assert.deepEqual(readdirSync(output).sort(), [
    ".codex-consumption-competition-output.json",
    "codex-consumption-manifest.json",
    "codex-consumption-report.html",
  ]);
  const manifest = JSON.parse(readFileSync(join(output, "codex-consumption-manifest.json"), "utf8"));
  assert.deepEqual(manifest.source, {
    kind: "uploaded-json",
    synthetic: false,
    inputFileLifecycle: "platform-or-caller-managed",
    inputFileDeletedByRunner: false,
    inputFileCopiedToPublishedOutput: false,
    privateIntermediatesDeletedAfterRun: true,
  });
});

test("JSON, JSONL, and CSV projections reconcile to the same golden totals", (t) => {
  const root = temporaryDirectory(t);
  const demo = JSON.parse(readFileSync(DEMO, "utf8"));
  const json = join(root, "usage.json");
  const jsonl = join(root, "usage.jsonl");
  const csv = join(root, "usage.csv");
  writeJson(json, { schema: demo.schema, timezone: demo.timezone, records: demo.records });
  writeFileSync(jsonl, `${demo.records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  writeFileSync(csv, csvFromRecords(demo.records), "utf8");
  const results = [json, jsonl, csv].map((input, index) => run([
    "--input", input,
    "--output-dir", join(root, `report-${index}`),
    "--timezone", "Asia/Shanghai",
  ]));
  for (const result of results) {
    assert.equal(result.status, 0);
    assertGolden(result.envelope);
  }
  const projections = results.map((result) => ({
    tokens: result.envelope.summary.tokens,
    components: result.envelope.summary.tokenComponents,
    calls: result.envelope.summary.calls,
    peak: result.envelope.summary.peakDay,
    facts: result.envelope.facts,
  }));
  assert.deepEqual(projections[0], projections[1]);
  assert.deepEqual(projections[0], projections[2]);
});

test("invalid uploads fail closed with one safe error and never fall back to demo", (t) => {
  const root = temporaryDirectory(t);
  const demo = JSON.parse(readFileSync(DEMO, "utf8"));
  const invalidCases = [
    ["unknown-field", { ...demo.records[0], extra: "not allowed" }],
    ["raw-path", { ...demo.records[0], project: "/private/work/project" }],
    ["raw-uuid", { ...demo.records[0], session: "123e4567-e89b-12d3-a456-426614174000" }],
    ["opaque-session", { ...demo.records[0], session: "a".repeat(64) }],
    ["zero-calls", { ...demo.records[0], calls: 0 }],
    ["no-offset", { ...demo.records[0], timestamp: "2026-07-01T09:12:00" }],
    ["secret-field", { ...demo.records[0], apiKey: "not-a-real-key-value" }],
  ];
  for (const [name, record] of invalidCases) {
    const input = join(root, `${name}.json`);
    writeJson(input, { schema: demo.schema, timezone: demo.timezone, records: [record] });
    const result = run(["--input", input, "--output-dir", join(root, `${name}-report`)]);
    assert.equal(result.status, 2);
    assert.equal(result.envelope.status, "error");
    assert.equal(result.envelope.error.code, "INVALID_INPUT");
    assert.equal(result.envelope.published, false);
    assert.ok(!readdirSync(root).includes(`${name}-report`));
  }

  const duplicateInput = join(root, "duplicate.json");
  writeJson(duplicateInput, { schema: demo.schema, records: [demo.records[0], demo.records[0]] });
  const duplicate = run(["--input", duplicateInput, "--output-dir", join(root, "duplicate-report")]);
  assert.equal(duplicate.status, 2);
  assert.equal(duplicate.envelope.error.code, "INVALID_INPUT");

  const rawInput = join(root, "raw-codeburn.json");
  writeJson(rawInput, { schema: "codeburn.export.v2", records: [] });
  const raw = run(["--input", rawInput, "--output-dir", join(root, "raw-report")]);
  assert.equal(raw.status, 2);
  assert.equal(raw.envelope.error.code, "INVALID_INPUT");
  assert.match(raw.envelope.error.message, /codex\.portable\.usage\.v1/u);
});

test("a failed replacement preserves the prior validated report", (t) => {
  const root = temporaryDirectory(t);
  const output = join(root, "report");
  const first = run(["--demo", "--output-dir", output]);
  assert.equal(first.status, 0);
  const report = join(output, "codex-consumption-report.html");
  const manifest = join(output, "codex-consumption-manifest.json");
  const before = { report: sha256(report), manifest: sha256(manifest) };
  const invalid = join(root, "invalid.json");
  writeJson(invalid, { schema: "wrong.schema", records: [] });
  const replacement = run(["--input", invalid, "--output-dir", output, "--replace-output"]);
  assert.equal(replacement.status, 2);
  assert.deepEqual({ report: sha256(report), manifest: sha256(manifest) }, before);

  const withoutReplace = run(["--demo", "--output-dir", output]);
  assert.equal(withoutReplace.status, 2);
  assert.equal(withoutReplace.envelope.error.code, "OUTPUT_EXISTS");
  assert.deepEqual({ report: sha256(report), manifest: sha256(manifest) }, before);
});

test("broad, source-tree, and unrelated non-empty output targets are rejected", (t) => {
  const root = temporaryDirectory(t);
  const unrelated = join(root, "unrelated");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep.txt"), "keep\n", "utf8");
  const unrelatedResult = run(["--demo", "--output-dir", unrelated]);
  assert.equal(unrelatedResult.status, 2);
  assert.equal(unrelatedResult.envelope.error.code, "UNSAFE_OUTPUT");
  assert.equal(readFileSync(join(unrelated, "keep.txt"), "utf8"), "keep\n");

  const sourceResult = run(["--demo", "--output-dir", join(SKILL_ROOT, "unsafe-report-output")]);
  assert.equal(sourceResult.status, 2);
  assert.equal(sourceResult.envelope.error.code, "UNSAFE_OUTPUT");
});

test("artifact names stay relative and output identity is independent of host paths", (t) => {
  const root = temporaryDirectory(t);
  const output = join(root, "nested", "report");
  const result = run(["--demo", "--output-dir", output]);
  assert.equal(result.status, 0);
  assert.deepEqual(result.envelope.artifacts, {
    html: "codex-consumption-report.html",
    manifest: "codex-consumption-manifest.json",
  });
  assert.equal(basename(output), "report");
  assert.doesNotMatch(JSON.stringify(result.envelope), /\/Users\/|\/tmp\/|file:\/\//u);
});
