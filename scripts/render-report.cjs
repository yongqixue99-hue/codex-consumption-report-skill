const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { pathToFileURL } = require("url");

process.umask(0o077);

const OUTPUT_MARKER = ".codex-consumption-report-output";
const OUTPUT_MARKER_SCHEMA = "codex.consumption.output.v1";
const MANIFEST_SCHEMA = "codex.consumption.report.manifest.v1";
const VALUE_OPTIONS = new Set(["report", "output-dir", "chrome"]);
const BOOLEAN_OPTIONS = new Set(["replace-output"]);

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (BOOLEAN_OPTIONS.has(key)) args[key] = true;
    else if (VALUE_OPTIONS.has(key)) {
      if (!value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
      args[key] = value;
      index += 1;
    } else throw new Error(`Unknown option: --${key}`);
  }
  return args;
}

function isRegularFile(file) {
  try {
    const info = fs.lstatSync(file);
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function isOwnedOutputDirectory(directory) {
  const markerPath = path.resolve(directory, OUTPUT_MARKER);
  if (isRegularFile(markerPath)) {
    try {
      if (JSON.parse(fs.readFileSync(markerPath, "utf8")).schema === OUTPUT_MARKER_SCHEMA) return true;
    } catch {
      // A malformed marker is not proof of ownership.
    }
  }
  const manifestPath = path.resolve(directory, "codex-consumption-manifest.json");
  const priorReportPath = path.resolve(directory, "codex-consumption-report.html");
  if (!isRegularFile(manifestPath) || !isRegularFile(priorReportPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return manifest.schema === MANIFEST_SCHEMA
      && path.basename(String(manifest.report?.path || "")) === "codex-consumption-report.html"
      && /^[0-9a-f]{64}$/.test(String(manifest.report?.sha256 || ""))
      && sha256(priorReportPath) === manifest.report.sha256;
  } catch {
    return false;
  }
}

function writeOwnershipMarker(directory) {
  const markerPath = path.resolve(directory, OUTPUT_MARKER);
  if (fs.existsSync(markerPath) && !isRegularFile(markerPath)) {
    throw new Error(`Output ownership marker must be a regular file: ${markerPath}`);
  }
  const temporaryPath = `${markerPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify({ schema: OUTPUT_MARKER_SCHEMA })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporaryPath, markerPath);
    fs.chmodSync(markerPath, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function prepareOutputDirectory(directory, replaceOutput) {
  if (fs.existsSync(directory)) {
    const info = fs.lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error(`Output directory must not be a symbolic link: ${directory}`);
    if (!info.isDirectory()) throw new Error(`Output path is not a directory: ${directory}`);
    if (fs.readdirSync(directory).length > 0 && !replaceOutput && !isOwnedOutputDirectory(directory)) {
      throw new Error(`Output directory is not empty and is not owned by this Skill: ${directory}. Choose an empty directory or pass --replace-output explicitly.`);
    }
  } else fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  writeOwnershipMarker(directory);
}

const args = parseArgs(process.argv.slice(2));
if (!args.report) throw new Error("Usage: node render-report.cjs --report <report.html> [--output-dir <dir>] [--chrome <path>] [--replace-output]");
const reportPath = path.resolve(args.report);
const finalOutputDirectory = path.resolve(args["output-dir"] || path.dirname(reportPath));
if (!isRegularFile(reportPath)) throw new Error(`Report is not a regular file: ${reportPath}`);
const reportUrl = pathToFileURL(reportPath).href;
const programFiles = process.env.PROGRAMFILES || process.env.ProgramFiles;
const programFilesX86 = process.env["PROGRAMFILES(X86)"] || process.env["ProgramFiles(x86)"];
const localAppData = process.env.LOCALAPPDATA || process.env.LocalAppData;
const chromeCandidates = [
  args.chrome,
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
  "/snap/bin/chromium",
  "/opt/google/chrome/chrome",
  programFiles && path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
  programFilesX86 && path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
  localAppData && path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe"),
  programFiles && path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
  programFilesX86 && path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
].filter(Boolean);
const chromePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!chromePath) throw new Error("Chrome, Chromium, or Edge was not found; pass --chrome <executable-path>");
prepareOutputDirectory(finalOutputDirectory, Boolean(args["replace-output"]));
const outputDirectory = path.resolve(
  finalOutputDirectory,
  `.codex-render-stage-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
);
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
fs.chmodSync(outputDirectory, 0o700);
let renderPublished = false;
process.on("exit", () => {
  if (!renderPublished && fs.existsSync(outputDirectory)) {
    try {
      const info = fs.lstatSync(outputDirectory);
      if (info.isDirectory() && !info.isSymbolicLink()) fs.rmSync(outputDirectory, { recursive: true, force: true });
    } catch {
      // Preserve the original exit status; cleanup is best effort.
    }
  }
});
const qaDirectory = path.resolve(outputDirectory, "qa");
const artifact = (name) => path.resolve(outputDirectory, name);
const directArtifactNames = [
  "codex-consumption-report-preview.png",
  "codex-consumption-report-cover.png",
  "codex-consumption-report-full.png",
  "codex-consumption-report.pdf",
  "codex-consumption-report-mobile-cover.png",
  "codex-consumption-report-mobile.png",
];
const qaArtifactNames = [
  "desktop-date-range-panel.png",
  "desktop-date-last-7-days.png",
  ...["date", "tokens", "projects", "routing", "sessions", "rhythm", "contents"].map((name) => `desktop-last-7-days-${name}.png`),
  ...["date", "tokens", "projects", "routing", "sessions", "rhythm", "actions"].map((name) => `desktop-layout-${name}.png`),
  ...["tokens", "projects", "routing", "sessions", "rhythm"].map((name) => `desktop-${name}.png`),
  "mobile-date-range-panel.png",
  ...["tokens", "projects-rank", "projects-week", "routing-model", "routing-activity", "sessions", "rhythm"].map((name) => `mobile-${name}.png`),
  ...["date", "tokens", "projects", "routing", "sessions", "rhythm", "contents"].map((name) => `mobile-last-7-days-${name}.png`),
];

function removeGeneratedFile(file) {
  if (!fs.existsSync(file)) return;
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Generated artifact path must be a regular file: ${file}`);
  }
  fs.unlinkSync(file);
}

function clearRenderedArtifacts() {
  for (const name of directArtifactNames) removeGeneratedFile(artifact(name));
  if (fs.existsSync(qaDirectory)) {
    const info = fs.lstatSync(qaDirectory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Generated QA path must be a real directory: ${qaDirectory}`);
    }
    for (const name of qaArtifactNames) removeGeneratedFile(path.join(qaDirectory, name));
    fs.chmodSync(qaDirectory, 0o700);
  }
}

