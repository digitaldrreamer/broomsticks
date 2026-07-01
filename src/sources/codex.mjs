// Source adapter for OpenAI Codex CLI transcripts.
//
// Codex writes:
//   ~/.codex/history.jsonl          — global command history
//   ~/.codex/sessions/**/*.jsonl    — per-session conversation logs

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Root directory for Codex data.
 * @returns {string}
 */
export function codexRoot() {
  return join(homedir(), '.codex')
}

/**
 * Recursively yield every *.jsonl file under a directory.
 * Silently skips missing or unreadable directories.
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkJsonl(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkJsonl(full)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield full
  }
}

/**
 * Discover all Codex transcript files and return them as Targets.
 * Returns an empty array if Codex has not been used on this machine.
 * @returns {import('./claude-code.mjs').Target[]}
 */
export function discoverTargets() {
  const root = codexRoot()
  const targets = []

  // history.jsonl sits directly in ~/.codex
  const history = join(root, 'history.jsonl')
  try {
    statSync(history)
    targets.push(makeTarget(history))
  } catch { /* file absent */ }

  // Per-session files live under ~/.codex/sessions/**
  for (const file of walkJsonl(join(root, 'sessions'))) {
    targets.push(makeTarget(file))
  }

  return targets
}

/**
 * @param {string} file
 * @returns {import('./claude-code.mjs').Target}
 */
function makeTarget(file) {
  const f = file
  return {
    source: 'codex',
    label:  f,
    file:   f,
    read:   () => readFileSync(f, 'utf8'),
    write:  (text) => writeFileSync(f, text, 'utf8'),
  }
}
