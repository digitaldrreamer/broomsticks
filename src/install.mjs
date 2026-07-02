// First-run onboarding: seed allowlist, install Claude Code skill + Stop hook.
//
// What gets installed:
//   ~/.broom/allowlist.txt                        — false-positive suppression list
//   ~/.claude/skills/broom-sweep/SKILL.md         — teaches Claude to sweep secrets
//   ~/.claude/hooks/stop-broom.mjs                — scans after each Claude turn
//   ~/.claude/settings.json  (hooks entry)        — registers the Stop hook

import { mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { DEFAULT_ALLOWLIST_CONTENT, allowlistPath } from './allowlist.mjs'

// ── Embedded assets ───────────────────────────────────────────────────────────

const SKILL_MD = `---
name: broom-sweep
description: Scan and clean leaked secrets from AI assistant transcripts. Use when broomsticks reports secrets detected in transcript files, or when the user asks to sweep, scan, or redact secrets from their AI chat history.
allowed-tools: Bash(broom *) Bash(npx broomsticks *)
---

## Dry-run preview

\`\`\`!
broom clean 2>&1
\`\`\`

## Your task

Present the dry-run output above to the user. If nothing was found, tell the user their transcripts are clean and no action is needed.

If secrets were found:
1. Explain what was detected and where (which transcript files)
2. Reassure the user: if these secrets exist only in local AI transcript files and have not been shared, synced to a third-party service, or committed to a repository, redacting the transcripts is complete remediation — no credential rotation is needed
3. Ask the user to confirm before applying redactions
4. If they confirm, run \`broom clean --apply\`
5. Report how many redactions were applied and confirm that originals are backed up under ~/.broom/backups/
`

// Stop hook: a standalone Node ESM script Claude Code runs after each turn.
// Outputs a JSON block decision when secrets are found, which blocks Claude
// from ending the turn and injects the reason into the next model pass.
const HOOK_SCRIPT = `#!/usr/bin/env node
// broomsticks Stop hook — silent scan after each Claude turn.
// Outputs JSON block decision when secrets are found in transcript files.
import { execSync } from 'node:child_process'

function scan() {
  for (const cmd of ['broom scan --json --no-fail', 'npx broomsticks scan --json --no-fail']) {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { /* command not found or scan itself errored */ }
  }
  return null
}

const output = scan()
if (!output) process.exit(0)

let count = 0
try { count = JSON.parse(output).totalFindings ?? 0 } catch { process.exit(0) }

if (count > 0) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: \`broomsticks detected \${count} secret(s) in your local AI transcript files. Invoke /broom-sweep to preview and redact them. Always ask the user for confirmation before applying.\`,
  }) + '\\n')
}
`

// ── Paths ─────────────────────────────────────────────────────────────────────

export function skillPath()    { return join(homedir(), '.claude', 'skills', 'broom-sweep', 'SKILL.md') }
export function hookPath()     { return join(homedir(), '.claude', 'hooks', 'stop-broom.mjs') }
export function settingsPath() { return join(homedir(), '.claude', 'settings.json') }

/** True when the skill + hook are already installed. */
export function isInstalled() {
  return existsSync(skillPath()) && existsSync(hookPath())
}

// ── Interactive prompt ────────────────────────────────────────────────────────

/**
 * Ask a yes/no question on stdin/stdout.
 * Resolves true for 'y'/'yes'/'' (default yes), false otherwise.
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function askYesNo(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => {
      rl.close()
      const a = answer.trim().toLowerCase()
      resolve(a === '' || a === 'y' || a === 'yes')
    })
  })
}

// ── Install ───────────────────────────────────────────────────────────────────

/**
 * Run the onboarding flow.
 *
 * @param {{ yes?: boolean, silent?: boolean }} opts
 *   yes    — skip confirmation prompt (CI / --yes flag)
 *   silent — suppress all output except errors
 * @returns {Promise<string[]>}  List of actions taken.
 */
export async function runInstall({ yes = false, silent = false } = {}) {
  const log = silent ? () => {} : (...a) => console.log(...a)

  log(`
  broomsticks — first-run setup

  This will install:
    1. ~/.broom/allowlist.txt                        — false-positive suppression list
    2. ~/.claude/skills/broom-sweep/SKILL.md         — teaches Claude to sweep secrets
    3. ~/.claude/hooks/stop-broom.mjs                — scans after each Claude turn
    4. ~/.claude/settings.json  (Stop hook entry)    — registers the hook
`)

  const proceed = yes || !process.stdin.isTTY
    ? true
    : await askYesNo('  Proceed? [Y/n] ')

  if (!proceed) {
    log('\n  Setup cancelled.\n')
    return []
  }

  const done = []

  // 1. Allowlist
  const listPath = allowlistPath()
  if (!existsSync(listPath)) {
    mkdirSync(dirname(listPath), { recursive: true })
    writeFileSync(listPath, DEFAULT_ALLOWLIST_CONTENT, 'utf8')
    done.push(`created   ${listPath}`)
  } else {
    done.push(`exists    ${listPath}  (unchanged)`)
  }

  // 2. Skill
  const sp = skillPath()
  mkdirSync(dirname(sp), { recursive: true })
  writeFileSync(sp, SKILL_MD, 'utf8')
  done.push(`installed ${sp}`)

  // 3. Hook script
  const hp = hookPath()
  mkdirSync(dirname(hp), { recursive: true })
  writeFileSync(hp, HOOK_SCRIPT, 'utf8')
  chmodSync(hp, 0o755)
  done.push(`installed ${hp}`)

  // 4. Register hook in settings.json
  const sp2 = settingsPath()
  let settings = {}
  if (existsSync(sp2)) {
    try { settings = JSON.parse(readFileSync(sp2, 'utf8')) } catch { /* corrupt — start fresh */ }
  }
  settings.hooks ??= {}
  settings.hooks.Stop ??= []

  const alreadyWired = settings.hooks.Stop.some(entry =>
    entry.hooks?.some(h => typeof h.command === 'string' && h.command.includes('stop-broom'))
  )
  if (!alreadyWired) {
    const commandStr = process.platform === 'win32' ? `node "${hp}"` : hp
    settings.hooks.Stop.push({ hooks: [{ type: 'command', command: commandStr }] })
    mkdirSync(dirname(sp2), { recursive: true })
    writeFileSync(sp2, JSON.stringify(settings, null, 2) + '\n', 'utf8')
    done.push(`updated   ${sp2}`)
  } else {
    done.push(`exists    ${sp2}  (hook already registered)`)
  }

  log()
  for (const line of done) log(`  ✓ ${line}`)
  log(`
  All done. Restart Claude Code (or run /reload-plugins) for the skill to take effect.
  The Stop hook will scan your transcripts silently after each turn and prompt
  Claude to invoke /broom-sweep if secrets are found.
`)

  return done
}