function secureRenderedArtifacts() {
  for (const name of directArtifactNames) {
    const file = artifact(name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.chmodSync(file, 0o600);
  }
  if (fs.existsSync(qaDirectory) && fs.statSync(qaDirectory).isDirectory()) {
    fs.chmodSync(qaDirectory, 0o700);
    for (const entry of fs.readdirSync(qaDirectory, { withFileTypes: true })) {
      if (entry.isFile()) fs.chmodSync(path.join(qaDirectory, entry.name), 0o600);
    }
  }
}

function writePrivateAtomic(file, contents) {
  const temporaryPath = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, file);
    fs.chmodSync(file, 0o600);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function stageUpdatedManifest() {
  const finalManifestPath = path.resolve(finalOutputDirectory, "codex-consumption-manifest.json");
  if (!fs.existsSync(finalManifestPath)) return false;
  if (!isRegularFile(finalManifestPath)) throw new Error(`Report manifest is not a regular file: ${finalManifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(finalManifestPath, "utf8"));
  if (manifest.schema !== MANIFEST_SCHEMA) throw new Error(`Unsupported report manifest schema: ${manifest.schema || "missing"}`);
  if (manifest.report?.sha256 !== sha256(reportPath)) {
    throw new Error("Report manifest hash does not match the rendered HTML");
  }
  manifest.rendered = true;
  manifest.renderedAt = new Date().toISOString();
  manifest.renderedFormats = ["png", "pdf", "qa"];
  writePrivateAtomic(
    path.resolve(outputDirectory, "codex-consumption-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return true;
}

function publishRenderedArtifacts(includeManifest) {
  const renderRelativePaths = [
    ...directArtifactNames,
    ...qaArtifactNames.map((name) => `qa/${name}`),
  ];
  const managedRelativePaths = includeManifest
    ? [...renderRelativePaths, "codex-consumption-manifest.json"]
    : renderRelativePaths;
  const backupDirectory = path.resolve(
    finalOutputDirectory,
    `.codex-render-backup-${process.pid}-${crypto.randomBytes(6).toString("hex")}`,
  );
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDirectory, 0o700);
  const staged = new Set();
  const backedUp = new Set();
  const mutated = new Set();

  const validateQaDirectory = (directory) => {
    const qa = path.resolve(directory, "qa");
    if (!fs.existsSync(qa)) return;
    const info = fs.lstatSync(qa);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Generated QA path must be a real directory: ${qa}`);
  };

  try {
    validateQaDirectory(outputDirectory);
    validateQaDirectory(finalOutputDirectory);
    for (const relativePath of managedRelativePaths) {
      const stagedPath = path.resolve(outputDirectory, relativePath);
      const finalPath = path.resolve(finalOutputDirectory, relativePath);
      if (fs.existsSync(stagedPath)) {
        if (!isRegularFile(stagedPath)) throw new Error(`Staged render artifact is not a regular file: ${stagedPath}`);
        staged.add(relativePath);
      }
      if (!fs.existsSync(finalPath)) continue;
      if (!isRegularFile(finalPath)) throw new Error(`Existing render artifact is not a regular file: ${finalPath}`);
      const backupPath = path.resolve(backupDirectory, relativePath);
      fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
      try {
        fs.linkSync(finalPath, backupPath);
      } catch {
        fs.copyFileSync(finalPath, backupPath);
      }
      fs.chmodSync(backupPath, fs.lstatSync(finalPath).mode & 0o777);
      backedUp.add(relativePath);
    }

    const publishOrder = [...staged].filter((name) => name !== "codex-consumption-manifest.json");
    if (staged.has("codex-consumption-manifest.json")) publishOrder.push("codex-consumption-manifest.json");
    for (const relativePath of publishOrder) {
      const stagedPath = path.resolve(outputDirectory, relativePath);
      const finalPath = path.resolve(finalOutputDirectory, relativePath);
      fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
      mutated.add(relativePath);
      try {
        fs.renameSync(stagedPath, finalPath);
      } catch (error) {
        if (!fs.existsSync(finalPath)) throw error;
        fs.unlinkSync(finalPath);
        fs.renameSync(stagedPath, finalPath);
      }
      fs.chmodSync(finalPath, 0o600);
    }

    for (const relativePath of renderRelativePaths) {
      if (staged.has(relativePath)) continue;
      const finalPath = path.resolve(finalOutputDirectory, relativePath);
      if (fs.existsSync(finalPath)) {
        fs.unlinkSync(finalPath);
        mutated.add(relativePath);
      }
    }
    const finalQaDirectory = path.resolve(finalOutputDirectory, "qa");
    if (fs.existsSync(finalQaDirectory)) fs.chmodSync(finalQaDirectory, 0o700);
  } catch (error) {
    for (const relativePath of [...mutated].reverse()) {
      const finalPath = path.resolve(finalOutputDirectory, relativePath);
      const backupPath = path.resolve(backupDirectory, relativePath);
      if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
      if (backedUp.has(relativePath) && fs.existsSync(backupPath)) {
        fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
        fs.renameSync(backupPath, finalPath);
      }
    }
    throw error;
  } finally {
    fs.rmSync(backupDirectory, { recursive: true, force: true });
  }
}
clearRenderedArtifacts();
const chartIds = [
  "timelineChart",
  "tokenLedger",
  "projectBars",
  "projectMatrix",
  "modelStrip",
  "activityBars",
  "sessionScatter",
  "rhythmHeat",
];

