// Report formatter — human-readable and JSON output for scan/clean results.

import { createHash } from 'node:crypto'
import { severity as color, bold, dim } from './ui.mjs'

/**
 * @typedef {import('./detector.mjs').Finding} Finding
 * @typedef {import('./sources/claude-code.mjs').Target} Target
 * @typedef {{ target: Target, findings: Finding[], applied?: number }} ScanResult
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']

/** Friendly display names for source ids. */
const SOURCE_NAME = {
  'claude-code': 'Claude Code',
  codex:         'Codex',
  cursor:        'Cursor',
}

/**
 * Mask a secret for display: show first 6 chars + … + last 4.
 * Very short secrets are shown as *** to avoid leaking them.
 * @param {string} secret
 * @returns {string}
 */
function maskSecret(secret) {
  if (secret.length <= 12) return '*'.repeat(secret.length)
  return secret.slice(0, 6) + dim('…') + secret.slice(-4)
}

/**
 * Compute the 1-indexed line number of a character offset in text.
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
function lineNumber(text, offset) {
  let line = 1
  for (let i = 0; i < offset; i++) {
    if (text[i] === '\n') line++
  }
  return line
}

/** Short severity breakdown for a set of findings, e.g. "12 critical · 3 high". */
/**
 * Reduce findings to distinct secrets (deduped by value) and their severity
 * counts. The same credential echoed many times across a transcript counts
 * once — this is the "how many secrets to rotate" number, as opposed to the
 * raw occurrence count (how many redactions `sweep` performs).
 * @param {Finding[]} findings
 * @returns {{ distinct: number, counts: Record<string, number> }}
 */
function distinctBySeverity(findings) {
  const seen = new Map()   // secret value → severity
  for (const f of findings) if (!seen.has(f.secret)) seen.set(f.secret, f.severity)
  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0]))
  for (const sev of seen.values()) counts[sev] = (counts[sev] ?? 0) + 1
  return { distinct: seen.size, counts }
}

/** Render a severity-count map, e.g. "5 critical · 25 high", coloured. */
function breakdownFromCounts(counts) {
  return SEVERITY_ORDER
    .filter(s => counts[s] > 0)
    .map(s => color(s, `${counts[s]} ${s}`))
    .join(dim(' · '))
}

/** Replace the home dir prefix with ~ for compact display. */
function shorten(label) {
  const home = process.env.HOME || process.env.USERPROFILE
  return home ? label.replaceAll(home, '~') : label
}

/**
 * Print a human-readable scan report to stdout.
 *
 * By default this prints a compact summary: totals plus one line per file with
 * its finding count and severity breakdown. Pass `verbose` to additionally list
 * every individual finding (rule, masked secret, line number) under each file —
 * useful for a handful of findings, overwhelming for thousands.
 *
 * @param {ScanResult[]} results
 * @param {{ clean?: boolean, apply?: boolean, verbose?: boolean }} [opts]
 *   clean   — true when called from `broom clean` (adjusts wording)
 *   apply   — true when redaction was actually performed
 *   verbose — true to list every finding, not just per-file counts
 */
