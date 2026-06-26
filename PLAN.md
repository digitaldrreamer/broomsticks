# broomsticks — design & roadmap

This document is the source of truth for what broomsticks is, how it's built, and
the order it gets built in. The README is the user-facing pitch; this is the
engineering plan.

## 1. Vision

A small, trustworthy CLI that finds and scrubs secrets out of the local chat
transcripts written by AI coding assistants (Claude Code, Codex, Cursor, and
later others), without making the situation worse — no new dependencies to
audit, no destructive default, always a backup.

Success looks like: a developer runs `npx broomsticks scan` after a session,
sees exactly which secrets leaked into which transcripts, and runs
`broom clean --apply` to scrub them — with a backup taken automatically and an
auditable record of what changed.

## 2. Non-goals

- **Not a rotation tool.** A secret in a transcript was likely also sent to a
  model provider; it must be rotated regardless. broomsticks is disk cleanup,
  and the docs say so loudly.
- **Not a git/secret-scanner for source code.** That space is well served
  (gitleaks, trufflehog, detect-secrets). We scan *assistant transcripts*.
- **Not a daemon / watcher** (at least through v1.0). It runs on demand.
- **Never touches credential files** (`auth.json`, `~/.aws/credentials`, keyrings).
  Only chat history.

## 3. Architecture

A linear, easily-auditable pipeline. Everything operates on **text blobs**, which
keeps every source uniform and avoids structure-aware editing bugs.

```
sources/*  ──▶  detector  ──▶  redactor  ──▶  backup  ──▶  writer
 (discover     (rules +       (placeholder   (copy        (source-
  Targets)      entropy)       substitution)  first)        specific)
                   │
                   ▼
                report (human / --json)
```

### 3.1 The `Target` abstraction

Every source reduces to a list of **Targets**, each a single addressable blob of
text plus how to read and write it:

```js
/**
 * @typedef {Object} Target
 * @property {string} source         // 'claude-code' | 'codex' | 'cursor'
 * @property {string} label          // human label (path, or db:key)
 * @property {string} file           // underlying file to back up before writing
 * @property {() => string} read     // current text content
 * @property {(text: string) => void} write  // persist redacted text (only on --apply)
 */
```

- **JSONL sources** (Claude Code, Codex): one Target per file. `read()` returns
  the whole file; `write()` overwrites it. Redaction happens inline on the raw
  text — placeholders contain no JSON-breaking characters, so the file stays
  valid JSON Lines without parse/serialize round-trips.
- **Cursor** (SQLite): one Target per relevant `ItemTable` / `cursorDiskKV` row.
  `read()` returns the stored value; `write()` runs an `UPDATE`. `file` is the
  `.vscdb` path so it's backed up once even though it yields many Targets.

### 3.2 Detector

`scanText(text, rules, extras) -> Finding[]` where

```js
/** @typedef {{ruleId:string,title:string,severity:'critical'|'high'|'medium'|'low',secret:string,start:number,end:number}} Finding */
```

- Each rule is a `RegExp` (with `g` and `d` flags so we get capture-group
  offsets via `match.indices`) plus an optional `secretGroup` and optional
  `entropy` threshold (Shannon bits/char) for the generic catch-all.
- **Overlap resolution:** when two rules match the same span (e.g. a provider
  rule and the generic assignment rule), keep the longer / higher-severity
  finding and drop the other, so we never nest placeholders.
- **Extras:** user-supplied literals/regexes from `--extra` are appended as
  synthetic high-severity rules.

### 3.3 Redactor

`redactText(text, findings) -> {text, applied}`

- Replaces from rightmost finding to leftmost so byte offsets stay valid.
- Placeholder format: `«BROOM:<ruleId>:<sha8>»`, `sha8 = sha256(secret)[0..8]`.
- Idempotent: placeholders match no rule, so re-runs are no-ops.

### 3.4 Backup

Before the first write to any `file`, copy it (plus SQLite `-wal`/`-shm`
siblings) into `~/.broom/backups/<ISO-timestamp>/<flattened-path>`. Track
backed-up files in a set so multi-Target files (Cursor) are copied once. A
`manifest.json` records originals, backups, and the redaction summary.

### 3.5 Report

Human output groups findings by source → file, masks each secret
(`sk-…o4UA`), and prints severity counts. `--json` emits the structured
findings for CI. Exit code `1` when findings exist (unless `--no-fail`).

## 4. Detection ruleset (initial)

| id | severity | shape |
| --- | --- | --- |
| `private-key` | critical | `-----BEGIN … PRIVATE KEY-----` … `-----END …-----` |
| `aws-access-key` | high | `AKIA[0-9A-Z]{16}` |
| `github-pat` | high | `gh[pousr]_[A-Za-z0-9]{36,}` |
| `github-fine-grained` | high | `github_pat_[0-9A-Za-z_]{82}` |
| `openai-key` | high | `sk-(proj-|svcacct-)?[A-Za-z0-9_-]{20,}` |
| `anthropic-key` | high | `sk-ant-[A-Za-z0-9_-]{20,}` |
| `huggingface` | high | `hf_[A-Za-z0-9]{34}` |
| `google-api-key` | high | `AIza[0-9A-Za-z_-]{35}` |
| `slack-token` | high | `xox[baprs]-[A-Za-z0-9-]{10,}` |
| `stripe-key` | high | `(sk|rk)_live_[A-Za-z0-9]{20,}` |
| `paddle-key` | high | `pdl_(live|sdbx)_[a-z0-9]+_[A-Za-z0-9_]{20,}` |
| `jwt` | medium | `eyJ….eyJ….…` |
| `db-url` | high | `scheme://user:pass@host` for postgres/mysql/mongodb/redis/amqp |
| `generic-assignment` | medium | `(api_key|secret|token|password|…) = <16+ chars>` gated at entropy ≥ 3.2 |