async function waitForRenderedCharts(page) {
  for (const id of chartIds) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await page.waitForSelector(`#${id} svg`);
  }
}

async function collectAudit(page, label) {
  const result = await page.evaluate(({ auditLabel, expectedChartIds }) => {
    const root = document.documentElement;
    const charts = expectedChartIds.map((id) => {
      const element = document.getElementById(id);
      const svg = element?.querySelector("svg");
      const rect = element?.getBoundingClientRect();
      return {
        id,
        hasSvg: Boolean(svg),
        width: Math.round(rect?.width ?? 0),
        height: Math.round(rect?.height ?? 0),
      };
    });
    const overflowElements = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > root.clientWidth + 2 || rect.left < -2);
      })
      .slice(0, 12)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        id: element.id,
        className: typeof element.className === "string" ? element.className : "",
        text: (element.textContent || "").trim().slice(0, 60),
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
      }));
    return {
      label: auditLabel,
      ready: window.__CODEX_REPORT_READY === true,
      viewportWidth: root.clientWidth,
      documentWidth: root.scrollWidth,
      documentHeight: root.scrollHeight,
      filterFrom: root.dataset.filterFrom || "",
      filterTo: root.dataset.filterTo || "",
      heroCost: (document.getElementById("heroCost")?.textContent || "").trim(),
      charts,
      externalResources: performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => /^https?:/i.test(url)),
      overflowElements,
      unreplacedText: document.body.innerText.includes("{{"),
      sectionCount: document.querySelectorAll(".story-section").length,
    };
  }, { auditLabel: label, expectedChartIds: chartIds });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) throw new Error(label + ": report did not become ready");
  if (result.documentWidth > result.viewportWidth + 2) throw new Error(label + ": horizontal document overflow");
  if (result.externalResources.length) throw new Error(label + ": external resource loaded");
  if (result.unreplacedText) throw new Error(label + ": unreplaced template text");
  if (result.charts.some((chart) => !chart.hasSvg || chart.width < 200 || chart.height < 250)) {
    throw new Error(label + ": one or more ECharts SVGs are missing or empty");
  }
  return result;
}

