#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';

export const COMPETITION_LIMITS = Object.freeze({
  maxArchiveBytes: 100_000_000,
  maxUncompressedBytes: 100_000_000,
  maxFileBytes: 10_000_000,
  maxFiles: 500,
});

export const ALLOWED_EXTENSIONS = Object.freeze([
  '.md', '.txt', '.json', '.yaml', '.yml', '.html', '.css', '.csv', '.pdf',
  '.toml', '.xml', '.xsd', '.xsl', '.dtd', '.ini', '.cfg', '.env',
  '.js', '.cjs', '.mjs', '.ts', '.py', '.sh', '.rb', '.go', '.rs', '.java',
  '.kt', '.lua', '.sql', '.r', '.bat', '.ps1', '.zsh', '.bash',
  '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.ico',
  '.doc', '.xls', '.ppt', '.docx', '.xlsx', '.pptx',
]);

const MANIFEST_PATH = 'competition-manifest.json';
const OFFICIAL_GUIDE_URL = 'https://openres.xfyun.cn/xfyundoc/2026-06-04/e8f94fb5-8626-45fe-91c3-f18130ec5348/1780542909612/Skill%E5%BC%80%E5%8F%91%E4%B8%8E%E6%8F%90%E4%BA%A4%E6%8C%87%E5%8D%97.md';
const OWNERSHIP_PATHS = Object.freeze([
  'competition-ip/background-ip.md',
  'competition-ip/third-party-components.md',
  'competition-ip/competition-new-work.md',
]);
const GENERATED_PATHS = new Set([MANIFEST_PATH, ...OWNERSHIP_PATHS]);
const PORTABLE_RUNTIME_SCRIPTS = Object.freeze([
  'scripts/generate-competition-report.mjs',
  'scripts/normalize-portable-usage.mjs',
  'scripts/derive-report.mjs',
  'scripts/build-report.mjs',
  'scripts/validate-report.mjs',
]);
const PORTABLE_REQUIRED_MAPPINGS = Object.freeze([
  { source: 'competition/iflytek/SKILL.md', archive: 'SKILL.md', kind: 'portable-root' },
  { source: 'competition/iflytek/agents/openai.yaml', archive: 'agents/openai.yaml', kind: 'portable-root' },
  { source: 'competition/iflytek/LICENSE.txt', archive: 'LICENSE.txt', kind: 'portable-root' },
  { source: 'competition/iflytek/NOTICE.txt', archive: 'NOTICE.txt', kind: 'portable-root' },
  { source: 'LICENSE', archive: 'licenses/LICENSE-Apache-2.0.txt', kind: 'allowed-extension' },
  { source: 'assets/report.template.html', archive: 'assets/report.template.html', kind: 'portable-runtime' },
  { source: 'assets/vendor/echarts/echarts.min.js', archive: 'assets/vendor/echarts/echarts.min.js', kind: 'third-party' },
  { source: 'assets/vendor/echarts/LICENSE.txt', archive: 'assets/vendor/echarts/LICENSE.txt', kind: 'third-party' },
  { source: 'assets/vendor/echarts/NOTICE.txt', archive: 'assets/vendor/echarts/NOTICE.txt', kind: 'third-party' },
  { source: 'assets/vendor/echarts/licenses/LICENSE-d3', archive: 'assets/vendor/echarts/licenses/LICENSE-d3.txt', kind: 'allowed-extension' },
  { source: 'assets/vendor/echarts/licenses/LICENSE-zrender', archive: 'assets/vendor/echarts/licenses/LICENSE-zrender.txt', kind: 'allowed-extension' },
  { source: 'assets/vendor/echarts/licenses/LICENSE-tslib', archive: 'assets/vendor/echarts/licenses/LICENSE-tslib.txt', kind: 'allowed-extension' },
  { source: 'assets/vendor/echarts/licenses/CopyrightNotice-tslib', archive: 'assets/vendor/echarts/licenses/CopyrightNotice-tslib.txt', kind: 'allowed-extension' },
  { source: 'assets/vendor/echarts/package.json', archive: 'assets/vendor/echarts/package.json', kind: 'third-party' },
  { source: 'examples/iflytek-demo-usage.json', archive: 'examples/iflytek-demo-usage.json', kind: 'synthetic-demo' },
  { source: 'examples/iflytek-demo-expected.json', archive: 'examples/iflytek-demo-expected.json', kind: 'synthetic-demo' },
  ...PORTABLE_RUNTIME_SCRIPTS.map((script) => ({ source: script, archive: script, kind: 'portable-runtime' })),
]);
const THIRD_PARTY_COMPONENTS = Object.freeze([
  Object.freeze({
    name: 'Apache ECharts',
    version: '6.1.0',
    license: 'Apache-2.0',
    role: 'offline chart runtime',
    upstream: 'https://github.com/apache/echarts/tree/6.1.0',
    archivePaths: Object.freeze([
      'assets/vendor/echarts/echarts.min.js',
      'assets/vendor/echarts/LICENSE.txt',
      'assets/vendor/echarts/NOTICE.txt',
    ]),
  }),
  Object.freeze({
    name: 'd3.js portions in Apache ECharts',
    version: 'not separately versioned by ECharts 6.1.0',
    license: 'BSD-3-Clause',
    role: 'algorithms embedded by Apache ECharts',
    upstream: 'https://github.com/apache/echarts/blob/6.1.0/licenses/LICENSE-d3',
    archivePaths: Object.freeze(['assets/vendor/echarts/licenses/LICENSE-d3.txt']),
  }),
  Object.freeze({
    name: 'zrender',
    version: '6.1.0',
    license: 'BSD-3-Clause',
    role: 'rendering implementation bundled into the ECharts browser distribution',
    upstream: 'https://github.com/ecomfe/zrender/tree/6.1.0',
    archivePaths: Object.freeze(['assets/vendor/echarts/licenses/LICENSE-zrender.txt']),
  }),
  Object.freeze({
    name: 'tslib',
    version: '2.3.0',
    license: '0BSD',
    role: 'TypeScript helpers bundled into the ECharts browser distribution',
    upstream: 'https://github.com/microsoft/tslib/tree/2.3.0',
    archivePaths: Object.freeze([
      'assets/vendor/echarts/licenses/LICENSE-tslib.txt',
      'assets/vendor/echarts/licenses/CopyrightNotice-tslib.txt',
    ]),
  }),
]);
const TRUSTED_VENDOR_FILE_SHA256 = Object.freeze({
  'assets/vendor/echarts/echarts.min.js': 'b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0',
  'assets/vendor/echarts/LICENSE.txt': '634293835b43a6dd2094fa39182a3d9a6b9ca43b7fdb9ac354e8037af2a3093a',
  'assets/vendor/echarts/NOTICE.txt': 'd491d358344f842685c1b1585970999db65fe30ecf7ef3867af8814f4016c016',
  'assets/vendor/echarts/licenses/LICENSE-d3.txt': 'e1211892da0b0e0585b7aebe8f98c1274fba15bafe47fa1f4ee8a7a502c06304',
  'assets/vendor/echarts/licenses/LICENSE-zrender.txt': '55ea01207028f76d844678511f29fc800f8a1e67a8a0fe80470128677847ad32',
  'assets/vendor/echarts/licenses/LICENSE-tslib.txt': '5989359645911c04a140c49d89496b13feca980bbf36d2250a12d3b9d06250d6',
  'assets/vendor/echarts/licenses/CopyrightNotice-tslib.txt': '0d8f66cd4afb566cb5b7e1540c68f43b939d3eba12ace290f18abc4f4cb53ed0',
  'assets/vendor/echarts/package.json': '3b5f84e135d641960271dd2d7d63b5486896a471fee8e0e841f822fa3846bb28',
});
const PORTABLE_OPTIONAL_DIRECTORIES = Object.freeze([
  { source: 'competition/iflytek/references', archive: 'references' },
]);
const PORTABLE_PROFILE_MANIFEST = Object.freeze({
  name: 'explicit-input-only',
  sourceSkill: 'competition/iflytek/SKILL.md',
  rootSkill: 'SKILL.md',
  runtimeScripts: [...PORTABLE_RUNTIME_SCRIPTS],
  explicitInputOnly: true,
  readsHomeDirectory: false,
  queriesSignedInAccount: false,
  invokesPackageManagers: false,
  launchesBrowser: false,
  networkAccess: false,
  excludedCapabilities: [
    'automatic Codex account collection',
    'CC Switch or CodeBurn discovery',
    'multi-device ledger merge',
    'npx or package-manager invocation',
    'Playwright, Chrome, Chromium, or Edge rendering',
  ],
});
const FORBIDDEN_PORTABLE_ARCHIVE_PATHS = new Set([
  'scripts/generate-report.mjs',
  'scripts/collect-official-usage.mjs',
  'scripts/collect-lifecycle-ledger.mjs',
  'scripts/merge-device-ledgers.mjs',
  'scripts/render-report.cjs',
]);
const FORBIDDEN_PORTABLE_RUNTIME_PATTERNS = [
  { label: 'general report generator', pattern: /generate-report\.mjs/iu },
  { label: 'automatic collector', pattern: /collect-(?:official-usage|lifecycle-ledger)\.mjs/iu },
  { label: 'multi-device merger', pattern: /merge-device-ledgers\.mjs/iu },
  { label: 'browser renderer', pattern: /render-report\.cjs|--render|--chrome|playwright|chrom(?:e|ium)|msedge/iu },
  { label: 'package-manager invocation', pattern: /(?:^|[^A-Za-z0-9_])npx(?:[^A-Za-z0-9_]|$)/iu },
  { label: 'home-directory discovery', pattern: /\bhomedir\s*\(|\.cc-switch|session_meta\.cwd/iu },
  { label: 'signed-in account or app-server access', pattern: /app-server|--codex-bin|CODEX_CONSUMPTION_CODEX_BIN/iu },
  { label: 'SQLite access', pattern: /node:sqlite|sqlite3/iu },
  { label: 'network module or request', pattern: /node:(?:http|https|net|tls)|\bfetch\s*\(/iu },
];
const FIRST_PARTY_RUNTIME_IMPORTS = Object.freeze({
  'scripts/generate-competition-report.mjs': Object.freeze([
    'node:fs', 'node:crypto', 'node:os', 'node:path', 'node:child_process',
  ]),
  'scripts/normalize-portable-usage.mjs': Object.freeze(['node:fs', 'node:crypto', 'node:path']),
  'scripts/derive-report.mjs': Object.freeze(['node:fs', 'node:crypto', 'node:path']),
  'scripts/build-report.mjs': Object.freeze(['node:fs', 'node:crypto', 'node:path']),
  'scripts/validate-report.mjs': Object.freeze(['node:fs', 'node:crypto', 'node:path']),
});
const ACTIVE_PACKAGE_PATHS = new Set([
  'SKILL.md',
  'agents/openai.yaml',
  'assets/report.template.html',
  'assets/vendor/echarts/echarts.min.js',
  ...PORTABLE_RUNTIME_SCRIPTS,
]);
const DOCUMENTATION_PATH_PATTERN = /^(?:references|competition-ip)\//u;
const NETWORK_BEHAVIOR_PATTERNS = Object.freeze([
  { label: 'remote Fetch API', pattern: /\bfetch\s*\(/iu },
  { label: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/iu },
  { label: 'WebSocket', pattern: /\bWebSocket\s*\(/iu },
  { label: 'EventSource', pattern: /\bEventSource\s*\(/iu },
  { label: 'sendBeacon', pattern: /\bsendBeacon\s*\(/iu },
  { label: 'network-capable Node module', pattern: /\bnode:(?:http|https|http2|net|tls|dns|dgram)\b/iu },
  { label: 'network-capable package import', pattern: /(?:from\s*|import\s*\(|require\s*\()\s*["'](?:axios|got|undici|node-fetch|superagent|request|ws)["']/iu },
  { label: 'shell network client', pattern: /(?:^|[;&|`\n]\s*)(?:curl|wget|aria2c|ftp|sftp|scp)\s+/iu },
  { label: 'Deno or Bun network API', pattern: /\b(?:Deno\.(?:connect|listen|resolveDns)|Bun\.(?:connect|serve))\s*\(/iu },
]);
const REMOTE_RESOURCE_PATTERNS = Object.freeze([
  { label: 'remote HTML resource', pattern: /<(?:script|link|img|iframe|source|video|audio)\b[^>]*(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//iu },
  { label: 'remote CSS resource', pattern: /(?:@import\s+|url\s*\()\s*["']?\s*(?:https?:)?\/\//iu },
  { label: 'remote JavaScript resource assignment', pattern: /\b(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//iu },
]);
const EXTERNAL_URL_PATTERN = /\b(?:https?|wss?|ftp):\/\/[^\s<>"'`)\]}]+/giu;
const ECHARTS_ALLOWED_URLS = Object.freeze([
  /^http:\/\/www\.apache\.org\/licenses\/LICENSE-2\.0$/u,
  /^https:\/\/github\.com\/ecomfe\/zrender\/blob\/master\/LICENSE$/u,
  /^http:\/\/www\.w3\.org\/(?:2000\/(?:svg|xmlns\/)|1999\/xlink|XML\/1998\/namespace)$/u,
]);
const ALLOWED_EXTENSION_SET = new Set(ALLOWED_EXTENSIONS);
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.html', '.css', '.csv',
  '.toml', '.xml', '.xsd', '.xsl', '.dtd', '.ini', '.cfg', '.env',
  '.js', '.cjs', '.mjs', '.ts', '.py', '.sh', '.rb', '.go', '.rs', '.java',
  '.kt', '.lua', '.sql', '.r', '.bat', '.ps1', '.zsh', '.bash', '.svg',
]);
const PLACEHOLDER_WORDS = [
  'your', 'example', 'sample', 'placeholder', 'changeme', 'replace', 'dummy',
  'mock', 'test', 'fake', 'todo', 'xxx', 'redacted',
];
const RESERVED_SKILL_NAMES = new Set([
  'admin', 'api', 'dashboard', 'search', 'auth', 'me', 'global', 'system',
  'static', 'assets', 'health',
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([
  '.git', '.github', '.gitlab', '.hg', '.svn', '.idea', '.vscode', '.cache',
  '.codex', '.claude', '.ssh', 'node_modules', 'coverage', 'dist', 'build',
  'out', 'output', 'outputs', 'report-output', 'report-outputs', 'reports',
  'generated', 'artifacts', 'qa', 'tmp', 'temp', 'private', 'private-data',
  'personal-data', 'user-data', 'raw-data', 'real-data',
]);
const EXCLUDED_FILE_NAMES = new Set([
  '.ds_store', '.gitignore', '.gitattributes', '.npmrc', '.yarnrc', '.netrc',
  'id_rsa', 'id_ed25519', 'credentials.json', 'secrets.json',
  'codex-consumption-report.html', 'codex-consumption-report.pdf',
  'codex-consumption-report.png', 'codex-consumption-data.json',
  'codex-consumption-source.json', 'codex-consumption-manifest.json',
  'codex-lifecycle-ledger.json', 'codex-official-usage.json',
]);
const OUTPUT_FILE_PATTERNS = [
  /^codex-consumption-(?:report|data|source|manifest)(?:[-_.].*)?\.(?:html|json|pdf|png)$/iu,
  /^codex-(?:lifecycle-ledger|official-usage)(?:[-_.].*)?\.json$/iu,
  /^(?:full-page|mobile|desktop)(?:[-_.].*)?\.png$/iu,
];
const PRIVATE_FILE_PATTERN = /(?:^|[-_.])(?:credential|credentials|secret|secrets|private-key|private_key|access-token|access_token)(?:[-_.]|$)/iu;
const INTERNAL_RESEARCH_PATTERN = /^docs\/competition-research(?:[-_.].*)?\.md$/iu;
const EXTENSIONLESS_LICENSE_PATTERN = /^(?:licen[cs]e|notice|copying|copyright[-_.]?notice)(?:[-_.][a-z0-9-]+)?$/iu;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = 33;
const UTF8_ZIP_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const FILE_MODE = 0o100644;

const SECRET_PATTERNS = [
  { type: 'AWS access key', pattern: /\bAKIA[A-Z0-9]{16}\b/gu },
  { type: 'GitHub token', pattern: /\bghp_[A-Za-z0-9]{20,}\b/gu },
  { type: 'GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu },
  { type: 'OpenAI or generic API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu },
  { type: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/gu },
  { type: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/gu },
  { type: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/gu },
  { type: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/gu },
  { type: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
];
const GENERIC_SECRET_ASSIGNMENT = /["']?\b(api[_-]?key|access[_-]?key|aws[_-]?secret[_-]?access[_-]?key|client[_-]?secret|secret|password|token)\b["']?\s*[:=]\s*(?:"([^"\r\n]{12,})"|'([^'\r\n]{12,})'|([^\s#;,]{12,}))/giu;
const PRIVACY_PATTERNS = [
  { type: 'macOS home path', pattern: /\/Users\/([A-Za-z0-9._-]+)/gu, capture: 1 },
  { type: 'Linux home path', pattern: /\/home\/([A-Za-z0-9._-]+)/gu, capture: 1 },
  { type: 'Windows home path', pattern: /[A-Za-z]:[\\/]Users[\\/]([A-Za-z0-9._-]+)/gu, capture: 1 },
  { type: 'UUID-shaped private identifier', pattern: /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/giu, capture: 0 },
];
const SAFE_HOME_SEGMENTS = new Set([
  'all users', 'default', 'default user', 'public', 'shared', ...PLACEHOLDER_WORDS,
]);

export class CompetitionPackageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CompetitionPackageError';
  }
}

function fail(message) {
  throw new CompetitionPackageError(message);
}

function compareUtf8Paths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extensionFor(archivePath) {
  const basename = path.posix.basename(archivePath).toLowerCase();
  if (basename === '.env') return '.env';
  return path.posix.extname(basename);
}

function normalizeArchivePath(value) {
  return String(value).replaceAll('\\', '/').normalize('NFC');
}

function assertSafeArchivePath(value, label = 'Archive path') {
  const archivePath = normalizeArchivePath(value);
  if (!archivePath || archivePath.startsWith('/') || /^[A-Za-z]:/u.test(archivePath)) {
    fail(`${label} is absolute or empty: ${JSON.stringify(value)}`);
  }
  if (Buffer.byteLength(archivePath, 'utf8') > 4096) {
    fail(`${label} is longer than 4096 UTF-8 bytes: ${archivePath}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(archivePath)) {
    fail(`${label} contains control characters: ${JSON.stringify(archivePath)}`);
  }
  const segments = archivePath.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      fail(`${label} contains an empty, current, or parent segment: ${archivePath}`);
    }
    if (segment.includes(':')
      || segment.endsWith('.')
      || segment.endsWith(' ')
      || WINDOWS_RESERVED_SEGMENT.test(segment)) {
      fail(`${label} is not portable across supported platforms: ${archivePath}`);
    }
  }
  return archivePath;
}

function assertAllowedExtension(archivePath) {
  const extension = extensionFor(archivePath);
  if (!ALLOWED_EXTENSION_SET.has(extension)) {
    fail(`File extension is not on the official SkillHub allowlist: ${archivePath || '(empty path)'}`);
  }
}

function pathSecurityReason(relativePath, isDirectory) {
  const normalized = normalizeArchivePath(relativePath);
  const segments = normalized.split('/');
  const basename = segments.at(-1).toLowerCase();
  if (segments.some((segment) => segment.startsWith('.'))) return 'hidden or VCS metadata';
  if (isDirectory && EXCLUDED_DIRECTORY_NAMES.has(basename)) return 'private, generated, or development directory';
  if (!isDirectory && EXCLUDED_FILE_NAMES.has(basename)) return 'private metadata or generated report artifact';
  if (!isDirectory && OUTPUT_FILE_PATTERNS.some((pattern) => pattern.test(basename))) return 'generated report artifact';
  if (!isDirectory && PRIVATE_FILE_PATTERN.test(basename)) return 'credential or private-data filename';
  if (!isDirectory && INTERNAL_RESEARCH_PATTERN.test(normalized)) return 'internal competition research';
  return null;
}

function mappedArchivePath(relativePath) {
  const normalized = normalizeArchivePath(relativePath);
  const basename = path.posix.basename(normalized);
  if (!path.posix.extname(basename) && EXTENSIONLESS_LICENSE_PATTERN.test(basename)) {
    return `${normalized}.txt`;
  }
  return normalized;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function decodeUtf8(buffer, archivePath) {
  if (buffer.includes(0)) fail(`Text file contains a NUL byte: ${archivePath}`);
  try {
    return UTF8_DECODER.decode(buffer);
  } catch (error) {
    fail(`Text file is not valid UTF-8: ${archivePath} (${error.message})`);
  }
}

function lineNumberAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (text.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function placeholderValue(value) {
  const normalized = String(value).trim().toLowerCase();
  if (PLACEHOLDER_WORDS.some((word) => normalized.includes(word))) return true;
  const compact = normalized.replace(/[\s'"`]/gu, '');
  return compact.length > 0 && /^[x*\-]+$/iu.test(compact);
}

function scanSecrets(text, archivePath) {
  for (const { type, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (placeholderValue(match[0])) continue;
      fail(`Suspected ${type} in ${archivePath}:${lineNumberAt(text, match.index)}`);
    }
  }
  GENERIC_SECRET_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(GENERIC_SECRET_ASSIGNMENT)) {
    const key = String(match[1] ?? '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (placeholderValue(value)) continue;
    if (key === 'token'
      && (/\s|[\u3400-\u9fff]/u.test(value) || /^[A-Z][A-Z0-9_]*$/u.test(value))) {
      continue;
    }
    fail(`Suspected secret assignment in ${archivePath}:${lineNumberAt(text, match.index)}`);
  }
}

function scanPrivateData(text, archivePath) {
  const currentHome = os.homedir();
  const currentHomeVariants = new Set([
    currentHome,
    currentHome.replaceAll('\\', '/'),
    currentHome.replaceAll('/', '\\'),
  ]);
  for (const home of currentHomeVariants) {
    if (home && home.length > 3 && text.includes(home)) {
      fail(`Current-user home path found in ${archivePath}`);
    }
  }
  for (const { type, pattern, capture } of PRIVACY_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const marker = String(match[capture] ?? match[0]).toLowerCase();
      if (SAFE_HOME_SEGMENTS.has(marker) || placeholderValue(marker)) continue;
      if (type === 'UUID-shaped private identifier') {
        const lineStart = text.lastIndexOf('\n', match.index) + 1;
        const beforeMatch = text.slice(lineStart, match.index);
        if (/https?:\/\/\S*$/iu.test(beforeMatch)) continue;
      }
      fail(`Suspected ${type} in ${archivePath}:${lineNumberAt(text, match.index)}`);
    }
  }
}

function validateFileContent(buffer, archivePath) {
  const extension = extensionFor(archivePath);
  if (TEXT_EXTENSIONS.has(extension)) {
    const text = decodeUtf8(buffer, archivePath);
    if (extension === '.svg' && !/<svg(?:\s|>)/iu.test(text)) {
      fail(`SVG file does not contain an <svg> element: ${archivePath}`);
    }
    scanSecrets(text, archivePath);
    scanPrivateData(text, archivePath);
    return text;
  }

  const hasPrefix = (...bytes) => bytes.every((byte, index) => buffer[index] === byte);
  if (extension === '.png' && !hasPrefix(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    fail(`PNG magic bytes are invalid: ${archivePath}`);
  }
  if ((extension === '.jpg' || extension === '.jpeg') && !hasPrefix(0xff, 0xd8, 0xff)) {
    fail(`JPEG magic bytes are invalid: ${archivePath}`);
  }
  if (extension === '.gif' && buffer.subarray(0, 4).toString('ascii') !== 'GIF8') {
    fail(`GIF magic bytes are invalid: ${archivePath}`);
  }
  if (extension === '.webp'
    && (buffer.subarray(0, 4).toString('ascii') !== 'RIFF'
      || buffer.subarray(8, 12).toString('ascii') !== 'WEBP')) {
    fail(`WebP magic bytes are invalid: ${archivePath}`);
  }
  if (extension === '.pdf' && buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
    fail(`PDF magic bytes are invalid: ${archivePath}`);
  }
  if (extension === '.ico' && !hasPrefix(0x00, 0x00, 0x01, 0x00)) {
    fail(`ICO magic bytes are invalid: ${archivePath}`);
  }
  return null;
}

function assertExactObjectKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort(compareUtf8Paths);
  const expected = [...expectedKeys].sort(compareUtf8Paths);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} has an invalid field set`);
  }
}

function isDocumentationOrLicensePath(archivePath) {
  return archivePath === MANIFEST_PATH
    || DOCUMENTATION_PATH_PATTERN.test(archivePath)
    || isLicenseDocument(archivePath)
    || archivePath === 'assets/vendor/echarts/package.json';
}

function assertRuntimeImportAllowlist(text, archivePath) {
  const allowed = new Set(FIRST_PARTY_RUNTIME_IMPORTS[archivePath] ?? []);
  const imports = [];
  const importPatterns = [
    /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bexport\s+(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of importPatterns) {
    for (const match of text.matchAll(pattern)) imports.push(match[1]);
  }
  if (/\bimport\s*\((?!\s*["'][^"']+["']\s*\))/u.test(text)
    || /\brequire\s*\((?!\s*["'][^"']+["']\s*\))/u.test(text)) {
    fail(`Portable runtime uses a non-literal module import: ${archivePath}`);
  }
  for (const specifier of imports) {
    if (!allowed.has(specifier)) {
      fail(`Portable runtime imports a module outside its allowlist (${specifier}): ${archivePath}`);
    }
  }
  if (archivePath === 'scripts/generate-competition-report.mjs') {
    if (/\b(?:exec|execFile|execSync|execFileSync|fork|spawn)\s*\(/u.test(text)
      || /\bspawnSync\s*\((?!\s*process\.execPath\s*,)/u.test(text)) {
      fail(`Portable runner invokes a process outside its fixed Node.js child-process boundary: ${archivePath}`);
    }
  } else if (/\bnode:child_process\b|\b(?:exec|execFile|execSync|execFileSync|fork|spawn|spawnSync)\s*\(/u.test(text)) {
    fail(`Portable runtime unexpectedly invokes a child process: ${archivePath}`);
  }
}

function assertNoRemoteRuntimeBehavior(entries) {
  for (const entry of entries) {
    if (!TEXT_EXTENSIONS.has(extensionFor(entry.path))) continue;
    const text = entry.text ?? decodeUtf8(entry.data, entry.path);
    const active = ACTIVE_PACKAGE_PATHS.has(entry.path);
    for (const { label, pattern } of NETWORK_BEHAVIOR_PATTERNS) {
      if (pattern.test(text)) {
        fail(`${active ? 'Active package content' : 'Package content'} contains ${label}: ${entry.path}`);
      }
    }
    if (active) {
      for (const { label, pattern } of REMOTE_RESOURCE_PATTERNS) {
        if (pattern.test(text)) fail(`Active package content contains ${label}: ${entry.path}`);
      }
    }

    EXTERNAL_URL_PATTERN.lastIndex = 0;
    for (const match of text.matchAll(EXTERNAL_URL_PATTERN)) {
      const rawUrl = match[0].replace(/[.,;:]$/u, '');
      const allowedVendorUrl = entry.path === 'assets/vendor/echarts/echarts.min.js'
        && ECHARTS_ALLOWED_URLS.some((pattern) => pattern.test(rawUrl));
      if (!allowedVendorUrl && active && !isDocumentationOrLicensePath(entry.path)) {
        fail(`Active package content contains an external URL: ${entry.path}:${lineNumberAt(text, match.index)}`);
      }
    }

    if (Object.hasOwn(FIRST_PARTY_RUNTIME_IMPORTS, entry.path)) {
      assertRuntimeImportAllowlist(text, entry.path);
    }
  }
}

function asSafeNonNegativeInteger(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) fail(`${label} must be a safe integer`);
  return value;
}

function asFiniteNumber(value, label, { positive = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < (positive ? Number.EPSILON : 0)) {
    fail(`${label} must be a finite number`);
  }
  return value;
}

function assertClose(actual, expected, tolerance, label) {
  if (typeof expected !== 'number' || !Number.isFinite(expected) || Math.abs(actual - expected) > tolerance) {
    fail(`Bundled expected result does not match the synthetic fixture: ${label}`);
  }
}

function dateKeyInTimezone(timestamp, timezone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    fail(`Bundled fixture timezone is invalid: ${timezone}`);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== 'literal')
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateSyntheticFixturePair(entries) {
  const fixtureEntry = entries.find((entry) => entry.path === 'examples/iflytek-demo-usage.json');
  const expectedEntry = entries.find((entry) => entry.path === 'examples/iflytek-demo-expected.json');
  let fixture;
  let expected;
  try {
    fixture = JSON.parse(fixtureEntry.text);
    expected = JSON.parse(expectedEntry.text);
  } catch (error) {
    fail(`Bundled fixture or expected result is not valid JSON: ${error.message}`);
  }
  assertExactObjectKeys(fixture, ['schema', 'generatedAt', 'timezone', 'synthetic', 'records'], 'Bundled fixture root');
  if (fixture.schema !== 'codex.portable.usage.v1' || fixture.synthetic !== true
    || !Array.isArray(fixture.records) || fixture.records.length === 0 || fixture.records.length > 100_000) {
    fail('Bundled fixture must be a non-empty codex.portable.usage.v1 synthetic dataset');
  }
  if (typeof fixture.generatedAt !== 'string'
    || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(fixture.generatedAt)
    || !Number.isFinite(Date.parse(fixture.generatedAt))) {
    fail('Bundled fixture generatedAt must be an ISO timestamp with an explicit UTC offset');
  }
  if (typeof fixture.timezone !== 'string' || fixture.timezone.length > 64) fail('Bundled fixture timezone is invalid');

  const components = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const sessions = new Set();
  const projects = new Set();
  const daily = new Map();
  const projectTokens = new Map();
  const modelTokens = new Map();
  const fingerprints = new Set();
  let cost = 0;
  let calls = 0;
  for (const [index, record] of fixture.records.entries()) {
    assertExactObjectKeys(record, [
      'timestamp', 'project', 'session', 'model', 'activity', 'inputTokens', 'outputTokens',
      'cacheReadTokens', 'cacheWriteTokens', 'estimatedCostUsd', 'calls',
    ], `Bundled fixture record ${index}`);
    for (const field of ['timestamp', 'project', 'session', 'model', 'activity']) {
      if (typeof record[field] !== 'string' || !record[field].trim() || record[field].length > 128) {
        fail(`Bundled fixture record ${index} has an invalid ${field}`);
      }
    }
    if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(record.timestamp) || !Number.isFinite(Date.parse(record.timestamp))) {
      fail(`Bundled fixture record ${index} timestamp must include an explicit UTC offset`);
    }
    if (!/^demo-session-\d{2,6}$/u.test(record.session)) {
      fail(`Bundled fixture record ${index} must use a visibly synthetic session alias`);
    }
    const input = asSafeNonNegativeInteger(record.inputTokens, `Bundled fixture record ${index} inputTokens`);
    const output = asSafeNonNegativeInteger(record.outputTokens, `Bundled fixture record ${index} outputTokens`);
    const cacheRead = asSafeNonNegativeInteger(record.cacheReadTokens, `Bundled fixture record ${index} cacheReadTokens`);
    const cacheWrite = asSafeNonNegativeInteger(record.cacheWriteTokens, `Bundled fixture record ${index} cacheWriteTokens`);
    const recordTokens = input + output + cacheRead + cacheWrite;
    if (!Number.isSafeInteger(recordTokens) || recordTokens < 1) fail(`Bundled fixture record ${index} has invalid total Tokens`);
    const recordCost = asFiniteNumber(record.estimatedCostUsd, `Bundled fixture record ${index} estimatedCostUsd`);
    const recordCalls = asSafeNonNegativeInteger(record.calls, `Bundled fixture record ${index} calls`, { positive: true });
    const fingerprint = canonicalJson(record);
    if (fingerprints.has(fingerprint)) fail(`Bundled fixture contains an exact duplicate record at index ${index}`);
    fingerprints.add(fingerprint);
    components.input += input;
    components.output += output;
    components.cacheRead += cacheRead;
    components.cacheWrite += cacheWrite;
    cost += recordCost;
    calls += recordCalls;
    sessions.add(record.session);
    projects.add(record.project);
    const date = dateKeyInTimezone(record.timestamp, fixture.timezone);
    const day = daily.get(date) ?? { tokens: 0, calls: 0 };
    day.tokens += recordTokens;
    day.calls += recordCalls;
    daily.set(date, day);
    projectTokens.set(record.project, (projectTokens.get(record.project) ?? 0) + recordTokens);
    modelTokens.set(record.model, (modelTokens.get(record.model) ?? 0) + recordTokens);
  }
  const tokens = Object.values(components).reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(calls) || cost <= 0) fail('Bundled fixture totals are invalid');
  const dates = [...daily.keys()].sort(compareUtf8Paths);
  const peakDate = dates.reduce((best, date) => daily.get(date).tokens > daily.get(best).tokens ? date : best, dates[0]);
  const topShare = (map) => Math.max(...map.values()) / tokens;
  const peakRatio = daily.get(peakDate).tokens / median([...daily.values()].map((day) => day.tokens));

  assertExactObjectKeys(expected, ['schema', 'fixture', 'source', 'summary', 'facts', 'quality', 'privacy'], 'Bundled expected result root');
  assertExactObjectKeys(expected.source, ['kind', 'synthetic'], 'Bundled expected source');
  assertExactObjectKeys(expected.summary, [
    'rangeStart', 'rangeEnd', 'timezone', 'tokens', 'tokenComponents', 'estimatedCostUsd',
    'calls', 'sessions', 'projects', 'cacheReadTokenShare', 'peakDay',
  ], 'Bundled expected summary');
  assertExactObjectKeys(expected.summary.tokenComponents, ['input', 'output', 'cacheRead', 'cacheWrite'], 'Bundled expected token components');
  assertExactObjectKeys(expected.summary.peakDay, ['date', 'tokens', 'calls'], 'Bundled expected peak day');
  assertExactObjectKeys(expected.facts, [
    'peakToMedianActiveDayTokens', 'topProjectTokenShare', 'topModelTokenShare', 'cacheReadTokenShare',
  ], 'Bundled expected facts');
  assertExactObjectKeys(expected.quality, [
    'reconciliation', 'calendarContinuity', 'projectAttribution', 'activityAttribution', 'sourceDisclosure',
  ], 'Bundled expected quality');
  assertExactObjectKeys(expected.privacy, [
    'containsRealAccountData', 'containsPromptOrCode', 'containsHostPath', 'containsRawSessionIdentifier',
  ], 'Bundled expected privacy');
  if (expected.schema !== 'codex.competition.expected-result.v1'
    || expected.fixture !== 'iflytek-demo-usage.json'
    || expected.source.kind !== 'bundled-synthetic'
    || expected.source.synthetic !== true) {
    fail('Bundled expected result has an invalid identity or source declaration');
  }
  const exactComparisons = [
    [expected.summary.rangeStart, dates[0], 'rangeStart'],
    [expected.summary.rangeEnd, dates.at(-1), 'rangeEnd'],
    [expected.summary.timezone, fixture.timezone, 'timezone'],
    [expected.summary.tokens, tokens, 'tokens'],
    [expected.summary.tokenComponents.input, components.input, 'input Tokens'],
    [expected.summary.tokenComponents.output, components.output, 'output Tokens'],
    [expected.summary.tokenComponents.cacheRead, components.cacheRead, 'cache-read Tokens'],
    [expected.summary.tokenComponents.cacheWrite, components.cacheWrite, 'cache-write Tokens'],
    [expected.summary.calls, calls, 'calls'],
    [expected.summary.sessions, sessions.size, 'sessions'],
    [expected.summary.projects, projects.size, 'projects'],
    [expected.summary.peakDay.date, peakDate, 'peak date'],
    [expected.summary.peakDay.tokens, daily.get(peakDate).tokens, 'peak Tokens'],
    [expected.summary.peakDay.calls, daily.get(peakDate).calls, 'peak calls'],
  ];
  for (const [actual, wanted, label] of exactComparisons) {
    if (actual !== wanted) fail(`Bundled expected result does not match the synthetic fixture: ${label}`);
  }
  assertClose(cost, expected.summary.estimatedCostUsd, 1e-9, 'estimated cost');
  assertClose(components.cacheRead / tokens, expected.summary.cacheReadTokenShare, 1e-12, 'cache-read share');
  assertClose(Number(peakRatio.toFixed(4)), expected.facts.peakToMedianActiveDayTokens, 1e-12, 'peak-to-median ratio');
  assertClose(Number(topShare(projectTokens).toFixed(8)), expected.facts.topProjectTokenShare, 1e-12, 'top project share');
  assertClose(Number(topShare(modelTokens).toFixed(8)), expected.facts.topModelTokenShare, 1e-12, 'top model share');
  assertClose(Number((components.cacheRead / tokens).toFixed(8)), expected.facts.cacheReadTokenShare, 1e-12, 'fact cache-read share');
  if (Object.values(expected.privacy).some((value) => value !== false)
    || expected.quality.reconciliation !== 'pass'
    || expected.quality.projectAttribution !== 'full'
    || expected.quality.activityAttribution !== 'full'
    || expected.quality.sourceDisclosure !== 'synthetic') {
    fail('Bundled expected result privacy or quality declaration is invalid');
  }
  const firstDate = new Date(`${dates[0]}T00:00:00Z`);
  const lastDate = new Date(`${dates.at(-1)}T00:00:00Z`);
  const expectedCalendarDays = Math.round((lastDate - firstDate) / 86_400_000) + 1;
  const continuity = daily.size === expectedCalendarDays ? 'pass' : 'gap';
  if (expected.quality.calendarContinuity !== continuity) {
    fail('Bundled expected result does not match the synthetic fixture: calendar continuity');
  }
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isLicenseDocument(archivePath) {
  return /^(?:licen[cs]e|notice|copying)(?:[-_.].*)?$/iu.test(path.posix.basename(archivePath));
}

function rewriteRenamedReferences(text, transforms, containingPath) {
  // Preserve upstream and package license/notice texts byte-for-byte. Package
  // references outside those documents are rewritten to the SkillHub-safe
  // archive names instead.
  if (isLicenseDocument(containingPath)) return text;
  let result = text;
  for (const transform of transforms) {
    if (transform.kind !== 'allowed-extension') continue;
    const source = transform.source;
    const archive = transform.archive;
    if (source.includes('/')) {
      result = result.replace(
        new RegExp(`${escapeRegularExpression(source)}(?!\\.txt)`, 'gu'),
        archive,
      );
    }
    const sourceBase = path.posix.basename(source);
    const archiveBase = path.posix.basename(archive);
    result = result
      .replaceAll(`"${source}"`, `"${archive}"`)
      .replaceAll(`'${source}'`, `'${archive}'`)
      .replaceAll(`](${source})`, `](${archive})`)
      .replaceAll(`\`${source}\``, `\`${archive}\``);
    if (source.includes('/') && sourceBase !== archiveBase) {
      result = result.replace(
        new RegExp(`${escapeRegularExpression(sourceBase)}(?!\\.txt)`, 'gu'),
        archiveBase,
      );
    }
  }
  return result;
}

function staleReferencePatterns(source) {
  return [
    `"${source}"`,
    `'${source}'`,
    `](${source})`,
    `\`${source}\``,
  ];
}

function assertNoStaleRenamedReferences(entries, transforms) {
  for (const entry of entries) {
    if (entry.path === MANIFEST_PATH) continue;
    if (!TEXT_EXTENSIONS.has(extensionFor(entry.path))) continue;
    const text = entry.text ?? decodeUtf8(entry.data, entry.path);
    for (const transform of transforms) {
      if (transform.kind !== 'allowed-extension') continue;
      const candidates = staleReferencePatterns(transform.source);
      if (!isLicenseDocument(entry.path)
        && candidates.some((candidate) => text.includes(candidate))) {
        fail(`Text file still references renamed path ${transform.source}: ${entry.path}`);
      }
      if (transform.source.includes('/')
        && new RegExp(`${escapeRegularExpression(transform.source)}(?!\\.txt)`, 'u').test(text)) {
        fail(`Text file still references renamed path ${transform.source}: ${entry.path}`);
      }
    }
  }
}

function parseSkillFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/u, '');
  const lines = normalized.split(/\r?\n/u);
  if (lines[0]?.trim() !== '---') fail('SKILL.md must begin with YAML frontmatter');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end < 0) fail('SKILL.md frontmatter is not terminated');
  const fields = new Map();
  for (let index = 1; index < end; index += 1) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/u.exec(lines[index]);
    if (!match) continue;
    let value = (match[2] ?? '').trim();
    if (value === '>' || value === '|') {
      const parts = [];
      while (index + 1 < end && /^\s+/u.test(lines[index + 1])) {
        index += 1;
        parts.push(lines[index].trim());
      }
      value = parts.join(value === '>' ? ' ' : '\n');
    }
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields.set(match[1], value.trim());
  }
  const name = fields.get('name') ?? '';
  const description = fields.get('description') ?? '';
  const length = [...name].length;
  if (length < 2 || length > 64
    || !/^[\p{Ll}\p{Lo}\p{Nd}](?:[\p{Ll}\p{Lo}\p{Nd}-]*[\p{Ll}\p{Lo}\p{Nd}])?$/u.test(name)
    || name.includes('--')
    || RESERVED_SKILL_NAMES.has(name)) {
    fail(`SKILL.md name does not satisfy the official slug rules: ${JSON.stringify(name)}`);
  }
  if (!description) fail('SKILL.md frontmatter is missing a non-empty description');
  if ([...description].length > 1024 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(description)) {
    fail('SKILL.md description must contain at most 1024 characters and no control characters');
  }
  return { name, description, version: fields.get('version') || null };
}

function portableAllowedArchivePath(archivePath) {
  if (GENERATED_PATHS.has(archivePath)) return true;
  if (archivePath.startsWith('references/')) return true;
  return PORTABLE_REQUIRED_MAPPINGS.some((mapping) => mapping.archive === archivePath);
}

function validateThirdPartyDistribution(entries) {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const [archivePath, expectedSha256] of Object.entries(TRUSTED_VENDOR_FILE_SHA256)) {
    const entry = byPath.get(archivePath);
    if (!entry) fail(`Portable ZIP is missing verified third-party file: ${archivePath}`);
    if (sha256(entry.data) !== expectedSha256) {
      fail(`Verified third-party file diverges from the audited distribution: ${archivePath}`);
    }
  }

  let metadata;
  try {
    metadata = JSON.parse(byPath.get('assets/vendor/echarts/package.json').text);
  } catch (error) {
    fail(`Apache ECharts package metadata is invalid: ${error.message}`);
  }
  if (metadata.name !== 'echarts'
    || metadata.version !== '6.1.0'
    || metadata.license !== 'Apache-2.0'
    || metadata.dependencies?.zrender !== '6.1.0'
    || metadata.dependencies?.tslib !== '2.3.0') {
    fail('Apache ECharts package metadata diverges from the audited 6.1.0 distribution');
  }
  const runtimeText = byPath.get('assets/vendor/echarts/echarts.min.js').text;
  if (!runtimeText.includes('Copyright (c) Microsoft Corporation.')
    || !runtimeText.includes('https://github.com/ecomfe/zrender/blob/master/LICENSE')) {
    fail('Apache ECharts runtime omits audited bundled-component notices');
  }
}

function assertPortableProfileEntries(entries) {
  const pathSet = new Set(entries.map((entry) => entry.path));
  for (const mapping of PORTABLE_REQUIRED_MAPPINGS) {
    if (!pathSet.has(mapping.archive)) fail(`Portable ZIP is missing allowlisted file: ${mapping.archive}`);
  }
  for (const archivePath of pathSet) {
    if (!portableAllowedArchivePath(archivePath)) {
      fail(`ZIP contains a file outside the portable explicit-input allowlist: ${archivePath}`);
    }
    if (FORBIDDEN_PORTABLE_ARCHIVE_PATHS.has(archivePath)) {
      fail(`ZIP contains a forbidden general-runtime file: ${archivePath}`);
    }
  }
  for (const runtimePath of PORTABLE_RUNTIME_SCRIPTS) {
    const entry = entries.find((candidate) => candidate.path === runtimePath);
    if (!entry) fail(`Portable ZIP is missing runtime script: ${runtimePath}`);
    const text = entry.text ?? decodeUtf8(entry.data, runtimePath);
    for (const { label, pattern } of FORBIDDEN_PORTABLE_RUNTIME_PATTERNS) {
      if (pattern.test(text)) fail(`Portable runtime references ${label}: ${runtimePath}`);
    }
  }
  validateThirdPartyDistribution(entries);
  assertNoRemoteRuntimeBehavior(entries);
  validateSyntheticFixturePair(entries);
}

function backgroundIpTemplate(skillName) {
  return `# 赛事专项改造前已有知识产权清单（事实版）

Skill：\`${skillName}\`

公开仓库：https://github.com/yongqixue99-hue/codex-consumption-report-skill

赛事专项改造及本次上传前的公开基线：[94a72c6ddf8685a5b4541cb453260df0a8c39570](https://github.com/yongqixue99-hue/codex-consumption-report-skill/commit/94a72c6ddf8685a5b4541cb453260df0a8c39570)，提交时间 2026-08-04T10:43:16+08:00。该时间晚于赛事启动日，因此本清单不将其表述为“赛事开始前”基线。

该公开基线在竞赛 portable 适配形成前已经按 Apache License 2.0 发布。当前包中的竞赛期间自研适配也统一使用 Apache-2.0。本清单中的 BG 与 NEW 分类只用于说明时间、来源和原创性，不代表不同的项目许可。本清单中的 BG 范围只覆盖下表所列文件在该 commit 中的基线版本；当前 ZIP 中的共享文件可能同时包含“BG 基线 + NEW 增量”，NEW 增量见 \`competition-ip/competition-new-work.md\`。

| 编号 | 专项改造前已有资产与精确边界 | 基线 Git blob 证据 | 当前 portable 包中的关系 | 权利人 | 许可状态 |
| --- | --- | --- | --- | --- | --- |
| BG-001 | 通用报告派生实现在公开基线 commit 中的版本 | \`scripts/derive-report.mjs\` = \`425d17511c74b9a2e1e0dd2d9d22e997fb1dd0ae\` | 当前同路径文件以该基线为基础，并含 NEW-004 的 post-baseline portable 指标/来源适配 | 提交人/仓库贡献者，以公开提交记录为准 | 基线版本为 Apache-2.0 |
| BG-002 | 通用报告构建与确定性验证在公开基线 commit 中的版本 | \`scripts/build-report.mjs\` = \`110df7b6e0791a092208761829e56a9d02b9ca64\`；\`scripts/validate-report.mjs\` = \`b1631d5aee4bde266079fbcc880f1fc25011920f\` | 当前同路径文件以这些基线为基础，并含 NEW-004 的 post-baseline portable 与许可完整性适配 | 提交人/仓库贡献者，以公开提交记录为准 | 基线版本为 Apache-2.0 |
| BG-003 | 离线交互报告模板在公开基线 commit 中的版本 | \`assets/report.template.html\` = \`ca8677a11c77b96c6ee246529e6f9b32a9044e79\` | 当前同路径文件以该基线为基础，并含 NEW-004 的 post-baseline source-neutral、synthetic 与 portable 展示适配 | 提交人/仓库贡献者，以公开提交记录为准 | 基线版本为 Apache-2.0 |
| BG-004 | 通用自动采集、生命周期重建、多设备合并和浏览器渲染能力 | 上述公开基线 commit 及公开仓库历史 | 明确不在 portable 竞赛 ZIP 内 | 提交人/仓库贡献者，以公开提交记录为准 | Apache-2.0；不属于本包竞赛新增 |

Apache-2.0 全文保存在 \`licenses/LICENSE-Apache-2.0.txt\`。根目录 \`LICENSE.txt\` 明确说明包内全部项目自有内容，包括 BG 基线和 NEW 竞赛适配，统一使用 Apache-2.0；第三方组件继续适用各自许可。本清单不把第三方组件、未提交模块或商标归入项目自有内容；当前包内文件级 SHA-256 以 \`competition-manifest.json\` 为准。
`;
}

function thirdPartyTemplate(skillName) {
  return `# 第三方组件与许可清单（事实版）

Skill：\`${skillName}\`

portable 竞赛 ZIP 内分发下列第三方实现。ECharts 浏览器文件与 npm 6.1.0 正式分发包逐字节一致（SHA-256：\`b66b25aeb4df84e33199dc21694014d336d222cbd9deb0e5a7c14bd6aa0d0fd0\`）。zrender 与 tslib 是 ECharts 6.1.0 \`package.json\` 明示的固定依赖并被构建进该浏览器文件；tslib 许可头也直接保留在该文件中。新增许可副本只做文件名/换行规范化以满足 SkillHub 扩展名规则，未修改许可实质文字。

| 编号 | 组件/来源 | 版本 | 包内用途与路径 | 许可证 | 许可/NOTICE 文件 | 修改状态 | 与自研实现的关系 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| TP-001 | [Apache ECharts](https://github.com/apache/echarts/tree/6.1.0) | 6.1.0 | 离线图表运行时：\`assets/vendor/echarts/echarts.min.js\` | Apache-2.0 | \`assets/vendor/echarts/LICENSE.txt\`、\`assets/vendor/echarts/NOTICE.txt\` | 运行时与官方 npm 分发逐字节一致 | 只承担离线图表渲染 |
| TP-002 | [d3.js portions bundled by Apache ECharts](https://github.com/apache/echarts/blob/6.1.0/licenses/LICENSE-d3) | ECharts 6.1.0 未单独标注 d3 版本 | ECharts 源码/分发包包含的部分算法 | BSD-3-Clause | \`assets/vendor/echarts/licenses/LICENSE-d3.txt\` | 随官方 ECharts 分发 | 不作为独立项目代码主张权利 |
| TP-003 | [zrender](https://github.com/ecomfe/zrender/tree/6.1.0) | 6.1.0 | ECharts 浏览器分发内的底层渲染实现 | BSD-3-Clause | \`assets/vendor/echarts/licenses/LICENSE-zrender.txt\` | ECharts 内嵌代码未修改；许可副本仅规范化文件名/换行 | 不作为独立项目代码主张权利 |
| TP-004 | [tslib](https://github.com/microsoft/tslib/tree/2.3.0) | 2.3.0 | ECharts 浏览器分发内的 TypeScript helper | 0BSD | \`assets/vendor/echarts/licenses/LICENSE-tslib.txt\`、\`assets/vendor/echarts/licenses/CopyrightNotice-tslib.txt\` | ECharts 内嵌代码未修改；许可副本仅规范化文件名/换行 | 不作为独立项目代码主张权利 |

上述第三方组件只承担可视化运行时与编译辅助，不负责显式输入白名单、数据规范化、指标派生、对账验证、对话摘要、隐私检查或竞赛打包；这些核心分析链与提交工程为本项目自研。本清单不把官方“核心 Skill 自研内容≥50%”解释为未经定义的字节数、代码行或功能百分比，也不作未经主办方确认的具体比例声明。

来源核验日期：2026-08-04。版本与依赖关系来自 ECharts 6.1.0、zrender 6.1.0、tslib 2.3.0 官方 tag/package metadata；许可全文来自各自官方 tag。本 ZIP 未分发其他第三方模型、数据集、字体、图片、音视频或远程运行依赖。匿名演示数据为本项目合成数据，不是第三方或真实账户数据。
`;
}

function competitionNewWorkTemplate(skillName) {
  return `# 竞赛期间新增成果清单（事实版）

Skill：\`${skillName}\`

开发日期：2026-08-04。

权利人表述：提交人/仓库贡献者，最终以报名实名为准。

许可状态：本清单中的 NEW-001 至 NEW-005 均为项目自有内容，统一按 Apache License 2.0 开源，允许在遵守该许可的前提下使用、修改、分发和创建派生作品。

| 编号 | 竞赛新增成果 | 包内路径 | 日期 | 作者/权利人 | 相对公开基线的新增内容 | 本清单中的分类 |
| --- | --- | --- | --- | --- | --- | --- |
| NEW-001 | 显式输入、无账户与设备探测的 portable runner 和 normalizer | \`scripts/generate-competition-report.mjs\`、\`scripts/normalize-portable-usage.mjs\` | 2026-08-04 | 提交人/仓库贡献者，最终以报名实名为准 | 仅处理包内匿名演示或用户显式提供的脱敏 JSON/JSONL/CSV；直接串联安全报告阶段并返回聊天摘要 | 竞赛 portable 适配 |
| NEW-002 | 赛事专用 Skill 指令与 AstronClaw 元数据 | \`SKILL.md\`、\`agents/openai.yaml\` | 2026-08-04 | 提交人/仓库贡献者，最终以报名实名为准 | 新增竞赛触发条件、显式输入边界、失败契约和聊天优先交付规则 | 竞赛 portable 适配 |
| NEW-003 | 匿名合成 fixture、黄金结果与 portable 数据/评测参考 | \`examples/iflytek-demo-usage.json\`、\`examples/iflytek-demo-expected.json\`、\`references/portable-data-contract.md\`、\`references/evaluation-and-limitations.md\` | 2026-08-04 | 提交人/仓库贡献者，最终以报名实名为准 | 新增可复现实例、黄金指标、脱敏输入契约和已知限制说明 | 竞赛 portable 适配 |
| NEW-004 | 公开基线共享报告文件的 post-baseline 竞赛适配增量 | \`scripts/derive-report.mjs\`、\`scripts/build-report.mjs\`、\`scripts/validate-report.mjs\`、\`assets/report.template.html\` | 2026-08-04 | 提交人/仓库贡献者，最终以报名实名为准 | 在 BG-001/BG-002/BG-003 基线上新增 portable 来源与质量事实、source-neutral 首屏、synthetic/portable 展示语义、portable 对账验证，以及 d3/zrender/tslib 独立 HTML 许可完整性；不把整份共享文件重新归类为 NEW | 竞赛 portable 适配增量 |
| NEW-005 | 确定性竞赛打包、ZIP 验证、SHA-256、许可索引与权属清单生成 | 包内 \`LICENSE.txt\`、\`NOTICE.txt\`、\`competition-manifest.json\`、\`competition-ip/*.md\`；packager 源码只在源仓库执行 | 2026-08-04 | 提交人/仓库贡献者，最终以报名实名为准 | 新增官方扩展名白名单、100 MB/10 MB/500 文件限制、路径/密钥/隐私检查、经哈希锁定的第三方分发核验和 byte-for-byte 可复现 ZIP | 竞赛提交工程 |

根目录 \`LICENSE.txt\` 对本包实行许可分层说明：全部项目自有内容，包括公开 BG 基线和本清单所列竞赛期原创增量，统一适用 Apache-2.0；第三方材料继续适用各自许可。本清单只用于证明 2026-08-04 实际形成并进入本次 portable 提交流程的新增内容，不限制 Apache-2.0 已经授予的二次开发权利，也不把第三方组件、商标、未提交模块或未提交数据归入项目自有成果。
`;
}

function ownershipEntries(skillName) {
  return [
    { path: OWNERSHIP_PATHS[0], data: Buffer.from(backgroundIpTemplate(skillName), 'utf8'), generated: true },
    { path: OWNERSHIP_PATHS[1], data: Buffer.from(thirdPartyTemplate(skillName), 'utf8'), generated: true },
    { path: OWNERSHIP_PATHS[2], data: Buffer.from(competitionNewWorkTemplate(skillName), 'utf8'), generated: true },
  ];
}

function candidateFromMapping(sourceDir, mapping) {
  const sourcePath = assertSafeArchivePath(mapping.source, 'Portable source path');
  const archivePath = assertSafeArchivePath(mapping.archive, 'Portable archive path');
  if (GENERATED_PATHS.has(archivePath)) fail(`Portable profile uses a reserved generated path: ${archivePath}`);
  const absolutePath = path.join(sourceDir, ...sourcePath.split('/'));
  let stat;
  try {
    stat = fs.lstatSync(absolutePath);
  } catch (error) {
    fail(`Portable profile is missing required source file ${sourcePath}: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`Portable profile source must be a regular non-symlink file: ${sourcePath}`);
  }
  assertAllowedExtension(archivePath);
  if (stat.size > COMPETITION_LIMITS.maxFileBytes) {
    fail(`Source file exceeds the 10 MB limit (${stat.size} bytes): ${sourcePath}`);
  }
  return { sourcePath, absolutePath, path: archivePath, sourceBytes: stat.size, kind: mapping.kind };
}

function collectOptionalPortableDirectory(sourceDir, directoryMapping, candidates, excluded) {
  const sourceRoot = path.join(sourceDir, ...directoryMapping.source.split('/'));
  if (!fs.existsSync(sourceRoot)) return;
  const rootStat = fs.lstatSync(sourceRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`Portable optional source must be a regular directory: ${directoryMapping.source}`);
  }

  function walk(absoluteDirectory, relativeDirectory) {
    const children = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareUtf8Paths(left.name.normalize('NFC'), right.name.normalize('NFC')));
    for (const child of children) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
      const sourcePath = `${directoryMapping.source}/${relativePath}`;
      const absolutePath = path.join(absoluteDirectory, child.name);
      const reason = pathSecurityReason(sourcePath, child.isDirectory());
      if (reason) {
        excluded.push({ path: normalizeArchivePath(sourcePath), reason });
        continue;
      }
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) fail(`Symbolic links are not accepted in a competition package: ${sourcePath}`);
      if (stat.isDirectory()) {
        walk(absolutePath, normalizeArchivePath(relativePath));
        continue;
      }
      if (!stat.isFile()) fail(`Only regular files are accepted in a competition package: ${sourcePath}`);
      const archivePath = assertSafeArchivePath(
        mappedArchivePath(`${directoryMapping.archive}/${relativePath}`),
        'Portable optional archive path',
      );
      assertAllowedExtension(archivePath);
      if (stat.size > COMPETITION_LIMITS.maxFileBytes) {
        fail(`Source file exceeds the 10 MB limit (${stat.size} bytes): ${sourcePath}`);
      }
      candidates.push({
        sourcePath: normalizeArchivePath(sourcePath),
        absolutePath,
        path: archivePath,
        sourceBytes: stat.size,
        kind: archivePath === `${directoryMapping.archive}/${normalizeArchivePath(relativePath)}`
          ? 'portable-reference'
          : 'allowed-extension',
      });
    }
  }
  walk(sourceRoot, '');
}

function collectExcludedInventory(sourceDir, includedSourcePaths, ignoredAbsolutePaths, existingExcluded) {
  const excluded = [...existingExcluded];
  const alreadyReported = new Set(excluded.map((entry) => entry.path));

  function report(relativePath, reason) {
    const normalized = normalizeArchivePath(relativePath);
    if (!alreadyReported.has(normalized)) {
      alreadyReported.add(normalized);
      excluded.push({ path: normalized, reason });
    }
  }

  function walk(absoluteDirectory, relativeDirectory) {
    const children = fs.readdirSync(absoluteDirectory, { withFileTypes: true })
      .sort((left, right) => compareUtf8Paths(left.name.normalize('NFC'), right.name.normalize('NFC')));
    for (const child of children) {
      const relativePath = normalizeArchivePath(relativeDirectory
        ? `${relativeDirectory}/${child.name}`
        : child.name);
      const absolutePath = path.join(absoluteDirectory, child.name);
      if (ignoredAbsolutePaths.has(path.resolve(absolutePath))) {
        report(relativePath, 'requested package output');
        continue;
      }
      const reason = pathSecurityReason(relativePath, child.isDirectory());
      if (reason) {
        report(relativePath, reason);
        continue;
      }
      const stat = fs.lstatSync(absolutePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        walk(absolutePath, relativePath);
      } else if (!includedSourcePaths.has(relativePath)) {
        report(relativePath, 'not in the portable explicit-input allowlist');
      }
    }
  }

  walk(sourceDir, '');
  return excluded;
}

function collectPortableCandidates(sourceDir, ignoredAbsolutePaths) {
  const candidates = PORTABLE_REQUIRED_MAPPINGS.map((mapping) => candidateFromMapping(sourceDir, mapping));
  const initiallyExcluded = [];
  for (const directoryMapping of PORTABLE_OPTIONAL_DIRECTORIES) {
    collectOptionalPortableDirectory(sourceDir, directoryMapping, candidates, initiallyExcluded);
  }
  assertUniquePaths(candidates);
  const includedSourcePaths = new Set(candidates.map((entry) => entry.sourcePath));
  const excluded = collectExcludedInventory(
    sourceDir,
    includedSourcePaths,
    ignoredAbsolutePaths,
    initiallyExcluded,
  );
  return { candidates, excluded };
}

function assertCandidatePreflightLimits(candidates) {
  if (candidates.length + OWNERSHIP_PATHS.length + 1 > COMPETITION_LIMITS.maxFiles) {
    fail(`Package would exceed the 500-file limit after generated files: ${candidates.length + OWNERSHIP_PATHS.length + 1}`);
  }
  const aggregateSourceBytes = candidates.reduce((total, candidate) => {
    const next = total + candidate.sourceBytes;
    if (!Number.isSafeInteger(next)) fail('Aggregate source size exceeds the safe-integer boundary');
    return next;
  }, 0);
  if (aggregateSourceBytes > COMPETITION_LIMITS.maxUncompressedBytes) {
    fail(`Aggregate source size exceeds the 100 MB uncompressed-content limit before reading: ${aggregateSourceBytes} bytes`);
  }
}

function assertUniquePaths(entries) {
  const exact = new Set();
  const portable = new Map();
  for (const entry of entries) {
    if (exact.has(entry.path)) fail(`Duplicate archive path: ${entry.path}`);
    exact.add(entry.path);
    const key = entry.path.toLowerCase();
    if (portable.has(key)) {
      fail(`Case-insensitive archive path collision: ${portable.get(key)} and ${entry.path}`);
    }
    portable.set(key, entry.path);
  }
}

function createManifest(entries, transforms) {
  const manifestEntries = entries
    .map((entry) => ({ path: entry.path, bytes: entry.data.length, sha256: sha256(entry.data) }))
    .sort((left, right) => compareUtf8Paths(left.path, right.path));
  return {
    schema: 'iflytek.competition-package.manifest.v1',
    profile: 'iflytek-skillhub-2026-portable',
    officialGuide: OFFICIAL_GUIDE_URL,
    rootSkill: 'SKILL.md',
    digestAlgorithm: 'sha256',
    manifestPath: MANIFEST_PATH,
    manifestSelfHashExcluded: true,
    deterministicZip: {
      entryOrder: 'utf8-path-ascending',
      timestamp: '1980-01-01T00:00:00.000Z',
      compression: 'store',
      unixMode: '0644',
    },
    limits: { ...COMPETITION_LIMITS },
    allowedExtensions: [...ALLOWED_EXTENSIONS],
    portableProfile: PORTABLE_PROFILE_MANIFEST,
    thirdPartyComponents: THIRD_PARTY_COMPONENTS,
    generatedOwnershipTemplates: [...OWNERSHIP_PATHS],
    pathTransforms: transforms,
    fileCount: entries.length + 1,
    entries: manifestEntries,
  };
}

function expectedArchiveForTransformSource(source) {
  const required = PORTABLE_REQUIRED_MAPPINGS.find((mapping) => mapping.source === source);
  if (required) return required.archive;
  for (const mapping of PORTABLE_OPTIONAL_DIRECTORIES) {
    const prefix = `${mapping.source}/`;
    if (source.startsWith(prefix)) {
      return mappedArchivePath(`${mapping.archive}/${source.slice(prefix.length)}`);
    }
  }
  return null;
}

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(buffer, value, offset) {
  buffer.writeUInt16LE(value, offset);
}

function writeUInt32(buffer, value, offset) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

function buildStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    writeUInt32(local, 0x04034b50, 0);
    writeUInt16(local, 20, 4);
    writeUInt16(local, UTF8_ZIP_FLAG, 6);
    writeUInt16(local, ZIP_STORE_METHOD, 8);
    writeUInt16(local, FIXED_DOS_TIME, 10);
    writeUInt16(local, FIXED_DOS_DATE, 12);
    writeUInt32(local, crc, 14);
    writeUInt32(local, entry.data.length, 18);
    writeUInt32(local, entry.data.length, 22);
    writeUInt16(local, name.length, 26);
    writeUInt16(local, 0, 28);
    name.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + name.length);
    writeUInt32(central, 0x02014b50, 0);
    writeUInt16(central, 0x0314, 4);
    writeUInt16(central, 20, 6);
    writeUInt16(central, UTF8_ZIP_FLAG, 8);
    writeUInt16(central, ZIP_STORE_METHOD, 10);
    writeUInt16(central, FIXED_DOS_TIME, 12);
    writeUInt16(central, FIXED_DOS_DATE, 14);
    writeUInt32(central, crc, 16);
    writeUInt32(central, entry.data.length, 20);
    writeUInt32(central, entry.data.length, 24);
    writeUInt16(central, name.length, 28);
    writeUInt16(central, 0, 30);
    writeUInt16(central, 0, 32);
    writeUInt16(central, 0, 34);
    writeUInt16(central, 0, 36);
    writeUInt32(central, (FILE_MODE * 0x10000) >>> 0, 38);
    writeUInt32(central, localOffset, 42);
    name.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length + entry.data.length;
  }

  const centralOffset = localOffset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  writeUInt32(end, 0x06054b50, 0);
  writeUInt16(end, 0, 4);
  writeUInt16(end, 0, 6);
  writeUInt16(end, entries.length, 8);
  writeUInt16(end, entries.length, 10);
  writeUInt32(end, centralSize, 12);
  writeUInt32(end, centralOffset, 16);
  writeUInt16(end, 0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  fail('ZIP end-of-central-directory record is missing');
}

function decodeZipName(buffer, label) {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch (error) {
    fail(`${label} is not valid UTF-8 (${error.message})`);
  }
}

function parseZip(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('Archive input must be a Buffer');
  if (buffer.length > COMPETITION_LIMITS.maxArchiveBytes) {
    fail(`ZIP exceeds the 100 MB limit: ${buffer.length} bytes`);
  }
  if (buffer.length < 22) fail('ZIP is truncated');
  const endOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const commentLength = buffer.readUInt16LE(endOffset + 20);
  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    fail('Multi-disk ZIP archives are not accepted');
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    fail('ZIP64 archives are not accepted for this size-limited profile');
  }
  if (endOffset + 22 + commentLength !== buffer.length) fail('ZIP has trailing or truncated data');
  if (commentLength !== 0) fail('Deterministic competition ZIP must not contain an archive comment');
  if (centralOffset + centralSize !== endOffset || centralOffset > buffer.length) {
    fail('ZIP central-directory bounds are invalid');
  }
  if (entryCount > 1_000) fail(`ZIP has too many central-directory entries: ${entryCount}`);

  const rawEntries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      fail(`ZIP central-directory entry ${index} is invalid`);
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const versionNeeded = buffer.readUInt16LE(cursor + 6);
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const dosTime = buffer.readUInt16LE(cursor + 12);
    const dosDate = buffer.readUInt16LE(cursor + 14);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const entryCommentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const internalAttributes = buffer.readUInt16LE(cursor + 36);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if (next > endOffset) fail(`ZIP central-directory entry ${index} is truncated`);
    if (diskStart !== 0) fail('Multi-disk ZIP entry is not accepted');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      fail('ZIP64 entry is not accepted');
    }
    const rawName = decodeZipName(buffer.subarray(cursor + 46, cursor + 46 + nameLength), `ZIP entry ${index} name`);
    const normalizedName = normalizeArchivePath(rawName);
    if (rawName !== normalizedName) fail(`ZIP entry ${index} does not use canonical NFC '/' path syntax`);
    const directory = normalizedName.endsWith('/');
    const safeName = directory
      ? assertSafeArchivePath(normalizedName.slice(0, -1), `ZIP directory entry ${index}`)
      : assertSafeArchivePath(normalizedName, `ZIP file entry ${index}`);
    rawEntries.push({
      path: safeName,
      rawName,
      directory,
      versionMadeBy,
      versionNeeded,
      flags,
      method,
      dosTime,
      dosDate,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      extraLength,
      entryCommentLength,
      internalAttributes,
      externalAttributes,
    });
    cursor = next;
  }
  if (cursor !== endOffset) fail('ZIP central-directory size does not match its entries');

  const files = rawEntries.filter((entry) => !entry.directory);
  if (files.length > COMPETITION_LIMITS.maxFiles) {
    fail(`ZIP exceeds the 500-file limit: ${files.length}`);
  }
  const uncompressedBytes = files.reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (uncompressedBytes > COMPETITION_LIMITS.maxUncompressedBytes) {
    fail(`ZIP exceeds the 100 MB uncompressed-content limit: ${uncompressedBytes} bytes`);
  }
  if (rawEntries.some((entry) => entry.directory)) {
    fail('Deterministic competition ZIP must omit explicit directory entries');
  }
  assertUniquePaths(files);

  const localRanges = [];
  for (const entry of files) {
    if ((entry.flags & 0x0001) !== 0) fail(`Encrypted ZIP entry is not accepted: ${entry.path}`);
    if (entry.method !== ZIP_STORE_METHOD && entry.method !== 8) {
      fail(`Unsupported ZIP compression method ${entry.method}: ${entry.path}`);
    }
    if (entry.uncompressedSize > COMPETITION_LIMITS.maxFileBytes) {
      fail(`ZIP entry exceeds the 10 MB limit (${entry.uncompressedSize} bytes): ${entry.path}`);
    }
    if (entry.localOffset + 30 > centralOffset || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
      fail(`ZIP local header is invalid: ${entry.path}`);
    }
    const localFlags = buffer.readUInt16LE(entry.localOffset + 6);
    const localMethod = buffer.readUInt16LE(entry.localOffset + 8);
    const localTime = buffer.readUInt16LE(entry.localOffset + 10);
    const localDate = buffer.readUInt16LE(entry.localOffset + 12);
    const localCrc = buffer.readUInt32LE(entry.localOffset + 14);
    const localCompressedSize = buffer.readUInt32LE(entry.localOffset + 18);
    const localUncompressedSize = buffer.readUInt32LE(entry.localOffset + 22);
    const localNameLength = buffer.readUInt16LE(entry.localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(entry.localOffset + 28);
    const localNameStart = entry.localOffset + 30;
    const dataStart = localNameStart + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > centralOffset) fail(`ZIP entry data is out of bounds: ${entry.path}`);
    const localName = decodeZipName(buffer.subarray(localNameStart, localNameStart + localNameLength), `Local ZIP name for ${entry.path}`);
    if (localName !== entry.rawName
      || localFlags !== entry.flags
      || localMethod !== entry.method
      || localTime !== entry.dosTime
      || localDate !== entry.dosDate
      || localCrc !== entry.crc
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize) {
      fail(`ZIP local and central headers disagree: ${entry.path}`);
    }
    entry.localExtraLength = localExtraLength;
    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (entry.method === ZIP_STORE_METHOD) {
      if (entry.compressedSize !== entry.uncompressedSize) fail(`Stored ZIP entry size mismatch: ${entry.path}`);
      data = Buffer.from(compressed);
    } else {
      try {
        data = inflateRawSync(compressed, { maxOutputLength: COMPETITION_LIMITS.maxFileBytes + 1 });
      } catch (error) {
        fail(`Unable to inflate ZIP entry ${entry.path}: ${error.message}`);
      }
    }
    if (data.length !== entry.uncompressedSize) fail(`ZIP entry uncompressed size mismatch: ${entry.path}`);
    if (crc32(data) !== entry.crc) fail(`ZIP entry CRC-32 mismatch: ${entry.path}`);
    entry.data = data;
    localRanges.push({ start: entry.localOffset, end: dataEnd, path: entry.path });
  }
  localRanges.sort((left, right) => left.start - right.start);
  let expectedOffset = 0;
  for (const range of localRanges) {
    if (range.start !== expectedOffset) fail(`ZIP contains a gap or overlap before local entry: ${range.path}`);
    expectedOffset = range.end;
  }
  if (expectedOffset !== centralOffset) fail('ZIP contains data outside its deterministic entries');
  return files;
}

function validatePackageEntries(entries, archiveBytes) {
  const pathSet = new Set(entries.map((entry) => entry.path));
  if (!pathSet.has('SKILL.md')) fail('ZIP must contain SKILL.md at the archive root');
  const skillFiles = entries.filter((entry) => path.posix.basename(entry.path).toLowerCase() === 'skill.md');
  if (skillFiles.length !== 1 || skillFiles[0].path !== 'SKILL.md') {
    fail('ZIP must contain exactly one SKILL.md, at the archive root');
  }
  for (const required of [MANIFEST_PATH, ...OWNERSHIP_PATHS]) {
    if (!pathSet.has(required)) fail(`ZIP is missing generated competition file: ${required}`);
  }

  const sortedPaths = entries.map((entry) => entry.path).sort(compareUtf8Paths);
  if (!entries.every((entry, index) => entry.path === sortedPaths[index])) {
    fail('ZIP entries are not in deterministic UTF-8 path order');
  }
  for (const entry of entries) {
    assertAllowedExtension(entry.path);
    const reason = pathSecurityReason(entry.path, false);
    if (reason) fail(`Forbidden competition package path (${reason}): ${entry.path}`);
    if (entry.method !== ZIP_STORE_METHOD
      || entry.versionMadeBy !== 0x0314
      || entry.versionNeeded !== 20
      || entry.flags !== UTF8_ZIP_FLAG
      || entry.dosTime !== FIXED_DOS_TIME
      || entry.dosDate !== FIXED_DOS_DATE
      || entry.extraLength !== 0
      || entry.localExtraLength !== 0
      || entry.entryCommentLength !== 0
      || entry.internalAttributes !== 0
      || entry.externalAttributes !== ((FILE_MODE * 0x10000) >>> 0)) {
      fail(`ZIP entry does not use the deterministic package profile: ${entry.path}`);
    }
    entry.text = validateFileContent(entry.data, entry.path);
  }
  for (const ownershipPath of OWNERSHIP_PATHS) {
    const ownership = entries.find((entry) => entry.path === ownershipPath);
    if (/\bTODO\b|\[\s\]|待确认/iu.test(ownership.text)) {
      fail(`Ownership inventory is not submission-ready: ${ownershipPath}`);
    }
  }
  assertPortableProfileEntries(entries);

  const skill = parseSkillFrontmatter(entries.find((entry) => entry.path === 'SKILL.md').text);
  const manifestEntry = entries.find((entry) => entry.path === MANIFEST_PATH);
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.text);
  } catch (error) {
    fail(`Competition manifest is not valid JSON: ${error.message}`);
  }
  if (manifestEntry.text !== canonicalJson(manifest)) fail('Competition manifest is not canonical pretty-printed JSON');
  assertExactObjectKeys(manifest, [
    'schema', 'profile', 'officialGuide', 'rootSkill', 'digestAlgorithm', 'manifestPath',
    'manifestSelfHashExcluded', 'deterministicZip', 'limits', 'allowedExtensions',
    'portableProfile', 'thirdPartyComponents', 'generatedOwnershipTemplates', 'pathTransforms', 'fileCount', 'entries',
  ], 'Competition manifest');
  assertExactObjectKeys(manifest.deterministicZip, [
    'entryOrder', 'timestamp', 'compression', 'unixMode',
  ], 'Competition manifest deterministicZip');
  assertExactObjectKeys(manifest.limits, [
    'maxArchiveBytes', 'maxUncompressedBytes', 'maxFileBytes', 'maxFiles',
  ], 'Competition manifest limits');
  assertExactObjectKeys(manifest.portableProfile, [
    'name', 'sourceSkill', 'rootSkill', 'runtimeScripts', 'explicitInputOnly',
    'readsHomeDirectory', 'queriesSignedInAccount', 'invokesPackageManagers',
    'launchesBrowser', 'networkAccess', 'excludedCapabilities',
  ], 'Competition manifest portableProfile');
  if (!Array.isArray(manifest.thirdPartyComponents)) {
    fail('Competition manifest thirdPartyComponents must be an array');
  }
  for (const [index, component] of manifest.thirdPartyComponents.entries()) {
    assertExactObjectKeys(component, [
      'name', 'version', 'license', 'role', 'upstream', 'archivePaths',
    ], `Competition manifest third-party component ${index}`);
    if (typeof component.name !== 'string'
      || typeof component.version !== 'string'
      || typeof component.license !== 'string'
      || typeof component.role !== 'string'
      || typeof component.upstream !== 'string'
      || !Array.isArray(component.archivePaths)
      || component.archivePaths.some((archivePath) => typeof archivePath !== 'string' || !pathSet.has(archivePath))) {
      fail(`Competition manifest third-party component ${index} has invalid field values`);
    }
  }
  if (manifest?.schema !== 'iflytek.competition-package.manifest.v1'
    || manifest.profile !== 'iflytek-skillhub-2026-portable'
    || manifest.officialGuide !== OFFICIAL_GUIDE_URL
    || manifest.rootSkill !== 'SKILL.md'
    || manifest.digestAlgorithm !== 'sha256'
    || manifest.manifestPath !== MANIFEST_PATH
    || manifest.manifestSelfHashExcluded !== true) {
    fail('Competition manifest header is invalid');
  }
  if (manifest.deterministicZip.entryOrder !== 'utf8-path-ascending'
    || manifest.deterministicZip.timestamp !== '1980-01-01T00:00:00.000Z'
    || manifest.deterministicZip.compression !== 'store'
    || manifest.deterministicZip.unixMode !== '0644') {
    fail('Competition manifest deterministicZip profile is invalid');
  }
  if (JSON.stringify(manifest.limits) !== JSON.stringify(COMPETITION_LIMITS)
    || JSON.stringify(manifest.allowedExtensions) !== JSON.stringify(ALLOWED_EXTENSIONS)
    || JSON.stringify(manifest.portableProfile) !== JSON.stringify(PORTABLE_PROFILE_MANIFEST)
    || JSON.stringify(manifest.thirdPartyComponents) !== JSON.stringify(THIRD_PARTY_COMPONENTS)
    || JSON.stringify(manifest.generatedOwnershipTemplates) !== JSON.stringify(OWNERSHIP_PATHS)) {
    fail('Competition manifest constraints diverge from the official packaging profile');
  }
  if (manifest.fileCount !== entries.length || entries.length > COMPETITION_LIMITS.maxFiles) {
    fail('Competition manifest file count is invalid');
  }
  if (!Array.isArray(manifest.entries) || manifest.entries.length !== entries.length - 1) {
    fail('Competition manifest entry list has the wrong length');
  }
  for (const [index, manifestFile] of manifest.entries.entries()) {
    assertExactObjectKeys(manifestFile, ['path', 'bytes', 'sha256'], `Competition manifest entry ${index}`);
    if (typeof manifestFile.path !== 'string'
      || !Number.isSafeInteger(manifestFile.bytes)
      || manifestFile.bytes < 0
      || !/^[0-9a-f]{64}$/u.test(manifestFile.sha256)) {
      fail(`Competition manifest entry ${index} has invalid field values`);
    }
  }
  const expectedEntries = entries
    .filter((entry) => entry.path !== MANIFEST_PATH)
    .map((entry) => ({ path: entry.path, bytes: entry.data.length, sha256: sha256(entry.data) }))
    .sort((left, right) => compareUtf8Paths(left.path, right.path));
  if (JSON.stringify(manifest.entries) !== JSON.stringify(expectedEntries)) {
    fail('Competition manifest SHA-256 entries do not match the ZIP contents');
  }
  if (!Array.isArray(manifest.pathTransforms)) fail('Competition manifest pathTransforms must be an array');
  const transformKeys = new Set();
  for (const transform of manifest.pathTransforms) {
    assertExactObjectKeys(transform, ['source', 'archive', 'kind'], 'Competition manifest path transform');
    if (typeof transform.source !== 'string'
      || typeof transform.archive !== 'string'
      || typeof transform.kind !== 'string'
      || pathSet.has(transform.source)
      || !pathSet.has(transform.archive)) {
      fail('Competition manifest contains an invalid path transform');
    }
    const key = `${transform.source}\u0000${transform.archive}`;
    if (transformKeys.has(key)) fail('Competition manifest contains a duplicate path transform');
    transformKeys.add(key);
    if (transform.kind === 'allowed-extension') {
      if (!EXTENSIONLESS_LICENSE_PATTERN.test(path.posix.basename(transform.source))
        || transform.archive !== expectedArchiveForTransformSource(transform.source)) {
        fail('Competition manifest contains an invalid license-path transform');
      }
    } else if (transform.kind === 'portable-root') {
      if (!PORTABLE_REQUIRED_MAPPINGS.some((mapping) => mapping.kind === 'portable-root'
        && mapping.source === transform.source
        && mapping.archive === transform.archive)) {
        fail('Competition manifest contains an invalid portable-root transform');
      }
    } else if (transform.kind === 'portable-reference') {
      const validReference = PORTABLE_OPTIONAL_DIRECTORIES.some((mapping) => {
        const prefix = `${mapping.source}/`;
        return transform.source.startsWith(prefix)
          && transform.archive === `${mapping.archive}/${transform.source.slice(prefix.length)}`;
      });
      if (!validReference) fail('Competition manifest contains an invalid portable-reference transform');
    } else {
      fail(`Competition manifest contains an unsupported transform kind: ${transform.kind}`);
    }
  }
  for (const mapping of PORTABLE_REQUIRED_MAPPINGS.filter((candidate) => candidate.source !== candidate.archive)) {
    if (!manifest.pathTransforms.some((transform) => transform.source === mapping.source
      && transform.archive === mapping.archive
      && transform.kind === mapping.kind)) {
      fail(`Competition manifest is missing required path transform: ${mapping.source}`);
    }
  }
  assertNoStaleRenamedReferences(entries, manifest.pathTransforms);
  return {
    archiveBytes,
    uncompressedBytes: entries.reduce((total, entry) => total + entry.data.length, 0),
    archiveSha256: null,
    fileCount: entries.length,
    skillName: skill.name,
    skillVersion: skill.version,
    manifest,
    paths: entries.map((entry) => entry.path),
    warnings: [],
  };
}

function atomicWrite(filePath, data, mode = 0o600) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(filePath)}.tmp-${process.pid}`);
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

export function validateCompetitionArchiveBuffer(buffer) {
  const entries = parseZip(buffer);
  const result = validatePackageEntries(entries, buffer.length);
  result.archiveSha256 = sha256(buffer);
  return result;
}

export function validateCompetitionArchive(archivePath) {
  const resolved = path.resolve(archivePath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (error) {
    fail(`Competition ZIP is not readable: ${resolved} (${error.message})`);
  }
  if (!stat.isFile()) fail(`Competition ZIP is not a regular file: ${resolved}`);
  if (stat.size > COMPETITION_LIMITS.maxArchiveBytes) {
    fail(`ZIP exceeds the 100 MB limit: ${stat.size} bytes`);
  }
  const result = validateCompetitionArchiveBuffer(fs.readFileSync(resolved));
  result.archivePath = resolved;
  return result;
}

export function buildCompetitionArchive({ sourceDir, outputPath, sha256OutputPath = null }) {
  const resolvedSource = fs.realpathSync(path.resolve(sourceDir));
  const sourceStat = fs.statSync(resolvedSource);
  if (!sourceStat.isDirectory()) fail(`Competition source is not a directory: ${resolvedSource}`);
  const resolvedOutput = path.resolve(outputPath);
  if (path.extname(resolvedOutput).toLowerCase() !== '.zip') fail('--output must end in .zip');
  const resolvedSha256Output = path.resolve(sha256OutputPath ?? `${resolvedOutput}.sha256.txt`);
  if (resolvedOutput === resolvedSha256Output) fail('ZIP output and SHA-256 sidecar must be different paths');
  const ignoredAbsolutePaths = new Set([resolvedOutput, resolvedSha256Output]);
  const { candidates, excluded } = collectPortableCandidates(resolvedSource, ignoredAbsolutePaths);
  assertCandidatePreflightLimits(candidates);
  const transforms = candidates
    .filter((entry) => entry.sourcePath !== entry.path)
    .map((entry) => ({ source: entry.sourcePath, archive: entry.path, kind: entry.kind }))
    .sort((left, right) => compareUtf8Paths(left.source, right.source));
  let entries = candidates.map((candidate) => {
    const original = fs.readFileSync(candidate.absolutePath);
    let data = original;
    if (TEXT_EXTENSIONS.has(extensionFor(candidate.path))) {
      const text = decodeUtf8(original, candidate.sourcePath);
      data = Buffer.from(rewriteRenamedReferences(text, transforms, candidate.path), 'utf8');
    }
    if (data.length > COMPETITION_LIMITS.maxFileBytes) {
      fail(`Transformed file exceeds the 10 MB limit (${data.length} bytes): ${candidate.path}`);
    }
    const validatedText = validateFileContent(data, candidate.path);
    return { path: candidate.path, data, text: validatedText, sourcePath: candidate.sourcePath };
  });
  assertUniquePaths(entries);
  const skillEntry = entries.find((entry) => entry.path === 'SKILL.md');
  const skill = parseSkillFrontmatter(skillEntry.text);
  entries.push(...ownershipEntries(skill.name));
  for (const entry of entries.filter((candidate) => candidate.generated)) {
    entry.text = validateFileContent(entry.data, entry.path);
  }
  assertUniquePaths(entries);
  assertNoStaleRenamedReferences(entries, transforms);
  assertPortableProfileEntries(entries);
  if (entries.length + 1 > COMPETITION_LIMITS.maxFiles) {
    fail(`Package would exceed the 500-file limit after generated files: ${entries.length + 1}`);
  }
  const manifest = createManifest(entries, transforms);
  const manifestData = Buffer.from(canonicalJson(manifest), 'utf8');
  entries.push({ path: MANIFEST_PATH, data: manifestData, text: decodeUtf8(manifestData, MANIFEST_PATH), generated: true });
  entries.sort((left, right) => compareUtf8Paths(left.path, right.path));
  assertUniquePaths(entries);
  const uncompressedBytes = entries.reduce((total, entry) => total + entry.data.length, 0);
  if (uncompressedBytes > COMPETITION_LIMITS.maxUncompressedBytes) {
    fail(`Package exceeds the 100 MB uncompressed-content limit: ${uncompressedBytes} bytes`);
  }
  const archive = buildStoredZip(entries);
  if (archive.length > COMPETITION_LIMITS.maxArchiveBytes) {
    fail(`ZIP exceeds the 100 MB limit after packaging: ${archive.length} bytes`);
  }
  const validation = validateCompetitionArchiveBuffer(archive);
  atomicWrite(resolvedOutput, archive);
  const digestLine = `${validation.archiveSha256}  ${path.basename(resolvedOutput)}\n`;
  atomicWrite(resolvedSha256Output, Buffer.from(digestLine, 'utf8'));
  return {
    ...validation,
    archivePath: resolvedOutput,
    sha256Path: resolvedSha256Output,
    excluded,
  };
}
