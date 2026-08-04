#!/usr/bin/env node

import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) args[key] = true;
    else { args[key] = value; index += 1; }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.data || !args.output) throw new Error("Usage: node build-report.mjs --data <report-data.json> --output <report.html>");
const skillRoot = resolve(import.meta.dirname, "..");
const templatePath = resolve(args.template || resolve(skillRoot, "assets/report.template.html"));
const dataPath = resolve(args.data);
const echartsPath = resolve(args.echarts || resolve(skillRoot, "assets/vendor/echarts/echarts.min.js"));
const outputPath = resolve(args.output);
const distributionNoticePaths = [
  ["Codex Consumption Report LICENSE", resolve(skillRoot, "LICENSE")],
  ["Codex Consumption Report NOTICE", resolve(skillRoot, "NOTICE")],
  ["Apache ECharts LICENSE", resolve(skillRoot, "assets/vendor/echarts/LICENSE.txt")],
  ["Apache ECharts NOTICE", resolve(skillRoot, "assets/vendor/echarts/NOTICE.txt")],
  ["d3 BSD 3-Clause LICENSE", resolve(skillRoot, "assets/vendor/echarts/licenses/LICENSE-d3")],
];
const SESSION_PSEUDONYM_PATTERN = /^session-[0-9a-f]{12}$/;
const UUID_PATTERN = /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/giu;

const data = JSON.parse(readFileSync(dataPath, "utf8"));
let html = readFileSync(templatePath, "utf8");
const echarts = readFileSync(echartsPath, "utf8").replaceAll("</script", "<\\/script");
const distributionNotices = distributionNoticePaths
  .map(([label, file]) => `===== ${label} =====\n${readFileSync(file, "utf8").trimEnd()}`)
  .join("\n\n");
if (distributionNotices.includes("--")) throw new Error("Distribution notices cannot be embedded safely in an HTML comment");

function writePrivateAtomic(path, contents) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