async function collectOfficialOnlyAudit(page) {
  const selectedDate = await page.evaluate(() => {
    const candidate = (BASE_REPORT.officialDaily || []).find((row) => (
      Number(row.tokens || 0) > 0
      && (BASE_REPORT.filterFacts || []).some((fact) => fact.date === row.date)
    ));
    if (!candidate) return "";
    BASE_REPORT.filterFacts = (BASE_REPORT.filterFacts || []).filter((fact) => fact.date !== candidate.date);
    const view = deriveView(candidate.date, candidate.date);
    if (!view) return "";
    applyDateRange(view);
    return candidate.date;
  });
  if (!selectedDate) throw new Error("official-only QA could not construct a dated official bucket");
  await page.waitForTimeout(500);
  await waitForRenderedCharts(page);
  const result = await page.evaluate(({ date, localChartIds }) => ({
    date,
    localDetail: document.documentElement.dataset.localDetail || "",
    officialTokens: Number(REPORT?.summary?.reconstruction?.officialTokens || 0),
    localCalls: Number(REPORT?.summary?.calls || 0),
    emptyCharts: localChartIds.filter((id) => [...document.querySelectorAll(`#${id} svg text`)]
      .some((node) => (node.textContent || "").includes("暂无本地明细"))),
  }), {
    date: selectedDate,
    localChartIds: ["tokenLedger", "projectBars", "projectMatrix", "modelStrip", "activityBars", "sessionScatter", "rhythmHeat"],
  });
  console.log(JSON.stringify({ label: "official-only-local-empty", ...result }, null, 2));
  if (result.localDetail !== "empty") throw new Error("official-only QA did not enter the local-detail empty state");
  if (!(result.officialTokens > 0) || result.localCalls !== 0) throw new Error("official-only QA totals are invalid");
  if (result.emptyCharts.length !== 7) throw new Error("official-only QA did not render all seven local empty states");
  return result;
}

