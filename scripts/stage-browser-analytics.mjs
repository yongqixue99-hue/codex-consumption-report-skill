#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const ENDPOINTS = Object.freeze({
  usage: "daily-workspace-usage-counts",
  skills: "daily-skill-usage-metrics",
  plugins: "daily-plugin-usage-metrics",
});

const SENSITIVE_KEY_PATTERN = /^(?:authorization|proxy-authorization|cookie|cookies|set-cookie|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|api[-_]?key|apikey|password|secret|email|account[-_]?id|user[-_]?id|workspace[-_]?id|organization[-_]?id|org[-_]?id)$/i;
const CREDENTIAL_VALUE_PATTERN = /(?:authorization\s*[:=]|proxy-authorization\s*[:=]|set-cookie\s*[:=]|bearer\s+[a-z0-9._~-]{12,}|(?:access|refresh|session)[-_]?token\s*[:=])/iu;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findSensitiveKeys(value, path = "$", found = []) {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => findSensitiveKeys(item, `${path}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) found.push(`${path}.${key}`);
    findSensitiveKeys(child, `${path}.${key}`, found);
  }
  return found;
}

function normalizePayload(responses, key, required) {
  const endpoint = ENDPOINTS[key];
  const payload = responses[key] ?? responses[endpoint];
  if (payload == null) {
    if (required) throw new Error(`${endpoint} response is required`);
    return null;
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    throw new Error(`${endpoint} must be a JSON object response body with a data array`);
  }
  if (payload.group_by != null && payload.group_by !== "day" && payload.group_by !== "week") {
    throw new Error(`${endpoint} has unsupported group_by=${payload.group_by}`);
  }
  const sensitiveKeys = findSensitiveKeys(payload);
  if (sensitiveKeys.length) {
    throw new Error(`${endpoint} contains sensitive or identity fields: ${sensitiveKeys.slice(0, 8).join(", ")}`);
  }
  if (CREDENTIAL_VALUE_PATTERN.test(JSON.stringify(payload))) {
    throw new Error(`${endpoint} contains credential-like text`);
  }
  return payload;
}

function prepareEmptyPrivateDirectory(outputDirectory) {
  const directory = resolve(outputDirectory);
  if (existsSync(directory)) {
    if (readdirSync(directory).length) {
      throw new Error(`capture directory must be empty: ${directory}`);
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

/**
 * Validate in-memory Analytics response bodies before writing only the
 * sanitized JSON payloads to a private local directory.
 */
export function stageBrowserAnalyticsResponses({ responses, outputDirectory }) {
  if (!isPlainObject(responses)) throw new Error("responses must be an object");
  if (typeof outputDirectory !== "string" || !outputDirectory.trim()) {
    throw new Error("outputDirectory is required");
  }

  const normalized = {
    usage: normalizePayload(responses, "usage", true),
    skills: normalizePayload(responses, "skills", false),
    plugins: normalizePayload(responses, "plugins", false),
  };
  const directory = prepareEmptyPrivateDirectory(outputDirectory);
  const files = {};

  for (const [key, payload] of Object.entries(normalized)) {
    if (payload == null) continue;
    const path = resolve(directory, `${ENDPOINTS[key]}.json`);
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    if (process.platform !== "win32") chmodSync(path, 0o600);
    files[key] = path;
  }

  return Object.freeze({
    directory,
    usageInput: files.usage,
    skillsInput: files.skills ?? null,
    pluginsInput: files.plugins ?? null,
  });
}

export const browserAnalyticsEndpoints = ENDPOINTS;
