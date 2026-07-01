// Report formatter — human-readable and JSON output for scan/clean results.

import { createHash } from 'node:crypto'

/**
 * @typedef {import('./detector.mjs').Finding} Finding
 * @typedef {import('./sources/claude-code.mjs').Target} Target
 * @typedef {{ target: Target, findings: Finding[], applied?: number }} ScanResult
 */

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']

const SEVERITY_COLOR = {
  critical: '\x1b[1;31m', // bold red
  high:     '\x1b[31m',   // red
  medium:   '\x1b[33m',   // yellow
  low:      '\x1b[90m',   // grey
}
const RESET = '\x1b[0m'
const DIM   = '\x1b[2m'
const BOLD  = '\x1b[1m'

/**
 * Whether stdout is a TTY — used to strip ANSI codes in piped output.
 */
const isTTY = process.stdout.isTTY ?? false

function color(sev, text) {
  return isTTY ? `${SEVERITY_COLOR[sev]}${text}${RESET}` : text
}
function bold(text)  { return isTTY ? `${BOLD}${text}${RESET}` : text }
function dim(text)   { return isTTY ? `${DIM}${text}${RESET}`  : text }

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

/**
 * Print a human-readable scan report to stdout.
 *
 * @param {ScanResult[]} results
 * @param {{ clean?: boolean, apply?: boolean }} [opts]
 *   clean — true when called from `broom clean` (adjusts wording)
 *   apply — true when redaction was actually performed
 */
export function printReport(results, opts = {}) {
  const { clean = false, apply = false } = opts

  const totalFindings = results.reduce((n, r) => n + r.findings.length, 0)
  const filesWithFindings = results.filter(r => r.findings.length > 0).length
  const totalApplied = results.reduce((n, r) => n + (r.applied ?? 0), 0)

  // ── Header ────────────────────────────────────────────────────────────────
  const cmd = clean ? 'clean' : 'scan'
  const mode = apply ? `${bold('--apply')} (redacted in place)` : `${dim('dry-run')}`
  console.log()
  console.log(`${bold('broomsticks')} ${cmd} — ${mode}`)

  if (totalFindings === 0) {
    console.log(`\n  ${bold('No secrets found.')} All ${results.length} file(s) are clean.\n`)
    return
  }

  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  console.log(`\n  ${bold(plural(totalFindings, 'secret'))} found across ${plural(filesWithFindings, 'file')}.`)
  if (apply) console.log(`  ${bold(plural(totalApplied, 'redaction'))} applied; originals backed up.\n`)
  else console.log(`  Run ${bold('broom clean --apply')} to redact in place (backs up first).\n`)

  // ── Per-file findings ──────────────────────────────────────────────────────
  const dirty = results.filter(r => r.findings.length > 0)

  for (const { target, findings } of dirty) {
    const shortLabel = target.label.replace(process.env.HOME ?? '', '~')
    console.log(`  ${bold(target.source)}  ${shortLabel}`)

    // Group by severity for ordered display
    const bySev = Object.fromEntries(SEVERITY_ORDER.map(s => [s, []]))
    for (const f of findings) bySev[f.severity].push(f)

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

  // ── Severity summary ───────────────────────────────────────────────────────
  const counts = Object.fromEntries(SEVERITY_ORDER.map(s => [s, 0]))
  for (const { findings } of results) for (const f of findings) counts[f.severity]++

  const summary = SEVERITY_ORDER
    .filter(s => counts[s] > 0)
    .map(s => color(s, `${counts[s]} ${s}`))
    .join(', ')
  console.log(`  Severity: ${summary}\n`)
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
