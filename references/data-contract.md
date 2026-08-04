# Data contract

## Contents

1. Source modes and precedence
2. Account and device layers
3. Lifecycle reconstruction
4. Date and filtering rules
5. Token and cost semantics
6. Attribution rules
7. Privacy and retention
8. Reconciliation rules
9. Interpretation limits

## Source modes and precedence

The generator supports two explicit modes.

### Lifecycle report

Use one official source and one or more device-local source bundles, with different responsibilities:

- `codex.official.usage.v1`: authoritative signed-in account Token headline and dated official buckets;
- `codex.lifecycle.ledger.v1`: locally reconstructed lifecycle volume, Token components, models, sessions, and cost estimate;
- CodeBurn `codeburn.export.v2`: current surviving local detail used to recover projects, inferred task types, and post-ledger activity.

Never treat these as interchangeable copies of one dataset. Official usage controls the account headline and must be collected and counted exactly once. The lifecycle ledger controls locally reconstructed components and total for an imported device. CodeBurn supplies detail only where the underlying local records still exist.

The official saved source may contain only:

- schema and collection timestamp;
- lifetime Token count;
- peak daily Token count and non-sensitive activity summary fields;
- daily `{startDate, tokens}` buckets.

Do not save email, account ID, access token, device ID, or raw app-server messages.

The official source is account-level. It is expected to include Mac and Windows activity when both used the same signed-in Codex account, but it contains no device, project, session, or local-path fields. Do not collect one official total per device or add official totals together.

### Local-only report

Use CodeBurn `export --format json`, not `report --format json`.

Required source schema: `codeburn.export.v2`. Required fields are `generated`, `summary[0]`, `periods[0].daily`, `periods[0].models`, `periods[0].activity`, and `records`. `sessions` and `projects` may be used for audit when scoped correctly.

CodeBurn 0.9.19 may leave `records`, `sessions`, or `projects` broader than a custom selected period. Never assume those arrays are scoped merely because `summary` is scoped. Also never call this mode a complete account lifecycle merely because collection began at `1970-01-01`: deleted or rotated session files are absent.

## Account and device layers

Represent a cross-device report as:

```text
report = one official account layer
       + one local explanatory layer per imported device
```

Require a user-defined, non-identifying `deviceAlias`, such as `mac-main` or `win-main`. Do not persist a hostname, hardware identifier, Windows user name, macOS account name, or raw home path as the device identity. A device with no imported bundle has unknown local coverage; never synthesize a zero-usage row for it.

Each device bundle should contain:

- one full-retention CodeBurn `codeburn.export.v2` snapshot for project and inferred-task attribution;
- an optional device-local CC Switch database snapshot for durable Token history;
- the collection timezone and timestamp;
- normalized local events with stable event IDs before aggregation.

The current collector writes these events inside `codex.lifecycle.ledger.v1` and sets `eventContract.eventLevelReliable=true`. It also keeps compact rows for report derivation. Raw Git remotes remain local to collection and only their SHA-256 fingerprints are emitted. Project paths may remain in the private ledger until an explicit alias map is applied, so do not publish device ledgers with the report. Read [multi-device.md](multi-device.md) for collection and identity rules.

### Event-level deduplication

Create a stable `eventId` from source-stable fields before compacting rows:

- CC Switch event: `request_id`, UTC `created_at`, `session_id`, model, and all Token components;
- CodeBurn event: UTC timestamp, `sessionId`, model, and all Token components.

Do not include `deviceAlias`, hostname, or local path in `eventId`, because the same event may appear in an export copied between devices. For equal event IDs with identical normalized payloads, retain one event and append all provenance records. If equal IDs have conflicting model, timestamp, session, or Token payloads, fail validation and require source inspection.

CC Switch and CodeBurn can represent the same call with different source-specific IDs. Remove such a pair only when it is mutually unique, has equal normalized session, model, and every Token component, and timestamps differ by no more than 1.5 seconds. If an opposite-source candidate exists within 10 seconds but that strict match is absent or non-unique, fail the merge rather than guessing.

Never deduplicate by calendar date plus model and Token total, by display label, or by session alone. Those keys can collapse legitimate calls. Compact-only legacy ledgers do not preserve enough identity for robust cross-device deduplication. The merger may inspect them and label its result `eventLevelReliable=false`, but the report generator must reject that output.

## Lifecycle reconstruction

Construct the local ledger as a disjoint union:

```text
local lifecycle = CC Switch baseline through cutoff
                + CodeBurn records strictly after cutoff
```

