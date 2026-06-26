# 🧹 broomsticks

> Sweep leaked secrets out of your AI coding-assistant chat transcripts — Claude Code, Codex, and Cursor — before they end up in a backup, a sync, or someone else's hands.

[![npm](https://img.shields.io/npm/v/broomsticks.svg)](https://www.npmjs.com/package/broomsticks)
[![node](https://img.shields.io/node/v/broomsticks.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/broomsticks.svg)](./LICENSE)

> **Status: early access.** The npm name is reserved and the design is locked (see [PLAN.md](./PLAN.md)); the scanner is in active development. The published `broom` command currently prints a notice only — it reads, writes, and transmits nothing until the engine lands. Watch the repo for `v0.1`.

---

## Why this exists

AI coding assistants keep a full, local, plaintext record of every session — your prompts, the model's replies, and **the raw output of every tool call**. That transcript is where secrets quietly accumulate:

- You paste a `.env`, a connection string, or a token to ask "why doesn't this work?"
- An agent runs `printenv`, `cat config`, or dumps a server's environment into the chat.
- A stack trace or API response with a bearer token gets logged verbatim.

Those transcripts then live on disk indefinitely — `~/.claude/projects/**/*.jsonl`, `~/.codex/*.jsonl`, Cursor's `state.vscdb` SQLite stores — and get swept into Time Machine, Dropbox, `rsync` backups, or a shared machine. A leaked key in a transcript is just as live as one in a committed `.env`, but nothing scans for it.

**broomsticks** is a small, auditable CLI that finds those secrets and scrubs them out of the transcripts in place — safely.

## Design principles

- **Dry-run by default.** Nothing is ever modified unless you pass `--apply`.
- **Back up before every write.** Each touched file is copied to a timestamped backup directory first.
- **Transcripts only.** It never touches credential files themselves (`~/.codex/auth.json`, `~/.aws/credentials`, etc.) — only chat history.
- **Auditable supply chain.** Plain ESM JavaScript, **zero runtime dependencies**, no build step. The code published to npm *is* the source — read every line before you trust it with your secrets.
- **Non-reversible, idempotent redaction.** Secrets are replaced with `«BROOM:<rule>:<sha8>»`. The hash lets you correlate without leaking, and re-running never double-redacts.

## Install

```bash
# one-off, no install
npx broomsticks scan

# or install the CLI globally
npm install -g broomsticks
broom scan
```

Requires **Node ≥ 22.5** (uses the built-in `node:sqlite` to read Cursor's database — no native modules).

Prefer no Node at all? A dependency-light **`scripts/broom.sh`** fallback (using `jq` + the `sqlite3` CLI) is planned for environments where you can't or won't run the package.

## Usage (target CLI)

```bash
# Scan every supported source, print a redacted report. Exits non-zero if anything is found (CI-friendly).
broom scan

# Limit to one source
broom scan --source claude-code
broom scan --source cursor

# Preview what would change, without writing
broom clean

# Actually redact — backs up every touched file first
broom clean --apply

# Machine-readable output for pipelines
broom scan --json

# Also scrub your own known-leaked values (one secret or /regex/ per line)
broom clean --apply --extra ./leaked.txt
```

| Flag | Meaning |
| --- | --- |
| `--source <id>` | Restrict to `claude-code`, `codex`, or `cursor` (repeatable; default: all) |
| `--apply` | Perform redaction (otherwise dry-run) |
| `--backup-dir <dir>` | Where backups go (default `~/.broom/backups/<timestamp>/`) |
| `--no-backup` | Skip backups (discouraged) |
| `--extra <file>` | Additional literal/regex secrets to redact |
| `--json` | Emit findings as JSON |
| `--no-fail` | Exit `0` even when secrets are found |

## What it detects

A curated, gitleaks-style ruleset for high-confidence provider tokens, plus an entropy-gated catch-all for unknown `KEY=value` / `"token": "…"` shapes:

| Rule | Examples |
| --- | --- |
| Private keys | `-----BEGIN … PRIVATE KEY-----` blocks (RSA/EC/OpenSSH/PGP) |
| Cloud | AWS access keys (`AKIA…`), Google API keys (`AIza…`) |
| Source hosting | GitHub `ghp_/gho_/ghu_/ghs_/ghr_…`, fine-grained `github_pat_…` |
| AI providers | OpenAI `sk-…` / `sk-proj-…` / `sk-svcacct-…`, Anthropic `sk-ant-…`, Hugging Face `hf_…` |
| Billing / SaaS | Stripe `sk_live_…`, Paddle `pdl_live_…`, Slack `xox[baprs]-…` |
| Tokens | JWTs (`eyJ….eyJ….…`) |
| Connection strings | `postgres://`, `mysql://`, `mongodb+srv://`, `redis://` with inline credentials |
| Generic | `api_key` / `secret` / `password` / `token` assignments above an entropy threshold |

The exact rule set, severities, and entropy thresholds live in `src/rules.mjs` once shipped — and are documented in [PLAN.md](./PLAN.md).

## How redaction works

A matched secret is replaced inline with a stable placeholder:

```
sk-ant-api03-VRLD…Ahg   →   «BROOM:anthropic-key:9f3a1c2b»
```

- The `sha8` is the first 8 hex chars of the secret's SHA-256 — enough to correlate the same leak across files without revealing it.
- Placeholders contain no JSON-breaking characters, so JSONL transcripts stay valid and Cursor's stored blobs stay parseable.
- Placeholders never match the detection rules, so `broom clean` is **idempotent** — run it as often as you like.

## Supported sources

| Source | Where it stores transcripts | Format |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl` | JSON Lines |
| **Codex CLI** | `~/.codex/history.jsonl`, `~/.codex/sessions/**` | JSON Lines |
| **Cursor** | `~/.config/Cursor/User/{globalStorage,workspaceStorage/**}/state.vscdb` (`ItemTable` / `cursorDiskKV`) | SQLite |

Paths shown for Linux; macOS/Windows equivalents are resolved automatically.

## Limitations

- It reduces exposure of secrets **already written to disk**; it cannot un-send anything already transmitted to a model provider. **If a secret hit a transcript, treat it as compromised and rotate it** — broomsticks is cleanup, not a substitute for rotation.
- Detection is best-effort. Novel or low-entropy secrets may be missed; tune with `--extra`.
- Cursor's schema evolves between versions; broomsticks targets the known chat/composer keys and will be kept current.

## Contributing

Issues and PRs welcome — especially new source adapters (Windsurf, Continue, Aider, Zed) and detection rules. See [PLAN.md](./PLAN.md) for architecture and the contribution surface.

## License

[MIT](./LICENSE) © digitaldrreamer
