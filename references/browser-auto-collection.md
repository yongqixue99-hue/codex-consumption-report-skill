# Automatic Analytics collection

Use this mode when the user asks to view, generate, or audit Codex Credits or official Analytics activity without supplying JSON. A short request such as “查看 Credits 报告” is enough: open a valid report already generated in the current task, or collect fresh data and generate one when no report exists. A request to refresh, recalculate, or use the latest data always triggers a fresh collection.

## Requirements and fallback

Automatic collection requires a supported browser-control capability and a browser session already signed in to `chatgpt.com`. Read the selected browser-control skill before acting.

1. Prefer an already open Analytics tab. Otherwise open `https://chatgpt.com/codex/cloud/settings/analytics` in an available browser.
2. If the first browser redirects to the ChatGPT home page or login, try another available browser when its browser-control policy permits. Do not inspect browser history, Cookies, local storage, profiles, passwords, or session stores.
3. If no available browser is signed in, ask the user only to sign in to ChatGPT in that browser and say when it is ready. Do not ask for credentials or Response JSON at this stage.
4. If browser control itself is unavailable, explain that one-click collection is unavailable in that environment, then offer the manual Response-JSON fallback from `credits-audit.md` or `official-analytics.md`.

This is a read-only workflow. It must not change account settings, purchase credits, connect GitHub, or submit forms.

## Choose the page range

- Respect a date range explicitly requested by the user.
- For a fresh Credits audit with no requested range, select a page range that fully contains the visible current weekly reset window; one month is the safe default when available.
- For a full official activity report with no requested range, use the page's current one-month range and daily grouping.
- Read the visible remaining percentage and reset time when present. They are optional generator arguments; never infer them from unrelated text.
- After changing the range or grouping, wait for the page to finish updating before collecting responses.

## Acquire only response bodies

Use the page's observed resource list to locate the latest same-origin GET for these exact request names:

- `daily-workspace-usage-counts` — required;
- `daily-skill-usage-metrics` — optional;
- `daily-plugin-usage-metrics` — optional.

Do not guess an endpoint URL. Do not print or retain query strings. Do not use DevTools exports, HAR, request headers, `document.cookie`, browser storage, CDP cookie APIs, or an `Authorization` value.

With a supported page evaluator, the collection shape is:

```js
const names = [
  "daily-workspace-usage-counts",
  "daily-skill-usage-metrics",
  "daily-plugin-usage-metrics",
];

const observedUrls = await tab.playwright.evaluate((requestNames) => {
  const entries = performance.getEntriesByType("resource").map((entry) => entry.name);
  return Object.fromEntries(requestNames.flatMap((name) => {
    const matches = entries.filter((candidate) => {
      try {
        const url = new URL(candidate, location.href);
        return url.origin === location.origin && url.pathname.includes(name);
      } catch {
        return false;
      }
    });
    return matches.length ? [[name, matches.at(-1)]] : [];
  }));
}, names);

const responsesByEndpoint = await tab.playwright.evaluate(async (urls) => {
  const output = {};
  for (const [name, url] of Object.entries(urls)) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
    output[name] = await response.json();
  }
  return output;
}, observedUrls);
```

If the required request was not observed, reload the Analytics page once or change the visible date range once, wait for completion, and inspect the resource list again. Do not probe guessed URL variants. Optional Skill or Plugin responses may remain unavailable; report them as not provided rather than zero.

## Validate before saving

Map the endpoint keys to the staging helper, validate the response bodies in memory, and write them only to a new private temporary directory:

```js
const responses = {
  usage: responsesByEndpoint["daily-workspace-usage-counts"],
  skills: responsesByEndpoint["daily-skill-usage-metrics"],
  plugins: responsesByEndpoint["daily-plugin-usage-metrics"],
};

const { stageBrowserAnalyticsResponses } = await import(
  "/absolute/path/to/generate-codex-consumption-report/scripts/stage-browser-analytics.mjs"
);
const staged = stageBrowserAnalyticsResponses({ responses, outputDirectory: privateTempDirectory });
```

The helper rejects credential and identity keys before any payload is written, preserves exact numeric values, creates `0700`/`0600` artifacts on POSIX, and returns the three generator input paths. Never paste large response bodies into the chat.

## Generate and hand off

- Credits only: run `generate-credits-audit.mjs` with `staged.usageInput`, plus the visible remaining percentage and reset time when available.
- Official activity: run `generate-official-analytics.mjs` with the staged usage input and whichever optional inputs were collected.
- Complete report: generate the Token report and the Credits report as sibling deliverables; add the official activity companion when requested.
- Open the resulting HTML in Codex and lead with its clickable path. State whether the data was collected automatically and identify the selected date range, but never expose endpoint URLs or browser/session identifiers.
