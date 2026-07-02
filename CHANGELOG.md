# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-07-02

First public release.

### Added
- `broom scan` / `broom clean` — find and redact secrets in AI coding-assistant
  transcripts. Dry-run by default; `--apply` writes, backing up every touched
  file to `~/.broom/backups/<timestamp>/` first.
- Source adapters for **Claude Code** (`~/.claude/**/*.jsonl`), **Codex**
  (`~/.codex/**`), and **Cursor** (`state.vscdb` SQLite via `node:sqlite`).
- `broom sources` — list discovered transcript files.
- Curated, gitleaks-style ruleset plus an entropy-gated generic catch-all;
  non-reversible, idempotent `«BROOM:<rule>:<sha8>»` placeholders.
- Allowlist with built-in documentation placeholders and a user file at
  `~/.broom/allowlist.txt` (`--allowlist` / `--no-allowlist`).
- `broom install` — installs a Claude Code skill + Stop hook that sweeps
  transcripts automatically after each turn.
- `broom proxy` — a local redacting proxy that strips secrets from outgoing
  requests and model responses (text **and** tool-call arguments) for both
  streaming and non-streaming Anthropic and OpenAI APIs.
- `broom proxy --install [--daemon]` / `--uninstall` — wire base-URL env vars
  into shell profiles and register a login-persistent daemon (launchd on macOS,
  `systemctl --user` on Linux); uninstall removes both the daemon and the env
  vars.
- `--json`, `--no-fail`, `--extra <file>` flags; `--source` filtering.

### Notes
- Requires Node ≥ 22.13 (`node:sqlite` is unflagged as of 22.13.0).
- Zero runtime dependencies.
- Extended-thinking blocks are passed through the proxy unredacted to preserve
  their signatures — see the README Limitations section.

[0.1.0]: https://github.com/digitaldrreamer/broomsticks/releases/tag/v0.1.0