for (const [index, session] of (data.sessions ?? []).entries()) {
  if (!SESSION_PSEUDONYM_PATTERN.test(String(session.id ?? "")) || session.shortId !== session.id) {
    throw new Error(`Session row ${index} does not contain one consistent pseudonym`);
  }
}
for (const [index, fact] of (data.filterFacts ?? []).entries()) {
  if (!SESSION_PSEUDONYM_PATTERN.test(String(fact.sessionId ?? "")) || fact.shortId !== fact.sessionId) {
    throw new Error(`Interactive fact ${index} does not contain one consistent session pseudonym`);
  }
}
const dataText = JSON.stringify(data);
if (UUID_PATTERN.test(dataText)) throw new Error("Report data contains a UUID-shaped identifier");
if (/(?:file:\/\/|(?:^|["'])\/(?:Users|home)\/|[A-Za-z]:\\\\)/i.test(dataText)) {
  throw new Error("Report data contains an absolute local path");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value, digits = 2) {
  return "$" + Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function compact(value, digits = 1) {
  const number = Number(value);
  if (Math.abs(number) >= 1e9) return (number / 1e9).toFixed(digits) + "B";
  if (Math.abs(number) >= 1e6) return (number / 1e6).toFixed(digits) + "M";
  if (Math.abs(number) >= 1e3) return (number / 1e3).toFixed(digits) + "k";
  return number.toLocaleString("en-US");
}

function compactZh(value, digits = 2) {
  const number = Number(value);
  if (Math.abs(number) >= 1e8) return (number / 1e8).toFixed(digits) + "亿";
  if (Math.abs(number) >= 1e4) return (number / 1e4).toFixed(digits) + "万";
  return number.toLocaleString("zh-CN");
}

function percent(value, digits = 1) {
  return (Number(value) * 100).toFixed(digits) + "%";
}

function zhDate(dateString, includeYear = false) {
  const [year, month, day] = String(dateString).slice(0, 10).split("-").map(Number);
  return (includeYear ? year + "年" : "") + month + "月" + day + "日";
}

function zhMonth(monthString, includeYear = false) {
  const [year, month] = String(monthString).split("-").map(Number);
  return (includeYear ? year + "年" : "") + month + "月";
}

function table(headers, rows) {
  const head = "<thead><tr>" + headers.map((header) => {
    const objectHeader = typeof header === "object" && header !== null;
    const value = objectHeader ? header.value : header;
    const numeric = objectHeader && header.numeric;
    const title = objectHeader && header.title ? ' title="' + esc(header.title) + '"' : "";
    return '<th scope="col" class="' + (numeric ? "num" : "") + '"' + title + ">" + esc(value) + "</th>";
  }).join("") + "</tr></thead>";
  const body = "<tbody>" + rows.map((row) => {
    return "<tr>" + row.map((cell) => {
      const value = typeof cell === "object" && cell !== null ? cell.value : cell;
      const numeric = typeof cell === "object" && cell !== null && cell.numeric;
      return '<td class="' + (numeric ? "num" : "") + '">' + esc(value) + "</td>";
    }).join("") + "</tr>";
  }).join("") + "</tbody>";
  return "<table>" + head + body + "</table>";
}

const generated = new Date(data.meta.generatedAt);
const reconstruction = data.summary.reconstruction ?? {
  officialTokens: data.summary.tokens,
  reconstructedTokens: data.summary.tokens,
  netGapTokens: 0,
  reconstructedToOfficialRatio: 1,
  projectTokenCoverage: 1,
  activityTokenCoverage: 1,
};
const officialRows = data.officialDaily?.length
  ? data.officialDaily
  : data.daily.map((row) => ({ date: row.date, tokens: row.tokens }));
const hasOfficialSource = data.meta?.officialSourceAvailable === true;
const officialActiveDays = officialRows.filter((row) => Number(row.tokens || 0) > 0).length;
const officialDailyAverage = reconstruction.officialTokens / Math.max(1, officialRows.length);
const officialPeakDay = data.facts.officialPeakDay
  ?? [...officialRows].sort((a, b) => Number(b.tokens || 0) - Number(a.tokens || 0))[0]
  ?? { date: data.meta.rangeStart, tokens: 0 };
const generatedLocal = new Intl.DateTimeFormat("zh-CN", {
  timeZone: data.meta.timezone,
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).format(generated);

const rangeLabel = zhDate(data.meta.rangeStart, true) + "—" + zhDate(data.meta.rangeEnd);
const topTwoProjectCost = data.projects.slice(0, 2).reduce((sum, row) => sum + row.cost, 0);
const peakHeat = [...data.heatmap].sort((a, b) => b.tokens - a.tokens)[0];
const weekdayLabels = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };
const activityLabels = {
  Coding: "编码",
  Delegation: "任务委派",
  Exploration: "探索",
  Conversation: "对话",
  "Feature Dev": "功能开发",
  Brainstorming: "方案构思",
  Debugging: "调试",
  Testing: "测试",
  Refactoring: "重构",
  "Git Ops": "Git 操作",
};
const activityLabel = (value) => activityLabels[value] || value;
const projectLabel = (value) => value === "Codex scratch" ? "Codex 临时工作区" : value;
const topProjectPair = [data.facts.topProject, data.facts.secondProject].filter(Boolean).map(projectLabel).join(" 与 ");
const topActivityPair = data.facts.topActivities.map(activityLabel).join("、");
const dominantComparison = data.facts.previousMonth && data.facts.dominantVsPrevious != null
  ? `约为 ${zhMonth(data.facts.previousMonth)}的 ${data.facts.dominantVsPrevious.toFixed(1)}×`
  : "没有可比的前一月基线";
const partialMonths = data.months.filter((row) => row.isPartial).map((row) => zhMonth(row.month));
const monthScopeNote = partialMonths.length ? `；${partialMonths.join("、")}为不完整月份` : "";

const dailyTableHeaders = hasOfficialSource
  ? [
      "日期",
      { value: "估算成本", numeric: true },
      { value: "调用", numeric: true },
      { value: "会话", numeric: true },
      { value: "官方账户 Token", numeric: true, title: "Codex 官方账户 Token 活动" },
      { value: "本地重建 Token", numeric: true, title: "新输入 + 输出 + 缓存读取 + 缓存写入" },
      { value: "缓存读取", numeric: true },
    ]
  : [
      "日期",
      { value: "估算成本", numeric: true },
      { value: "调用", numeric: true },
      { value: "会话", numeric: true },
      { value: "已采集本地 Token", numeric: true, title: "当前本地 CodeBurn 快照" },
      { value: "缓存读取", numeric: true },
    ];
const dailyTable = table(
  dailyTableHeaders,
  data.daily.map((row) => {
    const common = [
      zhDate(row.date, true),
      { value: money(row.cost), numeric: true },
      { value: row.calls.toLocaleString("en-US"), numeric: true },
      { value: row.sessions, numeric: true },
    ];
    return hasOfficialSource
      ? [
          ...common,
          { value: (row.officialTokens ?? row.tokens).toLocaleString("en-US"), numeric: true },
          { value: row.tokens.toLocaleString("en-US"), numeric: true },
          { value: row.cacheRead.toLocaleString("en-US"), numeric: true },
        ]
      : [
          ...common,
          { value: row.tokens.toLocaleString("en-US"), numeric: true },
          { value: row.cacheRead.toLocaleString("en-US"), numeric: true },
        ];
  }),
);

const projectTable = table(
  [
    { value: "排名", numeric: true },
    "项目",
    { value: "估算成本", numeric: true },
    { value: "占比", numeric: true },
    { value: "累计占比", numeric: true },
    { value: "调用", numeric: true },
    { value: "会话", numeric: true },
  ],
  data.projects.map((row) => [
    { value: row.rank, numeric: true },
    projectLabel(row.name),
    { value: money(row.cost), numeric: true },
    { value: percent(row.share), numeric: true },
    { value: percent(row.cumulativeShare), numeric: true },
    { value: row.calls.toLocaleString("en-US"), numeric: true },
    { value: row.sessions, numeric: true },
  ]),
);

const modelTable = table(
  [
    "模型",
    { value: "估算成本", numeric: true },
    { value: "占比", numeric: true },
    { value: "调用", numeric: true },
    { value: "Token 总量", numeric: true },
    "首次日期",
  ],
  data.models.map((row) => [
    row.model,
    { value: money(row.cost), numeric: true },
    { value: percent(row.share, row.share < 0.001 ? 2 : 1), numeric: true },
    { value: row.calls.toLocaleString("en-US"), numeric: true },
    { value: row.tokens.toLocaleString("en-US"), numeric: true },
    row.firstDate ? zhDate(row.firstDate, true) : "—",
  ]),
);
const activityTable = table(
  ["任务类型", { value: "估算成本", numeric: true }, { value: "占比", numeric: true }, { value: "模型调用", numeric: true }],
  data.activities.map((row) => [
    activityLabel(row.activity),
    { value: money(row.cost), numeric: true },
    { value: percent(row.share), numeric: true },
    { value: row.calls.toLocaleString("en-US"), numeric: true },
  ]),
);
const modelActivityTable = '<div style="display:grid;gap:22px"><div><h4 style="margin:0 0 8px">模型</h4>' +
  modelTable + '</div><div><h4 style="margin:0 0 8px">任务类型</h4>' + activityTable + "</div></div>";

const sessionTable = table(
  [
    { value: "排名", numeric: true },
    "范围内首次调用日期",
    "项目",
    { value: "估算成本", numeric: true },
    { value: "占本范围估算成本", numeric: true },
    { value: "模型调用", numeric: true },
    { value: "Token 总量", numeric: true },
  ],
  data.sessions.map((row) => [
    { value: row.rank, numeric: true },
    zhDate(row.date, true),
    projectLabel(row.project),
    { value: money(row.cost), numeric: true },
    { value: percent(data.summary.cost ? row.cost / data.summary.cost : 0), numeric: true },
    { value: row.calls.toLocaleString("en-US"), numeric: true },
    { value: row.tokens.toLocaleString("en-US"), numeric: true },
  ]),
);

const replacements = {
  RANGE_LABEL: rangeLabel,
  GENERATED_LOCAL: generatedLocal,
  TIMEZONE: esc(data.meta.timezone),
  TOTAL_COST: money(data.summary.cost),
  TOTAL_TOKENS: compactZh(reconstruction.officialTokens),
  OFFICIAL_DAILY_AVERAGE: compactZh(officialDailyAverage),
  OFFICIAL_ACTIVE_DAYS: officialActiveDays,
  OFFICIAL_PEAK_DATE: zhDate(officialPeakDay.date),
  RECONSTRUCTED_TOKENS: compact(reconstruction.reconstructedTokens, 2),
  FULL_LOCAL_LEDGER_TOKENS: compactZh(reconstruction.fullLocalLedgerTokens ?? reconstruction.reconstructedTokens, 2),
  OUTSIDE_OFFICIAL_DATE_TOKENS: compactZh(reconstruction.outsideOfficialDateRangeTokens ?? 0, 2),
  NET_GAP_TOKENS: compact(Math.abs(reconstruction.netGapTokens), 2),
  RECONSTRUCTION_RATIO: percent(reconstruction.reconstructedToOfficialRatio),
  PROJECT_TOKEN_COVERAGE: percent(reconstruction.projectTokenCoverage),
  ACTIVITY_TOKEN_COVERAGE: percent(reconstruction.activityTokenCoverage),
  OFFICIAL_PEAK_TOKENS: compactZh(officialPeakDay.tokens),
  TOTAL_CALLS: compact(data.summary.calls, 1),
  SESSION_COUNT: data.summary.sessions,
  ACTIVE_DAYS: officialActiveDays,
  CALENDAR_DAYS: data.summary.calendarDays,
  CODEBURN_VERSION: esc(data.meta.codeburnVersion),
  DOMINANT_MONTH: zhMonth(data.facts.dominantMonth),
  DOMINANT_COST: money(data.facts.dominantMonthCost),
  DOMINANT_SHARE: percent(data.facts.dominantMonthShare),
  DOMINANT_COMPARISON: dominantComparison,
  COST_BEFORE_DOMINANT: money(data.facts.costBeforeDominant),
  MONTH_SCOPE_NOTE: monthScopeNote,
  PEAK_DATE: zhDate(data.facts.peakDay.date),
  PEAK_COST: money(data.facts.peakDay.cost),
  PEAK_CALLS: data.facts.peakDay.calls.toLocaleString("en-US"),
  CACHE_SHARE: percent(data.facts.cacheTokenShare),
  CACHE_WRITE_SHARE: percent(data.facts.cacheWriteTokenShare, 2),
  INPUT_SHARE: percent(data.facts.inputTokenShare),
  OUTPUT_SHARE: percent(data.facts.outputTokenShare, 2),
  CACHE_SHARE_RAW: (data.facts.cacheTokenShare * 100).toFixed(6),
  CACHE_WRITE_SHARE_RAW: (data.facts.cacheWriteTokenShare * 100).toFixed(6),
  INPUT_SHARE_RAW: (data.facts.inputTokenShare * 100).toFixed(6),
  OUTPUT_SHARE_RAW: (data.facts.outputTokenShare * 100).toFixed(6),
  NON_CACHE_SHARE: percent(data.facts.inputTokenShare + data.facts.outputTokenShare),
  INPUT_WITHIN_NON_CACHE_RAW: ((data.facts.inputTokenShare / Math.max(Number.EPSILON, data.facts.inputTokenShare + data.facts.outputTokenShare)) * 100).toFixed(6),
  OUTPUT_WITHIN_NON_CACHE_RAW: ((data.facts.outputTokenShare / Math.max(Number.EPSILON, data.facts.inputTokenShare + data.facts.outputTokenShare)) * 100).toFixed(6),
  INPUT_WITHIN_NON_CACHE_SHARE: percent(data.facts.inputTokenShare / Math.max(Number.EPSILON, data.facts.inputTokenShare + data.facts.outputTokenShare)),
  OUTPUT_WITHIN_NON_CACHE_SHARE: percent(data.facts.outputTokenShare / Math.max(Number.EPSILON, data.facts.inputTokenShare + data.facts.outputTokenShare)),
  INPUT_TOKENS: compact(data.summary.tokenComponents.input, 2),
  OUTPUT_TOKENS: compact(data.summary.tokenComponents.output, 2),
  CACHE_TOKENS: compact(data.summary.tokenComponents.cacheRead, 2),
  CACHE_WRITE_TOKENS: compact(data.summary.tokenComponents.cacheWrite, 2),
  TOP2_PROJECT_SHARE: percent(data.facts.topTwoProjectShare),
  TOP2_PROJECT_COST: money(topTwoProjectCost),
  TOP5_PROJECT_SHARE: percent(data.facts.topFiveProjectShare),
  TOP_PROJECT: esc(projectLabel(data.facts.topProject)),
  SECOND_PROJECT: esc(projectLabel(data.facts.secondProject || "—")),
  TOP_PROJECT_PAIR: esc(topProjectPair),
  TOP_MODEL: esc(data.facts.topModel),
  TOP_MODEL_SHARE: percent(data.facts.topModelShare),
  TOP_MODEL_FIRST_DATE: data.facts.topModelFirstDate ? zhDate(data.facts.topModelFirstDate) : "未记录",
  TOP_ACTIVITY_PAIR: esc(topActivityPair),
  TOP_ACTIVITY_SHARE: percent(data.facts.codingDelegationShare),
  TOP5_SESSION_SHARE: percent(data.facts.topFiveSessionShare),
  TOP10_SESSION_SHARE: percent(data.facts.topTenSessionShare),
  TOP10_DAY_SHARE: percent(data.facts.topTenDayShare),
  ACTIVE_DAY_MEDIAN: money(data.facts.activeDayMedianCost),
  ACTIVE_DAY_P95: money(data.facts.activeDayP95Cost),
  SESSION_MEDIAN: money(data.facts.sessionMedianCost),
  SESSION_P95: money(data.facts.sessionP95Cost),
  TOP_SESSION_COST: money(data.sessions[0].cost),
  TOP_SESSION_DATE: zhDate(data.sessions[0].date, true),
  TOP_SESSION_PROJECT: esc(projectLabel(data.facts.topSessionProject)),
  NIGHT_TOKEN_SHARE: percent(data.facts.nightTokenShare),
  WEEKEND_TOKEN_SHARE: percent(data.facts.weekendTokenShare),
  HEAT_PEAK_LABEL: weekdayLabels[peakHeat.weekday] + " " + String(peakHeat.hour).padStart(2, "0") + ":00",
  HEAT_PEAK_TOKENS: compact(peakHeat.tokens, 2) + " Token",
  DAILY_TABLE: dailyTable,
  PROJECT_TABLE: projectTable,
  MODEL_ACTIVITY_TABLE: modelActivityTable,
  SESSION_TABLE: sessionTable,
};

for (const [key, value] of Object.entries(replacements)) {
  html = html.replaceAll("{{" + key + "}}", String(value));
}

html = html.replace("/*__ECHARTS__*/", echarts);
const serializedData = JSON.stringify(data)
  .replaceAll("<", "\\u003c")
  .replaceAll("\u2028", "\\u2028")
  .replaceAll("\u2029", "\\u2029");
html = html.replace("/*__REPORT_DATA__*/", serializedData);
html = html.replace("</head>", `<!--\n${distributionNotices}\n-->\n</head>`);

const unreplaced = [...html.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((match) => match[1]);
if (unreplaced.length) {
  throw new Error("Unreplaced report placeholders: " + [...new Set(unreplaced)].join(", "));
}
if (html.includes("/*__ECHARTS__*/") || html.includes("/*__REPORT_DATA__*/")) {
  throw new Error("Runtime placeholders were not replaced.");
}

if (UUID_PATTERN.test(html)) throw new Error("Built report contains a UUID-shaped identifier");
writePrivateAtomic(outputPath, html);
console.log(JSON.stringify({
  output: outputPath,
  bytes: Buffer.byteLength(html),
  generatedAt: data.meta.generatedAt,
  charts: 8,
  dynamic: true,
  externalResources: 0,
}, null, 2));
