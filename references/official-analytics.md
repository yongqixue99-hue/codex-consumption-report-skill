# Official Analytics activity companion

## What this companion measures

The Codex Analytics page at `https://chatgpt.com/codex/cloud/settings/analytics` exposes activity tables in addition to the credits and Token response. This companion imports three sanitized response bodies and produces one validated activity report:

| Browser request | Required | Used for |
| --- | --- | --- |
| `daily-workspace-usage-counts` | Yes | Daily `threads`, `turns`, model rows, and client rows |
| `daily-skill-usage-metrics` | No | Daily and ranked Skill invocation counts |
| `daily-plugin-usage-metrics` | No | Daily and ranked Plugin call counts |

This is a fourth reporting layer. It is not a replacement for the official account Token history, the device-local explanatory ledger, or the credits audit. Do not convert turns, Skill invocations, or Plugin calls into credits or Tokens.

The browser request names above are internal dashboard interfaces, not documented stable public APIs. OpenAI's [Workspace analytics documentation](https://learn.chatgpt.com/docs/enterprise/workspace-analytics) describes the dashboard as interactive and notes that displayed fields and formats can change. The importer therefore validates the currently observed minimal schema and stops on unfamiliar or mismatched data instead of guessing.

## Why this workflow uses Response JSON

OpenAI documents a separate [Analytics API](https://learn.chatgpt.com/docs/enterprise/analytics-api) for aggregated workspace metrics. Its authentication requires an OpenAI Platform organization API key whose organization matches the ChatGPT workspace. The public documentation does not publish a separate Analytics API price or promise that every call is free. Do not label it “confirmed free,” and do not make a personal Pro workflow depend on workspace administrator credentials.

For this Skill, use the page's already loaded, sanitized Response JSON instead. It requires no API key and makes the privacy boundary visible to the user.

## Collect automatically when possible

When the user supplies no JSON, read [browser-auto-collection.md](browser-auto-collection.md) and use the signed-in Analytics page to collect the response bodies. `daily-workspace-usage-counts` is required; the Skill and Plugin responses remain optional. Do not ask the user to open Developer Tools or paste JSON unless supported browser control is unavailable.

## Manual response-body fallback

1. Sign in and open `https://chatgpt.com/codex/cloud/settings/analytics`.
2. Select the intended date range and grouping on the page first.
3. Open browser developer tools and choose **Network**.
4. Reload the page or change the date range once so the requests run again.
5. Filter for `daily-workspace-usage-counts`, select it, open **Response**, and copy only the JSON response body into a local `.json` file.
6. Repeat for `daily-skill-usage-metrics` and `daily-plugin-usage-metrics` if their tables are wanted.
7. Confirm that all supplied responses came from the same page selection. Their `group_by` and date buckets must match exactly.

Never copy request headers, response headers, Cookies, Authorization, browser storage, account identifiers, email, access tokens, or a HAR file. Do not paste those values into a prompt. The generator rejects common credential and identity keys, but the user should still inspect the files before sharing or committing them.

Minimal accepted shapes:

```json
{
  "group_by": "day",
  "data": [
    {
      "date": "2026-08-18",
      "totals": { "threads": 9, "turns": 18 },
      "models": [{ "model": "gpt-5.6-sol", "threads": 2, "turns": 11 }],
      "clients": [{ "client_id": "CODEX_DESKTOP_APP", "threads": 9, "turns": 18 }]
    }
  ]
}
```

```json
{
  "group_by": "day",
  "data": [
    {
      "date": "2026-08-18",
      "skill_usage_overviews": [
        { "skill_name": "agent-reach", "display_name": "Agent Reach", "invocation_counts": 4 }
      ]
    }
  ]
}
```

```json
{
  "group_by": "day",
  "data": [
    {
      "date": "2026-08-18",
      "plugin_usage_overviews": [
        { "plugin_id": "plugin-example", "plugin_name": "github", "display_name": "GitHub", "invocation_counts": 3 }
      ]
    }
  ]
}
```

## Generate and validate

```bash
node "$SKILL_DIR/scripts/generate-official-analytics.mjs" \
  --usage-input "/absolute/path/daily-workspace-usage-counts.json" \
  --skills-input "/absolute/path/daily-skill-usage-metrics.json" \
  --plugins-input "/absolute/path/daily-plugin-usage-metrics.json" \
  --output-dir "/absolute/dedicated/official-analytics-directory" \
  --timezone "Asia/Shanghai"
```

`--skills-input` and `--plugins-input` are optional. If omitted, their totals remain `null` and the report says “not provided”; it never turns missing input into zero usage. `--from` and `--to` may select a subset of a larger, consistently grouped response set.

The generator writes:

- `codex-official-analytics.html`: offline report with all tables and the summary graphic;
- `codex-official-analytics.md`: publishable numeric tables;
- `codex-official-analytics.svg`: shareable chart;
- `codex-official-analytics.json`: normalized audit data;
- `codex-official-analytics-manifest.json`: artifact hashes.

It automatically runs `validate-official-analytics.mjs`. Validation checks date order and exact cross-response bucket alignment, daily totals, model/client shares, Skill and Plugin aggregation, table coverage, offline HTML, SVG safety, and credential-like output.

## Field meanings and limits

| Field | Meaning in this report | Do not interpret it as |
| --- | --- | --- |
| `threads` | Threads reported in one date bucket; period total is a sum of daily values | Deduplicated tasks over the full range |
| `turns` | Interaction exchanges counted by the dashboard | Manual send clicks, credits, or model calls |
| `models` | Model-attributed threads and turns for the bucket | Proof that every visible response used that model |
| `clients` | Client or surface attribution, such as Desktop App or Web | A verified physical-device split |
| `invocation_counts` for Skills | Explicit or implicit Skill activations reported by the page | Number of installed Skills or credits consumed |
| `invocation_counts` for Plugins | Plugin calls reported by the page | Skill activations, turns, or credits |

OpenAI's [glossary](https://learn.chatgpt.com/docs/glossary) describes Skills as reusable instructions that Codex can invoke explicitly or implicitly. A Skill count therefore can exceed the number of user prompts and should not be used to infer a one-to-one manual action history.
