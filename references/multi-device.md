# Multi-device collection and merge

Use this workflow when the report must explain Codex activity from more than one computer, especially a Mac and a Windows machine using the same account.

## Contents

1. Layer model
2. Device collection
3. Deleted-thread behavior
4. Event-level merge
5. Cross-OS project identity
6. Report labels and claims

## Layer model

Build two distinct layers:

```text
official account layer   = collect once from the signed-in account
local explanatory layer = import separately from each available device
```

Expect the official layer to include Mac and Windows activity only when both used the same signed-in Codex account. The official interface does not expose a device, project, session, or local-path dimension, so it cannot verify a Windows share. Never collect or sum one official total per device.

Require a user-defined `deviceAlias` such as `mac-main`, `win-main`, or `work-laptop`. Keep it descriptive but non-identifying. Do not export a hostname, hardware ID, OS account name, full home path, email, or account ID.

List every device actually imported. Mark an expected but unavailable device as “未导入本地明细”; never represent it as zero Token.

## Device collection

Collect on each device itself. A Mac cannot reconstruct Windows projects without a Windows-local export.

Use Node.js 20.11 or newer on each device. Node.js 22.5 or newer provides the read-only `node:sqlite` runtime; earlier supported versions need a separate `sqlite3` executable for CC Switch enrichment. CodeBurn collection also needs npm/`npx`. Run every command against a copied CC Switch database or through the collector's read-only connection—never modify the live database. The aggregation machine alone collects the official account layer; pass `--codex-bin` when its Codex executable is not on `PATH` or in a known macOS app bundle.

### CodeBurn snapshot

CodeBurn is required for retained project, inferred-task, and session attribution. On macOS or Linux:

```bash
npx -y codeburn@0.9.19 --timezone "Asia/Shanghai" export \
  --provider codex \
  --format json \
  --from 1970-01-01 \
  --output "/absolute/path/codeburn.json"
```

On Windows PowerShell:

```powershell
npx -y codeburn@0.9.19 --timezone "Asia/Shanghai" export `
  --provider codex `
  --format json `
  --from 1970-01-01 `
  --output "D:\CodexExport\codeburn.json"
```

Choose one report timezone and use it for every device ledger in the same report. Event timestamps remain UTC, while the ledger's dated compact rows use this timezone. The merger rejects mixed timezones so the rebuilt date and hour views have one calendar contract. Do not assume that identical displayed dates imply identical UTC boundaries.

When CC Switch indexes a Codex rollout file that still exists but CodeBurn has no project mapping, the collector may parse only that file's first `session_meta` row and retain only `payload.id` plus `payload.cwd`. Use the `cwd` as a project-only fallback; never infer a task type from it, and never scan prompt, tool, or code rows for attribution.

### Optional CC Switch snapshot

If the device has CC Switch, include a read-only snapshot of its local `cc-switch.db`. It can preserve Token history after CodeBurn thread files have disappeared. Do not alter the live database. Do not assume that a database copied from another computer is native to the current device; provenance must identify the snapshot source alias.

Build the current event-level device ledger on macOS or Linux with:

```bash
node "$SKILL_DIR/scripts/collect-lifecycle-ledger.mjs" \
  --codeburn "/absolute/path/codeburn.json" \
  --cc-db "/absolute/path/cc-switch.db" \
  --output "/absolute/path/mac-ledger.json" \
  --timezone "Asia/Shanghai"
```

On Windows PowerShell:

```powershell
node "C:\path\to\generate-codex-consumption-report\scripts\collect-lifecycle-ledger.mjs" `
  --codeburn "D:\CodexExport\codeburn.json" `
  --cc-db "D:\path\to\cc-switch.db" `
  --output "D:\CodexExport\windows-ledger.json" `
  --timezone "Asia/Shanghai"
```

Omit `--cc-db` when that device has no CC Switch database. In that case the ledger contains every retained CodeBurn call but cannot recover older calls whose thread files are already gone. Assign the non-identifying device alias later with the merge command; do not derive it from the path or hostname.

The collector writes `codex.lifecycle.ledger.v1` with `eventContract.eventLevelReliable=true`. Its transferable event layer contains:

- collection timestamp, timezone, and source availability;
- event-level UTC timestamps, session identifiers, models, Token components, and cost estimates;
- normalized project and inferred-task labels where recoverable;
- stable SHA-256 event IDs before aggregation;
- hashed Git repository fingerprints when a surviving `session_meta` row exposes a remote.

The merge step adds the user-supplied device alias as provenance. The collector reads only the first `session_meta` row for `payload.id`, `payload.cwd`, and the Git remote used to create the hash; it does not read later prompt, code, or tool rows. Keep credentials, hostnames, account IDs, raw Git remotes, and other identity fields out of the bundle. The local ledger can still contain project paths needed for alias resolution, so transfer it only through a trusted channel and do not upload it with the report.

## Deleted-thread behavior

