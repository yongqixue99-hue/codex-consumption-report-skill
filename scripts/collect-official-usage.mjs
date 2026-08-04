#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";

const CODEX_BIN_ENV = "CODEX_CONSUMPTION_CODEX_BIN";
const COMMON_MACOS_CODEX_PATHS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
  join(homedir(), "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
  join(homedir(), "Applications", "Codex.app", "Contents", "Resources", "codex"),
];
const REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_REQUEST_ID = 1;
const USAGE_REQUEST_ID = 2;
const SUMMARY_FIELDS = [
  "lifetimeTokens",
  "peakDailyTokens",
  "longestRunningTurnSec",
  "currentStreakDays",
  "longestStreakDays",
];

function fail(message) {
  process.stderr.write(`Official usage collection failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  let output;
  let codexBin;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== "--output" && token !== "--codex-bin") {
      throw new Error(`Unknown argument: ${token}`);
    }

    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${token} requires a value.`);
    }
    if (token === "--output") {
      if (output !== undefined) throw new Error("--output may be provided only once.");
      output = value;
    } else {
      if (codexBin !== undefined) throw new Error("--codex-bin may be provided only once.");
      codexBin = value;
    }
    index += 1;
  }

  if (!output) {
    throw new Error("Usage: node collect-official-usage.mjs [--codex-bin <path>] --output <usage.json>");
  }
  if (output === "-") {
    throw new Error("--output must be a file path, not stdout.");
  }
  return {
    output: resolve(output),
    codexBin: codexBin ? resolve(codexBin) : null,
  };
}

function isExecutableFile(candidate) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function requireExecutable(candidate, source) {
  if (!existsSync(candidate)) {
    throw new Error(`${source} does not exist: ${candidate}`);
  }
  if (!isExecutableFile(candidate)) {
    throw new Error(`${source} is not an executable file: ${candidate}`);
  }
  return candidate;
}

function canonicalPathForComparison(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    const parent = dirname(filePath);
    let canonicalParent;
    try {
      canonicalParent = realpathSync(parent);
    } catch {
      canonicalParent = resolve(parent);
    }
    return join(canonicalParent, basename(filePath));
  }
}

function pathCodexCandidates() {
  const names = process.platform === "win32" ? ["codex.exe", "codex.cmd", "codex"] : ["codex", "codex.exe"];
  const directories = String(process.env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  return directories.flatMap((directory) => names.map((name) => resolve(directory, name)));
}

function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (/[\r\n"]/.test(text)) throw new Error("Windows command arguments must not contain quotes or newlines.");
  return `"${text.replaceAll("%", "%%")}"`;
}

function spawnCodex(executable, argv, options) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return spawn(executable, argv, options);
  }
  const command = [quoteWindowsCommandArgument(executable), ...argv.map(quoteWindowsCommandArgument)].join(" ");
  return spawn(process.env.ComSpec || process.env.COMSPEC || "cmd.exe", [
    "/d", "/v:off", "/s", "/c", command,
  ], options);
}

