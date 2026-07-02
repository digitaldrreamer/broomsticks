# 🧹 broomsticks

> Sweep leaked secrets out of your AI coding-assistant chat transcripts — Claude Code, Codex, and Cursor — before they end up in a backup, a sync, or someone else's hands.

[![npm](https://img.shields.io/npm/v/broomsticks.svg)](https://www.npmjs.com/package/broomsticks)
[![node](https://img.shields.io/node/v/broomsticks.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/broomsticks.svg)](./LICENSE)

> **Status: early access.** The scanner, redactor, source adapters (Claude Code, Codex, Cursor), allowlist, Claude Code hook installer, and the live redacting proxy are all implemented and covered by tests. Being finalized for the `v0.1` npm release — until then, install from git. Watch the repo.

---

## Why this exists

AI coding assistants keep a full, local, plaintext record of every session — your prompts, the model's replies, and **the raw output of every tool call**. That transcript is where secrets quietly accumulate:

- You paste a `.env`, a connection string, or a token to ask "why doesn't this work?"
- An agent runs `printenv`, `cat config`, or dumps a server's environment into the chat.
- A stack trace or API response with a bearer token gets logged verbatim.

Those transcripts then live on disk indefinitely — `~/.claude/projects/**/*.jsonl`, `~/.codex/*.jsonl`, Cursor's `state.vscdb` SQLite stores — and get swept into Time Machine, Dropbox, `rsync` backups, or a shared machine. A leaked key in a transcript is just as live as one in a committed `.env`, but nothing scans for it.

**broomsticks** gives you two complementary tools:

1. **`broom scan` / `broom clean`** — find secrets already written to your transcripts and scrub them out in place, safely.
2. **`broom proxy`** — a local redacting proxy that sits between your AI tools and the provider API, stripping secrets out of requests *before they're ever sent* (and out of responses the model echoes back).

## Design principles

- **Dry-run by default.** `clean` never modifies anything unless you pass `--apply`.
- **Back up before every write.** Each touched file is copied to a timestamped backup directory first.
- **Transcripts only.** The scanner never touches credential files themselves (`~/.codex/auth.json`, `~/.aws/credentials`, etc.) — only chat history.
- **Local by default.** `scan`/`clean` do no networking at all (enforced by a test). Only `broom proxy` talks to the network — by design, since it *is* the network path.
- **Auditable supply chain.** Plain ESM JavaScript, **zero runtime dependencies**, no build step. The code published to npm *is* the source — read every line before you trust it with your secrets.
- **Non-reversible, idempotent redaction.** Secrets are replaced with `«BROOM:<rule>:<sha8>»`. The hash lets you correlate without leaking, and re-running never double-redacts.

## Install

```bash
# one-off, no install (once published)
npx broomsticks scan

# or install the CLI globally
npm install -g broomsticks
broom scan

# from git, before the npm release
git clone https://github.com/digitaldrreamer/broomsticks
npm install -g ./broomsticks
```

Requires **Node ≥ 22.13** — it uses the built-in `node:sqlite` to read Cursor's database (no native modules), which is available without the `--experimental-sqlite` flag as of Node 22.13.0.

Prefer no Node at all? A dependency-light **`scripts/broom.sh`** fallback (using `jq` + the `sqlite3` CLI) is planned for environments where you can't or won't run the package.

## Clean up: `scan` / `clean`

```bash
# Scan every supported source, print a redacted report. Exits non-zero if anything is found (CI-friendly).
broom scan

# Limit to one source
broom scan --source claude-code
broom scan --source cursor

# List discovered transcript files across all sources
broom sources

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
| `--apply` | Perform redaction (`clean` only; otherwise dry-run) |
| `--backup-dir <dir>` | Where backups go (default `~/.broom/backups/<timestamp>/`) |
| `--no-backup` | Skip backups (discouraged) |
| `--extra <file>` | Additional literal/regex secrets to redact (one per line) |
| `--allowlist <file>` | Custom allowlist file (default `~/.broom/allowlist.txt`) |
| `--no-allowlist` | Disable allowlist suppression — report every finding |
| `--json` | Emit findings as JSON |
| `--no-fail` | Exit `0` even when secrets are found |

## Prevent: `broom proxy`

Cleaning up after the fact only reduces exposure — the secret still reached the model. The proxy stops the leak at the source. It sits in front of the provider API and redacts secrets out of the text and tool-call content in every outgoing request before it's sent, and out of every response the model echoes back.

```bash
# Start the proxy in the foreground (Ctrl-C to stop)
broom proxy

# Then point your AI tools at it:
export ANTHROPIC_BASE_URL=http://127.0.0.1:7777
export OPENAI_BASE_URL=http://127.0.0.1:7777
```

| Route | Upstream | Used by |
| --- | --- | --- |
| `POST /v1/messages` | `api.anthropic.com` | Claude Code, Aider |
| `POST /v1/chat/completions` | `api.openai.com` | Codex, OpenAI-compatible clients |

Both streaming (SSE) and non-streaming responses are handled — a streaming response is buffered in full before redaction so a secret straddling two chunks can't slip through, then re-emitted as a valid SSE stream. Redaction covers both assistant **text** and **tool-call arguments** (e.g. a secret the model echoes into a `write_file` content or shell-command argument). Extended-thinking blocks are the one exception — see [Limitations](#limitations).

Make it permanent instead of exporting vars by hand:

```bash
# Add ANTHROPIC_BASE_URL / OPENAI_BASE_URL to your shell init files
broom proxy --install

# Also register a login-persistent daemon (launchd on macOS, systemd --user on Linux)
broom proxy --install --daemon

# Remove the daemon later
broom proxy --uninstall
```

> **Note:** `--uninstall` removes both the daemon **and** the `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` block it added to your shell profiles. Open a new terminal (or re-source your profile) afterward so your shell stops pointing at the now-stopped proxy.

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on (default `7777`) |
| `--verbose` | Log redaction counts to stderr |
| `--allowlist <file>` | Allowlist to suppress known false positives |
| `--install` | Add base-URL env vars to your shell init files |
| `--install --daemon` | Also install a login-persistent daemon (logs to `~/.broom/proxy.log`) |
| `--uninstall` | Remove the daemon |

## Automate: `broom install`

For Claude Code users, `broom install` wires broomsticks into your editor so it sweeps automatically:

```bash
broom install
```

This adds (with your confirmation):

- `~/.claude/skills/broom-sweep/SKILL.md` — a skill that teaches Claude to preview and apply redactions
- `~/.claude/hooks/stop-broom.mjs` — a Stop hook that silently scans your transcripts after every turn
- a `Stop` hook entry in `~/.claude/settings.json` to register it

Restart Claude Code afterward for the skill to take effect. Pass `--yes` to skip the confirmation prompt.

> **Tip:** install broomsticks globally (`npm install -g broomsticks`) when using the automatic integration. The Stop hook prefers the `broom` command but falls back to `npx broomsticks`, which re-resolves the package on every turn and adds noticeable latency to each response.

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

The exact rule set, severities, and entropy thresholds live in [`src/rules.mjs`](./src/rules.mjs).

## Allowlist

Well-known documentation placeholders (AWS's `AKIAIOSFODNN7EXAMPLE`, Stripe test keys, `.env.example` shapes) are suppressed out of the box. Add your own known false positives to `~/.broom/allowlist.txt`:

```
# one entry per line; blank lines and # comments ignored
AKIAIOSFODNN7EXAMPLE
/^sk_test_[A-Za-z0-9]+$/
```

Plain lines match a secret exactly; `/regex/flags` lines match by pattern. Disable suppression entirely with `--no-allowlist`.

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

- `scan`/`clean` reduce exposure of secrets **already written to disk**; they cannot un-send anything already transmitted to a model provider. **If a secret hit a transcript before you started using the proxy, treat it as compromised and rotate it** — broomsticks is cleanup, not a substitute for rotation.
- Detection is best-effort. Novel or low-entropy secrets may be missed; tune with `--extra`.
- Cursor's schema evolves between versions; broomsticks targets the known chat/composer keys and will be kept current.
- The proxy buffers each streaming response in full before redacting and re-emitting it. This is deliberate — a secret straddling two SSE chunks can't be caught otherwise — but it means the assistant's UI won't show tokens incrementally; long responses appear all at once after a pause. A sliding-window buffer that preserves incremental streaming is a possible future improvement.
- The proxy scans assistant text and tool-call arguments, but **not extended-thinking blocks** — rewriting a thinking block would invalidate its cryptographic signature and break multi-turn thinking+tool loops. A secret echoed only inside a model's thinking is passed through unredacted. (Thinking is not persisted to transcripts either, so `broom clean` won't see it; if a secret reached the model at all, rotate it.)

## Contributing

Issues and PRs welcome — especially new source adapters (Windsurf, Continue, Aider, Zed) and detection rules. See [PLAN.md](./PLAN.md) for architecture and the contribution surface.

Run the test suite with `npm test` (uses the built-in `node:test` runner — no dependencies).

## License

[MIT](./LICENSE) © digitaldrreamer
