# Competition and Portable Mode

Use the competition runner only for an anonymous demonstration or an explicitly supplied sanitized file. This path is deliberately separate from the full local lifecycle collector so that a cloud evaluator does not need a signed-in Codex installation, CC Switch history, CodeBurn discovery, a browser renderer, or access to the current computer.

```bash
node "$SKILL_DIR/scripts/generate-competition-report.mjs" \
  --demo \
  --output-dir "/dedicated/output/report" \
  --timezone "Asia/Shanghai"
```

Replace `--demo` with `--input /path/to/usage.json` for a sanitized `codex.portable.usage.v1` JSON, JSONL record stream, or CSV file. The accepted field contract is documented in [competition/iflytek/references/portable-data-contract.md](../competition/iflytek/references/portable-data-contract.md).

The runner returns one `codex.consumption.run-result.v1` JSON envelope. Use `replyMarkdown` as the primary chat response and the self-contained HTML as a secondary artifact. It never exposes input or output absolute paths in the envelope. Uploaded data cannot mark itself as the bundled synthetic demo.

Portable activity labels come from the input file. Portable estimated costs also come from the input file and are API-equivalent estimates, not Codex subscription billing. Do not apply the full local-lifecycle source claims to this mode.
