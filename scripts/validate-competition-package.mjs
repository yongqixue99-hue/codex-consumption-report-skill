#!/usr/bin/env node

import path from 'node:path';
import { validateCompetitionArchive } from './competition-package-lib.mjs';

function usage() {
  return `Usage:
  node scripts/validate-competition-package.mjs /absolute/path/to/submission.zip
  node scripts/validate-competition-package.mjs --archive /absolute/path/to/submission.zip`;
}

function parseArchivePath(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (argv.length === 1 && !argv[0].startsWith('--')) return path.resolve(argv[0]);
  if (argv.length === 2 && argv[0] === '--archive' && !argv[1].startsWith('--')) {
    return path.resolve(argv[1]);
  }
  throw new Error(usage());
}

try {
  const result = validateCompetitionArchive(parseArchivePath(process.argv.slice(2)));
  process.stdout.write([
    'Competition ZIP validation passed.',
    `Archive: ${result.archivePath}`,
    `SHA-256: ${result.archiveSha256}`,
    `Skill: ${result.skillName}${result.skillVersion ? ` @ ${result.skillVersion}` : ''}`,
    'Portable profile: explicit-input-only',
    `Files: ${result.fileCount} / 500`,
    `Archive bytes: ${result.archiveBytes} / 100000000`,
    `Uncompressed bytes: ${result.uncompressedBytes} / 100000000`,
    ...result.warnings.map((warning) => `Warning: ${warning}`),
  ].join('\n') + '\n');
} catch (error) {
  process.stderr.write(`Competition ZIP validation failed: ${error.message}\n`);
  process.exitCode = 1;
}