Deleting a Codex thread can remove the CodeBurn session file that carried its project path and inferred task. CC Switch may still retain Token, timestamp, model, session, and cost fields, so the amount can remain in the local ledger while its classification is lost. If the rollout file itself still survives, `session_meta.cwd` can recover the project even when CodeBurn did not export that mapping; it cannot recover the inferred task.

Apply these states:

- local event and project mapping survive: keep normal project attribution;
- local event survives but project mapping is gone: use `历史未归属 · <deviceAlias>`;
- local event survives but inferred task is gone: use `历史未归类`;
- neither device-local event source survives: do not fabricate an event from the official residual.

Backups or another valid snapshot may restore attribution. Without such evidence, project and task recovery is impossible from the current sources.

## Event-level merge

Reconstruct each device independently first:

```text
device local lifecycle = device CC Switch baseline through cutoff
                       + device CodeBurn records strictly after cutoff
```

Then merge normalized events across devices. Create source-stable event IDs before compacting:

- CC Switch: hash `request_id`, UTC `created_at`, `session_id`, model, and all Token components;
- CodeBurn: hash UTC timestamp, `sessionId`, model, and all Token components.

Exclude `deviceAlias`, hostname, and path from the hash. When two imports contain the same event ID and identical normalized payload, retain one event and attach both provenance records. When the same ID has conflicting payloads, fail validation and inspect the sources.

Never deduplicate by any of these weak keys:

- date + model + Token total;
- project or folder name;
- session ID alone;
- a compact row's display fields.

The current `codex.lifecycle.ledger.v1` collector includes this event layer. A ledger produced before the event contract existed may contain compact rows only; keep that legacy merge for diagnosis, but do not use it to generate a cross-device report.

Run the event-level merge with:

```bash
node "$SKILL_DIR/scripts/merge-device-ledgers.mjs" \
  --ledger mac=/absolute/path/mac-ledger.json \
  --ledger windows=/absolute/path/windows-ledger.json \
  --project-alias-map /absolute/path/project-aliases.json \
  --output /absolute/path/merged-ledger.json
```

The alias map is optional when projects should remain device-scoped or equal Git fingerprints are sufficient. The output remains `codex.lifecycle.ledger.v1` and must report `deduplication.eventLevelReliable=true`, `granularity="event"`, and `tokenAudit.verified=true`. It records exact-ID and strict cross-source duplicates separately. Equal event IDs with a conflicting core payload fail. For CC Switch/CodeBurn pairs, only a mutually unique match with the same session, model, every Token component, and no more than 1.5 seconds of timestamp difference is removed; any other opposite-source candidate within 10 seconds stops the merge.

When the inputs use the same report timezone and the event audit passes, build the report with:

```bash
node "$SKILL_DIR/scripts/generate-report.mjs" \
  --device-ledger mac=/absolute/path/mac-ledger.json \
  --device-ledger windows=/absolute/path/windows-ledger.json \
  --project-alias-map /absolute/path/project-aliases.json \
  --official-input /absolute/path/codex-official-usage.json \
  --output-dir "/absolute/output/directory" \
  --timezone "Asia/Shanghai" \
  --retention compressed
```

The generator imports the official source exactly once and fails before derivation if any input is compact-only or the event merge is ambiguous. Omit `--official-input` only on an aggregation computer that can collect the signed-in account layer directly.

Keep the official account layer outside this merge. It is a comparison total, not an event source to append to local records.

## Cross-OS project identity

Windows and macOS paths for the same repository usually differ. Merge them only through one of:

1. an explicit user-provided alias map;
2. an equal sanitized Git repository fingerprint.

Build the Git fingerprint locally from a canonical repository identity such as normalized Git host/owner/repository, then hash it before export. Do not store the raw remote URL. Never merge projects merely because their final folder basenames match.

Use this explicit alias-map contract when the same project has different paths and no common Git fingerprint:

```json
{
  "schema": "codex.project.aliases.v1",
  "aliases": [
    { "device": "mac", "project": "/Users/example/work/app", "alias": "app" },
    { "device": "windows", "project": "D:\\work\\app", "alias": "app" }
  ]
}
```

The `device` value must match the merge label exactly. `project` must match the path stored in that device ledger. `alias` is the final visible project name, must be 1–80 printable characters, and cannot contain `/` or `\`. Resolution order is explicit alias, equal Git fingerprint, then a device-scoped basename such as `app · mac`; missing projects remain `历史未归属 · mac`.

## Report labels and claims

Use `仅官方记录（无本地明细）` for the unallocated account-level difference between official activity and the imported local layer. Keep it out of device, project, task, model, session, date, hour, and Token-component charts.

Report these facts separately:

- official account Token, collected once;
- imported device aliases and their local subtotals;
- duplicate-event Token removed during merge;
- locally reconstructed Token after deduplication;
- project and task attribution coverage within that local total;
- official-versus-local residual, without causal assignment.

Never call the residual “Windows Token” or “deleted-thread Token”. It can mix unimported devices, deleted or rotated sessions, other clients, collection lag, and date-boundary effects.
