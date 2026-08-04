#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

process.umask(0o077);

const RESULT_SCHEMA = "codex.consumption.run-result.v1";
const MANIFEST_SCHEMA = "codex.consumption.competition-manifest.v1";
const OUTPUT_MARKER = ".codex-consumption-competition-output.json";
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = new Set([".json", ".jsonl", ".csv"]);

class CompetitionRunError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.name = "CompetitionRunError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Usage:
  node generate-competition-report.mjs --demo --output-dir <directory> [--timezone Asia/Shanghai]
  node generate-competition-report.mjs --input <portable.json|portable.jsonl|portable.csv> --output-dir <directory> [--timezone Asia/Shanghai]

Competition mode processes only the bundled anonymous demo or an explicitly supplied,
sanitized portable file. It performs no automatic account or device discovery.`;
}

function parseArgs(argv) {
  const args = {};
  const values = new Set(["input", "output-dir", "timezone"]);
  const booleans = new Set(["demo", "replace-output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!token.startsWith("--")) throw new CompetitionRunError("INVALID_ARGUMENT", "An unexpected positional argument was supplied.");
    const key = token.slice(2);
    if (booleans.has(key)) args[key] = true;
    else if (values.has(key)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new CompetitionRunError("INVALID_ARGUMENT", `--${key} requires a value.`);
      args[key] = value;
      index += 1;
    } else {
      throw new CompetitionRunError("INVALID_ARGUMENT", `Unknown option: --${key}.`);
    }
  }
  if (Boolean(args.demo) === Boolean(args.input)) {
    throw new CompetitionRunError("INVALID_ARGUMENT", "Choose exactly one input mode: --demo or --input.");
  }
  if (!args["output-dir"]) throw new CompetitionRunError("INVALID_ARGUMENT", "--output-dir is required.");
  return args;
}

function safeChildMessage(result, fallback) {
  const combined = String(result.stderr || result.stdout || "");
  const errorLine = combined.split(/\r?\n/u).find((line) => /^Error:/u.test(line.trim()));
  const raw = errorLine ? errorLine.trim().replace(/^Error:\s*/u, "") : fallback;
  return raw
    .replace(/(?:file:\/\/)?\/?(?:Users|home|private|tmp)\/[\w@%+.,=~/-]+/giu, "[private path]")
    .replace(/[A-Za-z]:[\\/][^\s:]+/gu, "[private path]")
    .replace(/\s+at\s+.*$/gu, "")
    .slice(0, 500);
}

function runStage(stage, script, argv) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw new CompetitionRunError("RUNTIME_UNAVAILABLE", `${stage} could not start.`, 3);
  if (result.status !== 0) {
    throw new CompetitionRunError(
      stage === "normalize" ? "INVALID_INPUT" : "GENERATION_FAILED",
      safeChildMessage(result, `${stage} failed deterministic validation.`),
      stage === "normalize" ? 2 : 3,
    );
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isRegularFile(path) {
  try {
    const info = lstatSync(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function isOwnedOutput(directory) {
  const markerPath = resolve(directory, OUTPUT_MARKER);
  if (!isRegularFile(markerPath)) return false;
  try {
    return JSON.parse(readFileSync(markerPath, "utf8")).schema === MANIFEST_SCHEMA;
  } catch {
    return false;
  }
}

function isInside(candidate, parent) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function assertSafeOutput(outputDirectory, skillRoot) {
  const parsed = parse(outputDirectory);
  if (outputDirectory === parsed.root || isInside(outputDirectory, skillRoot) || outputDirectory === dirname(skillRoot)) {
    throw new CompetitionRunError("UNSAFE_OUTPUT", "The output directory must be a dedicated directory outside the Skill source tree.");
  }
  if (!existsSync(outputDirectory)) return;
  const info = lstatSync(outputDirectory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new CompetitionRunError("UNSAFE_OUTPUT", "The output target must be a real directory, not a file or symbolic link.");
  }
}

function publish(stageDirectory, outputDirectory, replaceOutput) {
  const outputExists = existsSync(outputDirectory);
  const outputEntries = outputExists ? readdirSync(outputDirectory) : [];
  if (outputEntries.length > 0 && !isOwnedOutput(outputDirectory)) {
    throw new CompetitionRunError("UNSAFE_OUTPUT", "The output directory is not empty and is not owned by this competition runner.");
  }
  if (outputEntries.length > 0 && !replaceOutput) {
    throw new CompetitionRunError("OUTPUT_EXISTS", "A prior owned report exists; use --replace-output to refresh it.");
  }
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const backup = resolve(parent, `.${basename(outputDirectory)}.backup-${process.pid}-${randomBytes(5).toString("hex")}`);
  let backedUp = false;
  try {
    if (outputExists) {
      if (outputEntries.length === 0) rmSync(outputDirectory, { recursive: true, force: true });
      else {
        renameSync(outputDirectory, backup);
        backedUp = true;
      }
    }
    renameSync(stageDirectory, outputDirectory);
    chmodSync(outputDirectory, 0o700);
    if (backedUp) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(outputDirectory) && backedUp && existsSync(backup)) renameSync(backup, outputDirectory);
    throw new CompetitionRunError("PUBLISH_FAILED", "The validated report could not be published atomically.", 3);
  }
}

function validateTimezone(value) {
  const timezone = String(value || "Asia/Shanghai");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new CompetitionRunError("INVALID_TIMEZONE", "The timezone must be a valid IANA timezone name.");
  }
  return timezone;
}

function readPortableMetadata(inputPath, extension) {
  if (extension !== ".json") return {};
  let input;
  try {
    input = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch {
    throw new CompetitionRunError("INVALID_INPUT", "The JSON input is malformed.");
  }
  if (input?.schema !== "codex.portable.usage.v1") {
    throw new CompetitionRunError("INVALID_INPUT", "Competition JSON must use schema codex.portable.usage.v1.");
  }
  return { timezone: input.timezone };
}

function compactFacts(data) {
  const facts = Array.isArray(data.diagnostics?.analysisFacts) ? data.diagnostics.analysisFacts : [];
  return facts.map((fact) => ({
    code: fact.code,
    notable: fact.notable,
    date: fact.date,
    value: fact.value,
    baseline: fact.baseline,
    evidence: fact.evidence,
  }));
}

function factByCode(data, code) {
  return (data.diagnostics?.analysisFacts ?? []).find((fact) => fact.code === code) ?? null;
}

function compareExpected(expected, actual, path = "expected") {
  if (typeof expected === "number") {
    if (typeof actual !== "number" || !Number.isFinite(actual) || Math.abs(expected - actual) > 1e-12) {
      throw new CompetitionRunError("DEMO_INTEGRITY_FAILED", `Bundled demo mismatch at ${path}.`, 3);
    }
    return;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      throw new CompetitionRunError("DEMO_INTEGRITY_FAILED", `Bundled demo mismatch at ${path}.`, 3);
    }
    expected.forEach((value, index) => compareExpected(value, actual[index], `${path}[${index}]`));
    return;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      throw new CompetitionRunError("DEMO_INTEGRITY_FAILED", `Bundled demo mismatch at ${path}.`, 3);
    }
    for (const [key, value] of Object.entries(expected)) compareExpected(value, actual[key], `${path}.${key}`);
    return;
  }
  if (expected !== actual) throw new CompetitionRunError("DEMO_INTEGRITY_FAILED", `Bundled demo mismatch at ${path}.`, 3);
}

function validateBundledDemo(skillRoot, metrics, data) {
  const expectedPath = resolve(skillRoot, "examples", "iflytek-demo-expected.json");
  if (!isRegularFile(expectedPath)) throw new CompetitionRunError("DEMO_INTEGRITY_FAILED", "Bundled demo golden result is missing.", 3);
  let expected;
  try {
    expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  } catch {
    throw new CompetitionRunError("DEMO_INTEGRITY_FAILED", "Bundled demo golden result is malformed.", 3);
  }
  if (expected.schema !== "codex.competition.expected-result.v1") {
    throw new CompetitionRunError("DEMO_INTEGRITY_FAILED", "Bundled demo golden schema is invalid.", 3);
  }
  const actualFacts = {
    peakToMedianActiveDayTokens: factByCode(data, "peak-day-token-ratio")?.value,
    topProjectTokenShare: factByCode(data, "top-project-token-share")?.value,
    topModelTokenShare: factByCode(data, "top-model-token-share")?.value,
    cacheReadTokenShare: factByCode(data, "cache-read-token-share")?.value,
  };
  const qualityOutcome = (code) => data.diagnostics?.qualityFacts?.find((fact) => fact.code === code)?.outcome;
  const actualQuality = {
    reconciliation: qualityOutcome("reconciliation"),
    calendarContinuity: qualityOutcome("calendar-continuity"),
    projectAttribution: qualityOutcome("project-token-attribution"),
    activityAttribution: qualityOutcome("activity-token-attribution"),
    sourceDisclosure: qualityOutcome("source-disclosure"),
  };
  compareExpected(expected.source, { kind: "bundled-synthetic", synthetic: true }, "expected.source");
  compareExpected(expected.summary, metrics, "expected.summary");
  compareExpected(expected.facts, actualFacts, "expected.facts");
  compareExpected(expected.quality, actualQuality, "expected.quality");
  compareExpected(expected.privacy, {
    containsRealAccountData: false,
    containsPromptOrCode: false,
    containsHostPath: false,
    containsRawSessionIdentifier: false,
  }, "expected.privacy");
}

function buildReply(sourceKind, metrics, data) {
  const peakRatio = factByCode(data, "peak-day-token-ratio");
  const projectShare = factByCode(data, "top-project-token-share");
  const modelShare = factByCode(data, "top-model-token-share");
  const cacheShare = Number(metrics.cacheReadTokenShare || 0);
  const qualityPassed = (data.diagnostics?.qualityFacts ?? []).every((fact) => fact.outcome !== "fail");
  const lines = [
    sourceKind === "bundled-synthetic"
      ? "已完成匿名合成数据演示；这些数字不代表任何真实账户。"
      : "已从显式提供的脱敏文件完成 Codex 用量分析。",
    `统计范围 ${metrics.rangeStart} 至 ${metrics.rangeEnd}：Token ${Number(metrics.tokens || 0).toLocaleString("zh-CN")}，调用 ${Number(metrics.calls || 0).toLocaleString("zh-CN")} 次，会话 ${Number(metrics.sessions || 0).toLocaleString("zh-CN")} 个，API 等价估算成本 $${Number(metrics.estimatedCostUsd || 0).toFixed(2)}。`,
    metrics.peakDay ? `Token 峰值出现在 ${metrics.peakDay.date}，当日 ${Number(metrics.peakDay.tokens || 0).toLocaleString("zh-CN")}；相当于活跃日中位数的 ${Number(peakRatio?.value || 0).toFixed(2)} 倍。` : null,
    projectShare && modelShare
      ? `Token 最集中的项目占 ${Number(projectShare.value * 100).toFixed(1)}%，最集中的模型占 ${Number(modelShare.value * 100).toFixed(1)}%；缓存读取占全部 Token 的 ${(cacheShare * 100).toFixed(1)}%。`
      : projectShare
        ? `Token 最集中的项目占 ${Number(projectShare.value * 100).toFixed(1)}%；缓存读取占全部 Token 的 ${(cacheShare * 100).toFixed(1)}%。`
        : modelShare
          ? `Token 最集中的模型占 ${Number(modelShare.value * 100).toFixed(1)}%；缓存读取占全部 Token 的 ${(cacheShare * 100).toFixed(1)}%。`
          : `缓存读取占全部 Token 的 ${(cacheShare * 100).toFixed(1)}%。`,
    `数据质量检查：${qualityPassed ? "通过" : "存在异常"}；日期、调用与 Token 组成已完成确定性对账。`,
    "交互式 HTML 已生成：codex-consumption-report.html。成本为输入文件提供的 API 等价估算，不是 Codex 订阅账单或剩余额度。",
  ].filter(Boolean);
  return lines.join("\n\n");
}

function emitError(error) {
  const known = error instanceof CompetitionRunError;
  const result = {
    schema: RESULT_SCHEMA,
    status: "error",
    error: {
      code: known ? error.code : "GENERATION_FAILED",
      message: known ? error.message : "The report could not be generated or validated.",
    },
    published: false,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = known ? error.exitCode : 3;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const skillRoot = resolve(import.meta.dirname, "..");
  const outputDirectory = resolve(args["output-dir"]);
  assertSafeOutput(outputDirectory, skillRoot);
  const inputPath = args.demo
    ? resolve(skillRoot, "examples", "iflytek-demo-usage.json")
    : resolve(String(args.input));
  if (!isRegularFile(inputPath)) throw new CompetitionRunError("INVALID_INPUT", "The input must be a readable regular file.");
  if (statSync(inputPath).size > MAX_INPUT_BYTES) {
    throw new CompetitionRunError("INVALID_INPUT", `The input exceeds the ${MAX_INPUT_BYTES}-byte limit.`);
  }
  const extension = extname(inputPath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new CompetitionRunError("INVALID_INPUT", "Competition input must use .json, .jsonl, or .csv.");
  }
  const metadata = readPortableMetadata(inputPath, extension);
  const timezone = validateTimezone(args.timezone || metadata.timezone || "Asia/Shanghai");
  const sourceKind = args.demo ? "bundled-synthetic" : `uploaded-${extension.slice(1)}`;
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-consumption-competition-"));
  const parent = dirname(outputDirectory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stageDirectory = mkdtempSync(resolve(parent, `.${basename(outputDirectory)}.stage-`));
  chmodSync(stageDirectory, 0o700);
  let published = false;

  try {
    const privateSource = resolve(temporaryDirectory, "codex-consumption-source.json");
    const privateData = resolve(temporaryDirectory, "codex-consumption-data.json");
    const normalizeArgs = ["--input", inputPath, "--output", privateSource, "--timezone", timezone];
    if (args.demo) normalizeArgs.push("--trusted-demo");
    runStage("normalize", resolve(import.meta.dirname, "normalize-portable-usage.mjs"), normalizeArgs);
    chmodSync(privateSource, 0o600);

    const reportPath = resolve(stageDirectory, "codex-consumption-report.html");
    runStage("derive", resolve(import.meta.dirname, "derive-report.mjs"), [
      "--input", privateSource,
      "--output", privateData,
      "--timezone", timezone,
      "--codeburn-version", "portable-1",
    ]);
    runStage("build", resolve(import.meta.dirname, "build-report.mjs"), ["--data", privateData, "--output", reportPath]);
    runStage("validate", resolve(import.meta.dirname, "validate-report.mjs"), [
      "--source", privateSource,
      "--data", privateData,
      "--report", reportPath,
    ]);

    const data = JSON.parse(readFileSync(privateData, "utf8"));
    const metrics = {
      sourceMode: data.meta.sourceMode,
      syntheticData: data.meta.syntheticData === true,
      rangeStart: data.meta.rangeStart,
      rangeEnd: data.meta.rangeEnd,
      timezone: data.meta.timezone,
      tokens: data.summary.tokens,
      tokenComponents: data.summary.tokenComponents,
      estimatedCostUsd: data.summary.cost,
      calls: data.summary.calls,
      sessions: data.summary.sessions,
      projects: data.summary.logicalProjects,
      cacheReadTokenShare: data.diagnostics.cacheReadTokenShare,
      peakDay: data.diagnostics.peakDay,
    };
    if (args.demo) validateBundledDemo(skillRoot, metrics, data);
    const manifest = {
      schema: MANIFEST_SCHEMA,
      generatedAt: new Date().toISOString(),
      mode: "portable-offline",
      source: {
        kind: sourceKind,
        synthetic: args.demo === true,
        inputFileLifecycle: args.demo ? "bundled-read-only" : "platform-or-caller-managed",
        inputFileDeletedByRunner: false,
        inputFileCopiedToPublishedOutput: false,
        privateIntermediatesDeletedAfterRun: true,
      },
      capabilities: {
        networkAccess: false,
        accountDiscovery: false,
        deviceDiscovery: false,
        explicitInputOnly: true,
      },
      report: {
        path: basename(reportPath),
        sha256: sha256(reportPath),
        bytes: statSync(reportPath).size,
        selfContained: true,
        externalRuntimeDependencies: 0,
      },
      metrics,
      dataQuality: data.diagnostics.qualityFacts,
      facts: compactFacts(data),
    };
    const manifestPath = resolve(stageDirectory, "codex-consumption-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    writeFileSync(resolve(stageDirectory, OUTPUT_MARKER), `${JSON.stringify({ schema: MANIFEST_SCHEMA })}\n`, { encoding: "utf8", mode: 0o600 });
    publish(stageDirectory, outputDirectory, Boolean(args["replace-output"]));
    published = true;

    const response = {
      schema: RESULT_SCHEMA,
      status: "complete",
      mode: args.demo ? "demo" : "uploaded-file",
      source: { kind: sourceKind, synthetic: args.demo === true },
      summary: metrics,
      facts: compactFacts(data),
      dataQuality: data.diagnostics.qualityFacts,
      artifacts: {
        html: "codex-consumption-report.html",
        manifest: "codex-consumption-manifest.json",
      },
      replyMarkdown: buildReply(sourceKind, metrics, data),
    };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    if (!published) rmSync(stageDirectory, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  emitError(error);
}
