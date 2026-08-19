#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function run(script, args, expectSuccess = true) {
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (expectSuccess && result.status !== 0) {
    throw new Error(`${script} failed:\n${result.stdout}\n${result.stderr}`);
  }
  if (!expectSuccess && result.status === 0) {
    throw new Error(`${script} unexpectedly succeeded`);
  }
  return result;
}

const skillDirectory = resolve(import.meta.dirname, "..");
const generator = resolve(import.meta.dirname, "generate-credits-audit.mjs");
const validator = resolve(import.meta.dirname, "validate-credits-audit.mjs");
const example = resolve(skillDirectory, "examples/codex-credits-demo.json");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-credits-audit-test-"));

try {
  const output = resolve(temporaryDirectory, "report");
  run(generator, [
    "--input", example,
    "--output-dir", output,
    "--remaining-percent", "41",
    "--reset-at", "2026-08-16T18:00:00+08:00",
    "--timezone", "Asia/Shanghai",
  ]);
  run(validator, [
    "--audit", resolve(output, "codex-credits-audit.json"),
    "--markdown", resolve(output, "codex-credits-audit.md"),
    "--svg", resolve(output, "codex-credits-audit.svg"),
    "--html", resolve(output, "codex-credits-audit.html"),
  ]);

  const audit = JSON.parse(readFileSync(resolve(output, "codex-credits-audit.json"), "utf8"));
  check(audit.summary.credits === 6400, "demo credit total changed");
  check(audit.summary.textTotalTokens === 265700000, "demo Token total changed");
  check(audit.summary.solStandardReferenceCredits === 7900, "Sol reference calculation changed");
  check(Math.abs(audit.summary.quotaInference.pointEstimateCredits - 6400 / 0.59) < 1e-8, "quota point estimate changed");
  check(audit.models.every((row) => row.reportedCredits === 0), "demo model credits should remain zero");
  check(audit.summary.credits > sum(audit.models, (row) => row.reportedCredits), "totals.credits must remain separate from model credits");

  const sensitiveInput = resolve(temporaryDirectory, "sensitive.json");
  const sensitive = JSON.parse(readFileSync(example, "utf8"));
  sensitive.authorization = "redacted-test-value";
  writeFileSync(sensitiveInput, `${JSON.stringify(sensitive)}\n`, { mode: 0o600 });
  const rejected = run(generator, [
    "--input", sensitiveInput,
    "--output-dir", resolve(temporaryDirectory, "sensitive-output"),
  ], false);
  check(/sensitive or identity fields/u.test(rejected.stderr), "sensitive-input rejection message changed");

  const invalidInput = resolve(temporaryDirectory, "invalid-total.json");
  const invalid = JSON.parse(readFileSync(example, "utf8"));
  invalid.data[0].totals.text_total_tokens += 1;
  writeFileSync(invalidInput, `${JSON.stringify(invalid)}\n`, { mode: 0o600 });
  const invalidResult = run(generator, [
    "--input", invalidInput,
    "--output-dir", resolve(temporaryDirectory, "invalid-output"),
  ], false);
  check(/Token identity failed/u.test(invalidResult.stderr), "Token-identity rejection message changed");

  process.stdout.write(`${JSON.stringify({ status: "passed", tests: 3 })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}
