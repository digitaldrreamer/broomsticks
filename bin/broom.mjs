#!/usr/bin/env node
// broomsticks — sweep leaked secrets out of AI coding-assistant transcripts.
// Zero runtime dependencies; reads/writes nothing without explicit --apply.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { RULES }            from '../src/rules.mjs'
import { scanText }         from '../src/detector.mjs'
import { redactText }       from '../src/redactor.mjs'
import { BackupSession }    from '../src/backup.mjs'
import { printReport, printJsonReport } from '../src/report.mjs'
import { loadAllowlist, isAllowlisted } from '../src/allowlist.mjs'
import { discoverTargets as claudeCodeTargets } from '../src/sources/claude-code.mjs'
import { discoverTargets as codexTargets }      from '../src/sources/codex.mjs'
import { discoverTargets as cursorTargets }     from '../src/sources/cursor.mjs'
import { runInstall, isInstalled }              from '../src/install.mjs'
import { startProxy, installProxyEnv, installDaemon, uninstallDaemon } from '../src/proxy.mjs'

// ── Package metadata ──────────────────────────────────────────────────────────
const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

// ── Argument parsing (no dependencies — hand-rolled) ─────────────────────────
const argv = process.argv.slice(2)

function flag(name) {
  return argv.includes(name)
}

function option(name) {
  const i = argv.indexOf(name)
  return i !== -1 ? argv[i + 1] : undefined
}

function options(name) {
  const vals = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) vals.push(argv[i + 1])
  }
  return vals
}

// ── Top-level flags ───────────────────────────────────────────────────────────
if (flag('--version') || flag('-v')) { console.log(pkg.version); process.exit(0) }
if (flag('--help')    || flag('-h') || argv.length === 0) { printHelp(); process.exit(0) }

const command = argv[0]
if (!['scan', 'clean', 'sources', 'install', 'proxy'].includes(command)) {
  console.error(`broom: unknown command '${command}'. Try 'broom --help'.`)
  process.exit(1)
}

// ── `broom install` ───────────────────────────────────────────────────────────
if (command === 'install') {
  await runInstall({ yes: flag('--yes') })
  process.exit(0)
}

// ── `broom proxy` ────────────────────────────────────────────────────────────
if (command === 'proxy') {
  const portStr = option('--port') ?? '7777'
  const port    = parseInt(portStr, 10)
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`broom: invalid port '${portStr}' — must be a number between 1 and 65535`)
    process.exit(1)
  }
  const verbose = flag('--verbose')

  if (flag('--uninstall')) {
    const removed = uninstallDaemon()
    console.log(removed
      ? '\n  broom proxy: daemon removed. Env vars in your shell profile still point to\n  the proxy — remove them manually or they will silently fail to connect.\n'
      : '\n  broom proxy: no daemon found to remove.\n'
    )
    process.exit(0)
  }

  if (flag('--install')) {
    const updated = installProxyEnv(port)
    if (updated.length === 0) {
      console.log('\n  broom proxy: env vars already present in all shell init files.\n')
    } else {
      console.log('\n  broom proxy: added env vars to:')
      for (const f of updated) console.log(`    ${f}`)
    }

    if (flag('--daemon')) {
      try {
        const { path, platform } = installDaemon({
          port,
          nodeBin:  process.execPath,
          broomBin: process.argv[1],
        })
        console.log(`\n  broom proxy: daemon installed (${platform})`)
        console.log(`    ${path}`)
        console.log('\n  The proxy will start automatically at login and restart on failure.')
        console.log('  Logs: ~/.broom/proxy.log')
        console.log('  To remove: broom proxy --uninstall\n')
      } catch (err) {
        console.error('\n  broom proxy --daemon failed:', err.message)
        console.error('  Start the proxy manually: broom proxy\n')
        process.exit(1)
      }
    } else {
      console.log(`\n  Open a new terminal (or: source ~/.zshrc) then run:\n    broom proxy\n`)
      console.log(`  To start automatically at login:\n    broom proxy --install --daemon\n`)
    }
    process.exit(0)
  }

  const server = await startProxy({ port, verbose, allowlistFile: option('--allowlist') })
  console.log(`
  broom proxy  listening on http://127.0.0.1:${port}

  Point your AI tools at this proxy:
    export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}
    export OPENAI_BASE_URL=http://127.0.0.1:${port}

  Or run \`broom proxy --install\` to add these permanently to your shell.

  Routes:
    POST /v1/messages           → api.anthropic.com  (Claude Code, Aider)
    POST /v1/chat/completions   → api.openai.com     (Codex, OpenAI-compatible)

  Press Ctrl-C to stop.
`)

  process.on('SIGINT',  () => { server.close(); process.exit(0) })
  process.on('SIGTERM', () => { server.close(); process.exit(0) })
  // Server holds the event loop open — no further code needed
}

// ── Shared options ────────────────────────────────────────────────────────────
const sources      = options('--source')         // [] means all
const extraFile    = option('--extra')
const allowFile    = option('--allowlist')
const jsonOut      = flag('--json')
const noFail       = flag('--no-fail')
const apply        = flag('--apply')
const backupDir    = option('--backup-dir')
const noBackup     = flag('--no-backup')
const noAllowlist  = flag('--no-allowlist')

