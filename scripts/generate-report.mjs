#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";

process.umask(0o077);

const OUTPUT_MARKER = ".codex-consumption-report-output";
const OUTPUT_MARKER_SCHEMA = "codex.consumption.output.v1";
const MANIFEST_SCHEMA = "codex.consumption.report.manifest.v1";
const JSON_ARTIFACT_NAMES = [
  "codex-consumption-source.json",
  "codex-lifecycle-ledger.json",
  "codex-official-usage.json",
  "codex-consumption-data.json",
];
const DIRECT_RENDER_ARTIFACT_NAMES = [
  "codex-consumption-report-preview.png",
  "codex-consumption-report-cover.png",
  "codex-consumption-report-full.png",
  "codex-consumption-report.pdf",
  "codex-consumption-report-mobile-cover.png",
  "codex-consumption-report-mobile.png",
];
const QA_RENDER_ARTIFACT_NAMES = [
  "desktop-date-range-panel.png",
  "desktop-date-last-7-days.png",
  ...["date", "tokens", "projects", "routing", "sessions", "rhythm", "contents"].map((name) => `desktop-last-7-days-${name}.png`),
  ...["date", "tokens", "projects", "routing", "sessions", "rhythm", "actions"].map((name) => `desktop-layout-${name}.png`),
  ...["tokens", "projects", "routing", "sessions", "rhythm"].map((name) => `desktop-${name}.png`),
  "mobile-date-range-panel.png",
  ...["tokens", "projects-rank", "projects-week", "routing-model", "routing-activity", "sessions", "rhythm"].map((name) => `mobile-${name}.png`),
  ...["date", "tokens", "projects", "routing", "sessions", "rhythm", "contents"].map((name) => `mobile-last-7-days-${name}.png`),
];
const VALUE_OPTIONS = new Set([
  "output-dir", "timezone", "codeburn-version", "input", "from", "to", "cc-db",
  "official-input", "project-alias-map", "chrome", "retention", "codex-bin",
]);
const BOOLEAN_OPTIONS = new Set(["local-only", "enrich-lifecycle", "render", "replace-output"]);

