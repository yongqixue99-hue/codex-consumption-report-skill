# Credits audit contract

Use this reference only when the user asks about Codex credits, remaining quota, Fast mode, `daily-workspace-usage-counts`, or a credits-to-Token conversion. Keep this audit separate from the local Token reconstruction and the API-equivalent dollar estimate.

## What this layer can answer

The audit can:

- total `totals.credits` over an explicit date range;
- verify `cached_text_input_tokens + uncached_text_input_tokens + text_output_tokens = text_total_tokens` for every day;
- tabulate daily Token components, credits, threads, and turns;
- summarize the model names and their threads/turns;
- compare charged credits with an all-Sol-Standard text-only reference;
- approximately infer a weekly credit pool from consumed credits and a remaining percentage;
- generate validated JSON, Markdown, HTML, and SVG artifacts.

It cannot prove a universal plan allowance, attribute total credits to one model when `models[].credits` is zero, split a calendar day at a mid-day reset, or prove which model handled one individual reply.

## Collect only the response body

1. Open `https://chatgpt.com/codex/cloud/settings/analytics#usage` while signed in.
2. Record the visible remaining percentage and reset time separately.
3. Open browser developer tools, choose **Network**, and select **Fetch/XHR**.
4. Filter for `daily-workspace-usage-counts`.
5. Change the dashboard date range or refresh the page if no matching request appears.
6. Open the request and inspect **Preview** or **Response**.
7. Copy or save only the JSON response body. It should contain a top-level `data` array and normally `group_by: "day"`.

Never export or upload a HAR. Never copy **Headers**, request cookies, `Authorization`, access tokens, account IDs, or email addresses. The generator rejects common credential and identity keys before writing artifacts.

The endpoint above is an internal webpage endpoint, not a documented public API. Its name and fields may change. The Skill must fail clearly on an unfamiliar schema instead of guessing.

## Generate and validate

Run from the Skill directory:

```bash
node scripts/generate-credits-audit.mjs \
  --input "/absolute/path/daily-workspace-usage-counts.json" \
  --output-dir "/absolute/dedicated/output/directory" \
  --remaining-percent 41 \
  --reset-at "2026-08-16T18:00:00+08:00" \
  --timezone "Asia/Shanghai"
```

Use `--from YYYY-MM-DD` and `--to YYYY-MM-DD` to restrict the selected range. Include only dates inside the current reset window when estimating a weekly pool. If reset occurs in the middle of a day, disclose that the boundary day cannot be split exactly by the daily endpoint.

The generator validates its artifacts automatically. Independent validation is also available:

```bash
node scripts/validate-credits-audit.mjs \
  --audit "/absolute/output/codex-credits-audit.json" \
  --markdown "/absolute/output/codex-credits-audit.md" \
  --svg "/absolute/output/codex-credits-audit.svg" \
  --html "/absolute/output/codex-credits-audit.html"
```

Do not deliver the audit when validation fails.

## Field meanings

| Field | Meaning | Interpretation limit |
| --- | --- | --- |
| `totals.credits` | Credits charged for that daily bucket | Treat as already charged; do not multiply the total by Fast again |
| `cached_text_input_tokens` | Cached input Tokens | Lower Standard credit rate than uncached input |
| `uncached_text_input_tokens` | New input Tokens not served from cache | Standard input credit rate |
| `text_output_tokens` | Model output Tokens | Highest text credit rate in the current rate card |
| `text_total_tokens` | Sum of the three fields above | Must reconcile exactly |
| `threads` | Daily task/thread count | Summing days is not a unique weekly task count |
| `turns` | Agent run rounds | Not identical to manual send count |
| `models` | Models recorded in the bucket | Background or delegated work may appear; it does not prove a silent model switch for a specific reply |

Use `totals.credits` for the daily and selected-range total. `models[].credits` may be zero even when the daily total is nonzero, so do not use model credits as the account total and do not fabricate a model allocation.

## Official rate snapshot

