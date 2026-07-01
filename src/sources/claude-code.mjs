// Source adapter for Claude Code transcripts.
//
// Claude Code writes one JSONL file per session under:
//   ~/.claude/projects/<url-encoded-project-path>/<session-uuid>.jsonl
//
// Each line is a JSON object representing one turn. We treat each file as
// a single text blob — redaction is inline on the raw bytes, so the JSONL
// stays valid without a parse/serialize round-trip.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * A single addressable blob of text plus how to read and write it.
 * @typedef {Object} Target
 * @property {string} source   - 'claude-code'
 * @property {string} label    - human-readable identifier shown in reports
 * @property {string} file     - absolute path to the backing file (for backup)
 * @property {() => string} read          - return current file content as UTF-8 text
 * @property {(text: string) => void} write - overwrite the file with redacted text
 */

/**
 * Root directory for Claude Code session transcripts.
 * Claude Code uses ~/.claude on Linux, macOS, and Windows alike.
 * @returns {string}
 */
export function claudeCodeRoot() {
  return join(homedir(), '.claude', 'projects')
}

/**
 * Walk a directory tree and yield the absolute path of every *.jsonl file.
 * Silently skips directories that don't exist or aren't readable.
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkJsonl(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // dir missing or unreadable — not an error, just no transcripts
  }

  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkJsonl(full)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      yield full
    }
  }
}

/**
 * Discover all Claude Code session files and return them as Targets.
 * Returns an empty array if Claude Code has never been used on this machine.
 * @returns {Target[]}
 */
export function discoverTargets() {
  const root = claudeCodeRoot()
  const targets = []

  for (const file of walkJsonl(root)) {
    // Capture `file` in a closure-safe way for the lazy read/write callbacks.
    const f = file
    targets.push({
      source: 'claude-code',
      label: f,
      file: f,
      read: () => readFileSync(f, 'utf8'),
      write: (text) => writeFileSync(f, text, 'utf8'),
    })
  }

  return targets
}
