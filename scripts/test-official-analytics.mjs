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
const generator = resolve(import.meta.dirname, "generate-official-analytics.mjs");
const validator = resolve(import.meta.dirname, "validate-official-analytics.mjs");
const usageExample = resolve(skillDirectory, "examples/codex-credits-demo.json");
const skillsExample = resolve(skillDirectory, "examples/codex-skills-demo.json");
const pluginsExample = resolve(skillDirectory, "examples/codex-plugins-demo.json");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-official-analytics-test-"));

try {
  const output = resolve(temporaryDirectory, "complete-report");
  run(generator, [
    "--usage-input", usageExample,
    "--skills-input", skillsExample,
    "--plugins-input", pluginsExample,
    "--output-dir", output,
    "--timezone", "Asia/Shanghai",
  ]);
  run(validator, [
    "--audit", resolve(output, "codex-official-analytics.json"),
    "--markdown", resolve(output, "codex-official-analytics.md"),
    "--svg", resolve(output, "codex-official-analytics.svg"),
    "--html", resolve(output, "codex-official-analytics.html"),
  ]);

  const audit = JSON.parse(readFileSync(resolve(output, "codex-official-analytics.json"), "utf8"));
  check(audit.summary.turns === 57, "demo turn total changed");
  check(audit.summary.threadsDailySum === 35, "demo daily thread sum changed");
  check(audit.summary.skillInvocations === 28, "demo Skill total changed");
  check(audit.summary.pluginCalls === 6, "demo Plugin total changed");
  check(audit.skills.find((row) => row.displayName === "Agent Reach")?.invocations === 15, "Agent Reach aggregate changed");
  check(audit.plugins.find((row) => row.displayName === "GitHub")?.invocations === 4, "GitHub Plugin aggregate changed");
  check(audit.models.find((row) => row.model === "gpt-5.6-sol")?.turns === 29, "Sol turn aggregate changed");
  check(audit.clients.find((row) => row.clientId === "CODEX_DESKTOP_APP")?.turns === 57, "Desktop client aggregate changed");

  const usageOnlyOutput = resolve(temporaryDirectory, "usage-only-report");
  run(generator, [
    "--usage-input", usageExample,
    "--output-dir", usageOnlyOutput,
    "--timezone", "Asia/Shanghai",
  ]);
  const usageOnly = JSON.parse(readFileSync(resolve(usageOnlyOutput, "codex-official-analytics.json"), "utf8"));
  check(usageOnly.summary.skillInvocations === null && usageOnly.skills.length === 0, "usage-only Skill state changed");
  check(usageOnly.summary.pluginCalls === null && usageOnly.plugins.length === 0, "usage-only Plugin state changed");

  const sensitiveInput = resolve(temporaryDirectory, "sensitive-skills.json");
  const sensitive = JSON.parse(readFileSync(skillsExample, "utf8"));
  sensitive.email = "person@example.invalid";
  writeFileSync(sensitiveInput, `${JSON.stringify(sensitive)}\n`, { mode: 0o600 });
  const sensitiveResult = run(generator, [
    "--usage-input", usageExample,
    "--skills-input", sensitiveInput,
    "--output-dir", resolve(temporaryDirectory, "sensitive-output"),
  ], false);
  check(/sensitive or identity fields/u.test(sensitiveResult.stderr), "sensitive-input rejection message changed");

  const mismatchInput = resolve(temporaryDirectory, "mismatch-skills.json");
  const mismatch = JSON.parse(readFileSync(skillsExample, "utf8"));
  mismatch.group_by = "week";
  writeFileSync(mismatchInput, `${JSON.stringify(mismatch)}\n`, { mode: 0o600 });
  const mismatchResult = run(generator, [
    "--usage-input", usageExample,
    "--skills-input", mismatchInput,
    "--output-dir", resolve(temporaryDirectory, "mismatch-output"),
  ], false);
  check(/group_by mismatch/u.test(mismatchResult.stderr), "group_by mismatch rejection message changed");

  const missingDateInput = resolve(temporaryDirectory, "missing-date-skills.json");
  const missingDate = JSON.parse(readFileSync(skillsExample, "utf8"));
  missingDate.data.pop();
  writeFileSync(missingDateInput, `${JSON.stringify(missingDate)}\n`, { mode: 0o600 });
  const missingDateResult = run(generator, [
    "--usage-input", usageExample,
    "--skills-input", missingDateInput,
    "--output-dir", resolve(temporaryDirectory, "missing-date-output"),
  ], false);
  check(/date buckets must exactly match/u.test(missingDateResult.stderr), "date-bucket rejection message changed");

  process.stdout.write(`${JSON.stringify({ status: "passed", tests: 5 })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
