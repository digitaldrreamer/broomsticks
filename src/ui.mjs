// Terminal UI helpers — styling and interactive prompts. Zero dependencies:
// styling is hand-rolled ANSI (respecting NO_COLOR / FORCE_COLOR / TTY, the
// same contract as chalk / util.styleText) and prompts use the built-in
// node:readline/promises. Nothing here touches the network.

import { stdin, stdout } from 'node:process'
import * as readline from 'node:readline/promises'

// ── Colour support ─────────────────────────────────────────────────────────
// Honour the de-facto standards: NO_COLOR disables, FORCE_COLOR overrides, and
// otherwise colour only when stdout is a TTY. https://no-color.org
function colorEnabled() {
  if (process.env.NO_COLOR) return false
  // Match Node's own rule (docs, `FORCE_COLOR`): '', '1', '2', '3', 'true'
  // enable colour; any other value (incl. '0'/'false') disables it. Note an
  // *empty* string enables — deliberately, per the standard.
  if (process.env.FORCE_COLOR != null) {
    return ['', '1', '2', '3', 'true'].includes(process.env.FORCE_COLOR)
  }
  return Boolean(stdout.isTTY)
}

const CODES = {
  reset: 0, bold: 1, dim: 2,
  red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, gray: 90,
}

/**
 * Wrap `text` in one or more ANSI codes, or return it unchanged when colour is
 * disabled. `names` is a code name or array of them (e.g. ['bold','red']).
 */
export function paint(names, text) {
  if (!colorEnabled()) return text
  const list = Array.isArray(names) ? names : [names]
  const open = list.map(n => `\x1b[${CODES[n] ?? 0}m`).join('')
  return `${open}${text}\x1b[0m`
}

export const bold = t => paint('bold', t)
export const dim  = t => paint('dim', t)

const SEVERITY_FMT = {
  critical: ['bold', 'red'],
  high:     ['red'],
  medium:   ['yellow'],
  low:      ['gray'],
}

/** Colour a string by severity level. */
export const severity = (sev, text) => paint(SEVERITY_FMT[sev] ?? 'reset', text)

/** True only when both stdin and stdout are interactive terminals. */
export function isInteractive() {
  return Boolean(stdout.isTTY && stdin.isTTY)
}

/**
 * Ask a yes/no question. Returns `def` immediately when non-interactive so the
 * CLI never blocks in a pipe or CI.
 * @param {string} question
 * @param {boolean} [def=false]
 * @returns {Promise<boolean>}
 */
export async function confirm(question, def = false) {
  if (!isInteractive()) return def
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    const hint = def ? 'Y/n' : 'y/N'
    const ans = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase()
    if (ans === '') return def
    return ans === 'y' || ans === 'yes'
  } finally {
    rl.close()
  }
}

/**
 * Present a numbered menu and return the chosen value. Returns `null` when
 * non-interactive (caller should fall back to help / an explicit command).
 * @param {string} question
 * @param {Array<{label:string, value:any}>} choices
 * @returns {Promise<any|null>}
 */
export async function select(question, choices) {
  if (!isInteractive()) return null
  const rl = readline.createInterface({ input: stdin, output: stdout })
  try {
    console.log(question)
    choices.forEach((c, i) => console.log(`  ${bold(String(i + 1))}) ${c.label}`))
    for (;;) {
      const ans = (await rl.question('Choose a number (or Enter to cancel): ')).trim()
      if (ans === '') return null
      const n = Number(ans)
      if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1].value
      console.log(dim('  Please enter a valid number.'))
    }
  } finally {
    rl.close()
  }
}

/**
 * Suggest the closest candidate to `input` (Levenshtein ≤ 2) for "did you
 * mean" hints on unknown commands. Returns null when nothing is close.
 * @param {string} input
 * @param {string[]} candidates
 * @returns {string|null}
 */
export function closest(input, candidates) {
  let best = null
  let bestDist = Infinity
  for (const c of candidates) {
    const d = levenshtein(input, c)
    if (d < bestDist) { bestDist = d; best = c }
  }
  return bestDist <= 2 ? best : null
}

function levenshtein(a, b) {
  const m = a.length, n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}
