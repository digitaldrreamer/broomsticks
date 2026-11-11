// Backup integrity: a backup exists and byte-matches the original before any
// write, the manifest records entries, and paths flatten safely (incl. Windows
// drive letters — regression for the mid-path colon bug).
//
// Also covers the issue #8 regressions: a nearly-full disk fails that one file
// with a clear BackupError instead of an unhandled ENOSPC, every file is
// flushed to the manifest as it is copied, and a failed copy is recorded
// without disturbing the backups already made.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { BackupSession, BackupError } from '../src/backup.mjs'

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

test('refuses to copy when the destination disk is too full to hold the backup', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-full-'))
  try {
    const original = join(tmp, 'session.jsonl')
    writeFileSync(original, 'x'.repeat(64 * 1024))

    const backupDir = join(tmp, 'backups')
    let checked
    const session = new BackupSession(backupDir, {
      // 4 blocks of 4 KiB = 16 KiB free, far below the 64 KiB file + headroom.
      statfs: dir => { checked = dir; return { bsize: 4096, frsize: 4096, bavail: 4, blocks: 1000 } },
    })

    assert.throws(() => session.backup(original), err => {
      assert.ok(err instanceof BackupError, 'must raise a typed backup error')
      assert.equal(err.code, 'ENOSPC')
      assert.match(err.message, /not enough disk space/)
      assert.match(err.message, /free in /)
      return true
    })

    assert.equal(checked, tmp, 'free space is measured on the nearest existing directory')
    assert.ok(!existsSync(backupDir), 'no backup directory is created when the copy is refused')
    const summary = session.summary()
    assert.equal(summary.files, 0)
    assert.equal(summary.skipped.length, 1)
    assert.equal(summary.skipped[0].original, original)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('copies normally when the destination disk has room', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-room-'))
  try {
    const original = join(tmp, 'session.jsonl')
    writeFileSync(original, '{"text":"hi"}\n')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir, {
      statfs: () => ({ bsize: 4096, frsize: 4096, bavail: 1024 * 1024, blocks: 2 * 1024 * 1024 }), // 4 GiB
    })
    const dest = session.backup(original)

    assert.ok(existsSync(dest))
    assert.equal(readFileSync(dest, 'utf8'), '{"text":"hi"}\n')
    assert.equal(session.summary().files, 1)
    assert.ok(session.summary().bytes > 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a genuinely full filesystem fails fast instead of attempting the copy', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-zero-'))
  try {
    const original = join(tmp, 'session.jsonl')
    writeFileSync(original, 'x'.repeat(4096))

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir, {
      // Full disk: no free blocks, but the mount does report its capacity.
      statfs: () => ({ bsize: 4096, frsize: 4096, bavail: 0, bfree: 0, blocks: 1000 }),
    })

    assert.throws(() => session.backup(original), err => {
      assert.ok(err instanceof BackupError)
      assert.equal(err.code, 'ENOSPC')
      assert.match(err.message, /0 B free/)
      return true
    })

    assert.ok(!existsSync(backupDir), 'nothing is written when the disk is full')
    assert.equal(session.summary().skipped.length, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a filesystem that reports no capacity is treated as unknown, not full', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-unknown-'))
  try {
    const original = join(tmp, 'session.jsonl')
    writeFileSync(original, '{"text":"hi"}\n')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir, {
      // No block count at all (some network mounts) — the copy itself decides.
      statfs: () => ({ bsize: 4096, frsize: 4096, bavail: 0 }),
    })
    const dest = session.backup(original)

    assert.ok(existsSync(dest))
    assert.equal(readFileSync(dest, 'utf8'), '{"text":"hi"}\n')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a failed manifest commit refuses the backup and removes its new files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-tmp-'))
  try {
    const original = join(tmp, 'session.jsonl')
    writeFileSync(original, 'x')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    // Block the atomic rename: a directory sits where manifest.json must go.
    mkdirSync(join(backupDir, 'manifest.json'), { recursive: true })
    const tmpManifest = join(backupDir, 'manifest.json.tmp')

    assert.throws(() => session.backup(original), BackupError)
    assert.ok(!existsSync(tmpManifest), 'no temp file after a failed manifest commit')
    assert.ok(!existsSync(session._destPath(original)), 'an unrecorded copy must be removed')
    assert.equal(readFileSync(original, 'utf8'), 'x', 'the original must remain unchanged')
    assert.equal(session.summary().files, 0)
    assert.equal(session.summary().bytes, 0)
    assert.equal(session.summary().skipped.length, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a failed final manifest write removes its temporary file and preserves backups', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-final-'))
  try {
    const original = join(tmp, 'session.jsonl')
    writeFileSync(original, 'saved original')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    const dest = session.backup(original)
    const manifestPath = join(backupDir, 'manifest.json')
    rmSync(manifestPath)
    mkdirSync(manifestPath)

    assert.throws(
      () => session.writeManifest([{ target: { source: 'claude-code', label: original }, applied: 1 }]),
      'the final write must still report the failure',
    )
    assert.ok(!existsSync(join(backupDir, 'manifest.json.tmp')), 'no temp file after a failed strict write')
    assert.equal(readFileSync(dest, 'utf8'), 'saved original')
    assert.equal(session.summary().files, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('SQLite -wal and -shm siblings are backed up with the database', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-sqlite-'))
  try {
    const db = join(tmp, 'state.vscdb')
    writeFileSync(db, 'main-db')
    writeFileSync(db + '-wal', 'write-ahead-log')
    writeFileSync(db + '-shm', 'shared-memory')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    const dest = session.backup(db)

    assert.equal(readFileSync(dest, 'utf8'), 'main-db')
    assert.equal(readFileSync(dest + '-wal', 'utf8'), 'write-ahead-log')
    assert.equal(readFileSync(dest + '-shm', 'utf8'), 'shared-memory')
    // The size accounting covers the sidecars, not just the main file.
    assert.equal(session.summary().bytes, Buffer.byteLength('main-dbwrite-ahead-logshared-memory'))
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a late SQLite copy failure removes partial copies and preserves earlier backups', t => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-sidecar-full-'))
  let copyMock
  try {
    const good = join(tmp, 'good.jsonl')
    const db = join(tmp, 'state.vscdb')
    writeFileSync(good, 'saved original')
    writeFileSync(db, 'main-db')
    writeFileSync(db + '-wal', 'write-ahead-log')
    writeFileSync(db + '-shm', 'shared-memory')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    const goodDest = session.backup(good)
    const copy = fs.copyFileSync
    const copied = []
    const destinations = []
    copyMock = t.mock.method(fs, 'copyFileSync', (source, dest, ...args) => {
      destinations.push(dest)
      if (source === db + '-shm') {
        // The main database and WAL have already copied; the final copy runs
        // out of space after writing a partial file of its own.
        writeFileSync(dest, 'partial')
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
      copy(source, dest, ...args)
      copied.push(source)
    })
    syncBuiltinESMExports()

    assert.throws(() => session.backup(db), err => {
      assert.ok(err instanceof BackupError)
      assert.equal(err.code, 'ENOSPC')
      return true
    })
    assert.deepEqual(copied, [db, db + '-wal'])
    for (const dest of destinations) {
      assert.ok(!existsSync(dest), 'every file created by the failed copy must be removed')
    }
    assert.ok(!existsSync(session._destPath(db)))
    assert.ok(!existsSync(session._destPath(db) + '-wal'))
    assert.ok(!existsSync(session._destPath(db) + '-shm'))
    assert.equal(readFileSync(goodDest, 'utf8'), 'saved original')
    assert.equal(readFileSync(db, 'utf8'), 'main-db')
    assert.equal(readFileSync(db + '-wal', 'utf8'), 'write-ahead-log')
    assert.equal(readFileSync(db + '-shm', 'utf8'), 'shared-memory')
    assert.equal(session.summary().files, 1)
    assert.equal(session.summary().bytes, Buffer.byteLength('saved original'))
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.deepEqual(manifest.files.map(file => file.original), [good])
    assert.equal(manifest.skipped[0].original, db)
  } finally {
    if (copyMock) {
      copyMock.mock.restore()
      syncBuiltinESMExports()
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a later sidecar failure preserves pre-existing destination files and directories', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-existing-'))
  try {
    const db = join(tmp, 'state.vscdb')
    writeFileSync(db, 'new main-db')
    writeFileSync(db + '-wal', 'new write-ahead-log')
    writeFileSync(db + '-shm', 'new shared-memory')

    const session = new BackupSession(join(tmp, 'backups'))
    const dest = session._destPath(db)
    mkdirSync(dest + '-shm', { recursive: true })
    writeFileSync(dest, 'previous main-db backup')
    writeFileSync(dest + '-wal', 'previous WAL backup')
    writeFileSync(join(dest + '-shm', 'keep.txt'), 'existing directory content')

    assert.throws(() => session.backup(db), BackupError)
    assert.equal(readFileSync(dest, 'utf8'), 'previous main-db backup')
    assert.equal(readFileSync(dest + '-wal', 'utf8'), 'previous WAL backup')
    assert.equal(readFileSync(join(dest + '-shm', 'keep.txt'), 'utf8'), 'existing directory content')
    assert.equal(session.summary().files, 0)
    assert.equal(session.summary().bytes, 0)
    assert.equal(session.summary().skipped.length, 1)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a failed manifest commit restores previous backup bytes after publishing new copies', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-manifest-restore-'))
  try {
    const db = join(tmp, 'state.vscdb')
    writeFileSync(db, 'new main-db')
    writeFileSync(db + '-wal', 'new write-ahead-log')
    writeFileSync(db + '-shm', 'new shared-memory')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    const dest = session._destPath(db)
    mkdirSync(join(backupDir, 'manifest.json'), { recursive: true })
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, 'previous main-db backup')
    writeFileSync(dest + '-wal', 'previous WAL backup')

    assert.throws(() => session.backup(db), BackupError)
    assert.equal(readFileSync(dest, 'utf8'), 'previous main-db backup')
    assert.equal(readFileSync(dest + '-wal', 'utf8'), 'previous WAL backup')
    assert.ok(!existsSync(dest + '-shm'), 'the newly created sidecar must be removed')
    assert.ok(!existsSync(join(backupDir, 'manifest.json.tmp')))
    assert.equal(session.summary().files, 0)
    assert.equal(session.summary().bytes, 0)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a manifest-failed database stays blocked while another file can succeed after recovery', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-manifest-recovery-'))
  try {
    const first = join(tmp, 'first.jsonl')
    const db = join(tmp, 'state.vscdb')
    const next = join(tmp, 'next.jsonl')
    writeFileSync(first, 'first original')
    writeFileSync(db, 'database original')
    writeFileSync(next, 'next original')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    const firstDest = session.backup(first)
    const manifestPath = join(backupDir, 'manifest.json')
    const savedManifest = readFileSync(manifestPath, 'utf8')
    const blockedTemp = join(backupDir, 'manifest.json.tmp')
    mkdirSync(blockedTemp)

    let failure
    assert.throws(() => session.backup(db), err => {
      assert.ok(err instanceof BackupError)
      failure = err
      return true
    })
    assert.equal(readFileSync(manifestPath, 'utf8'), savedManifest, 'the previous manifest must stay intact')
    assert.equal(readFileSync(firstDest, 'utf8'), 'first original')
    assert.ok(!existsSync(session._destPath(db)))
    assert.equal(session.summary().files, 1)
    assert.equal(session.summary().bytes, Buffer.byteLength('first original'))

    rmSync(blockedTemp, { recursive: true })
    assert.throws(() => session.backup(db), err => err === failure,
      'another Cursor row must receive the cached failure even after the obstruction is removed')
    assert.equal(session.summary().skipped.length, 1)
    assert.ok(!existsSync(session._destPath(db)))

    const nextDest = session.backup(next)
    assert.equal(readFileSync(nextDest, 'utf8'), 'next original')
    assert.equal(session.summary().files, 2)
    assert.equal(session.summary().bytes, Buffer.byteLength('first originalnext original'))
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.deepEqual(manifest.files.map(file => file.original), [first, next])
    assert.equal(manifest.skipped.length, 1)
    assert.equal(manifest.skipped[0].original, db)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('manifest is flushed as each file is copied, so a crash mid-run stays auditable', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-flush-'))
  try {
    const first  = join(tmp, 'a.jsonl')
    const second = join(tmp, 'b.jsonl')
    writeFileSync(first, 'a')
    writeFileSync(second, 'b')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)

    // Deliberately no writeManifest(): this simulates a run killed part-way.
    session.backup(first)
    let manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 1)
    assert.equal(manifest.files[0].original, first)

    session.backup(second)
    manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 2)
    assert.equal(manifest.files[1].original, second)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a file that already failed is not retried or recorded twice', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-retry-'))
  try {
    const db = join(tmp, 'state.vscdb')
    writeFileSync(db, 'db')

    const session = new BackupSession(join(tmp, 'backups'))
    // Every Cursor chat row points at the same database; a directory where the
    // backup file should go makes the copy fail for all of them.
    mkdirSync(session._destPath(db), { recursive: true })

    assert.throws(() => session.backup(db), BackupError)
    assert.throws(() => session.backup(db), BackupError)

    assert.equal(session.summary().skipped.length, 1, 'the failure is recorded once')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('a failed copy is recorded as skipped without losing the backups already made', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'broom-backup-partial-'))
  try {
    const good = join(tmp, 'a.jsonl')
    const bad  = join(tmp, 'b.jsonl')
    writeFileSync(good, 'good')
    writeFileSync(bad, 'bad')

    const backupDir = join(tmp, 'backups')
    const session = new BackupSession(backupDir)
    session.backup(good)

    // A directory sitting where the backup file must go makes the copy fail.
    const blocked = session._destPath(bad)
    mkdirSync(blocked, { recursive: true })

    assert.throws(() => session.backup(bad), err => {
      assert.ok(err instanceof BackupError)
      assert.match(err.message, /backup (failed|denied)|permission denied/)
      return true
    })

    session.writeManifest([
      { target: { source: 'claude-code', label: good }, applied: 1 },
      { target: { source: 'claude-code', label: bad  }, applied: 0 },
    ])

    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 1, 'only the successful file is listed')
    assert.equal(manifest.files[0].original, good)
    assert.equal(manifest.skipped.length, 1)
    assert.equal(manifest.skipped[0].original, bad)
    assert.match(manifest.skipped[0].reason, /backup (failed|denied)|permission denied/)
    assert.ok(!existsSync(join(backupDir, 'manifest.json.tmp')), 'manifest write must be atomic')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