export function printReport(results, opts = {}) {
  const { clean = false, apply = false, verbose = false } = opts

  const totalOccurrences = results.reduce((n, r) => n + r.findings.length, 0)
  const totalApplied = results.reduce((n, r) => n + (r.applied ?? 0), 0)

  // ── Header ────────────────────────────────────────────────────────────────
  const cmd = clean ? (apply ? 'sweep' : 'clean') : 'scan'
  const mode = apply ? `${bold('redacted in place')}` : `${dim('dry-run')}`
  console.log()
  console.log(`${bold('broomsticks')} ${cmd} — ${mode}`)

  if (totalOccurrences === 0) {
    console.log(`\n  ${bold('No secrets found.')} All ${results.length} chat(s) are clean.\n`)
    return
  }

  const dirty = results.filter(r => r.findings.length > 0)
  const allFindings = dirty.flatMap(r => r.findings)
  const totalDistinct = new Set(allFindings.map(f => f.secret)).size

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  let headline = `\n  ${bold(plural(totalDistinct, 'secret'))} found across ${plural(dirty.length, 'chat')}.`
  // Distinct vs occurrences: the same key echoed many times counts once above.
  if (totalOccurrences !== totalDistinct) headline += dim(`  (${plural(totalOccurrences, 'occurrence')})`)
  console.log(headline)
  if (apply) console.log(`  ${bold(plural(totalApplied, 'redaction'))} applied; originals backed up.`)
  console.log()

  if (verbose) {
    // ── Full listing: every occurrence under its chat ────────────────────────
    for (const { target, findings } of dirty) {
      console.log(`  ${bold(SOURCE_NAME[target.source] ?? target.source)}  ${shorten(target.label)}`)
      const bySev = Object.fromEntries(SEVERITY_ORDER.map(s => [s, []]))
      // Defensive: a finding with an unknown severity is bucketed under the
      // lowest level rather than crashing (rules only emit known severities).
      for (const f of findings) (bySev[f.severity] ?? bySev.low).push(f)

      let targetText = null
      try { targetText = target.read() } catch { /* non-blocking */ }

      for (const sev of SEVERITY_ORDER) {
        for (const f of bySev[sev]) {
          const tag      = color(sev, `[${sev.padEnd(8)}]`)
          const rule     = f.ruleId.padEnd(26)
          const masked   = maskSecret(f.secret)
          const lineInfo = targetText !== null ? dim(`  line ${lineNumber(targetText, f.start)}`) : ''
          console.log(`    ${tag} ${dim(rule)} ${masked}${lineInfo}`)
        }
      }
      console.log()
    }
  } else {
    // ── Compact: one row per AI client — vulnerable chats + distinct secrets ──
    const byClient = new Map()
    for (const r of dirty) {
      const arr = byClient.get(r.target.source) ?? []
      arr.push(r)
      byClient.set(r.target.source, arr)
    }

    const rows = [...byClient.entries()]
      .map(([src, rs]) => {
        const { distinct, counts } = distinctBySeverity(rs.flatMap(r => r.findings))
        return { name: SOURCE_NAME[src] ?? src, chats: rs.length, distinct, counts }
      })
      .sort((a, b) => b.distinct - a.distinct)

    const nameW = Math.max(...rows.map(r => r.name.length))
    const chatW = Math.max(...rows.map(r => String(r.chats).length))
    const secW  = Math.max(...rows.map(r => String(r.distinct).length))

    for (const row of rows) {
      const name  = bold(row.name.padEnd(nameW))
      const chats = dim(`${String(row.chats).padStart(chatW)} ${row.chats === 1 ? 'chat ' : 'chats'}`)
      const secs  = `${String(row.distinct).padStart(secW)} ${row.distinct === 1 ? 'secret ' : 'secrets'}`
      console.log(`  ${name}   ${chats}   ${bold(secs)}   ${breakdownFromCounts(row.counts)}`)
    }
  }

  // ── Totals + next steps ─────────────────────────────────────────────────────
  console.log(`\n  Severity: ${breakdownFromCounts(distinctBySeverity(allFindings).counts)}`)
  if (!verbose) console.log(dim(`  Re-run with --verbose to list every occurrence.`))
  if (!apply) console.log(`  Run ${bold('broom sweep')} (or ${bold('broom clean --apply')}) to redact in place — backs up first.`)
  console.log()
}

/**
 * Emit findings as a JSON structure for CI / machine consumption.
 * Printed to stdout; caller should pipe or redirect.
 *
 * @param {ScanResult[]} results
 */
export function printJsonReport(results) {
  const totalFindings = results.reduce((n, r) => n + r.findings.length, 0)

  const output = {
    version: 1,
    totalFindings,
    files: results
      .filter(r => r.findings.length > 0)
      .map(({ target, findings, applied }) => ({
        source:   target.source,
        label:    target.label,
        file:     target.file,
        applied:  applied ?? null,
        findings: findings.map(f => ({
          ruleId:   f.ruleId,
          title:    f.title,
          severity: f.severity,
          start:    f.start,
          end:      f.end,
          // Never include the raw secret in JSON output — only the hash
          sha8: hashSecret(f.secret),
        })),
      })),
  }

  console.log(JSON.stringify(output, null, 2))
}

/**
 * @param {string} secret
 * @returns {string}  First 8 hex chars of SHA-256(secret)
 */
function hashSecret(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8)
}
