# 🧹 broomsticks

> Clean leaked secrets from your AI chat history.

[![npm](https://img.shields.io/npm/v/broomsticks.svg)](https://www.npmjs.com/package/broomsticks)
[![node](https://img.shields.io/node/v/broomsticks.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/broomsticks.svg)](./LICENSE)

broomsticks finds and redacts secrets in local transcripts from **Claude Code, Codex, and Cursor**. Its optional proxy also redacts detected secrets from API requests before they reach the provider.

Built with plain ESM and no runtime dependencies. Scans are read-only, and cleanup runs as a dry-run by default.

## Quick start

```bash
# scan every transcript for secrets (read-only)
npx broomsticks scan

# preview redactions, then sweep them away (each touched file is backed up first)
npx broomsticks clean
npx broomsticks sweep
```

Run `broom` with no arguments in a terminal for an interactive menu.

Install globally to use `broom` in the examples below:

```bash
npm install -g broomsticks
```

Requires **Node.js 22.13.0 or later**. Cursor support uses the built-in `node:sqlite`, so there are no native modules to build.

## What it does

AI coding assistants save prompts, replies, and tool output locally. A pasted `.env`, an agent running `printenv`, or a stack trace with a bearer token can leave credentials in that history. Records under `~/.claude`, `~/.codex`, and Cursor's `state.vscdb` can also end up in Time Machine, Dropbox, or `rsync` backups.

Use either or both:

- **Clean up existing transcripts.** Use `broom scan` to find secrets, `broom clean` to preview redactions, and `broom sweep` to apply them.
- **Redact API traffic.** Use `broom proxy` between your tools and the provider API. It scans outgoing requests and incoming assistant text and tool-call arguments.

Transcripts are modified only by `sweep` or `clean --apply`. Each changed file is backed up first unless you pass `--no-backup`. The scanner reads supported transcript locations, leaving credential files such as `~/.aws/credentials` alone. Scanning and cleanup run locally without network access.

## Commands

### `scan` / `clean`

```bash
broom scan                              # report secrets; exits 1 if any (CI-friendly)
broom scan --source cursor              # limit to one source (repeatable)
broom sources                           # list discovered transcript files
broom clean                             # preview redactions (dry-run)
broom sweep                             # redact in place, backing up first (= clean --apply)
broom scan --verbose                    # list every finding, not just per-file counts
broom scan --json                       # machine-readable output
broom sweep --extra ./leaked.txt         # also scrub your own known values
```

Reports group findings by AI client and show affected chats, **distinct secrets**, and total occurrences. A key repeated within a transcript counts once toward the distinct total. Add `--verbose` to list each occurrence with its rule and line number.

Colour is enabled in a terminal and disabled when piped or when `NO_COLOR` is set. `sweep` and `clean --apply` ask for confirmation in a terminal. Pass `--yes` to skip the prompt. Non-interactive runs, including pipes and CI, proceed without prompting.

| Flag | Meaning |
| --- | --- |
| `--source <id>` | Restrict to `claude-code`, `codex`, or `cursor` (repeatable; default: all) |
| `--apply` | Perform redaction (`clean` only; `sweep` implies it) |
| `--yes` | Skip the pre-redaction confirmation prompt |
| `--verbose` | List every finding, not just per-file counts |
| `--backup-dir <dir>` | Where backups go (default `~/.broom/backups/<timestamp>/`) |
| `--no-backup` | Skip backups (discouraged) |
| `--extra <file>` | Extra literal secrets or `/regex/` patterns, one per line |
| `--allowlist <file>` | Custom allowlist (default `~/.broom/allowlist.txt`) |
| `--no-allowlist` | Report every finding, ignoring the allowlist |
| `--json` | Emit findings as JSON |
| `--no-fail` | Exit `0` for findings; scan, backup and write errors still fail |

#### Backups

Every write is preceded by a copy of the original under `~/.broom/backups/<timestamp>/` (or `--backup-dir`). Before copying, broom checks that the destination has room for the file plus any SQLite `-wal`/`-shm` sidecars. If space is short, copying fails, or the backup cannot be recorded in `manifest.json`, **that transcript is skipped and left untouched**, the rest of the run continues, and the file is listed under *Skipped* with the reason. Failed attempts remove their new copies and restore any older backups they replaced. `manifest.json` is rewritten after each backed-up file, before redaction is allowed, so an interrupted run still records the backups of modified originals. The end of the report prints where the backup went and how large it is. Backups are never pruned automatically — delete old folders under `~/.broom/backups/` once you no longer need them.

### `proxy`

```bash
broom proxy                             # start in the foreground (Ctrl-C to stop)
export ANTHROPIC_BASE_URL=http://127.0.0.1:7777
export OPENAI_BASE_URL=http://127.0.0.1:7777
```

The proxy routes `POST /v1/messages` to `api.anthropic.com` for Claude Code and Aider. It routes `POST /v1/chat/completions` to `api.openai.com` for Codex and other OpenAI-compatible clients.

Both streaming (SSE) and non-streaming responses are supported. Streaming responses are buffered in full before redaction, so detection can catch secrets split across chunks. Redaction covers assistant **text** and **tool-call arguments**, including file contents and shell-command arguments. Extended-thinking blocks pass through unchanged; see [Limitations](#limitations).

To save these environment variables in your shell profiles and optionally run the proxy at login:

```bash
broom proxy --install                   # add the base-URL env vars to your shell profiles
broom proxy --install --daemon          # + login-persistent daemon (launchd / systemd --user)
broom proxy --uninstall                 # remove the daemon *and* the env vars
```

> **Headless Linux:** `loginctl enable-linger` with no argument targets the current user and lets the daemon run without an active login. It typically needs no root privileges where Polkit allows self-lingering. After `--uninstall`, open a new terminal so your shell stops pointing at the stopped proxy.

| Flag | Meaning |
| --- | --- |
| `--port <n>` | Port to listen on (default `7777`) |
| `--verbose` | Log redaction counts to stderr |
| `--allowlist <file>` | Suppress known false positives |
| `--install` | Add the environment variables to your shell profiles |
| `--daemon` | With `--install`, also install a login service (logs to `~/.broom/proxy.log`) |
| `--uninstall` | Remove the daemon and the env vars |

### `install` (Claude Code integration)

`broom install` adds the `broom-sweep` skill and a Stop hook that scans after every Claude Code turn. The hook is registered in `~/.claude/settings.json`. When it finds secrets, it prompts Claude to invoke the skill and ask for confirmation before redacting.

Restart Claude Code after installation. Pass `--yes` to skip the setup confirmation prompt.

> A global install (`npm install -g broomsticks`) keeps the hook faster. It tries `broom` first and falls back to `npx broomsticks`, which adds package resolution and startup time to each scan.

To install the skill without the automatic scan, use [`skills`](https://github.com/obra/skills):

```bash
npx skills add digitaldrreamer/broomsticks/skills/broom-sweep
```

Then invoke `/broom-sweep` on demand.

## How it works

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:a3f4aad897c584b67fafc7f180ea3a40d2869d7ba4a7e2b7d32ace34225fd7d0 -->

A matched secret is replaced inline with a stable placeholder:

<!-- /coderabbit-ai-generated:v1 -->

```
sk-ant-api03-VRLD…Ahg   →   «BROOM:anthropic-key:9f3a1c2b»
```

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:cd7de028ec70dc74f91b027bb5c0c83ead8a2487a68024cd583ab0ec4ddd5c5f -->

The final component is the first eight hexadecimal characters of the secret's SHA-256 hash. It lets you correlate the same leak across files without including the credential itself. However, someone can hash candidate credentials and compare the suffix, enabling guessing of weak or guessable credentials. Consider this risk before sharing placeholders. Placeholders contain no JSON-breaking characters and are designed to stay unchanged on repeated sweeps.

<!-- /coderabbit-ai-generated:v1 -->

JSON and JSONL matches stay within individual strings and records, including serialized tool arguments and cache keys. Escapes and surrounding formatting are preserved, and Cursor values retain their original TEXT or BLOB storage type. Malformed JSONL files and redactions that would merge object entries are skipped with an error before anything is written. Other transcripts can still be cleaned, and successful backups remain recorded in the manifest.

Detection uses gitleaks-style rules for provider tokens, plus an entropy threshold for unfamiliar credentials in assignments such as `api_key=value`. The exact rules, severities, and thresholds live in [`src/rules.mjs`](./src/rules.mjs).

<details>
<summary><b>Detection rules</b></summary>

| Rule | Examples |
| --- | --- |
| Private keys | `-----BEGIN … PRIVATE KEY-----` blocks (RSA/EC/OpenSSH/PGP) |
| Cloud | AWS access keys (`AKIA…`), Google API keys (`AIza…`) |
| Source hosting | GitHub `ghp_/gho_/ghu_/ghs_/ghr_…`, fine-grained `github_pat_…` |
| AI providers | OpenAI `sk-…` / `sk-proj-…` / `sk-svcacct-…`, Anthropic `sk-ant-…`, Hugging Face `hf_…` |
| Billing / SaaS | Stripe `sk_live_…`, Slack `xox[baprs]-…` |
| Tokens | JWTs (`eyJ….eyJ….…`) |
| Connection strings | `postgres://`, `mysql://`, `mongodb+srv://`, `redis://` with inline credentials |
| Labeled passwords | `password:` / `passwd:` / `passphrase:` values in prose, including shorter credentials and excluding known placeholders |
| Generic | `api_key` / `secret` / `password` / `token` assignments above an entropy threshold |

</details>

<details>
<summary><b>Supported sources &amp; paths</b></summary>

| Source | Where it stores transcripts | Format |
| --- | --- | --- |
| **Claude Code** | `~/.claude/projects/<project>/<session>.jsonl` | JSON Lines |
| **Codex CLI** | `~/.codex/history.jsonl`, `~/.codex/sessions/**` | JSON Lines |
| **Cursor** | `~/.config/Cursor/User/{globalStorage,workspaceStorage/**}/state.vscdb` (`ItemTable` / `cursorDiskKV`) | SQLite |

Paths above are for Linux. macOS and Windows equivalents are resolved automatically.

</details>

<details>
<summary><b>Allowlist</b></summary>

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:3014afd15ec9185995fb46c56e24dd1414aabf5a0967a40809abfa4feebba8b2 -->

Known documentation placeholders, including AWS's `AKIAIOSFODNN7EXAMPLE` and specific `.env.example` values, are suppressed by the built-in allowlist. Running `broom install` creates `~/.broom/allowlist.txt` if it does not already exist, adding a default pattern for `sk_test_` keys with 10–99 alphanumeric characters after the prefix. Without running `broom install` (or adding an equivalent allowlist entry), `sk_test_` keys may be reported and redacted. The installed default allowlist does not suppress `rk_test_` keys. Add your own known false positives to `~/.broom/allowlist.txt`:

<!-- /coderabbit-ai-generated:v1 -->

```
# one entry per line; blank lines and # comments ignored
AKIAIOSFODNN7EXAMPLE
/^sk_test_[A-Za-z0-9]+$/
```

Plain lines match a secret exactly; `/regex/flags` lines match by pattern. Disable suppression entirely with `--no-allowlist`.

</details>

## Limitations

- Cleanup only affects local transcripts. **Rotate any secret that was sent to a provider or shared elsewhere.** Redacting a local copy cannot undo that exposure.
- Detection is best-effort. Novel or low-entropy secrets may be missed. Add known values or patterns with `--extra`.
- Cursor support targets known chat and composer keys. Schema changes may require an update.
- The proxy buffers each streaming response before redacting it. The assistant's UI receives the response after it completes, so long responses arrive after a pause rather than token by token.
- **Extended-thinking blocks are not redacted.** Changing them would invalidate their cryptographic signatures and break multi-turn thinking and tool-call flows. Secrets that appear only in those blocks pass through unchanged.

## Contributing

Issues and PRs are welcome, especially new source adapters (Windsurf, Continue, Aider, Zed) and detection rules. See [PLAN.md](./PLAN.md) for architecture and [CHANGELOG.md](./CHANGELOG.md) for release notes.

Run the test suite with `npm test`. It uses the built-in `node:test` runner and needs no dependencies.

## License

[MIT](./LICENSE) © digitaldrreamer