Requirements:

- Resolve the maximum CC Switch event timestamp as the baseline cutoff.
- Admit a CodeBurn record only when its timestamp is strictly greater than the exclusive append boundary.
- Records at or before the cutoff may be used to recover project or inferred-task mappings for an existing session, but must not add Token, call, or cost totals. When CodeBurn has no project mapping, a surviving rollout's first `session_meta` row may provide `payload.cwd` as a project-only fallback; do not read later content rows or infer a task from `cwd`.
- Preserve source subtotals for CC Switch and CodeBurn increment so the union is auditable.
- Weight compact rows by their stored `calls`; one compact row does not necessarily mean one call.
- Reconstruct this disjoint union independently for every imported device before cross-device event deduplication. Do not apply one device's cutoff to another device.

Restrict the account comparison and visible default range to the official bucket bounds. Retain local amounts before the first official bucket or after the last available bucket as `outsideOfficialDateRangeTokens`; do not add them to the current account comparison. The exposed official bucket range is the only safe account-range boundary available from this sanitized interface.

## Date and filtering rules

- In lifecycle mode, derive `rangeStart` and `rangeEnd` from the first and last official daily buckets. In local-only mode, derive them from `periods[0].daily`.
- Interpret every UI range as inclusive calendar dates inside those bounds.
- Preserve official bucket labels exactly as returned. The official interface does not expose a bucket timezone; do not shift dates merely to improve reconciliation.
- Convert lifecycle record timestamps into the requested IANA timezone and build compact local facts by date, hour, project alias, session, model, and inferred task type.
- Filter the official series and local facts independently using the same selected date labels. They are parallel layers, not a row-by-row join.
- Insert zero rows for missing calendar dates so the visible date axis remains continuous.
- Keep one global range state. Applying a range must atomically update the official headline/timeline and every local Token, cost, project, model, task, session, hour, table, and selected-range fact.
- For each filtered session, define start as its first call inside the selected range. This is a period view, not necessarily the original lifetime session start.

## Token and cost semantics

Normalized Token total:

```text
freshInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
```

CC Switch stores cache-inclusive `input_tokens`. Normalize it as:

```text
freshInputTokens = input_tokens - cache_read_tokens
totalTokens      = freshInputTokens + cache_read_tokens + output_tokens
                 = input_tokens + output_tokens
```

This means the cache field is not being added twice. In CodeBurn records, the input component is already represented separately from cache read and cache write.

For CodeBurn 0.9.19 Codex records, `reasoningTokens` is an informational subset of `outputTokens`. Do not add it again.

The monetary value is an API-equivalent model-price estimate, not a Codex subscription invoice, credit balance, or quota deduction. Apply one immutable full-range cost scale to the local facts when needed. Date filters sum already-scaled rows; never renormalize cost per selected range or per dimension.

## Attribution rules

- Normalize separators and casing; remove the `Users/<name>/` prefix from visible labels.
- Merge `.codex/worktrees/<id>/<suffix>` into a matching parent project when one exists.
- Normalize `project/<number>` to `project-<number>`.
- Group dated `Documents/Codex/YYYY/MM/DD/...` paths as `Codex scratch`.
- Use surviving CodeBurn session mappings to recover lifecycle project and inferred-task labels.
- If CodeBurn has no project for a CC Switch session and its rollout still exists, parse only the first `session_meta` row and retain only `payload.id` plus `payload.cwd`; use that `cwd` for project attribution after CodeBurn, never for inferred-task attribution.
- When a local event survives but its project mapping does not, label it `历史未归属 · <deviceAlias>`; use `历史未归类` for a missing inferred-task label.
- Use `仅官方记录（无本地明细）` only as the account-level name for the official residual. Never materialize that residual as fabricated project, task, device, model, session, date, or Token-component rows.
- Report project and task attribution coverage as `known attributed Tokens / locally reconstructed Tokens`.
- Do not drop unattributed rows, assign them proportionally, or fold the official-minus-local gap into them.
- Merge the same project across operating systems only through an explicit user alias map or an equal sanitized Git fingerprint. Build the fingerprint locally from a canonical repository identity, such as normalized Git host/owner/repository, then hash it before export. Do not store the raw remote and do not merge by folder basename alone.
- Do not embed prompts, code, raw project paths, identity fields, or credentials in derived data or report HTML.

## Privacy and retention