// ── Load extra secrets from --extra file ──────────────────────────────────────
let extras = []
if (extraFile) {
  try {
    extras = readFileSync(extraFile, 'utf8').split('\n')
  } catch (e) {
    console.error(`broom: cannot read --extra file '${extraFile}': ${e.message}`)
    process.exit(1)
  }
}

// ── Load allowlist ────────────────────────────────────────────────────────────
const allowlist = noAllowlist ? null : loadAllowlist(allowFile)

// ── First-run nudge (scan/clean only, TTY only, not yet installed) ────────────
if (!isInstalled() && process.stdout.isTTY && !jsonOut) {
  console.log('\n  Tip: run `broom install` to add a Claude Code skill + Stop hook that')
  console.log('  automatically sweeps secrets after each Claude turn.\n')
}

// ── `broom sources` ───────────────────────────────────────────────────────────
if (command === 'sources') {
  const allTargets = gatherTargets(sources)
  console.log(`\n  Discovered sources:\n`)
  if (allTargets.length === 0) {
    console.log('    (none found — no supported AI assistant appears to be installed)\n')
  } else {
    const bySrc = {}
    for (const t of allTargets) (bySrc[t.source] ??= []).push(t)
    for (const [src, ts] of Object.entries(bySrc)) {
      console.log(`  ${src}  (${ts.length} file${ts.length === 1 ? '' : 's'})`)
      for (const t of ts) console.log(`    ${t.label}`)
      console.log()
    }
  }
  process.exit(0)
}

// ── `broom scan` / `broom clean` ─────────────────────────────────────────────
const targets = gatherTargets(sources)

if (targets.length === 0) {
  console.error('\n  broom: no transcript files found. Have you used Claude Code, Codex, or Cursor?\n')
  process.exit(noFail ? 0 : 1)
}

const isClean   = command === 'clean'
const backup    = (!noBackup && apply) ? new BackupSession(backupDir) : null

const scanResults = []

for (const target of targets) {
  let text
  try {
    text = target.read()
  } catch (e) {
    console.error(`broom: cannot read '${target.label}': ${e.message}`)
    continue
  }

  const raw      = scanText(text, RULES, extras)
  const findings = allowlist
    ? raw.filter(f => !isAllowlisted(f.secret, allowlist))
    : raw

  let applied = 0

  if (findings.length > 0 && isClean && apply) {
    // Back up before the first write to this file
    if (backup) backup.backup(target.file)

    const { text: redacted, applied: n } = redactText(text, findings)
    try {
      target.write(redacted)
      applied = n
    } catch (e) {
      console.error(`broom: cannot write '${target.label}': ${e.message}`)
    }
  }

  scanResults.push({ target, findings, applied: isClean ? applied : undefined })
}

// ── Write manifest after all writes complete ──────────────────────────────────
if (backup) backup.writeManifest(scanResults)

// ── Output ────────────────────────────────────────────────────────────────────
if (jsonOut) {
  printJsonReport(scanResults)
} else {
  printReport(scanResults, { clean: isClean, apply })
}

const totalFindings = scanResults.reduce((n, r) => n + r.findings.length, 0)
process.exit(totalFindings > 0 && !noFail ? 1 : 0)

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Collect Targets from all enabled source adapters.
 * @param {string[]} filter  If non-empty, only include these source ids.
 * @returns {import('../src/sources/claude-code.mjs').Target[]}
 */
function gatherTargets(filter) {
  const all = [
    ...claudeCodeTargets(),
    ...codexTargets(),
    ...cursorTargets(),
  ]
  if (!filter.length) return all
  return all.filter(t => filter.includes(t.source))
}

function printHelp() {
  console.log(`
broomsticks v${pkg.version} — sweep secrets out of AI coding-assistant transcripts

USAGE
  broom scan   [options]          find secrets (read-only, exits 1 if found)
  broom clean  [options]          preview redactions (dry-run by default)
  broom clean  --apply [options]  redact in place — backs up first
  broom sources                   list discovered transcript files
  broom install                   install Claude Code skill + Stop hook
  broom proxy   [options]         start local redacting proxy for all AI tools
  broom proxy   --install         add ANTHROPIC_BASE_URL / OPENAI_BASE_URL to shell
  broom proxy   --install --daemon  also register as a login-persistent daemon
  broom proxy   --uninstall       remove the daemon (macOS / Linux)
  broom --version

OPTIONS
  --source <id>       Restrict to one source (repeatable):
                      claude-code | codex | cursor
  --apply             Perform redaction (clean only; dry-run without it)
  --backup-dir <dir>  Where to write backups (default: ~/.broom/backups/<ts>/)
  --no-backup         Skip backup — strongly discouraged
  --extra <file>      File of additional secrets to redact (one per line,
                      plain strings or /regex/flags)
  --allowlist <file>  Custom allowlist file (default: ~/.broom/allowlist.txt)
  --no-allowlist      Disable allowlist suppression (report all findings)
  --json              Machine-readable JSON output
  --no-fail           Exit 0 even when secrets are found (CI override)
  --port <n>          Proxy port (default: 7777)
  --verbose           Log redaction counts to stderr (proxy only)
  --yes               Skip confirmation prompts (install only)
  --help, -h          Show this help
  --version, -v       Print version

EXAMPLES
  npx broomsticks scan
  broom scan --source claude-code --json | jq '.totalFindings'
  broom clean --apply
  broom clean --apply --extra ./leaked-keys.txt
  broom install
`)
}
