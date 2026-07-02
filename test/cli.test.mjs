// End-to-end CLI tests: scan/clean lifecycle over a real transcript, and a
// regression guard that `broom proxy` keeps running instead of falling through
// into the scan path and exiting immediately.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const BIN = fileURLToPath(new URL('../bin/broom.mjs', import.meta.url))
const SECRET = 'ghp_1234567890abcdefABCDEF1234567890abcd'

function makeHome() {
  const home = mkdtempSync(join(tmpdir(), 'broom-cli-'))
  const dir = join(home, '.claude', 'projects', 'demo')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.jsonl')
  writeFileSync(file, JSON.stringify({ role: 'user', text: `key ${SECRET}` }) + '\n', 'utf8')
  return { home, file }
}

function run(args, home) {
  return spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  })
}

test('scan → clean --apply → re-scan lifecycle', () => {
  const { home, file } = makeHome()
  try {
    // scan: finds the secret, JSON output, non-zero exit
    const scan = run(['scan', '--json', '--source', 'claude-code'], home)
    assert.equal(scan.status, 1, 'scan should exit 1 when secrets are found')
    const report = JSON.parse(scan.stdout)
    assert.equal(report.totalFindings, 1)
    assert.equal(report.files[0].findings[0].ruleId, 'github-pat')
    // JSON output must never contain the raw secret — only the hash.
    assert.ok(!scan.stdout.includes(SECRET), 'raw secret must not appear in JSON report')

    // clean --apply: redacts in place, takes a backup
    const clean = run(['clean', '--apply', '--source', 'claude-code'], home)
    assert.equal(clean.status, 1) // findings existed → exit 1 unless --no-fail
    const redacted = readFileSync(file, 'utf8')
    assert.ok(!redacted.includes(SECRET), 'file must no longer contain the secret')
    assert.ok(redacted.includes('«BROOM:github-pat:'))
    JSON.parse(redacted.trim()) // still valid JSONL

    const backupsRoot = join(home, '.broom', 'backups')
    assert.ok(existsSync(backupsRoot), 'backup directory should exist')
    const stamps = readdirSync(backupsRoot)
    assert.ok(stamps.length >= 1)
    assert.ok(existsSync(join(backupsRoot, stamps[0], 'manifest.json')))

    // re-scan: clean now, zero exit
    const rescan = run(['scan', '--json', '--source', 'claude-code'], home)
    assert.equal(rescan.status, 0)
    assert.equal(JSON.parse(rescan.stdout).totalFindings, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('invalid --port is rejected', () => {
  const { home } = makeHome()
  try {
    const res = run(['proxy', '--port', 'not-a-number'], home)
    assert.equal(res.status, 1)
    assert.match(res.stderr + res.stdout, /invalid port/i)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('broom proxy keeps running (does not fall through to scan and exit)', async () => {
  const { home } = makeHome()
  const port = 39117
  const child = spawn(process.execPath, [BIN, 'proxy', '--port', String(port)], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    encoding: 'utf8',
  })
  let stdout = ''
  child.stdout.on('data', d => { stdout += d })

  try {
    await sleep(800)
    assert.equal(child.exitCode, null, 'proxy must still be running, not exited')
    assert.equal(child.signalCode, null)
    assert.match(stdout, /listening on/i)
    // The scan report banner must NOT appear — that would mean it fell through.
    assert.doesNotMatch(stdout, /No secrets found|secrets? found across/i)
  } finally {
    child.kill('SIGTERM')
    await sleep(50)
    if (child.exitCode === null) child.kill('SIGKILL')
    rmSync(home, { recursive: true, force: true })
  }
})