Raw source and device-ledger files are private audit inputs and may contain local paths or source session identifiers. Derived report data and HTML must replace every session identifier with a deterministic SHA-256 pseudonym formatted as `session-<12 lowercase hex>`. The same source session must map to the same pseudonym throughout one or repeated runs, while calls and Token totals must reconcile exactly before and after pseudonymization. Reject UUID-shaped values in any derived JSON or HTML field, including project labels.

On POSIX, write source, derived data, HTML, manifest, rendered images, and PDF as `0600` files inside `0700` directories. On Windows, use a current-user private NTFS directory and rely on its inherited ACL; never claim POSIX mode bits alone define Windows access. The manifest stores artifact paths relative to the output directory and records both retained-file hashes and uncompressed content hashes. Embed the Skill, ECharts, and d3 license/notice texts in the standalone HTML. Apply retention only after derivation, build, validation, and optional rendering succeed:

- `full`: retain validated JSON;
- `compressed`: retain deterministic-content JSON as private gzip files;
- `report-only`: remove JSON intermediates while retaining their content hashes and the self-contained HTML.

Mark Skill-owned output directories. Refuse fixed-name writes into a non-empty unowned directory unless the caller explicitly uses `--replace-output`. This opt-in does not authorize using a home directory, workspace root, or another broad directory as the target.

## Reconciliation rules

Lifecycle validation must assert:

- official daily dates are unique, ordered, and bounded;
- official bucket sum equals official lifetime Tokens exactly;
- official peak equals the maximum daily bucket exactly;
- the official account source occurs once, regardless of the number of imported devices;
- CC Switch component total equals its source Token total;
- CodeBurn increment begins strictly after the exclusive cutoff;
- CC Switch baseline plus CodeBurn increment equals the full local ledger for calls, components, total Tokens, and cost;
- local records inside official bounds sum to `reconstructedTokens`;
- local records outside official bounds sum to `outsideOfficialDateRangeTokens`;
- those two amounts sum to `fullLocalLedgerTokens`;
- `officialTokens - reconstructedTokens = netGapTokens` and absolute gap/rates use the declared denominators;
- known project Tokens plus historical unattributed project Tokens equals reconstructed Tokens;
- known task Tokens plus historical unattributed task Tokens equals reconstructed Tokens;
- daily, project, model, task, session, and heatmap local aggregates reconcile to the same selected local fact subset;
- weighted compact-fact call counts reconcile to the selected ledger;
- every imported device has a unique sanitized alias and a declared collection timezone;
- every device ledger in one merge uses the requested report timezone; reject mixed timezones rather than shifting already dated compact rows;
- every event-level local record has one stable event ID; exact duplicates retain one payload plus provenance, and conflicting duplicates fail;
- the merged local total equals per-device event totals minus validated duplicate-event totals;
- an unimported device is reported as outside local-detail coverage, never as zero usage;
- representative full-range, cross-month, 7-day, single-day, and empty/no-call selections preserve inclusive boundaries for both layers;
- the report contains all eight chart containers, no unresolved placeholders, and no remote runtime dependency.

Local-only validation must assert CodeBurn summary/daily/fact call, session, Token, and scaled-cost reconciliation using the source period bounds. Rounded display tables may differ by no more than `$0.10`; underlying unrounded totals must reconcile.

## Interpretation limits

- Official usage is the account-level Token total exposed by the signed-in Codex interface; it is not a remaining-quota denominator.
- The official total is expected to span same-account Mac and Windows activity, but the source cannot prove which device produced a Token.
- Official bucket timezone is not exposed. A local-versus-official daily mismatch is not proof of missing data on that date.
- A net official-minus-local gap measures coverage difference between the two layers. It may mix unimported devices, deleted or rotated local records, other clients, collection lag, and date-boundary effects. It must not be described as Windows usage, a precisely identified deletion count, or a project allocation.
- Deleting a Codex thread may leave Token, timestamp, model, session, and cost evidence in CC Switch while removing the CodeBurn project or inferred-task mapping. If neither source survives, no local reconstruction can recover that event from the current machine.
- A copied CodeBurn or CC Switch snapshot can appear on more than one device. Only event-level identifiers support reliable removal of that overlap; compact aggregates cannot prove it.
- Local history outside the currently exposed official bucket range may belong to a different account/auth period or to an as-yet-unavailable official date. Keep it outside the current account comparison.
- Cache Token share is not cache cost share.
- CodeBurn task labels are heuristic.
- Temporal overlap between a model and a high-volume period is not causal evidence.
- Execution-hour concentration includes background agent work and is not a timesheet.
