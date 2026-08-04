# Evaluation and Platform Notes

## What the evaluator can test

The bundled fixture is anonymous synthetic data with fixed, reproducible totals. A successful demo must report:

- date range: 2026-07-01 through 2026-07-14;
- 54,618,100 Tokens;
- 435 calls;
- 17 sessions;
- 4 projects;
- API-equivalent estimated cost of $91.44;
- peak date 2026-07-08 with 14,563,800 Tokens;
- cache-read share approximately 87.55%.

The report must visibly identify the fixture as synthetic. These values do not represent a real Codex account.

The machine-readable golden result is bundled as `examples/iflytek-demo-expected.json` so an evaluator can compare the summary without relying on formatted display text.

The same pipeline can analyze an uploaded portable JSON, JSONL, or CSV file. Invalid input must fail closed: it must not switch to demo data or inspect the host environment.

## Analysis facts

The report uses rule set `codex.portable.analysis.v1` to describe observable distributions, including:

- peak-day Token volume divided by the median active day;
- top project and top model Token shares;
- cache-read Token share;
- calendar continuity, attribution coverage, and multi-view reconciliation.

Threshold hits are descriptive. They do not identify a cause and do not produce recommendations.

## Runtime limitation

Generating a new report requires Node.js 20.11 or newer and a writable temporary directory. If the host does not expose that runtime, state the environment limitation exactly. Do not claim that a report was regenerated.

The HTML is an optional artifact because some AstronClaw channels may not send generated local files back to the user. The in-chat `replyMarkdown` is therefore the primary deliverable.

## Platform statistics

Competition downloads and favorites are recorded by SkillHub after the work is submitted through the competition page and approved. The Skill contains no telemetry, tracking SDK, or self-reported popularity counter. Platform statistics must never be simulated or manipulated.

The first competition submission must use the official contest submission entry so that the work is bound to the event. Subsequent approved updates and the review status are managed through the platform dashboard.
