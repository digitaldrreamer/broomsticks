// Backup module — copies files before any write and records a manifest.
//
// Backup layout:
//   ~/.broom/backups/<ISO-timestamp>/
//     manifest.json
//     <original-absolute-path-recreated-under-backup-root>
//
// Example:
//   ~/.broom/backups/2024-01-15T10-30-00Z/
//     home/alice/.claude/projects/myapp/abc123.jsonl
//     manifest.json
//
// Safety properties:
//   - free space is checked before every copy, so a nearly full disk produces a
//     clear per-file error instead of an unhandled ENOSPC crash;
//   - manifest.json is rewritten after each file, so a run that dies part-way
//     still records the backups that were made;
//   - a file that cannot be backed up raises a BackupError and is never
//     written by the caller — the original is left untouched.

import {
  copyFileSync, existsSync, mkdirSync, renameSync, statSync, statfsSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { formatBytes } from './ui.mjs'

/** Headroom reserved for the backup directory itself and the manifest write. */
const SPACE_MARGIN = 64 * 1024

/** SQLite sidecar files that must travel with a database backup. */
const SQLITE_SIBLINGS = ['-wal', '-shm']

/**
 * A backup could not be made. `code` carries the underlying filesystem error
 * code (`ENOSPC`, `EACCES`, …) when there is one, so callers can react to the
 * cause without parsing the message.
 */
export class BackupError extends Error {
  /**
   * @param {string} message  Human-readable, safe to print.
   * @param {{ code?: string, cause?: unknown }} [options]
   */
  constructor(message, { code = 'EBACKUP', cause } = {}) {
    super(message, { cause })
    this.name = 'BackupError'
    this.code = code
  }
}

/**
 * A single backup session. Create one per `broom clean --apply` run.
 * Call backup(file) before every write; call writeManifest() when done.
 */
export class BackupSession {
  /**
   * @param {string} [backupDir]  Override the default ~/.broom/backups/<timestamp>
   * @param {{ statfs?: typeof statfsSync }} [options]  Injectable for tests.
   */
  constructor(backupDir, options = {}) {
    this.dir = backupDir ?? defaultBackupDir()
    /** Session start, kept stable across incremental manifest writes. */
    this.startedAt = new Date().toISOString()
    this._statfs = options.statfs ?? statfsSync
    /** @type {Set<string>} files already copied this session */
    this._copied = new Set()
    /** @type {Map<string, BackupError>} files that failed, to avoid retrying */
    this._failed = new Map()
    /** @type {Array<{original:string, backup:string, bytes:number}>} */
    this._entries = []
    /** @type {Array<{original:string, reason:string}>} */
    this._skipped = []
    /** @type {Array<{source:string, label:string, applied:number}>} */
    this._summary = []
    this._bytes = 0
  }

  /**
   * Copy `file` into the backup directory if it hasn't been copied yet.
   * For SQLite databases, also copies -wal and -shm siblings if present.
   * Safe to call multiple times for the same file (idempotent).
   *
   * @param {string} file  Absolute path to the file to back up.
   * @returns {string}  The backup path.
   * @throws {BackupError}  When free space is insufficient or the copy fails.
   *   The caller must not write the original in that case.
   */
  backup(file) {
    const abs = resolve(file)
    if (this._copied.has(abs)) {
      return this._destPath(abs)
    }
    // Cursor stores a whole chat database in one file; every row targets the
    // same file, so a failure must not be retried (and re-reported) per row.
    if (this._failed.has(abs)) {
      throw this._failed.get(abs)
    }

    const dest = this._destPath(abs)
    const { bytes, siblings } = this._measure(abs)

    this._ensureSpace(abs, bytes)

    try {
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(abs, dest)
      for (const suffix of siblings) {
        copyFileSync(abs + suffix, dest + suffix)
      }
    } catch (err) {
      this._fail(abs, describeCopyError(err), { code: err.code ?? 'EBACKUP', cause: err })
    }

    this._copied.add(abs)
    this._bytes += bytes
    this._entries.push({ original: abs, backup: dest, bytes })
    // Flush now, not only at the end: a crash or Ctrl-C mid-run must still
    // leave a manifest describing the backups that were actually made.
    this._persistManifest()

    return dest
  }

  /**
   * Write a manifest.json to the backup root summarising the session.
   * Called once at the end of a run; each backup() already writes an interim
   * manifest, so a partial run stays auditable either way.
   * @param {Array<{target: import('./sources/claude-code.mjs').Target, applied: number}>} results
   */
  writeManifest(results) {
    this._summary = results.map(r => ({
      source: r.target.source,
      label:  r.target.label,
      applied: r.applied,
    }))
    this._persistManifest(true)
  }

  /**
   * Describe what was written, for the end-of-run report.
   * @returns {{ dir: string, files: number, bytes: number,
   *            skipped: Array<{original:string, reason:string}> }}
   */
  summary() {
    return {
      dir: this.dir,
      files: this._entries.length,
      bytes: this._bytes,
      skipped: [...this._skipped],
    }
  }

  /**
   * Size the file plus any SQLite sidecars so the free-space check accounts for
   * everything that is about to be copied.
   * @param {string} abs
   * @returns {{ bytes: number, siblings: string[] }}
   */
  _measure(abs) {
    let bytes
    try {
      bytes = statSync(abs).size
    } catch (err) {
      this._fail(abs, `cannot read file: ${err.message}`, { code: err.code ?? 'EBACKUP', cause: err })
    }

    const siblings = []
    for (const suffix of SQLITE_SIBLINGS) {
      try {
        const stat = statSync(abs + suffix)
        if (stat.isFile()) {
          siblings.push(suffix)
          bytes += stat.size
        }
      } catch {
        // Sidecar doesn't exist — nothing to copy.
      }
    }
    return { bytes, siblings }
  }

  /**
   * Fail early with a friendly message instead of letting copyFileSync die with
   * a raw ENOSPC after the disk is already full. If the filesystem can't report
   * free space, the check is skipped and the copy itself decides.
   * @param {string} abs
   * @param {number} bytes
   */
  _ensureSpace(abs, bytes) {
    const dir = nearestExistingDir(this.dir)

    let stats
    try {
      stats = this._statfs(dir)
    } catch {
      return // statfs unsupported here — don't block a working backup
    }

    const blockSize = Number(stats?.frsize ?? stats?.bsize ?? 0)
    const available = Number(stats?.bavail ?? stats?.bfree ?? 0) * blockSize
    // A filesystem that reports nothing useful (0 blocks free on some network
    // mounts) is treated as unknown — the copy itself will report the truth.
    if (!Number.isFinite(available) || available <= 0 || blockSize <= 0) return

    const needed = bytes + SPACE_MARGIN
    if (available >= needed) return

    const reason = `not enough disk space: needs ${formatBytes(needed)}, ` +
      `only ${formatBytes(available)} free in ${dir}`
    this._fail(abs, reason, { code: 'ENOSPC' })
  }

  /**
   * Record a backup failure once, cache it, and throw it. Never returns, so it
   * can be used in place of `throw`. Repeated targets that share a file (one
   * Cursor database backs up many chat rows) get the same error without a
   * duplicate entry in `skipped`.
   * @param {string} abs
   * @param {string} reason
   * @param {{ code?: string, cause?: unknown }} options
   */
  _fail(abs, reason, options) {
    let err = this._failed.get(abs)
    if (!err) {
      err = new BackupError(reason, options)
      this._failed.set(abs, err)
      this._skip(abs, reason)
    }
    throw err
  }

  /** Record a file that was not backed up (and therefore must not be written). */
  _skip(abs, reason) {
    this._skipped.push({ original: abs, reason })
    this._persistManifest()
  }

  /**
   * Serialise the manifest, atomically replacing the previous one.
   * @param {boolean} [strict]  Rethrow write errors (final call only).
   */
  _persistManifest(strict = false) {
    // Nothing was saved, so there is nothing to record.
    if (this._entries.length === 0) return

    const manifest = {
      timestamp: this.startedAt,
      backupDir: this.dir,
      files: this._entries,
      skipped: this._skipped,
      redactionSummary: this._summary,
    }

    try {
      mkdirSync(this.dir, { recursive: true })
      const target = join(this.dir, 'manifest.json')
      const tmp    = `${target}.tmp`
      writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
      renameSync(tmp, target)
    } catch (err) {
      // Interim flushes are best-effort; the final write reports failures.
      if (strict) throw err
    }
  }

  /** @param {string} abs  Absolute original path */
  _destPath(abs) {
    // Strip the leading separator (POSIX) or drive letter + separators
    // (Windows) so we can join under the backup dir. A retained `C:` would
    // otherwise produce an invalid mid-path colon and fail with EINVAL/ENOENT.
    //   /home/alice/.claude/...  → home/alice/.claude/...
    //   C:\Users\alice\...       → Users\alice\...
    const relative = abs.replace(/^[a-zA-Z]:/, '').replace(/^[\\/]+/, '')
    return join(this.dir, relative)
  }
}

/**
 * Default backup directory: ~/.broom/backups/<ISO-timestamp with colons replaced>
 * @returns {string}
 */
function defaultBackupDir() {
  // Replace colons so the path is valid on Windows and unambiguous in shells.
  const stamp = new Date().toISOString().replace(/:/g, '-')
  return join(homedir(), '.broom', 'backups', stamp)
}

/**
 * Walk up from `dir` until an existing directory is found — the backup folder
 * itself usually doesn't exist yet, but free space must be measured on the disk
 * it will land on.
 * @param {string} dir
 * @returns {string}
 */
function nearestExistingDir(dir) {
  let current = resolve(dir)
  for (;;) {
    if (existsSync(current)) return current
    const parent = dirname(current)
    if (parent === current) return resolve('.')
    current = parent
  }
}

/**
 * Turn a copy failure into a message that is useful at the CLI. Node's raw
 * message repeats both absolute paths, which the caller already prints, so only
 * the reason is kept; the original error rides along as `cause`.
 * @param {NodeJS.ErrnoException} err
 * @returns {string}
 */
function describeCopyError(err) {
  switch (err.code) {
    case 'ENOSPC': return 'not enough disk space to write the backup'
    case 'EDQUOT': return 'disk quota exceeded while writing the backup'
    case 'EACCES':
    case 'EPERM':  return 'permission denied while writing the backup'
    default:       return `backup failed: ${err.message.split(', ')[0]}`
  }
}