Thresholds and additions tracked here as the ruleset evolves. False-positive
control: provider rules are precise; the generic rule is entropy-gated and
last-resort.

## 5. Safety & threat model

- **Default is read-only.** Writing requires `--apply`.
- **Backups always precede writes** (unless `--no-backup` is explicitly passed).
- **No network.** broomsticks never makes a network call. Easy to verify: there
  is no `fetch`/`http` import anywhere in `src/`.
- **No new dependencies.** Zero-dependency by policy; CI will fail if
  `dependencies` becomes non-empty.
- **Credential files are out of scope** and explicitly skipped.
- **Placeholders are one-way.** The original secret cannot be recovered from a
  redacted transcript or the manifest (only a truncated hash is kept).

## 6. CLI surface

```
broom scan  [--source <id>]… [--json] [--no-fail] [--extra <file>]
broom clean [--source <id>]… [--apply] [--backup-dir <dir>] [--no-backup] [--extra <file>]
broom sources                 # list discovered sources + transcript counts
broom --help | --version
```

`scan` and `clean` (without `--apply`) are both read-only; `clean --apply` is the
only mutating path.

## 7. Source adapters

| Source | Discovery | Read unit | Write |
| --- | --- | --- | --- |
| `claude-code` | `~/.claude/projects/**/*.jsonl` | whole file | overwrite |
| `codex` | `~/.codex/history.jsonl`, `~/.codex/sessions/**/*.jsonl` | whole file | overwrite |
| `cursor` | `state.vscdb` under `globalStorage` + `workspaceStorage/**` | `ItemTable`/`cursorDiskKV` rows whose key matches `/chat|composer|aiService|aichat|prompt|cursorai/i` | `UPDATE` |

Path roots are OS-resolved: Linux `~/.config/Cursor`, macOS
`~/Library/Application Support/Cursor`, Windows `%APPDATA%/Cursor`.

## 8. Milestones

- **v0.0.x — placeholder (done).** Reserve the npm name; stub `broom` prints a
  notice; README + PLAN published. No engine.
- **v0.1 — MVP.** `rules`, `detector`, `redact`, `backup`, `report`, and the
  `claude-code` adapter. `scan` + `clean --apply` end-to-end on JSONL. Unit
  tests for detection/redaction. This is the first genuinely useful release.
- **v0.2 — full source coverage.** `codex` and `cursor` (SQLite via
  `node:sqlite`, with a `sqlite3`-CLI fallback). `broom sources`.
- **v0.3 — control & CI.** Config file (`.broomrc`), allowlist for known false
  positives, `--extra` custom secrets, `--json`, documented exit codes, and a
  GitHub Action wrapper for "fail the job if a transcript leaks."
- **v0.4 — more assistants.** Windsurf, Continue, Aider, Zed AI, Cline. The
  `scripts/broom.sh` dependency-light fallback (`jq` + `sqlite3`).
- **v1.0 — stable.** Frozen rule schema, semver guarantees, docs site.

## 9. Testing strategy

- `node --test` (built-in runner, no test-framework dependency).
- **Detector fixtures:** a corpus of synthetic transcripts containing planted
  secrets of every rule type + decoys that must *not* match; assert exact
  findings.
- **Redaction round-trip:** redact → re-parse JSON / re-open SQLite → assert
  still valid and secrets gone; redact twice → assert idempotent.
- **Backup integrity:** assert a backup exists and byte-matches the original
  before any write.
- **No-network assertion:** static check that `src/` imports no networking APIs.

## 10. Distribution

- **Primary:** npm — `npx broomsticks` and `npm i -g broomsticks` (bin `broom`).
- **Fallback:** `scripts/broom.sh` for machines without a suitable Node.
- Published artifact equals source (no build/minify step) for auditability.

## 11. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Corrupting a transcript on write | Inline placeholder substitution (no re-serialize); mandatory backup; round-trip tests |
| Cursor schema drift | Key-pattern matching, not fixed keys; version-tolerant; covered by tests against captured fixtures |
| False sense of security (secret already sent to provider) | README + report both state: rotate anyway |
| False positives | Precise provider rules + entropy-gated generic rule + allowlist (v0.3) |
| Supply-chain trust | Zero deps, no build, CI guard on `dependencies` |

## 12. Open questions

- Redact within Cursor's nested JSON values field-by-field, or treat the whole
  row value as a blob? (Leaning blob — simpler, and placeholders are
  JSON-safe.)
- Should `--apply` write a `.redacted` sidecar log per file in addition to the
  global manifest?
- Worth a `--since <duration>` filter to scan only recent sessions?
