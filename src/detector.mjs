// Scanner: runs rules against a text blob and returns de-overlapped findings.

import { shannonEntropy } from './rules.mjs'
import { jsonDocuments, mapJsonFindings } from './json.mjs'

/**
 * @typedef {'critical'|'high'|'medium'|'low'} Severity
 * @typedef {{ ruleId:string, title:string, severity:Severity, secret:string, start:number, end:number, jsonDepth?:number }} Finding
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
  const allRules = prepareRules(rules, extras)
  return scan(text, allRules)
}

export function scanJsonLines(text, rules, extras = []) {
  const allRules = prepareRules(rules, extras)
  return scanDocuments(text, jsonDocuments(text, true), allRules)
}

function prepareRules(rules, extras) {
  return [...rules, ...extrasToRules(extras)].map(rule => ({
    ...rule, pattern: new RegExp(rule.pattern.source, rule.pattern.flags),
  }))
}

function scan(text, rules) {
  const documents = jsonDocuments(text)
  return documents ? scanDocuments(text, documents, rules) : scanRaw(text, rules)
}

function scanDocuments(text, documents, rules) {
  const findings = []
  // Scan once with field context intact. Validate spans before resolving
  // overlaps so a match crossing fields cannot hide a valid contained secret.
  const raw = scanRaw(text, rules, false).sort((a, b) => a.start - b.start)
  let next = 0
  let crossing = []
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g
  for (const document of documents) {
    for (const match of document.text.matchAll(tokens)) {
      const start = document.start + match.index
      const end = start + match[0].length
      const string = match[0][0] === '"'
      const content = string ? match[0].slice(1, -1) : match[0]
      // Escaped strings need decoded offsets; serialized JSON also needs its
      // own token boundaries and quoting depth (including arrays of scalars).
      const nested = string && (content.includes('\\') || /^\s*[\[{\"]/.test(content))
      let serialized
      if (nested) {
        const decoded = JSON.parse(match[0])
        serialized = jsonDocuments(decoded)
        const found = serialized ? scanDocuments(decoded, serialized, rules) : scanRaw(decoded, rules)
        for (const finding of mapJsonFindings(match[0], found, start)) findings.push(finding)
      }
      crossing = crossing.filter(finding => finding.end > start)
      while (next < raw.length && raw[next].start < end) {
        const finding = raw[next++]
        if (string && finding.start >= start + 1 && finding.end <= end - 1) {
          if (!nested) findings.push(finding)
          else if (!serialized && finding.ruleId.startsWith('extra-')) {
            // Contextual extras can match encoded values. Accept only whole
            // escape sequences and hash the decoded credential as usual.
            try {
              JSON.parse(match[0].slice(0, finding.start - start) + '"')
              const secret = JSON.parse('"' + finding.secret + '"')
              findings.push({ ...finding, secret })
            } catch { /* match cut through a JSON escape */ }
          }
        } else if (!string && finding.start === start && finding.end === end) {
          findings.push({ ...finding, jsonDepth: 0 })
        } else if (finding.end > start) {
          crossing.push(finding)
        }
      }
      // A rejected cross-field match may have consumed a later match of the
      // same rule. Retry only those rules within the affected tokens.
      if (!nested && crossing.length) {
        const retry = rules.filter(rule => crossing.some(finding => finding.ruleId === rule.id))
        for (const finding of scanRaw(content, retry)) {
          if (!string && (finding.start !== 0 || finding.end !== content.length)) continue
          findings.push({ ...finding, start: start + (string ? 1 : 0) + finding.start,
            end: start + (string ? 1 : 0) + finding.end, ...(string ? {} : { jsonDepth: 0 }) })
        }
      }
    }
  }
  return resolveOverlaps(findings)
}

function scanRaw(text, rules, resolve = true) {
  const raw = []
  const placeholders = [...text.matchAll(/«BROOM:[\w-]+:[a-f0-9]{8}»/g)]

  for (const rule of rules) {
    // matchAll clones the regex itself; the caller's lastIndex stays untouched.
    for (const match of text.matchAll(rule.pattern)) {
      const grp = rule.secretGroup ?? 0
      const secret = match[grp] ?? match[0]
      if (!secret) continue

      const indices = match.indices?.[grp] ?? match.indices?.[0]
      if (!indices) continue
      const [start, end] = indices

      let low = 0
      let high = placeholders.length - 1
      while (low <= high) {
        const middle = (low + high) >>> 1
        if (placeholders[middle].index <= start) low = middle + 1
        else high = middle - 1
      }
      if (high >= 0 && end <= placeholders[high].index + placeholders[high][0].length) continue

      if (rule.entropy !== undefined && shannonEntropy(secret) < rule.entropy) continue
      if (rule.deny && rule.deny.test(secret)) continue

      raw.push({ ruleId: rule.id, title: rule.title, severity: rule.severity, secret, start, end })
    }
  }

  return resolve ? resolveOverlaps(raw) : raw
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
