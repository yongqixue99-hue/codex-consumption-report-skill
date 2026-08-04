# Portable Codex Usage Contract

The competition profile accepts only the bundled anonymous demo or an explicitly supplied portable file. It does not accept a raw local database, a general CodeBurn export, a Codex account response, prompt text, source code, or host metadata.

## JSON

Use schema `codex.portable.usage.v1`:

```json
{
  "schema": "codex.portable.usage.v1",
  "generatedAt": "2026-07-14T23:30:00+08:00",
  "timezone": "Asia/Shanghai",
  "records": [
    {
      "rowId": "row-001",
      "timestamp": "2026-07-14T09:12:00+08:00",
      "project": "agent-platform",
      "session": "session-01",
      "model": "gpt-5.6-sol",
      "activity": "Coding",
      "inputTokens": 182000,
      "outputTokens": 21400,
      "cacheReadTokens": 1480000,
      "cacheWriteTokens": 12000,
      "estimatedCostUsd": 2.84,
      "calls": 14
    }
  ]
}
```

`rowId` is optional but, when present, must be unique. The top-level `synthetic` field is reserved for the bundled fixture; an uploaded file cannot make itself trusted demo data by setting it.

JSONL uses one record object per non-empty line. JSONL is accepted as an external uploaded input, but it is not bundled in the competition ZIP because the platform upload allowlist does not include `.jsonl` package entries.

## CSV

Use UTF-8 CSV with these headers:

```text
row_id,timestamp,project,session,model,activity,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,estimated_cost_usd,calls
```

`row_id` is optional. `timestamp`, `project`, `session` or `session_id`, `model`, `activity`, `calls`, one cost column, and at least one Token component column are required.

## Record meaning

Each record is one already-aggregated usage fact. Its Token components, calls, and estimated cost are totals for that fact, not per-call values.

- Timestamps must be valid ISO timestamps with `Z` or an explicit UTC offset.
- `timezone` must be an IANA timezone such as `Asia/Shanghai`.
- Token components and calls must be non-negative safe integers; calls must be at least 1 and each record must contain at least one Token.
- The file must contain a positive `estimatedCostUsd` total.
- The maximum file size is 10 MiB, the maximum record count is 100,000, and the maximum date span is 366 days.
- Exact duplicate normalized records and duplicate `rowId` values are rejected instead of being silently counted twice.

## Privacy boundary

Use short aliases for `project`, `session`, `model`, and `activity`. The normalizer rejects raw UUIDs, long opaque session identifiers, email addresses, local paths, URLs, control characters, known secret fields, prompt/message/content/code fields, and unknown fields.

The HTML replaces supplied session aliases with stable report-only pseudonyms. The uploaded original file remains managed by the platform or caller: the runner does not delete or modify it and does not copy it into the published output. The runner-created normalized and derived intermediates are stored in a private temporary directory and removed in `finally` after success or failure. The published output contains only the self-contained HTML, a safe manifest, and an ownership marker.

The manifest records this boundary explicitly: `inputFileLifecycle` is `platform-or-caller-managed` for uploads (and `bundled-read-only` for the demo), `inputFileDeletedByRunner` and `inputFileCopiedToPublishedOutput` are `false`, and `privateIntermediatesDeletedAfterRun` is `true`. These fields describe the runner's behavior; they do not claim that the platform itself deletes or retains an uploaded file.

## Output contract

The runner writes one JSON object to stdout:

```json
{
  "schema": "codex.consumption.run-result.v1",
  "status": "complete",
  "mode": "demo",
  "source": { "kind": "bundled-synthetic", "synthetic": true },
  "summary": {},
  "facts": [],
  "dataQuality": [],
  "artifacts": {
    "html": "codex-consumption-report.html",
    "manifest": "codex-consumption-manifest.json"
  },
  "replyMarkdown": "..."
}
```

The envelope contains artifact basenames, never host-absolute paths. Errors use the same schema with `status: "error"`, a stable code, a safe message, and `published: false`.