function parseArgs(argv) {
  const args = { "device-ledger": [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (key === "device-ledger") {
      if (!value || value.startsWith("--")) throw new Error("--device-ledger requires label=/absolute/path");
      args[key].push(value);
      index += 1;
    } else if (BOOLEAN_OPTIONS.has(key)) {
      args[key] = true;
    } else if (VALUE_OPTIONS.has(key)) {
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
      args[key] = value;
      index += 1;
    } else {
      throw new Error(`Unknown option: --${key}`);
    }
  }
  return args;
}

function runNode(script, argv) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
    env: process.env,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${script} failed with exit code ${result.status}`);
}

function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (/[\r\n"]/.test(text)) throw new Error("Windows command arguments must not contain quotes or newlines");
  return `"${text.replaceAll("%", "%%")}"`;
}

function runNpx(argv, options) {
  if (process.platform !== "win32") return spawnSync("npx", argv, options);
  const command = ["npx.cmd", ...argv.map(quoteWindowsCommandArgument)].join(" ");
  return spawnSync(process.env.ComSpec || process.env.COMSPEC || "cmd.exe", [
    "/d", "/v:off", "/s", "/c", command,
  ], options);
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function isRegularFile(file) {
  try {
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function writePrivateAtomic(file, contents) {
  const temporaryPath = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporaryPath, file);
    chmodSync(file, 0o600);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function isOwnedOutputDirectory(directory) {
  const markerPath = resolve(directory, OUTPUT_MARKER);
  if (isRegularFile(markerPath)) {
    try {
      if (JSON.parse(readFileSync(markerPath, "utf8")).schema === OUTPUT_MARKER_SCHEMA) return true;
    } catch {
      // A malformed marker is not proof of ownership.
    }
  }
  const manifestPath = resolve(directory, "codex-consumption-manifest.json");
  const reportPath = resolve(directory, "codex-consumption-report.html");
  if (!isRegularFile(manifestPath) || !isRegularFile(reportPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return manifest.schema === MANIFEST_SCHEMA
      && basename(String(manifest.report?.path || "")) === "codex-consumption-report.html"
      && /^[0-9a-f]{64}$/.test(String(manifest.report?.sha256 || ""))
      && sha256(reportPath) === manifest.report.sha256;
  } catch {
    return false;
  }
}

function prepareOutputDirectory(directory, replaceOutput) {
  if (existsSync(directory)) {
    const info = lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error(`Output directory must not be a symbolic link: ${directory}`);
    if (!info.isDirectory()) throw new Error(`Output path is not a directory: ${directory}`);
    const entries = readdirSync(directory);
    if (entries.length > 0 && !replaceOutput && !isOwnedOutputDirectory(directory)) {
      throw new Error(`Output directory is not empty and is not owned by this Skill: ${directory}. Choose an empty directory or pass --replace-output explicitly.`);
    }
  } else {
    mkdirSync(directory, { recursive: true });
  }
  chmodSync(directory, 0o700);
  const markerPath = resolve(directory, OUTPUT_MARKER);
  if (existsSync(markerPath) && !isRegularFile(markerPath)) {
    throw new Error(`Output ownership marker must be a regular file: ${markerPath}`);
  }
  writePrivateAtomic(markerPath, `${JSON.stringify({ schema: OUTPUT_MARKER_SCHEMA })}\n`);
}

function previousReportHasLifecycle(directory) {
  const manifestPath = resolve(directory, "codex-consumption-manifest.json");
  const reportPath = resolve(directory, "codex-consumption-report.html");
  if (!isRegularFile(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    return manifest.schema === MANIFEST_SCHEMA
      && manifest.lifecycle && typeof manifest.lifecycle === "object"
      && manifest.officialUsage && typeof manifest.officialUsage === "object"
      && isRegularFile(reportPath)
      && /^[0-9a-f]{64}$/.test(String(manifest.report?.sha256 || ""))
      && sha256(reportPath) === manifest.report.sha256;
  } catch {
    return false;
  }
}

function officialCollectorArgs(outputPath, codexBin) {
  const values = ["--output", outputPath];
  if (codexBin) values.push("--codex-bin", String(codexBin));
  return values;
}

function removeIfPresent(file) {
  if (!existsSync(file)) return;
  const info = lstatSync(file);
  if (info.isDirectory()) throw new Error(`Expected a generated file but found a directory: ${file}`);
  unlinkSync(file);
}

function generatedArtifactRelativePaths() {
  return [
    ...JSON_ARTIFACT_NAMES.flatMap((name) => [name, `${name}.gz`]),
    "codex-consumption-report.html",
    "codex-consumption-manifest.json",
    ...DIRECT_RENDER_ARTIFACT_NAMES,
    ...QA_RENDER_ARTIFACT_NAMES.map((name) => `qa/${name}`),
  ];
}

function validateArtifactParent(directory, relativePath) {
  if (!relativePath.startsWith("qa/")) return;
  const qaDirectory = resolve(directory, "qa");
  if (!existsSync(qaDirectory)) return;
  const info = lstatSync(qaDirectory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Generated QA path must be a real directory: ${qaDirectory}`);
  }
}

