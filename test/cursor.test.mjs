// Cursor adapter round-trip — regression guard for the read-only write bug:
// write() must persist a redacted value back into the SQLite row (previously it
// opened the DB readOnly:true and every UPDATE threw "readonly database").

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { cursorUserRoot, discoverTargets } from '../src/sources/cursor.mjs'
import { RULES } from '../src/rules.mjs'
import { scanText } from '../src/detector.mjs'
import { redactText } from '../src/redactor.mjs'

const SECRET = 'ghp_1234567890abcdefABCDEF1234567890abcd'

test('cursor target read → redact → write persists the redaction', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'broom-cursor-'))
  const prevHome = process.env.HOME
  process.env.HOME = home

  try {
    const root = cursorUserRoot()
    // Only meaningful if os.homedir() honors our $HOME override on this platform.
    if (!root.startsWith(home) && !root.startsWith(homedir())) {
      return t.skip('cursorUserRoot() not redirectable via $HOME on this platform')
    }
    // If homedir() ignored $HOME entirely, bail rather than touch a real profile.
    if (!root.startsWith(home)) return t.skip('os.homedir() does not honor $HOME here')

    const storage = join(root, 'globalStorage')
    mkdirSync(storage, { recursive: true })
    const dbPath = join(storage, 'state.vscdb')

    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
      .run('aichat.conversations', `history: ${SECRET} end`)
    db.close()

    const targets = discoverTargets()
    assert.equal(targets.length, 1, 'exactly one AI row should be discovered')
    const target = targets[0]
    assert.equal(target.source, 'cursor')

    const text = target.read()
    assert.ok(text.includes(SECRET))

    const { text: redacted, applied } = redactText(text, scanText(text, RULES))
    assert.equal(applied, 1)

    target.write(redacted) // must not throw (readonly bug) and must persist

    const after = target.read()
    assert.ok(!after.includes(SECRET), 'secret must be gone from the DB row')
    assert.ok(after.includes('«BROOM:github-pat:'), 'placeholder must be persisted')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

// Regression guard for the OOM: discovery must not bulk-load row values. A big
// non-AI blob (Cursor stores embeddings/caches this way) sitting next to a small
// AI row must be ignored by discovery — previously `SELECT key, value FROM …`
// pulled every blob into memory at once and crashed on large databases.
test('cursor discovery ignores large non-AI blobs and reads values lazily', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'broom-cursor-oom-'))
  const prevHome = process.env.HOME
  process.env.HOME = home

  try {
    const root = cursorUserRoot()
    if (!root.startsWith(home)) return t.skip('os.homedir() does not honor $HOME here')

    const storage = join(root, 'globalStorage')
    mkdirSync(storage, { recursive: true })
    const dbPath = join(storage, 'state.vscdb')

    const bigBlob = 'x'.repeat(8 * 1024 * 1024) // 8 MB non-AI value

    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    ins.run('workbench.embeddings.cache', bigBlob)      // non-AI: must be skipped
    ins.run('history.entries', bigBlob)                 // non-AI: must be skipped
    ins.run('composer.chat', `msg ${SECRET} msg`)       // AI: must be discovered
    db.close()

    const targets = discoverTargets()
    assert.equal(targets.length, 1, 'only the AI row is discovered, not the blobs')
    assert.equal(targets[0].label.endsWith(':composer.chat'), true)
    assert.ok(targets[0].read().includes(SECRET), 'value is fetched lazily on read')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('cursor writes preserve TEXT and BLOB storage and unrelated rows', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'broom-cursor-types-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const root = cursorUserRoot()
    if (!root.startsWith(home)) return t.skip('os.homedir() does not honor HOME here')
    const storage = join(root, 'globalStorage')
    mkdirSync(storage, { recursive: true })
    const dbPath = join(storage, 'state.vscdb')
    const original = JSON.stringify({ text: `😀 ${SECRET}`, keep: 2 })
    const database = new DatabaseSync(dbPath)
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    const insert = database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)')
    insert.run('aichat.text', original)
    insert.run('composer.blob', Buffer.from(original, 'utf8'))
    insert.run('workbench.settings', Buffer.from('keep these bytes'))
    database.close()

    const targets = discoverTargets()
    assert.equal(targets.length, 2)
    for (const target of targets) {
      const text = target.read()
      target.write(redactText(text, scanText(text, RULES)).text)
    }

    const saved = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const rows = saved.prepare('SELECT key, value, typeof(value) AS kind FROM ItemTable ORDER BY key').all()
      assert.equal(rows[0].kind, 'text')
      assert.equal(rows[1].kind, 'blob')
      for (const row of rows.slice(0, 2)) {
        const text = typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8')
        const parsed = JSON.parse(text)
        assert.equal(parsed.keep, 2)
        assert.ok(parsed.text.startsWith('😀 «BROOM:github-pat:'))
        assert.equal(scanText(text, RULES).length, 0)
      }
      assert.deepEqual(Buffer.from(rows[2].value), Buffer.from('keep these bytes'))
      assert.equal(Object.values(saved.prepare('PRAGMA quick_check').get())[0], 'ok')
    } finally {
      saved.close()
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('cursor writes fail if a discovered row disappears', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'broom-cursor-missing-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const root = cursorUserRoot()
    if (!root.startsWith(home)) return t.skip('os.homedir() does not honor HOME here')
    const storage = join(root, 'globalStorage')
    mkdirSync(storage, { recursive: true })
    const database = new DatabaseSync(join(storage, 'state.vscdb'))
    database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
    database.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('composer.chat', SECRET)
    const [target] = discoverTargets()
    database.exec('DELETE FROM ItemTable')
    database.close()
    assert.throws(() => target.write('redacted'), /no longer exists/)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('cursor rejects invalid UTF-8 BLOBs without changing their bytes', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'broom-cursor-utf8-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const root = cursorUserRoot()
    if (!root.startsWith(home)) return t.skip('os.homedir() does not honor HOME here')
    const storage = join(root, 'globalStorage')
    mkdirSync(storage, { recursive: true })
    const database = new DatabaseSync(join(storage, 'state.vscdb'))
    try {
      database.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')
      const original = Buffer.concat([Buffer.from(`before ${SECRET} after `), Buffer.from([0xff, 0xc3, 0x28])])
      database.prepare('INSERT INTO ItemTable VALUES (?, ?)').run('composer.chat', original)
      const [target] = discoverTargets()
      assert.throws(() => target.read(), /UTF-8/)
      assert.deepEqual(Buffer.from(database.prepare('SELECT value FROM ItemTable').get().value), original)
    } finally {
      database.close()
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
