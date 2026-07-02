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
