# 🧹 broomsticks

> Sweep leaked secrets out of your AI coding-assistant transcripts — Claude Code, Codex, and Cursor — and stop new ones from ever leaving your machine.

[![npm](https://img.shields.io/npm/v/broomsticks.svg)](https://www.npmjs.com/package/broomsticks)
[![node](https://img.shields.io/node/v/broomsticks.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/broomsticks.svg)](./LICENSE)

broomsticks does two things: it **cleans** secrets already sitting in your local AI chat transcripts, and it **prevents** new leaks with a local proxy that redacts secrets before they reach the model. Plain ESM, zero runtime dependencies, dry-run by default.

## Quick start

```bash
# scan every transcript for secrets (read-only)
npx broomsticks scan

# preview redactions, then apply them (each touched file is backed up first)
npx broomsticks clean
npx broomsticks clean --apply
```

Prefer a global command? `npm install -g broomsticks` gives you `broom` (used throughout this README). Requires **Node ≥ 22.13** — it reads Cursor's SQLite store with the built-in `node:sqlite`, unflagged as of 22.13.0, so there are no native modules to build.

## What it does

AI assistants keep a full, local, plaintext record of every session — your prompts, the model's replies, and the raw output of every tool call. Secrets quietly pile up there: a pasted `.env`, an agent that runs `printenv` or `cat config`, a stack trace with a bearer token. Those files then linger under `~/.claude`, `~/.codex`, and Cursor's `state.vscdb` and get swept into Time Machine, Dropbox, and `rsync` backups. A key in a transcript is just as live as one in a committed `.env`, but nothing scans for it.

Two tools — use either or both:

- **Clean up — `broom scan` / `broom clean`.** Finds secrets already written to disk and redacts them in place. Dry-run by default; every write is backed up first.
- **Prevent — `broom proxy`.** A local proxy between your tools and the provider API that strips secrets out of requests *before they're sent* — and out of responses the model echoes back.

**Safety by design:** nothing is modified without `--apply` · every touched file is backed up · only chat transcripts are read, never credential files like `~/.aws/credentials` · `scan`/`clean` do zero networking (enforced by a test) · redaction is non-reversible and idempotent.

## Commands

### `scan` / `clean`

```bash
broom scan                              # report secrets; exits 1 if any (CI-friendly)
broom scan --source cursor              # limit to one source (repeatable)
broom sources                           # list discovered transcript files
broom clean                             # preview redactions (dry-run)
broom clean --apply                     # redact in place, backing up first
broom scan --json                       # machine-readable output
broom clean --apply --extra ./leaked.txt   # also scrub your own known values
```

| Flag | Meaning |
| --- | --- |
| `--source <id>` | Restrict to `claude-code`, `codex`, or `cursor` (repeatable; default: all) |
| `--apply` | Perform redaction (`clean` only; otherwise dry-run) |
| `--backup-dir <dir>` | Where backups go (default `~/.broom/backups/<timestamp>/`) |
| `--no-backup` | Skip backups (discouraged) |
| `--extra <file>` | Extra literal / `/regex/` secrets to redact, one per line |
| `--allowlist <file>` | Custom allowlist (default `~/.broom/allowlist.txt`) |
| `--no-allowlist` | Report every finding, ignoring the allowlist |
| `--json` | Emit findings as JSON |
| `--no-fail` | Exit `0` even when secrets are found |

### `proxy`

```bash
broom proxy                             # start in the foreground (Ctrl-C to stop)
export ANTHROPIC_BASE_URL=http://127.0.0.1:7777
export OPENAI_BASE_URL=http://127.0.0.1:7777
```

Routes `POST /v1/messages` → `api.anthropic.com` (Claude Code, Aider) and `POST /v1/chat/completions` → `api.openai.com` (Codex and other OpenAI-compatible clients). Streaming (SSE) and non-streaming responses both work — a streaming response is buffered in full, redacted, then re-emitted as a valid stream so a secret can't slip through a chunk boundary. Redaction covers assistant **text** and **tool-call arguments** (e.g. a secret the model echoes into a `write_file` content or shell-command argument); extended-thinking blocks are the one exception — see [Limitations](#limitations).

Make it permanent instead of exporting vars by hand:

```bash
broom proxy --install                   # add the base-URL env vars to your shell profiles
broom proxy --install --daemon          # + login-persistent daemon (launchd / systemd --user)
broom proxy --uninstall                 # remove the daemon *and* the env vars
```

> **Headless Linux:** `loginctl enable-linger` (no argument — targets the current user) lets the `--daemon` service run without an active login. With no argument it typically needs no root privileges where Polkit is configured to allow self-lingering. After `--uninstall`, open a new terminal so your shell stops pointing at the stopped proxy.

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on (default `7777`) |
| `--verbose` | Log redaction counts to stderr |
| `--allowlist <file>` | Suppress known false positives |
| `--install` / `--install --daemon` | Wire env vars / also install the daemon (logs to `~/.broom/proxy.log`) |
| `--uninstall` | Remove the daemon and the env vars |

### `install` (Claude Code integration)

`broom install` wires broomsticks into Claude Code so it sweeps automatically — a `broom-sweep` skill plus a Stop hook that silently scans after every turn (registered in `~/.claude/settings.json`). Restart Claude Code afterward for it to take effect; pass `--yes` to skip the confirmation prompt.

> Install globally (`npm install -g broomsticks`) when using this — the hook prefers the `broom` command but falls back to `npx broomsticks`, which re-resolves the package on every turn and adds noticeable latency.

## How it works

A matched secret is replaced inline with a stable, non-reversible placeholder:

```
sk-ant-api03-VRLD…Ahg   →   «BROOM:anthropic-key:9f3a1c2b»
```

The `sha8` (first 8 hex chars of the secret's SHA-256) lets you correlate the same leak across files without revealing it. Placeholders contain no JSON-breaking characters — JSONL transcripts and Cursor's stored blobs stay valid — and never match a detection rule, so `broom clean` is idempotent: run it as often as you like.

Detection is a curated, gitleaks-style ruleset for high-confidence provider tokens, plus an entropy-gated catch-all for unknown `KEY=value` / `"token": "…"` shapes. The exact rules, severities, and thresholds live in [`src/rules.mjs`](./src/rules.mjs).

<details>
<summary><b>Detection rules</b></summary>

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

</details>

<details>
<summary><b>Supported sources &amp; paths</b></summary>

| Source | Where it stores transcripts | Format |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl` | JSON Lines |
| **Codex CLI** | `~/.codex/history.jsonl`, `~/.codex/sessions/**` | JSON Lines |
| **Cursor** | `~/.config/Cursor/User/{globalStorage,workspaceStorage/**}/state.vscdb` (`ItemTable` / `cursorDiskKV`) | SQLite |

Paths shown for Linux; macOS/Windows equivalents are resolved automatically.

</details>

<details>
<summary><b>Allowlist</b></summary>

Well-known documentation placeholders (AWS's `AKIAIOSFODNN7EXAMPLE`, Stripe test keys, `.env.example` shapes) are suppressed out of the box. Add your own known false positives to `~/.broom/allowlist.txt`:

```
# one entry per line; blank lines and # comments ignored
AKIAIOSFODNN7EXAMPLE
/^sk_test_[A-Za-z0-9]+$/
```

Plain lines match a secret exactly; `/regex/flags` lines match by pattern. Disable suppression entirely with `--no-allowlist`.

</details>

## Limitations

- `scan`/`clean` reduce exposure of secrets **already on disk**; they can't un-send anything already transmitted to a provider. **If a secret reached a transcript before you started using the proxy, treat it as compromised and rotate it** — broomsticks is cleanup, not a substitute for rotation.
- Detection is best-effort. Novel or low-entropy secrets may be missed; tune with `--extra`.
- Cursor's schema evolves between versions; broomsticks targets the known chat/composer keys and is kept current.
- The proxy buffers each streaming response in full before redacting — deliberate, so a secret straddling two chunks can't be missed, but the assistant's UI won't render tokens incrementally; long responses arrive all at once after a pause. A sliding-window buffer is a possible future improvement.
- The proxy scans assistant text and tool-call arguments but **not extended-thinking blocks** — rewriting a thinking block invalidates its cryptographic signature and breaks multi-turn thinking+tool loops. A secret echoed *only* inside thinking passes through unredacted (thinking isn't persisted to transcripts either, so `broom clean` won't see it — if it reached the model, rotate it).

## Contributing

**v0.1 — first public release.** Issues and PRs welcome, especially new source adapters (Windsurf, Continue, Aider, Zed) and detection rules. See [PLAN.md](./PLAN.md) for architecture and [CHANGELOG.md](./CHANGELOG.md) for release notes. Run the test suite with `npm test` (built-in `node:test` runner — no dependencies).

## License

[MIT](./LICENSE) © digitaldrreamer
