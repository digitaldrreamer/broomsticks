// Scanner: runs rules against a text blob and returns de-overlapped findings.

import { shannonEntropy } from './rules.mjs'

/**
 * @typedef {'critical'|'high'|'medium'|'low'} Severity
 * @typedef {{ ruleId:string, title:string, severity:Severity, secret:string, start:number, end:number }} Finding
 */

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 }

/**
 * Scan a text blob with the given rules plus any user-supplied extras.
 * Returns findings sorted by start position, with overlapping spans resolved.
 *
 * @param {string} text
 * @param {import('./rules.mjs').Rule[]} rules
 * @param {string[]} [extras]  Lines from --extra file: literal strings or /regex/flags
 * @returns {Finding[]}
 */
export function scanText(text, rules, extras = []) {
  const allRules = [...rules, ...extrasToRules(extras)]
  const raw = []

  for (const rule of allRules) {
    // Clone the pattern so matchAll gets a fresh lastIndex each call.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags)

    for (const match of text.matchAll(pattern)) {
      const grp = rule.secretGroup ?? 0
      const secret = match[grp] ?? match[0]
      if (!secret) continue

      const indices = match.indices[grp] ?? match.indices[0]
      if (!indices) continue
      const [start, end] = indices

      if (rule.entropy !== undefined && shannonEntropy(secret) < rule.entropy) continue

      raw.push({ ruleId: rule.id, title: rule.title, severity: rule.severity, secret, start, end })
    }
  }

  return resolveOverlaps(raw)
}

/**
 * When two findings overlap, keep the one with the longer span; break ties by
 * higher severity. This prevents nested placeholders and double-redaction.
 * @param {Finding[]} findings
 * @returns {Finding[]}
 */
function resolveOverlaps(findings) {
  if (findings.length <= 1) return findings

  // Sort by priority: longer span first, then higher severity, then earlier start.
  // Greedy sweep then naturally keeps the best non-overlapping set.
  const sorted = [...findings].sort((a, b) => {
    const lenDiff = (b.end - b.start) - (a.end - a.start)
    if (lenDiff !== 0) return lenDiff
    const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (rankDiff !== 0) return rankDiff
    return a.start - b.start
  })

  const kept = []
  for (const f of sorted) {
    if (!kept.some(k => f.start < k.end && k.start < f.end)) kept.push(f)
  }

  return kept.sort((a, b) => a.start - b.start)
}

/**
 * Convert --extra file lines into synthetic rules.
 * Each line is either a /regex/flags literal or a plain string to match exactly.
 * @param {string[]} lines
 * @returns {import('./rules.mjs').Rule[]}
 */
function extrasToRules(lines) {
  return lines
    .map(l => l.trim())
    .filter(Boolean)
    .map((entry, i) => {
      let pattern
      const reMatch = entry.match(/^\/(.+)\/([gimsud]*)$/)
      if (reMatch) {
        const flags = [...new Set([...reMatch[2], 'g', 'd'])].join('')
        pattern = new RegExp(reMatch[1], flags)
      } else {
        const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        pattern = new RegExp(escaped, 'gd')
      }
      return {
        id: `extra-${i}`,
        title: `User-supplied secret #${i + 1}`,
        severity: /** @type {Severity} */ ('high'),
        pattern,
      }
    })
}
