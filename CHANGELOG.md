# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — unreleased

### Fixed
- Report: findings with an unexpected severity are bucketed under `low` instead
  of throwing when building the verbose per-severity listing.
- `FORCE_COLOR` parsing now follows Node's documented rule — `''`, `1`, `2`, `3`,
  `true` enable colour; any other value (including `0`/`false`) disables it.

## [0.2.0] — 2026-07-02

### Added
- `broom sweep` — redact in place, equivalent to `clean --apply` (both work).
- Interactive menu when `broom` is run with no arguments on a terminal, and a
  confirmation prompt before `sweep`/`clean --apply` (skipped with `--yes` and
  in non-interactive/CI use). Built on `node:readline/promises` — still zero
  runtime dependencies.
- `--verbose` flag: the default report is now a compact summary; `--verbose`
  lists every occurrence with rule and line number.
- "Did you mean …?" suggestion for unknown commands.

### Changed
- Report redesigned. Instead of one line per finding (thousands of lines on a
  busy history), the default groups by **AI client** and shows vulnerable chats
  and the count of **distinct** secrets, deduped by value — the same credential
  echoed many times counts once (the raw occurrence count is shown alongside).
- Colour output now respects `NO_COLOR` / `FORCE_COLOR` and TTY detection.

## [0.1.1] — 2026-07-02

### Fixed
- **Cursor adapter out-of-memory crash.** Discovery selected `key, value` across
  Cursor's entire `ItemTable` / `cursorDiskKV`, loading every blob (embeddings,
  file caches — often gigabytes) into memory at once and crashing with "heap out
  of memory" on large databases. Discovery now selects only keys; each row's
  value is fetched lazily when it's actually scanned.

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

[0.2.1]: https://github.com/digitaldrreamer/broomsticks/releases/tag/v0.2.1
[0.2.0]: https://github.com/digitaldrreamer/broomsticks/releases/tag/v0.2.0
[0.1.1]: https://github.com/digitaldrreamer/broomsticks/releases/tag/v0.1.1
[0.1.0]: https://github.com/digitaldrreamer/broomsticks/releases/tag/v0.1.0