function publishStagedOutput(stagingDirectory, finalDirectory) {
  const relativePaths = generatedArtifactRelativePaths();
  const backupDirectory = resolve(
    finalDirectory,
    `.codex-consumption-backup-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  chmodSync(backupDirectory, 0o700);

  const staged = new Set();
  const backedUp = new Set();
  const mutated = new Set();

  try {
    for (const relativePath of relativePaths) {
      validateArtifactParent(stagingDirectory, relativePath);
      validateArtifactParent(finalDirectory, relativePath);
      const stagedPath = resolve(stagingDirectory, relativePath);
      const finalPath = resolve(finalDirectory, relativePath);
      if (existsSync(stagedPath)) {
        if (!isRegularFile(stagedPath)) throw new Error(`Staged artifact is not a regular file: ${stagedPath}`);
        staged.add(relativePath);
      }
      if (!existsSync(finalPath)) continue;
      if (!isRegularFile(finalPath)) throw new Error(`Existing generated artifact is not a regular file: ${finalPath}`);
      const backupPath = resolve(backupDirectory, relativePath);
      mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
      try {
        linkSync(finalPath, backupPath);
      } catch {
        copyFileSync(finalPath, backupPath);
      }
      chmodSync(backupPath, lstatSync(finalPath).mode & 0o777);
      backedUp.add(relativePath);
    }

    const manifestRelativePath = "codex-consumption-manifest.json";
    const publishOrder = [...staged].filter((name) => name !== manifestRelativePath);
    if (staged.has(manifestRelativePath)) publishOrder.push(manifestRelativePath);

    for (const relativePath of publishOrder) {
      const stagedPath = resolve(stagingDirectory, relativePath);
      const finalPath = resolve(finalDirectory, relativePath);
      mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
      mutated.add(relativePath);
      try {
        renameSync(stagedPath, finalPath);
      } catch (error) {
        if (!existsSync(finalPath)) throw error;
        unlinkSync(finalPath);
        renameSync(stagedPath, finalPath);
      }
      chmodSync(finalPath, 0o600);
    }

    for (const relativePath of relativePaths) {
      if (staged.has(relativePath) || relativePath === "codex-consumption-manifest.json") continue;
      const finalPath = resolve(finalDirectory, relativePath);
      if (existsSync(finalPath)) {
        unlinkSync(finalPath);
        mutated.add(relativePath);
      }
    }
    const finalQaDirectory = resolve(finalDirectory, "qa");
    if (existsSync(finalQaDirectory)) chmodSync(finalQaDirectory, 0o700);
  } catch (error) {
    for (const relativePath of [...mutated].reverse()) {
      const finalPath = resolve(finalDirectory, relativePath);
      const backupPath = resolve(backupDirectory, relativePath);
      if (existsSync(finalPath)) unlinkSync(finalPath);
      if (backedUp.has(relativePath) && existsSync(backupPath)) {
        mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
        renameSync(backupPath, finalPath);
      }
    }
    throw error;
  } finally {
    rmSync(backupDirectory, { recursive: true, force: true });
  }
}

function retainJson(file, retention) {
  const contentSha256 = sha256(file);
  if (retention === "full") {
    chmodSync(file, 0o600);
    return { path: basename(file), sha256: contentSha256, contentSha256, encoding: "json", retained: true };
  }
  if (retention === "report-only") {
    unlinkSync(file);
    return { path: null, sha256: null, contentSha256, encoding: null, retained: false };
  }
  const archivePath = `${file}.gz`;
  const temporaryPath = `${archivePath}.tmp-${process.pid}`;
  const compressed = gzipSync(readFileSync(file), { level: 9 });
  writeFileSync(temporaryPath, compressed, { mode: 0o600 });
  renameSync(temporaryPath, archivePath);
  chmodSync(archivePath, 0o600);
  unlinkSync(file);
  return {
    path: basename(archivePath),
    sha256: sha256(archivePath),
    contentSha256,
    encoding: "gzip",
    retained: true,
  };
}

const args = parseArgs(process.argv.slice(2));
const deviceLedgerSpecs = args["device-ledger"];
const multiDeviceMode = deviceLedgerSpecs.length > 0;
const incompatibleMultiDeviceArgs = ["input", "from", "to", "local-only", "enrich-lifecycle"]
  .filter((key) => args[key]);
if (multiDeviceMode && incompatibleMultiDeviceArgs.length) {
  throw new Error(`--device-ledger cannot be combined with ${incompatibleMultiDeviceArgs.map((key) => `--${key}`).join(", ")}`);
}
if (!multiDeviceMode && args["official-input"]
  && (args["local-only"] || args.from || args.to || (args.input && !args["enrich-lifecycle"]))) {
  throw new Error("--official-input requires lifecycle enrichment and cannot be combined with --local-only, --from, or --to");
}
if (!multiDeviceMode && args["project-alias-map"]) {
  throw new Error("--project-alias-map requires at least one --device-ledger");
}
if (!multiDeviceMode && args.input && (args.from || args.to)) {
  throw new Error("--from/--to apply only to automatic CodeBurn collection. For --input, provide an export already scoped to the desired period.");
}
const finalOutputDirectory = resolve(args["output-dir"] || resolve(process.cwd(), "codex-consumption-report"));
const preservePreviousLifecycleReport = previousReportHasLifecycle(finalOutputDirectory);
const timezone = String(args.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai");
const codeburnVersion = String(args["codeburn-version"] || "0.9.19");
const retention = String(args.retention || "full");
if (!["full", "compressed", "report-only"].includes(retention)) {
  throw new Error(`Unsupported --retention value: ${retention}. Use full, compressed, or report-only.`);
}
prepareOutputDirectory(finalOutputDirectory, Boolean(args["replace-output"]));
const outputDirectory = resolve(
  finalOutputDirectory,
  `.codex-consumption-stage-${process.pid}-${randomBytes(6).toString("hex")}`,
);
prepareOutputDirectory(outputDirectory, false);
let stagingPublished = false;
process.on("exit", () => {
  if (!stagingPublished && existsSync(outputDirectory)) {
    try {
      const info = lstatSync(outputDirectory);
      if (info.isDirectory() && !info.isSymbolicLink()) rmSync(outputDirectory, { recursive: true, force: true });
    } catch {
      // Preserve the original exit status; cleanup is best effort.
    }
  }
});

const sourcePath = resolve(outputDirectory, "codex-consumption-source.json");
const lifecyclePath = resolve(outputDirectory, "codex-lifecycle-ledger.json");
const officialPath = resolve(outputDirectory, "codex-official-usage.json");
const dataPath = resolve(outputDirectory, "codex-consumption-data.json");
const reportPath = resolve(outputDirectory, "codex-consumption-report.html");

let lifecycleEnabled = false;
let importedDevices = [];
let crossDeviceDeduplication = null;

if (multiDeviceMode) {
  if (args["official-input"]) {
    const officialInputPath = resolve(String(args["official-input"]));
    if (!existsSync(officialInputPath)) throw new Error(`Official usage input does not exist: ${officialInputPath}`);
    if (officialInputPath !== officialPath) copyFileSync(officialInputPath, officialPath);
  } else {
    runNode(
      resolve(import.meta.dirname, "collect-official-usage.mjs"),
      officialCollectorArgs(officialPath, args["codex-bin"]),
    );
  }
  chmodSync(officialPath, 0o600);

  const official = JSON.parse(readFileSync(officialPath, "utf8"));
  if (official.schema !== "codex.official.usage.v1") {
    throw new Error(`Unsupported official usage schema: ${official.schema || "missing"}`);
  }
  const sourceAnchor = {
    schema: "codeburn.export.v2",
    generated: official.generatedAt || new Date().toISOString(),
    codeburnVersion,
    summary: [],
    periods: [],
    records: [],
    sessions: [],
    projects: [],
  };
  writeFileSync(sourcePath, JSON.stringify(sourceAnchor, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  chmodSync(sourcePath, 0o600);

  const mergeArgs = [];
  for (const spec of deviceLedgerSpecs) mergeArgs.push("--ledger", spec);
  if (args["project-alias-map"]) {
    mergeArgs.push("--project-alias-map", resolve(String(args["project-alias-map"])));
  }
  mergeArgs.push("--output", lifecyclePath);
  runNode(resolve(import.meta.dirname, "merge-device-ledgers.mjs"), mergeArgs);
  chmodSync(lifecyclePath, 0o600);

  const merged = JSON.parse(readFileSync(lifecyclePath, "utf8"));
  if (merged.timezone !== timezone) {
    throw new Error(`Merged device-ledger timezone ${merged.timezone || "missing"} does not match requested report timezone ${timezone}`);
  }
  if (merged.deduplication?.eventLevelReliable !== true || !Array.isArray(merged.events)) {
    throw new Error("Multi-device report generation requires event-level ledgers from the current collector; compact-only ledgers cannot guarantee cross-device deduplication.");
  }
  const possibleAmbiguousOverlapGroups = Number(merged.deduplication?.possibleAmbiguousOverlapGroups || 0);
  if (merged.deduplication?.hasPossibleAmbiguousOverlap || possibleAmbiguousOverlapGroups > 0) {
    throw new Error(`Multi-device compact-ledger merge is ambiguous in ${possibleAmbiguousOverlapGroups} overlap group(s); refusing to generate a potentially double-counted report.`);
  }
  importedDevices = Array.isArray(merged.devices) ? merged.devices : [];
  crossDeviceDeduplication = merged.deduplication ?? null;
  lifecycleEnabled = true;
} else {
  if (args.input) {
    const inputPath = resolve(args.input);
    if (inputPath !== sourcePath) copyFileSync(inputPath, sourcePath);
  } else {
    const commandArgs = ["-y", `codeburn@${codeburnVersion}`, "--timezone", timezone, "export", "--provider", "codex", "--format", "json", "--output", sourcePath];
    commandArgs.push("--from", String(args.from || "1970-01-01"));
    if (args.to) commandArgs.push("--to", String(args.to));
    const result = runNpx(commandArgs, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 512 * 1024 * 1024,
      env: process.env,
    });
    if (result.error) throw new Error(`Unable to start CodeBurn collection: ${result.error.message}`);
    if (result.status !== 0) {
      if (result.stderr) process.stderr.write(result.stderr);
      throw new Error(`CodeBurn collection failed with exit code ${result.status}`);
    }
    const source = JSON.parse(readFileSync(sourcePath, "utf8"));
    if (!source.generated) source.generated = new Date().toISOString();
    writeFileSync(sourcePath, JSON.stringify(source, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }
  chmodSync(sourcePath, 0o600);

  const defaultCcDbPath = resolve(homedir(), ".cc-switch", "cc-switch.db");
  const ccDbPath = resolve(String(args["cc-db"] || defaultCcDbPath));
  const lifecycleRequested = !args["local-only"]
    && !args.from
    && !args.to
    && (!args.input || args["enrich-lifecycle"]);
  const lifecycleRequired = preservePreviousLifecycleReport
    || Boolean(args["enrich-lifecycle"] || args["official-input"] || args["codex-bin"]);
  if (lifecycleRequested && existsSync(ccDbPath)) {
    try {
      if (args["official-input"]) {
        const officialInputPath = resolve(String(args["official-input"]));
        if (!isRegularFile(officialInputPath)) {
          throw new Error(`Official usage input is not a regular file: ${officialInputPath}`);
        }
        copyFileSync(officialInputPath, officialPath);
        chmodSync(officialPath, 0o600);
        const official = JSON.parse(readFileSync(officialPath, "utf8"));
        if (official.schema !== "codex.official.usage.v1") {
          throw new Error(`Unsupported official usage schema: ${official.schema || "missing"}`);
        }
      } else {
        runNode(
          resolve(import.meta.dirname, "collect-official-usage.mjs"),
          officialCollectorArgs(officialPath, args["codex-bin"]),
        );
      }
      runNode(resolve(import.meta.dirname, "collect-lifecycle-ledger.mjs"), [
        "--codeburn", sourcePath,
        "--cc-db", ccDbPath,
        "--output", lifecyclePath,
        "--timezone", timezone,
      ]);
      chmodSync(officialPath, 0o600);
      chmodSync(lifecyclePath, 0o600);
      lifecycleEnabled = true;
    } catch (error) {
      if (lifecycleRequired) {
        const outcome = preservePreviousLifecycleReport
          ? "the previous complete report was preserved"
          : "no report was published";
        throw new Error(`Lifecycle refresh failed; ${outcome}. ${error.message}`);
      }
      process.stderr.write(`Lifecycle enrichment unavailable; continuing with the current local CodeBurn snapshot. ${error.message}\n`);
    }
  } else if (lifecycleRequested && lifecycleRequired) {
    throw new Error(`Lifecycle refresh failed because the CC Switch database is unavailable; no report was replaced: ${ccDbPath}`);
  }
}

const deriveArgs = [
  "--input", sourcePath,
  "--output", dataPath,
  "--timezone", timezone,
  "--codeburn-version", codeburnVersion,
];
if (lifecycleEnabled) deriveArgs.push("--lifecycle", lifecyclePath, "--official", officialPath);
runNode(resolve(import.meta.dirname, "derive-report.mjs"), deriveArgs);
runNode(resolve(import.meta.dirname, "build-report.mjs"), ["--data", dataPath, "--output", reportPath]);
const validateArgs = ["--source", sourcePath, "--data", dataPath, "--report", reportPath];
if (lifecycleEnabled) validateArgs.push("--lifecycle", lifecyclePath, "--official", officialPath);
runNode(resolve(import.meta.dirname, "validate-report.mjs"), validateArgs);

if (args.render) {
  const renderArgs = ["--report", reportPath, "--output-dir", outputDirectory];
  if (args.chrome) renderArgs.push("--chrome", String(args.chrome));
  runNode(resolve(import.meta.dirname, "render-report.cjs"), renderArgs);
}

const data = JSON.parse(readFileSync(dataPath, "utf8"));
const publicMetrics = {
  sourceMode: data.meta.sourceMode || (lifecycleEnabled ? "official-and-local-lifecycle" : "codeburn-snapshot"),
  syntheticData: data.meta.syntheticData === true,
  rangeStart: data.meta.rangeStart,
  rangeEnd: data.meta.rangeEnd,
  tokens: data.summary.tokens,
  officialTokens: data.summary.officialTokens ?? data.summary.tokens,
  estimatedCostUsd: data.summary.cost,
  calls: data.summary.calls,
  sessions: data.summary.sessions,
  logicalProjects: data.summary.logicalProjects,
  cacheReadTokenShare: data.diagnostics?.cacheReadTokenShare ?? data.summary.cacheHitRate,
  peakDay: data.diagnostics?.peakDay ?? null,
};
chmodSync(reportPath, 0o600);
if (!lifecycleEnabled) {
  removeIfPresent(lifecyclePath);
  removeIfPresent(officialPath);
}
const sourceArtifact = retainJson(sourcePath, retention);
const lifecycleArtifact = lifecycleEnabled ? retainJson(lifecyclePath, retention) : null;
const officialArtifact = lifecycleEnabled ? retainJson(officialPath, retention) : null;
const dataArtifact = retainJson(dataPath, retention);
const manifestPath = resolve(outputDirectory, "codex-consumption-manifest.json");
const manifest = {
  schema: MANIFEST_SCHEMA,
  generatedAt: new Date().toISOString(),
  snapshotAt: data.meta.generatedAt,
  range: { start: data.meta.rangeStart, end: data.meta.rangeEnd },
  timezone,
  codeburnVersion,
  retention,
  outputOwned: true,
  source: sourceArtifact,
  lifecycle: lifecycleArtifact,
  officialUsage: officialArtifact,
  importedDevices,
  crossDeviceDeduplication,
  compactDeduplication: crossDeviceDeduplication?.eventLevelReliable === false
    ? crossDeviceDeduplication
    : null,
  projectAliasMapApplied: Boolean(multiDeviceMode && args["project-alias-map"]),
  metrics: publicMetrics,
  diagnostics: data.diagnostics ?? null,
  data: dataArtifact,
  report: { path: basename(reportPath), sha256: sha256(reportPath), selfContained: true, externalRuntimeDependencies: 0 },
  rendered: Boolean(args.render),
  renderedFormats: args.render ? ["png", "pdf", "qa"] : [],
};
writePrivateAtomic(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
publishStagedOutput(outputDirectory, finalOutputDirectory);
rmSync(outputDirectory, { recursive: true, force: true });
stagingPublished = true;
const finalReportPath = resolve(finalOutputDirectory, basename(reportPath));
const finalManifestPath = resolve(finalOutputDirectory, basename(manifestPath));
console.log(JSON.stringify({
  status: "complete",
  outputDirectory: finalOutputDirectory,
  report: finalReportPath,
  manifest: finalManifestPath,
  retention,
  metrics: publicMetrics,
  diagnostics: data.diagnostics ?? null,
}, null, 2));