Verified 2026-08-19 against [OpenAI Codex pricing](https://learn.chatgpt.com/docs/pricing):

| Model | Credits / 1M uncached input | Credits / 1M cached input | Credits / 1M output | 1 credit ≈ uncached input | 1 credit ≈ cached input | 1 credit ≈ output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Sol | 125 | 12.5 | 750 | 8,000 | 80,000 | 1,333.33 |
| GPT-5.6 Terra | 50 | 5 | 300 | 20,000 | 200,000 | 3,333.33 |
| GPT-5.6 Luna | 5 | 0.5 | 30 | 200,000 | 2,000,000 | 33,333.33 |
| GPT-5.5 | 125 | 12.5 | 750 | 8,000 | 80,000 | 1,333.33 |
| GPT-5.4 | 62.5 | 6.25 | 375 | 16,000 | 160,000 | 2,666.67 |

Rates can change. Recheck the official page before publishing a current rate claim.

## Fast mode

According to [OpenAI's Speed documentation](https://learn.chatgpt.com/docs/agent-configuration/speed), Fast increases supported model speed by 1.5×. GPT-5.6 and GPT-5.5 consume credits at 2.5× Standard; GPT-5.4 consumes at 2×.

Fast makes the remaining allowance decline faster for the same Token mix. It does not by itself prove that the nominal weekly pool became smaller. Treat `totals.credits` from the webpage response as the charged amount; applying the multiplier again would double count it.

An all-Sol-Standard text-only reference is useful as a diagnostic:

```text
reference credits
= uncached input × 125 / 1,000,000
+ cached input × 12.5 / 1,000,000
+ output × 750 / 1,000,000
```

The ratio `reported totals.credits / reference credits` is not a measured Fast share. It may also reflect model mix, tools, image generation, reasoning, or fields that the internal endpoint does not expose.

## Weekly pool inference

When `U` is the selected-range charged credits and the dashboard shows `R%` remaining:

```text
consumed percentage = 100% - R%
point estimate       = U / consumed percentage
```

For example, if the selected range contains 5,900 credits and the dashboard shows 41% remaining:

```text
5,900 / 0.59 = 10,000 credits
```

If 41% is rounded to the nearest whole percentage point, the displayed value alone gives an approximate interval of 9,916–10,085 credits. This interval still does not cover reset-boundary error, collection lag, omitted dates, or a changing usage policy. Label the result as an estimate, not a confirmed entitlement.

OpenAI's public pricing page says additional weekly limits may apply, but does not publish one universal fixed weekly credit pool for every account. Do not use community reports such as “50k–60k” as an official benchmark.

## 250-credit Sol conversion

| Mode | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| Sol Standard | 2,000,000 | 20,000,000 | 333,333 |
| Sol Fast (GPT-5.6) | 800,000 | 8,000,000 | 133,333 |

There is no single Token answer because real tasks mix uncached input, cached input, and output.

## Output contract

The generator writes:

- `codex-credits-audit.html`: self-contained readable report;
- `codex-credits-audit.svg`: shareable summary graphic;
- `codex-credits-audit.md`: complete tables and formulas;
- `codex-credits-audit.json`: sanitized machine-readable audit;
- `codex-credits-audit-manifest.json`: hashes and artifact metadata.

The HTML and Markdown must include the full daily table, model table, official rate table, 250-credit Sol table, quota estimate, and caveats. The SVG may summarize long ranges, but it must point to the complete tables. Keep all artifacts private unless the user explicitly chooses to publish them.

For reader-facing HTML, Markdown, and SVG, format measured credits and calculated decimal values with one decimal place. Format Token quantities with Chinese compact units: use `亿` at 100,000,000 or above, `万` at 10,000 or above, and retain one decimal place. Apply the same rule to the summary, every daily Token column, and the 250-credit Token conversion table. Keep threads and turns as integers, preserve official rate-card precision where rounding would change the published rate, and retain every exact raw value in `codex-credits-audit.json`.

In HTML tables, keep the descriptive first column left-aligned and center every numeric header and numeric cell, including all columns in the model table after the model name.
