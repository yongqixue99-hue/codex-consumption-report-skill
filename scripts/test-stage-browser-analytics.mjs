#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stageBrowserAnalyticsResponses } from "./stage-browser-analytics.mjs";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const skillDirectory = resolve(import.meta.dirname, "..");
const temporaryDirectory = mkdtempSync(join(tmpdir(), "codex-browser-analytics-test-"));

try {
  const usage = JSON.parse(readFileSync(resolve(skillDirectory, "examples/codex-credits-demo.json"), "utf8"));
  const skills = JSON.parse(readFileSync(resolve(skillDirectory, "examples/codex-skills-demo.json"), "utf8"));
  const plugins = JSON.parse(readFileSync(resolve(skillDirectory, "examples/codex-plugins-demo.json"), "utf8"));
  const staged = stageBrowserAnalyticsResponses({
    responses: { usage, skills, plugins },
    outputDirectory: resolve(temporaryDirectory, "valid"),
  });

  check(JSON.parse(readFileSync(staged.usageInput, "utf8")).data.length === usage.data.length, "usage response changed while staging");
  check(JSON.parse(readFileSync(staged.skillsInput, "utf8")).data.length === skills.data.length, "skills response changed while staging");
  check(JSON.parse(readFileSync(staged.pluginsInput, "utf8")).data.length === plugins.data.length, "plugins response changed while staging");

  const sensitive = structuredClone(usage);
  sensitive.workspace_id = "workspace-test-value-should-never-be-saved";
  let rejected = false;
  try {
    stageBrowserAnalyticsResponses({
      responses: { usage: sensitive },
      outputDirectory: resolve(temporaryDirectory, "sensitive"),
    });
  } catch (error) {
    rejected = /sensitive or identity fields/u.test(String(error.message));
  }
  check(rejected, "sensitive browser response was not rejected before writing");

  process.stdout.write(`${JSON.stringify({ status: "passed", tests: 2 })}\n`);
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
