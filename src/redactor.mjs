// Redactor: replaces detected secrets with stable, JSON-safe placeholders.
//
// Placeholder format:  «BROOM:<ruleId>:<sha8>»
//   «»  — not matched by any detection rule, so redacted transcripts are idempotent
//   sha8 — first 8 hex digits of SHA-256(secret), lets you correlate the same leak
//           across files without re-exposing the value

import { createHash } from 'node:crypto'

/**
 * Replace every finding's secret span with a placeholder.
 * Processes right-to-left so earlier byte offsets stay valid after each substitution.
 *
 * @param {string} text
 * @param {import('./detector.mjs').Finding[]} findings
 * @returns {{ text: string, applied: number }}
 */
export function redactText(text, findings) {
  if (!findings.length) return { text, applied: 0 }

  // Descending start order — rightmost replacement first.
  const ordered = [...findings].sort((a, b) => b.start - a.start)

  let result = text
  let applied = 0

  for (const f of ordered) {
    const placeholder = buildPlaceholder(f.ruleId, f.secret)
    result = result.slice(0, f.start) + placeholder + result.slice(f.end)
    applied++
  }

  return { text: result, applied }
}

/**
 * Build the stable placeholder string for a finding.
 * Exported so the report module can show what placeholder was used.
 * @param {string} ruleId
 * @param {string} secret
 * @returns {string}
 */
export function buildPlaceholder(ruleId, secret) {
  const sha8 = createHash('sha256').update(secret).digest('hex').slice(0, 8)
  return `«BROOM:${ruleId}:${sha8}»`
}
