# Troubleshooting

## Wrong JSON schema

Symptom: `Unsupported CodeBurn schema: missing`.

Cause: `codeburn report --format json` returns a compact dashboard object, not `codeburn.export.v2`.

Fix: use:

```bash
npx -y codeburn@0.9.19 export --provider codex --format json --from 1970-01-01 --output /absolute/path/source.json
```

## Report contains only today

CodeBurn export defaults to Today when no custom start is passed. Omit `--input` and use the bundled generator, or add `--from 1970-01-01` manually for the lifecycle.

## Account total is much larger than CodeBurn

CodeBurn reads currently retained local Codex session files. Deleted, rotated, migrated, or unavailable sessions are no longer present, so a current CodeBurn export is not necessarily a complete account ledger.

Use automatic generation with no `--input`. When `~/.cc-switch/cc-switch.db` exists, the generator combines its persistent baseline with only CodeBurn records strictly after the baseline cutoff, and compares that reconstruction with the sanitized official account usage series. Do not add the two full sources together.

## Windows usage appears in the account total but not in projects

The official source is account-level and is expected to include activity from every device using the same signed-in Codex account. The Mac report cannot read Windows session files, project paths, or a Windows CC Switch database remotely, so Windows activity may affect the official headline without appearing in local project detail.

Run CodeBurn on Windows and import that export as a separately aliased device. If Windows also has CC Switch, include a read-only snapshot of its `cc-switch.db` for retained history. Until the Windows bundle is imported, describe Windows local-detail coverage as unavailable, not zero. See [multi-device.md](multi-device.md).

## The official-versus-local gap looks like Windows usage

Do not label it that way. The residual can combine unimported devices, deleted or rotated sessions, other clients, collection lag, and official/local date-boundary differences. Keep it as `仅官方记录（无本地明细）` at account-summary level and never allocate it across devices, projects, models, dates, sessions, or Token components.

## Official and local daily values do not match

The official account interface exposes dated buckets but not their timezone contract. Local detail uses the requested IANA timezone and call timestamps. Keep the two daily series separate, compare only their selected-range totals, and describe the difference as a net account-versus-local gap. Do not shift official buckets until they appear to match, and do not allocate the residual to projects or Token components.

## Historical rows show `历史未归属`

CC Switch preserves Token, model, session, timestamp, and cost information but may not retain CodeBurn's project and inferred-task labels. Surviving CodeBurn records recover some mappings. If a referenced rollout file still exists, the collector also reads only its first `session_meta` row and may recover the project from `payload.cwd`; it does not read prompt/code rows or infer a task from the path. The remainder must stay explicitly unattributed. Show the coverage percentage rather than dropping those Tokens or inventing a project.

In a multi-device report, make the origin visible as `历史未归属 · <deviceAlias>`. If the local thread file and every durable ledger record were both deleted, the current sources cannot reconstruct either the amount or its project. Do not guess from the official residual.

## The same local history appears in two device exports

Copied session folders or database snapshots can create overlap. Build each ledger with the current collector, merge its event layer using stable event IDs, retain one identical payload with both provenance records, and stop on conflicting duplicates. The merger can also remove a mutually unique CC Switch/CodeBurn pair only when session, model, every Token component, and timestamp satisfy the strict rule. Do not deduplicate by date, model, total Token, project name, or session alone.

If only old compact `codex.lifecycle.ledger.v1` files are available, collect fresh ledgers before generating a cross-device report. The merger can emit a diagnostic compact result, but the report generator rejects it because exact cross-device deduplication is not guaranteed.

## Same project appears twice across Mac and Windows

Folder names are not project identity. Prefer the shared hashed Git fingerprint emitted from surviving `session_meta` metadata. When that is unavailable, create a `codex.project.aliases.v1` file mapping the exact device label and stored project path to one visible alias, then pass it with `--project-alias-map`. Do not merge two projects merely because both folders are named `app` or `project`.

## Cross-device merge stops on an ambiguous event

The merger found opposite-source calls close in time but could not prove a unique one-to-one match. Keep both source ledgers unchanged and inspect which device snapshot was copied or which source boundary overlaps. Do not widen the time window, remove Token fields from the match, or force the report to continue; those changes can silently delete legitimate calls.

## Explicit input did not use CC Switch

A supplied CodeBurn export is treated as a self-contained local snapshot so it is not silently mixed with a different machine state. Use `--enrich-lifecycle` only for a current full-lifecycle export that is intended to be combined with this machine's CC Switch database and official signed-in account. Automatic collection enables enrichment by default when the database is present.

## CodeBurn refuses to overwrite

CodeBurn protects existing files that do not look like its export. Choose a new dedicated output directory. Do not delete or overwrite an ambiguous target.

## Output directory is not owned by this Skill

The generator refuses a non-empty directory unless it contains its own marker or a valid prior report manifest. Choose a new empty directory. Use `--replace-output` only after checking the exact target and deliberately authorizing replacement of the Skill's fixed artifact names; it does not make a workspace root an appropriate output directory.

## Codex executable cannot be found

The official collector checks `--codex-bin`, `CODEX_CONSUMPTION_CODEX_BIN`, `codex`, `codex.exe`, or `codex.cmd` on `PATH`, and known macOS ChatGPT/Codex app locations. Automatic discovery tries every distinct candidate until one returns valid usage; explicit and environment-selected binaries fail fast so configuration errors stay visible. Pass an explicit executable path when Codex is installed elsewhere. If official collection remains unavailable, generate the local-only report and label it accordingly.

## SQLite collection is unavailable

Use Node.js 22.5 or newer so `node:sqlite` can open the CC Switch database read-only. On older Node versions, install the `sqlite3` command-line tool or omit lifecycle enrichment. A real database or SQL error is not retried through another engine; inspect the database path or snapshot instead.

## JSON intermediates are missing

Check `codex-consumption-manifest.json` for `retention`. With `compressed`, the validated intermediates are stored as `.json.gz`; decompress them into a private temporary directory before independent validation. With `report-only`, only hashes remain and the sources must be regenerated to validate again. The HTML remains self-contained in all three modes.

## Session labels no longer match raw UUIDs

This is intentional. Derived JSON and HTML use stable pseudonyms such as `session-a1b2c3d4e5f6`; raw source session IDs are validated internally but never embedded in the deliverable report.

## Custom-period totals disagree

Some CodeBurn 0.9.19 arrays can remain broader than the selected period. The bundled derivation filters raw records to the daily range and reconstructs projects/sessions when their call totals do not match the period. Do not remove this fallback.

## Date flags are rejected with an input file

`--from` and `--to` control automatic CodeBurn collection only. A supplied `--input` already has its reporting period encoded in `periods[0].daily`. Export the desired period first, then pass that scoped JSON without date flags.

## Playwright cannot be resolved

Call the workspace dependency locator, use its Node executable, and set `NODE_PATH` to its `node_modules`. HTML generation and validation do not require Playwright.

## Chrome is missing

Pass `--chrome /absolute/path/to/chrome-or-chromium`. If no browser exists, deliver the validated HTML and explain that PNG/PDF QA was skipped.

## PDF charts are clipped

Confirm print media has activated before chart resize. The renderer waits, dispatches `beforeprint` and `resize`, audits SVG widths, then creates the PDF. Keep the fixed millimeter print width in the template.

## Mobile overflow audit lists tables

Tables inside `.table-scroll` are allowed to exceed their scroller. Fail only when `documentElement.scrollWidth` exceeds the viewport or a non-table visualization leaks outside its card.
