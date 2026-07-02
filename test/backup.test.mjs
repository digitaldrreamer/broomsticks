// Backup integrity: a backup exists and byte-matches the original before any
// write, the manifest records entries, and paths flatten safely (incl. Windows
// drive letters — regression for the mid-path colon bug).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackupSession } from '../src/backup.mjs'

test('backup copies the file byte-for-byte and records a manifest', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-'))
  try {
    const original = join(tmp, 'transcript.jsonl')
    const content = '{"text":"secret ghp_xxx"}\n'
    writeFileSync(original, content, 'utf8')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    const dest = session.backup(original)

    assert.ok(existsSync(dest), 'backup file must exist')
    assert.equal(readFileSync(dest, 'utf8'), content, 'backup must byte-match original')

    // Second call for the same file is a no-op (idempotent per session).
    const dest2 = session.backup(original)
    assert.equal(dest, dest2)

    session.writeManifest([
      { target: { source: 'claude-code', label: original }, applied: 1 },
    ])
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 1)
    assert.equal(manifest.files[0].original, original)
    assert.equal(manifest.redactionSummary[0].applied, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('_destPath strips leading separators and Windows drive letters', () => {
  const s = new BackupSession('/backups/ts')
  assert.equal(s._destPath('/home/alice/x.jsonl'), join('/backups/ts', 'home/alice/x.jsonl'))
  // No mid-path colon should survive from a C:\ style absolute path.
  const win = s._destPath('C:\\Users\\alice\\x.jsonl')
  assert.ok(!win.slice(2).includes(':'), 'no drive-letter colon should remain in the joined path')
})
