#!/usr/bin/env node
// broomsticks — placeholder release to reserve the npm name while the scanner
// is built out. See PLAN.md for the design and roadmap. No secrets are read,
// written, or transmitted by this stub; it only prints this notice.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const args = process.argv.slice(2)

if (args.includes('--version') || args.includes('-v')) {
  console.log(pkg.version)
  process.exit(0)
}

console.log(`broomsticks v${pkg.version} — sweep secrets out of AI coding-assistant transcripts

  This is an early placeholder release. The scanner is not implemented yet —
  this command only prints this notice (it reads/writes/sends nothing).

  Planned commands:
    broom scan             scan Claude Code / Codex / Cursor transcripts for secrets
    broom clean --apply    redact found secrets in place (backs up first)

  Design & roadmap: https://github.com/digitaldrreamer/broomsticks/blob/main/PLAN.md
  Follow progress:  https://github.com/digitaldrreamer/broomsticks`)
process.exit(0)
