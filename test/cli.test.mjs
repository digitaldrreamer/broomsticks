// End-to-end CLI tests: scan/clean lifecycle over a real transcript, and a
// regression guard that `broom proxy` keeps running instead of falling through
// into the scan path and exiting immediately.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import { scanText } from '../src/detector.mjs'
import { redactText } from '../src/redactor.mjs'
import { RULES } from '../src/rules.mjs'

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
    env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming') },
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

    // The run tells the user where the backup went and how big it is.
    assert.match(clean.stdout, /Backups\s+~[\\/]\.broom[\\/]backups/)
    assert.match(clean.stdout, /\(\d+ files?, [\d.]+ (?:B|KB|MB|GB)\)/)

    // re-scan: clean now, zero exit
    const rescan = run(['scan', '--json', '--source', 'claude-code'], home)
    assert.equal(rescan.status, 0)
    assert.equal(JSON.parse(rescan.stdout).totalFindings, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('sweep redacts in place like clean --apply', () => {
  const { home, file } = makeHome()
  try {
    const res = run(['sweep', '--source', 'claude-code'], home)
    assert.equal(res.status, 1, 'findings existed → exit 1')
    const redacted = readFileSync(file, 'utf8')
    assert.ok(!redacted.includes(SECRET), 'secret must be gone')
    assert.ok(redacted.includes('«BROOM:github-pat:'), 'placeholder written')
    assert.match(res.stdout, /redacted in place/i)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('default report is a compact summary; --verbose lists findings', () => {
  const { home } = makeHome()
  try {
    const summary = run(['scan', '--source', 'claude-code'], home)
    // Compact mode shows a per-file count + severity summary, not finding lines.
    assert.match(summary.stdout, /secret.*found across/i)
    assert.doesNotMatch(summary.stdout, /\[high\s*\]|\[critical\s*\]/, 'no per-finding rows by default')

    const verbose = run(['scan', '--source', 'claude-code', '--verbose'], home)
    assert.match(verbose.stdout, /\bgithub-pat\b/, 'verbose lists the rule per finding')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('unknown command suggests the closest match', () => {
  const { home } = makeHome()
  try {
    const res = run(['sacn'], home)
    assert.equal(res.status, 1)
    assert.match(res.stderr, /did you mean 'scan'/i)
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

for (const source of ['claude-code', 'codex']) {
  test(`${source}: escaped JSONL scan, backup, sweep and rescan preserve records`, () => {
    const home = mkdtempSync(join(tmpdir(), 'broom-cli-json-'))
    const directory = source === 'codex' ? join(home, '.codex', 'sessions') : join(home, '.claude', 'projects', 'demo')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'session.jsonl')
    const url = 'postgres://' + 'reader:Example123@database.example.invalid/app'
    const records = [
      { type: 'user', text: `connect("${url}")`, keep: [1, true, null] },
      { type: 'assistant', arguments: JSON.stringify({ url, count: 3 }) },
      { type: 'user', text: '-----BEGIN PRIVATE KEY-----', keep: 1 },
      { type: 'assistant', text: '-----END PRIVATE KEY-----', keep: 2 },
    ]
    const original = records.map(record => JSON.stringify(record)).join('\r\n') + '\r\n'
    writeFileSync(file, original)
    try {
      const scan = run(['scan', '--source', source, '--json'], home)
      assert.equal(scan.status, 1)
      assert.equal(JSON.parse(scan.stdout).totalFindings, 2)
      assert.ok(!scan.stdout.includes(url))
      assert.equal(readFileSync(file, 'utf8'), original)

      const sweep = run(['sweep', '--source', source], home)
      assert.equal(sweep.status, 1)
      const after = readFileSync(file, 'utf8')
      const parsed = after.trim().split('\r\n').map(line => JSON.parse(line))
      assert.equal(parsed.length, records.length)
      assert.deepEqual(parsed[0].keep, records[0].keep)
      assert.ok(!parsed[0].text.includes(url))
      assert.ok(JSON.parse(parsed[1].arguments).url.startsWith('«BROOM:db-url:'))
      assert.deepEqual(parsed.slice(2), records.slice(2))

      const root = join(home, '.broom', 'backups')
      const stamps = readdirSync(root)
      assert.equal(stamps.length, 1)
      const manifest = JSON.parse(readFileSync(join(root, stamps[0], 'manifest.json'), 'utf8'))
      assert.equal(readFileSync(manifest.files[0].backup, 'utf8'), original)

      const rescan = run(['scan', '--source', source, '--json'], home)
      assert.equal(rescan.status, 0)
      assert.equal(JSON.parse(rescan.stdout).totalFindings, 0)
      const repeated = run(['sweep', '--source', source], home)
      assert.equal(repeated.status, 0)
      assert.equal(readFileSync(file, 'utf8'), after)
      assert.deepEqual(readdirSync(root), stamps)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
}

test('malformed JSONL is skipped without writes or leaked parser context', () => {
  const { home, file } = makeHome()
  const original = readFileSync(file, 'utf8') + '{"text":"unterminated ' + SECRET
  writeFileSync(file, original)
  try {
    const result = run(['sweep', '--source', 'claude-code', '--no-fail'], home)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Invalid JSONL record on line 2/)
    assert.doesNotMatch(result.stdout, /All .*chat.*clean/)
    assert.ok(!result.stderr.includes(SECRET))
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.ok(!existsSync(join(home, '.broom', 'backups')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('installed Stop hook alerts on valid findings even when another transcript is malformed', { skip: process.platform === 'win32' }, () => {
  const { home } = makeHome()
  try {
    writeFileSync(join(home, '.claude', 'projects', 'demo', 'incomplete.jsonl'), '{"text":')
    const scan = run(['scan', '--json', '--no-fail'], home)
    assert.equal(scan.status, 1)
    assert.equal(JSON.parse(scan.stdout).totalFindings, 1)
    assert.equal(run(['install', '--yes'], home).status, 0)

    const bin = join(home, 'bin')
    mkdirSync(bin)
    const fallback = join(home, 'fallback-used')
    writeFileSync(join(bin, 'broom'), `#!${process.execPath}\nawait import(${JSON.stringify(BIN)})\n`)
    writeFileSync(join(bin, 'npx'), `#!${process.execPath}\nimport { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(fallback)}, 'used'); process.exit(1)\n`)
    for (const name of ['broom', 'npx']) chmodSync(join(bin, name), 0o755)
    const hook = spawnSync(process.execPath, [join(home, '.claude', 'hooks', 'stop-broom.mjs')], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PATH: bin + delimiter + process.env.PATH }, encoding: 'utf8',
    })
    assert.equal(hook.status, 0)
    assert.equal(JSON.parse(hook.stdout).decision, 'block')
    assert.match(JSON.parse(hook.stdout).reason, /1 secret/)
    assert.ok(!existsSync(fallback), 'valid partial output must not trigger the npx fallback')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('CLI field-scoped extras find and redact credentials while preserving adjacent fields', () => {
  const { home, file } = makeHome()
  const credential = 'internal-credential-7712'
  writeFileSync(file, JSON.stringify({ credential, keep: 7 }) + '\n')
  const extra = join(home, 'extra.txt')
  writeFileSync(extra, '/(?<="credential":\\s*")[^"]+/\n')
  try {
    const scan = run(['scan', '--json', '--extra', extra], home)
    assert.equal(scan.status, 1)
    assert.equal(JSON.parse(scan.stdout).totalFindings, 1)
    const sweep = run(['sweep', '--extra', extra], home)
    assert.equal(sweep.status, 1)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.match(parsed.credential, /^«BROOM:extra-0:/)
    assert.equal(parsed.keep, 7)
    assert.equal(run(['scan', '--extra', extra], home).status, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('failed backups leave transcripts unchanged and fail despite --no-fail', () => {
  const { home, file } = makeHome()
  const original = readFileSync(file, 'utf8')
  const backupDir = join(home, 'not-a-directory')
  writeFileSync(backupDir, 'keep this file')
  try {
    const result = run(['sweep', '--source', 'claude-code', '--backup-dir', backupDir, '--no-fail'], home)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /skipped/)
    assert.match(result.stderr, /file left unchanged/)
    assert.match(result.stdout, /Skipped 1 file/)
    assert.doesNotMatch(result.stdout, /originals backed up/)
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.equal(readFileSync(backupDir, 'utf8'), 'keep this file')
    assert.equal(JSON.parse(run(['scan', '--json'], home).stdout).totalFindings, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('Cursor CLI scans, backs up and cleans real TEXT and BLOB rows', () => {
  const home = mkdtempSync(join(tmpdir(), 'broom-cli-cursor-'))
  const root = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Cursor', 'User')
    : process.platform === 'win32'
      ? join(home, 'AppData', 'Roaming', 'Cursor', 'User')
      : join(home, '.config', 'Cursor', 'User')
  const storage = join(root, 'globalStorage')
  mkdirSync(storage, { recursive: true })
  const file = join(storage, 'state.vscdb')
  const url = 'postgres://' + 'reader:Example123@database.example.invalid/app'
  const database = new DatabaseSync(file)
  database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)')
  const text = JSON.stringify({ text: `connect("${url}")`, keep: 7 })
  const blob = JSON.stringify({ [JSON.stringify({ url })]: { text: SECRET, keep: true } })
  database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('aichat.text', text)
  database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('workbench.settings', 'keep this')
  database.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composer.blob', Buffer.from(blob))
  database.close()
  try {
    const scan = run(['scan', '--source', 'cursor', '--json'], home)
    assert.equal(scan.status, 1)
    assert.equal(JSON.parse(scan.stdout).totalFindings, 3)
    assert.ok(!scan.stdout.includes(SECRET))
    const sweep = run(['sweep', '--source', 'cursor'], home)
    assert.equal(sweep.status, 1)
    const saved = new DatabaseSync(file, { readOnly: true })
    try {
      const a = saved.prepare('SELECT value, typeof(value) AS kind FROM ItemTable WHERE key = ?').get('aichat.text')
      const b = saved.prepare('SELECT value, typeof(value) AS kind FROM cursorDiskKV WHERE key = ?').get('composer.blob')
      assert.equal(a.kind, 'text')
      assert.equal(b.kind, 'blob')
      assert.equal(JSON.parse(a.value).keep, 7)
      const parsed = JSON.parse(Buffer.from(b.value).toString('utf8'))
      assert.equal(Object.keys(parsed).length, 1)
      assert.ok(JSON.parse(Object.keys(parsed)[0]).url.startsWith('«BROOM:db-url:'))
      assert.equal(Object.values(parsed)[0].keep, true)
      assert.ok(!Buffer.from(b.value).toString('utf8').includes(SECRET))
      assert.equal(saved.prepare('SELECT value FROM ItemTable WHERE key = ?').get('workbench.settings').value, 'keep this')
      assert.equal(Object.values(saved.prepare('PRAGMA quick_check').get())[0], 'ok')
    } finally {
      saved.close()
    }
    const backups = join(home, '.broom', 'backups')
    const stamp = readdirSync(backups)[0]
    const manifest = JSON.parse(readFileSync(join(backups, stamp, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 1)
    const backup = new DatabaseSync(manifest.files[0].backup, { readOnly: true })
    try {
      assert.equal(backup.prepare('SELECT value FROM ItemTable WHERE key = ?').get('aichat.text').value, text)
      assert.equal(Buffer.from(backup.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get('composer.blob').value).toString('utf8'), blob)
    } finally {
      backup.close()
    }
    const rescan = run(['scan', '--source', 'cursor', '--json'], home)
    assert.equal(rescan.status, 0)
    assert.equal(JSON.parse(rescan.stdout).totalFindings, 0)

    const invalid = Buffer.concat([Buffer.from(`history ${SECRET} `), Buffer.from([0xff, 0xc3, 0x28])])
    const writable = new DatabaseSync(file)
    writable.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composer.invalid', invalid)
    writable.close()
    const rejected = run(['sweep', '--source', 'cursor', '--no-fail', '--json'], home)
    assert.equal(rejected.status, 1)
    assert.match(rejected.stderr, /not valid UTF-8/)
    assert.ok(!rejected.stderr.includes(SECRET))
    const unchanged = new DatabaseSync(file, { readOnly: true })
    try {
      assert.deepEqual(Buffer.from(unchanged.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get('composer.invalid').value), invalid)
      assert.equal(Object.values(unchanged.prepare('PRAGMA quick_check').get())[0], 'ok')
    } finally {
      unchanged.close()
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('decoded allowlist values remain untouched while other secrets are cleaned', () => {
  const { home, file } = makeHome()
  const url = 'postgres://' + 'reader:Example123@database.example.invalid/app'
  const original = JSON.stringify({ text: `connect("${url}") key ${SECRET}` }) + '\n'
  const allowlist = join(home, 'allowlist.txt')
  writeFileSync(file, original)
  writeFileSync(allowlist, url + '\n')
  try {
    const result = run(['sweep', '--source', 'claude-code', '--allowlist', allowlist], home)
    assert.equal(result.status, 1)
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    assert.ok(parsed.text.includes(url))
    assert.ok(!parsed.text.includes(SECRET))
    const rescan = run(['scan', '--json', '--allowlist', allowlist], home)
    assert.equal(rescan.status, 0)
    assert.equal(JSON.parse(rescan.stdout).totalFindings, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('unsafe key collisions leave the transcript unchanged and create no backup', () => {
  const { home, file } = makeHome()
  const { text: placeholder } = redactText(SECRET, scanText(SECRET, RULES))
  const original = JSON.stringify({ [SECRET]: 1, [placeholder]: 2 }) + '\n'
  writeFileSync(file, original)
  try {
    const result = run(['sweep', '--source', 'claude-code', '--no-fail', '--json'], home)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /JSON structure|object entries/)
    assert.ok(!result.stderr.includes(SECRET))
    assert.equal(JSON.parse(result.stdout).files[0].applied, 0)
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.ok(!existsSync(join(home, '.broom', 'backups')))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('partial backup failures retain a manifest for successful files', () => {
  const { home, file } = makeHome()
  const first = join(home, '.claude', 'projects', 'demo', 'a.jsonl')
  const second = join(home, '.claude', 'projects', 'demo', 'b.jsonl')
  const original = JSON.stringify({ text: SECRET }) + '\n'
  writeFileSync(first, original)
  writeFileSync(second, original)
  rmSync(file)
  const backupDir = join(home, 'backups')
  const blockedDestination = join(backupDir, second.replace(/^[a-zA-Z]:/, '').replace(/^[\\/]+/, ''))
  mkdirSync(blockedDestination, { recursive: true })
  try {
    const result = run(['sweep', '--source', 'claude-code', '--backup-dir', backupDir, '--no-fail'], home)
    assert.equal(result.status, 1)
    assert.ok(!readFileSync(first, 'utf8').includes(SECRET))
    assert.equal(readFileSync(second, 'utf8'), original)
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 1)
    assert.equal(manifest.files[0].original, first)
    assert.equal(readFileSync(manifest.files[0].backup, 'utf8'), original)
    assert.equal(manifest.redactionSummary.find(row => row.label === second).applied, 0)
    // The failure is recorded, and the report names the file and where the
    // successful backup went.
    assert.equal(manifest.skipped.length, 1)
    assert.equal(manifest.skipped[0].original, second)
    assert.ok(!existsSync(join(backupDir, 'manifest.json.tmp')), 'manifest write must be atomic')
    assert.match(result.stdout, /Skipped 1 file/)
    assert.match(result.stdout, /Backups\s+.*1 file/)
    assert.ok(!result.stdout.includes(SECRET))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