async function collectShortRangeAudit(page, label, { expectRailVisible = true } = {}) {
  const result = await page.evaluate(({ auditLabel }) => {
    const readText = (id) => (document.getElementById(id)?.textContent || "").replace(/\s+/g, " ").trim();
    const readData = (id, key) => document.getElementById(id)?.dataset?.[key] || "";
    const svgTexts = (id) => [...document.querySelectorAll(`#${id} svg text`)]
      .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    const slashDates = (id) => [...new Set(svgTexts(id).map((text) => text.match(/^(\d{1,2}\/\d{1,2})(?:\*|\s|$)/)?.[1]).filter(Boolean))];
    const timelineLabels = svgTexts("timelineChart");
    const dateLabels = slashDates("timelineChart");
    const rhythmLabels = svgTexts("rhythmHeat");
    const projectChart = window.echarts?.getInstanceByDom(document.getElementById("projectMatrix"));
    const projectLegendType = projectChart?.getOption()?.legend?.[0]?.type || "plain";
    const actionMetric = document.querySelector("#actions .section-head p strong")?.getBoundingClientRect();
    const actionCopy = document.querySelector("#actions .section-head p span")?.getBoundingClientRect();
    const boxesOverlap = Boolean(actionMetric && actionCopy
      && actionMetric.left < actionCopy.right && actionMetric.right > actionCopy.left
      && actionMetric.top < actionCopy.bottom && actionMetric.bottom > actionCopy.top);
    const rail = document.querySelector(".chapter-rail");
    const railRect = rail?.getBoundingClientRect();
    const railStyle = rail ? getComputedStyle(rail) : null;
    const railVisible = Boolean(
      rail
      && railStyle?.display !== "none"
      && railStyle?.visibility !== "hidden"
      && Number(railStyle?.opacity || 1) > 0
      && (railRect?.width || 0) > 0
      && (railRect?.height || 0) > 0
    );
    return {
      label: auditLabel,
      range: {
        from: document.documentElement.dataset.filterFrom || "",
        to: document.documentElement.dataset.filterTo || "",
      },
      timeline: {
        grain: readData("timelineChart", "grain"),
        dateLabels,
        allLabels: timelineLabels,
      },
      tokens: {
        title: readText("token-title"),
        grain: readData("tokenLedger", "grain"),
        dateLabels: slashDates("tokenLedger"),
      },
      projects: {
        title: readText("project-week-title"),
        grain: readData("projectMatrix", "grain"),
        dateLabels: slashDates("projectMatrix"),
        legendType: projectLegendType,
      },
      models: {
        title: readText("model-title"),
        grain: readData("modelStrip", "grain"),
        dateLabels: slashDates("modelStrip"),
      },
      sessions: {
        title: readText("session-title"),
        view: readData("sessionScatter", "view"),
        pointsReadable: readData("sessionScatter", "pointsReadable"),
      },
      rhythm: {
        title: readText("rhythm-title"),
        view: readData("rhythmHeat", "view"),
        dateLabels: slashDates("rhythmHeat"),
        hourLabels: [...new Set(rhythmLabels.filter((text) => /^\d{2}:00$/.test(text)))],
        totalCost: readData("rhythmHeat", "totalCost"),
        selectedCost: typeof REPORT === "object" ? Number(REPORT?.summary?.cost) : NaN,
      },
      rangeSummary: { overlaps: boxesOverlap },
      chapterRail: {
        exists: Boolean(rail),
        visible: railVisible,
      },
    };
  }, { auditLabel: label });

  console.log(JSON.stringify(result, null, 2));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result.range.from) || !/^\d{4}-\d{2}-\d{2}$/.test(result.range.to)) {
    throw new Error(label + ": last-7-days range is missing or invalid");
  }
  const inclusiveDayCount = Math.round((Date.parse(result.range.to) - Date.parse(result.range.from)) / 86_400_000) + 1;
  if (inclusiveDayCount !== 7) throw new Error(label + `: expected a 7-day range, got ${inclusiveDayCount} days`);
  if (result.timeline.grain !== "daily" || result.timeline.dateLabels.length < 7) {
    throw new Error(label + ": daily cost chart does not expose seven date labels or data-grain=daily");
  }
  if (!result.tokens.title) throw new Error(label + ": token section title is missing");
  if (/(?:每月|月度)/.test(result.tokens.title)) {
    throw new Error(label + `: token title remains monthly after a 7-day filter (${result.tokens.title})`);
  }
  if (result.tokens.grain !== "daily") throw new Error(label + ": token ledger is not data-grain=daily");
  if (result.tokens.dateLabels.length < 7) throw new Error(label + ": token ledger does not expose seven daily date labels");
  if (!result.projects.title) throw new Error(label + ": project time-distribution title is missing");
  if (result.projects.grain !== "daily") throw new Error(label + ": project time distribution is not data-grain=daily");
  if (result.projects.dateLabels.length < 7) throw new Error(label + ": project time distribution does not expose seven daily date labels");
  if (result.projects.legendType !== "plain") throw new Error(label + ": project legend is not compact/plain in the 7-day view");
  if (!result.models.title) throw new Error(label + ": model section title is missing");
  if (result.models.grain !== "daily") throw new Error(label + ": model time distribution is not data-grain=daily");
  if (result.models.dateLabels.length < 7) throw new Error(label + ": model time distribution does not expose seven daily date labels");
  if (!result.sessions.title) throw new Error(label + ": session section title is missing");
  if (result.sessions.view !== "ranked" && result.sessions.pointsReadable !== "true") {
    throw new Error(label + ": session chart is neither data-view=ranked nor marked points-readable");
  }
  if (!result.rhythm.title) throw new Error(label + ": rhythm section title is missing");
  if (result.rhythm.view !== "date-hour") throw new Error(label + ": rhythm chart is not data-view=date-hour");
  if (result.rhythm.dateLabels.length < 7) throw new Error(label + ": rhythm chart does not expose seven real dates");
  if (!expectRailVisible && result.rhythm.hourLabels.length > 4) throw new Error(label + ": mobile rhythm chart exposes more than four hour labels");
  if (!Number.isFinite(result.rhythm.selectedCost)) throw new Error(label + ": selected cost is unavailable for reconciliation");
  if (Math.abs(Number(result.rhythm.totalCost) - result.rhythm.selectedCost) > 0.01) {
    throw new Error(label + ": rhythm daily totals do not reconcile to selected cost");
  }
  if (result.rangeSummary.overlaps) throw new Error(label + ": range-summary metric overlaps its explanatory copy");
  if (!result.chapterRail.exists) throw new Error(label + ": chapter rail is missing");
  if (expectRailVisible && !result.chapterRail.visible) throw new Error(label + ": chapter rail is not visible on desktop");
  if (!expectRailVisible && result.chapterRail.visible) throw new Error(label + ": chapter rail is visible on mobile");
  return result;
}

