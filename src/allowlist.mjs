// Allowlist — suppresses known false positives from scan findings.
//
// Sources (merged at scan time):
//   1. Built-in DEMO_SECRETS — well-known placeholder values from docs/tutorials
//   2. User file at ~/.broom/allowlist.txt (one entry per line)
//      Lines starting with # are comments; /regex/flags entries compile to RegExp.
//
// A finding is suppressed when its secret matches any entry exactly (string)
// or fully (regex). Only the secret value is tested, not the rule or context.

import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Built-in demo / documentation secrets that are safe to suppress.
 * These appear in AWS docs, GitHub tutorials, etc. and frequently end up in
 * transcripts from "why doesn't this work?" conversations.
 *
 * Note: Stripe test keys are handled via regex in DEFAULT_ALLOWLIST_CONTENT
 * rather than a literal here to avoid triggering secret-scanning tools on this
 * source file itself.
 */
export const DEMO_SECRETS = [
  // AWS — official documentation placeholder credentials
  'AKIAIOSFODNN7EXAMPLE',
  'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  // GitHub — placeholder PAT used in docs
  'ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  // Generic placeholder shapes that appear in .env.example files
  'your_api_key_here',
  'your-secret-key',
  'changeme',
  'replace_me',
  'INSERT_API_KEY_HERE',
]

/**
 * Default path for the user allowlist file.
 * @returns {string}
 */
export function allowlistPath() {
  return join(homedir(), '.broom', 'allowlist.txt')
}

/**
 * Default content written to the allowlist file on first run.
 * Users can add their own entries below the built-in block.
 */
export const DEFAULT_ALLOWLIST_CONTENT = `# broomsticks allowlist — one entry per line.
# Lines starting with # are comments.
# Use /regex/flags syntax for pattern matching (e.g. /sk_test_[A-Za-z0-9]+/).
#
# ── Built-in: well-known documentation placeholder values ──────────────────────
# These appear in AWS, Stripe, GitHub, and other official docs and tutorials.
# Remove any line here if you want broomsticks to flag that value in your sessions.

# AWS documentation example credentials (https://docs.aws.amazon.com)
AKIAIOSFODNN7EXAMPLE
wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

# Stripe test-mode keys (not live; safe to allow unless you want to catch them)
/sk_test_[A-Za-z0-9]{10,99}/

# Generic placeholder values that show up in .env.example files
your_api_key_here
your-secret-key
changeme
replace_me
INSERT_API_KEY_HERE

# ── Your entries ──────────────────────────────────────────────────────────────
# Add your own known-safe values below this line.

`

/**
 * @typedef {{ literals: Set<string>, patterns: RegExp[] }} Allowlist
 */

/**
 * Parse a list of text lines into a compiled Allowlist.
 * @param {string[]} lines
 * @returns {Allowlist}
 */
export function parseAllowlist(lines) {
  const literals = new Set()
  const patterns = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const reMatch = line.match(/^\/(.+)\/([gimsud]*)$/)
    if (reMatch) {
      try { patterns.push(new RegExp(reMatch[1], reMatch[2])) } catch { /* bad regex — skip */ }
    } else {
      literals.add(line)
    }
  }

  return { literals, patterns }
}

/**
 * Load the combined allowlist: built-in demo secrets + user file (if present).
 * @param {string} [file]  Override the default allowlist path.
 * @returns {Allowlist}
 */
export function loadAllowlist(file) {
  const lines = [...DEMO_SECRETS]

  const path = file ?? allowlistPath()
  if (existsSync(path)) {
    try {
      lines.push(...readFileSync(path, 'utf8').split('\n'))
    } catch { /* unreadable — use built-ins only */ }
  }

  return parseAllowlist(lines)
}

/**
 * Return true if `secret` is covered by the allowlist and should be suppressed.
 * @param {string} secret
 * @param {Allowlist} allowlist
 * @returns {boolean}
 */
export function isAllowlisted(secret, allowlist) {
  if (allowlist.literals.has(secret)) return true
  return allowlist.patterns.some(re => {
    re.lastIndex = 0
    return re.test(secret)
  })
}
