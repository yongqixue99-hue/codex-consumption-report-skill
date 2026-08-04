#!/usr/bin/env node

import path from 'node:path';
import { buildCompetitionArchive } from './competition-package-lib.mjs';

function usage() {
  return `Usage:
  node scripts/package-competition.mjs \\
    --source /absolute/path/to/skill \\
    --output /absolute/path/to/submission.zip \\
    [--sha256-output /absolute/path/to/submission.zip.sha256.txt]

The portable ZIP maps competition/iflytek/SKILL.md to root SKILL.md and includes
only explicit-input report stages, the anonymous demo, offline template/runtime,
competition references, agent metadata, and license files. It is byte-for-byte
deterministic and validated before replacing the output. --source defaults to
the current directory.`;
}

function parseArgs(argv) {
  let sourceDir = process.cwd();
  let outputPath = null;
  let sha256OutputPath = null;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--help' || option === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!['--source', '--output', '--sha256-output'].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    index += 1;
    if (option === '--source') sourceDir = path.resolve(value);
    else if (option === '--output') outputPath = path.resolve(value);
    else sha256OutputPath = path.resolve(value);
  }
  if (!outputPath) throw new Error(`Missing required --output\n\n${usage()}`);
  return { sourceDir, outputPath, sha256OutputPath };
}

try {
  const result = buildCompetitionArchive(parseArgs(process.argv.slice(2)));
  process.stdout.write([
    'Competition ZIP created and validated.',
    `Archive: ${result.archivePath}`,
    `SHA-256: ${result.archiveSha256}`,
    `SHA-256 sidecar: ${result.sha256Path}`,
    `Skill: ${result.skillName}${result.skillVersion ? ` @ ${result.skillVersion}` : ''}`,
    'Portable profile: explicit-input-only (no account, home, network, package manager, or browser access)',
    `Files: ${result.fileCount} / 500`,
    `Archive bytes: ${result.archiveBytes} / 100000000`,
    `Uncompressed bytes: ${result.uncompressedBytes} / 100000000`,
    `Excluded source paths: ${result.excluded.length}`,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ].join('\n') + '\n');
} catch (error) {
  process.stderr.write(`Competition packaging failed: ${error.message}\n`);
  process.exitCode = 1;
}