async function screenshotShortRangeSections(page, prefix) {
  const screenshotStyle = await page.addStyleTag({ content: ".report-toolbar{visibility:hidden!important}" });
  try {
    for (const [name, selector] of [
      ["date", "#when"],
      ["tokens", "#tokens"],
      ["projects", "#projects"],
      ["routing", "#models"],
      ["sessions", "#sessions"],
      ["rhythm", "#rhythm"],
      ["contents", "#actions"],
    ]) {
      const section = page.locator(selector);
      await section.scrollIntoViewIfNeeded();
      await page.waitForTimeout(100);
      await section.screenshot({ path: path.join(qaDirectory, `${prefix}-${name}.png`) });
    }
  } finally {
    await screenshotStyle.evaluate((node) => node.remove());
  }
}

(async () => {
  let browser;
  try {
  browser = await chromium.launch({ headless: true, executablePath: chromePath });
  const errors = [];
  const attachErrors = (page) => {
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("pageerror", (error) => errors.push(error.message));
  };

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  attachErrors(desktop);
  await desktop.goto(reportUrl, { waitUntil: "load" });
  await desktop.waitForFunction(() => window.__CODEX_REPORT_READY === true);
  await desktop.locator("#timelineChart").scrollIntoViewIfNeeded();
  await desktop.waitForSelector("#timelineChart svg");
  await desktop.waitForTimeout(2100);
  await desktop.screenshot({
    path: artifact("codex-consumption-report-preview.png"),
    fullPage: false,
  });
  const fullRange = await desktop.evaluate(() => ({
    from: document.documentElement.dataset.filterFrom || "",
    to: document.documentElement.dataset.filterTo || "",
    heroCost: (document.getElementById("heroCost")?.textContent || "").trim(),
  }));
  const fullRangeDayCount = /^\d{4}-\d{2}-\d{2}$/.test(fullRange.from) && /^\d{4}-\d{2}-\d{2}$/.test(fullRange.to)
    ? Math.round((Date.parse(fullRange.to) - Date.parse(fullRange.from)) / 86_400_000) + 1
    : 0;
  const canNarrowToSevenDays = fullRangeDayCount > 7;
  let selectedRange = null;
  await desktop.evaluate(() => window.scrollTo(0, 0));
  await desktop.locator("#rangeTrigger").click();
  await desktop.locator("#rangeLayer").waitFor({ state: "visible" });
  fs.mkdirSync(qaDirectory, { recursive: true });
  await desktop.screenshot({
    path: path.join(qaDirectory, "desktop-date-range-panel.png"),
    fullPage: false,
  });
  const noCallDate = await desktop.evaluate(() => {
    const first = document.getElementById("rangeFrom")?.min || "";
    const last = document.getElementById("rangeFrom")?.max || "";
    for (let value = first; value && value <= last;) {
      if (typeof deriveView === "function" && deriveView(value, value) === null) return value;
      const date = new Date(value + "T00:00:00Z");
      date.setUTCDate(date.getUTCDate() + 1);
      value = date.toISOString().slice(0, 10);
    }
    return "";
  });
  if (noCallDate) {
    await desktop.locator("#rangeFrom").fill(noCallDate);
    await desktop.locator("#rangeTo").fill(noCallDate);
    if (!await desktop.locator("#rangeApply").isDisabled()) throw new Error("empty date range did not disable apply");
    if (!/没有模型调用/.test(await desktop.locator("#rangeError").innerText())) throw new Error("empty date range did not explain the empty state");
  }
  if (canNarrowToSevenDays) {
    await desktop.locator("[data-range-preset='7']").click();
    selectedRange = await desktop.evaluate(() => ({
      from: document.getElementById("rangeFrom")?.value || "",
      to: document.getElementById("rangeTo")?.value || "",
    }));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedRange.from) || !/^\d{4}-\d{2}-\d{2}$/.test(selectedRange.to)) {
      throw new Error("last-7-days preset did not populate valid date inputs");
    }
    await desktop.locator("#rangeApply").click();
    await desktop.waitForFunction(({ from, to }) => (
      document.documentElement.dataset.filterFrom === from
      && document.documentElement.dataset.filterTo === to
    ), selectedRange);
    await desktop.locator("#rangeLayer").waitFor({ state: "hidden" });
    const filteredState = await desktop.evaluate(() => ({
      from: document.documentElement.dataset.filterFrom || "",
      to: document.documentElement.dataset.filterTo || "",
      heroCost: (document.getElementById("heroCost")?.textContent || "").trim(),
    }));
    if (filteredState.from !== selectedRange.from || filteredState.to !== selectedRange.to) {
      throw new Error(`date filter state mismatch: expected ${selectedRange.from}..${selectedRange.to}, got ${filteredState.from}..${filteredState.to}`);
    }
    if (fullRange.from === filteredState.from && fullRange.to === filteredState.to) {
      throw new Error("last-7-days filter did not narrow the full report range");
    }
    await waitForRenderedCharts(desktop);
    await collectAudit(desktop, "desktop-filtered-last-7-days");
    await collectShortRangeAudit(desktop, "desktop-adaptive-last-7-days");
    await desktop.locator("#when").screenshot({ path: path.join(qaDirectory, "desktop-date-last-7-days.png") });
    await screenshotShortRangeSections(desktop, "desktop-last-7-days");
  } else {
    await desktop.locator("#rangeClose").click();
    await desktop.locator("#rangeLayer").waitFor({ state: "hidden" });
    console.log(JSON.stringify({
      label: "desktop-last-7-days-skipped",
      reason: "full report range is already seven days or shorter",
      fullRangeDayCount,
    }, null, 2));
  }

  const staticDesktop = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  attachErrors(staticDesktop);
  await staticDesktop.goto(reportUrl + "?static=1", { waitUntil: "load" });
  await staticDesktop.waitForFunction(() => window.__CODEX_REPORT_READY === true);
  await staticDesktop.waitForTimeout(800);
  await collectAudit(staticDesktop, "desktop-static");
  await staticDesktop.evaluate(() => window.scrollTo(0, 0));
  await staticDesktop.screenshot({
    path: artifact("codex-consumption-report-cover.png"),
    fullPage: false,
  });
  await staticDesktop.screenshot({
    path: artifact("codex-consumption-report-full.png"),
    fullPage: true,
  });
  for (const [name, selector] of [
    ["date", "#when"],
    ["tokens", "#tokens"],
    ["projects", "#projects"],
    ["routing", "#models"],
    ["sessions", "#sessions"],
    ["rhythm", "#rhythm"],
    ["actions", "#actions"],
  ]) {
    await staticDesktop.locator(selector).screenshot({ path: path.join(qaDirectory, `desktop-layout-${name}.png`) });
  }
  for (const [name, selector] of [
    ["tokens", "#tokens .chart-shell"],
    ["projects", "#projects .two-up"],
    ["routing", "#models .two-up"],
    ["sessions", "#sessions .chart-shell"],
    ["rhythm", "#rhythm .chart-shell"],
  ]) {
    await staticDesktop.locator(selector).screenshot({ path: path.join(qaDirectory, `desktop-${name}.png`) });
  }

  const officialOnlyPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  attachErrors(officialOnlyPage);
  await officialOnlyPage.goto(reportUrl + "?static=1", { waitUntil: "load" });
  await officialOnlyPage.waitForFunction(() => window.__CODEX_REPORT_READY === true);
  await collectOfficialOnlyAudit(officialOnlyPage);
  await officialOnlyPage.close();

  await staticDesktop.emulateMedia({ media: "print" });
  await staticDesktop.waitForTimeout(350);
  await staticDesktop.evaluate(() => {
    window.dispatchEvent(new Event("beforeprint"));
    window.dispatchEvent(new Event("resize"));
  });
  await staticDesktop.waitForTimeout(700);
  const printAudit = await staticDesktop.evaluate(() => ["timelineChart", "activityBars", "sessionScatter", "rhythmHeat"].map((id) => {
    const element = document.getElementById(id);
    const svg = element?.querySelector("svg");
    return {
      id,
      containerWidth: Math.round(element?.getBoundingClientRect().width ?? 0),
      svgWidth: Math.round(svg?.getBoundingClientRect().width ?? 0),
      svgViewBox: svg?.getAttribute("viewBox") ?? "",
    };
  }));
  console.log(JSON.stringify({ label: "print-static", charts: printAudit }, null, 2));
  await staticDesktop.pdf({
    path: artifact("codex-consumption-report.pdf"),
    format: "A4",
    printBackground: true,
    margin: { top: "8mm", right: "7mm", bottom: "8mm", left: "7mm" },
  });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  attachErrors(mobile);
  await mobile.goto(reportUrl + "?static=1", { waitUntil: "load" });
  await mobile.waitForFunction(() => window.__CODEX_REPORT_READY === true);
  await mobile.waitForTimeout(700);
  await collectAudit(mobile, "mobile-static");
  await mobile.evaluate(() => window.scrollTo(0, 0));
  await mobile.screenshot({
    path: artifact("codex-consumption-report-mobile-cover.png"),
    fullPage: false,
  });
  await mobile.locator("#rangeTrigger").click();
  await mobile.locator("#rangeLayer").waitFor({ state: "visible" });
  await mobile.screenshot({
    path: path.join(qaDirectory, "mobile-date-range-panel.png"),
    fullPage: false,
  });
  await mobile.locator("#rangeClose").click();
  await mobile.locator("#rangeLayer").waitFor({ state: "hidden" });
  await mobile.locator("#timelineChart").scrollIntoViewIfNeeded();
  await mobile.waitForTimeout(150);
  await mobile.screenshot({
    path: artifact("codex-consumption-report-mobile.png"),
    fullPage: false,
  });
  for (const [name, selector] of [
    ["tokens", "#tokens .chart-shell"],
    ["projects-rank", "#projects .chart-shell:nth-of-type(1)"],
    ["projects-week", "#projects .chart-shell:nth-of-type(2)"],
    ["routing-model", "#models .chart-shell:nth-of-type(1)"],
    ["routing-activity", "#models .chart-shell:nth-of-type(2)"],
    ["sessions", "#sessions .chart-shell"],
    ["rhythm", "#rhythm .chart-shell"],
  ]) {
    await mobile.locator(selector).screenshot({ path: path.join(qaDirectory, `mobile-${name}.png`) });
  }
  await mobile.locator("[data-heat-metric='calls']").click();
  if (!await mobile.locator("[data-heat-metric='calls']").evaluate((el) => el.classList.contains("active"))) {
    throw new Error("heat metric toggle did not activate");
  }

  if (selectedRange) {
    const mobileFilteredUrl = new URL(reportUrl);
    mobileFilteredUrl.searchParams.set("static", "1");
    mobileFilteredUrl.searchParams.set("from", selectedRange.from);
    mobileFilteredUrl.searchParams.set("to", selectedRange.to);
    await mobile.goto(mobileFilteredUrl.href, { waitUntil: "load" });
    await mobile.waitForFunction(() => window.__CODEX_REPORT_READY === true);
    await waitForRenderedCharts(mobile);
    await collectAudit(mobile, "mobile-filtered-last-7-days");
    await collectShortRangeAudit(mobile, "mobile-adaptive-last-7-days", { expectRailVisible: false });
    await screenshotShortRangeSections(mobile, "mobile-last-7-days");
  }

  if (errors.length) throw new Error("browser errors:\n" + [...new Set(errors)].join("\n"));
  secureRenderedArtifacts();
  await browser.close();
  browser = null;
  const manifestUpdated = stageUpdatedManifest();
  publishRenderedArtifacts(manifestUpdated);
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  renderPublished = true;
  console.log(JSON.stringify({
    status: "pass",
    report: reportPath,
    outputDirectory: finalOutputDirectory,
    chrome: chromePath,
    artifacts: ["PNG", "PDF", "QA"],
    manifestUpdated,
  }, null, 2));
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