function resolveCodexExecutables(explicitPath) {
  if (explicitPath) {
    return { candidates: [requireExecutable(explicitPath, "--codex-bin")], automatic: false };
  }

  const environmentPath = String(process.env[CODEX_BIN_ENV] ?? "").trim();
  if (environmentPath) {
    return {
      candidates: [requireExecutable(resolve(environmentPath), CODEX_BIN_ENV)],
      automatic: false,
    };
  }

  const discovered = [
    ...pathCodexCandidates(),
    ...(process.platform === "darwin" ? COMMON_MACOS_CODEX_PATHS : []),
  ].filter(isExecutableFile);
  const seen = new Set();
  const candidates = discovered.filter((candidate) => {
    const canonical = canonicalPathForComparison(candidate);
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
  if (candidates.length > 0) return { candidates, automatic: true };

  throw new Error(
    `no executable Codex binary was found; provide --codex-bin <path>, set ${CODEX_BIN_ENV}, `
    + "put codex, codex.exe, or codex.cmd on PATH, or install ChatGPT/Codex in a standard macOS Applications folder.",
  );
}

function sendMessage(child, message) {
  if (!child.stdin.writable) {
    throw new Error("Codex app-server closed its input unexpectedly.");
  }
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function collectUsage(codexExecutable) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnCodex(codexExecutable, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let settled = false;
    let stdoutBuffer = "";
    let usageResult;

    const timeout = setTimeout(() => {
      finish(new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds waiting for account/usage/read.`));
    }, REQUEST_TIMEOUT_MS);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (child.stdin.writable) child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");

      if (error) rejectPromise(error);
      else resolvePromise(result);
    }

    function handleMessage(message) {
      if (!message || typeof message !== "object") return;

      if (message.id === INITIALIZE_REQUEST_ID) {
        if (message.error) {
          const code = Number.isFinite(message.error.code) ? ` ${message.error.code}` : "";
          finish(new Error(`initialize request failed with JSON-RPC code${code || " unknown"}.`));
          return;
        }
        if (!message.result) {
          finish(new Error("initialize response did not contain a result."));
          return;
        }

        try {
          sendMessage(child, { jsonrpc: "2.0", method: "initialized", params: {} });
          sendMessage(child, {
            jsonrpc: "2.0",
            id: USAGE_REQUEST_ID,
            method: "account/usage/read",
            params: {},
          });
        } catch (error) {
          finish(error);
        }
        return;
      }

      if (message.id === USAGE_REQUEST_ID) {
        if (message.error) {
          const code = Number.isFinite(message.error.code) ? ` ${message.error.code}` : "";
          finish(new Error(`account/usage/read failed with JSON-RPC code${code || " unknown"}.`));
          return;
        }
        if (!message.result) {
          finish(new Error("account/usage/read response did not contain a result."));
          return;
        }
        usageResult = message.result;
        finish(undefined, usageResult);
      }
    }

    child.on("error", (error) => {
      finish(new Error(`could not start the selected Codex app-server (${error.code || "spawn error"}).`));
    });
    child.stdin.on("error", (error) => {
      finish(new Error(`could not write to the Codex app-server (${error.code || "stream error"}).`));
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      let newlineIndex;
      while ((newlineIndex = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (!line) continue;

        let message;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new Error("the Codex app-server returned malformed JSONL."));
          return;
        }
        handleMessage(message);
        if (settled) return;
      }
    });

    // Consume stderr so the subprocess cannot block. Its contents are intentionally
    // not forwarded because collection failures must never echo credentials or identity.
    child.stderr.resume();

    child.on("close", (code, signal) => {
      if (settled) return;
      if (usageResult) {
        finish(undefined, usageResult);
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      finish(new Error(`the Codex app-server exited before returning usage (${reason}).`));
    });

    try {
      sendMessage(child, {
        jsonrpc: "2.0",
        id: INITIALIZE_REQUEST_ID,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-consumption-report",
            title: "Codex Consumption Report",
            version: "1.0.0",
          },
          capabilities: {},
        },
      });
    } catch (error) {
      finish(error);
    }
  });
}

function optionalNonnegativeInteger(value, label) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} is not a non-negative safe integer.`);
  }
  return value;
}

function validDateString(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function sanitizeUsage(result) {
  if (!result || typeof result !== "object" || !result.summary || typeof result.summary !== "object") {
    throw new Error("account/usage/read returned an invalid summary.");
  }

  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    summary[field] = optionalNonnegativeInteger(result.summary[field], `summary.${field}`);
  }

  const rawBuckets = result.dailyUsageBuckets ?? [];
  if (!Array.isArray(rawBuckets)) {
    throw new Error("account/usage/read returned invalid daily usage buckets.");
  }

  const dates = new Set();
  const dailyUsageBuckets = rawBuckets.map((bucket, index) => {
    if (!bucket || typeof bucket !== "object" || !validDateString(bucket.startDate)) {
      throw new Error(`dailyUsageBuckets[${index}].startDate is invalid.`);
    }
    if (dates.has(bucket.startDate)) {
      throw new Error(`dailyUsageBuckets contains duplicate date ${bucket.startDate}.`);
    }
    dates.add(bucket.startDate);
    return {
      startDate: bucket.startDate,
      tokens: optionalNonnegativeInteger(bucket.tokens, `dailyUsageBuckets[${index}].tokens`),
    };
  });

  if (dailyUsageBuckets.some((bucket) => bucket.tokens === null)) {
    throw new Error("daily usage bucket tokens cannot be null.");
  }
  dailyUsageBuckets.sort((left, right) => left.startDate.localeCompare(right.startDate));

  return {
    schema: "codex.official.usage.v1",
    generatedAt: new Date().toISOString(),
    summary,
    dailyUsageBuckets,
  };
}

function writeJsonAtomic(outputPath, value) {
  const outputDirectory = dirname(outputPath);
  mkdirSync(outputDirectory, { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, outputPath);
    chmodSync(outputPath, 0o600);
  } finally {
    if (existsSync(temporaryPath)) rmSync(temporaryPath);
  }
}

async function main() {
  const { output, codexBin } = parseArgs(process.argv.slice(2));
  const selection = resolveCodexExecutables(codexBin);
  const canonicalOutput = canonicalPathForComparison(output);
  if (selection.candidates.some((candidate) => canonicalOutput === canonicalPathForComparison(candidate))) {
    throw new Error("--output must not overwrite a selected Codex executable.");
  }

  const failures = [];
  let usage;
  for (const candidate of selection.candidates) {
    try {
      usage = sanitizeUsage(await collectUsage(candidate));
      break;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      failures.push(`${candidate}: ${message}`);
      if (!selection.automatic) throw error;
    }
  }
  if (!usage) {
    throw new Error(`all discovered Codex app-server candidates failed: ${failures.join("; ")}`);
  }
  writeJsonAtomic(output, usage);

  process.stdout.write(`${JSON.stringify({
    status: "complete",
    output,
    schema: usage.schema,
    generatedAt: usage.generatedAt,
    dailyBucketCount: usage.dailyUsageBuckets.length,
  })}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "unknown error.");
});
