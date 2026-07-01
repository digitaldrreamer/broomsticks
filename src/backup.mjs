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

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

/**
 * A single backup session. Create one per `broom clean --apply` run.
 * Call backup(file) before every write; call writeManifest() when done.
 */
export class BackupSession {
  /**
   * @param {string} [backupDir]  Override the default ~/.broom/backups/<timestamp>
   */
  constructor(backupDir) {
    this.dir = backupDir ?? defaultBackupDir()
    /** @type {Set<string>} files already copied this session */
    this._copied = new Set()
    /** @type {Array<{original:string, backup:string}>} */
    this._entries = []
  }

  /**
   * Copy `file` into the backup directory if it hasn't been copied yet.
   * For SQLite databases, also copies -wal and -shm siblings if present.
   * Safe to call multiple times for the same file (idempotent).
   * @param {string} file  Absolute path to the file to back up.
   * @returns {string}  The backup path.
   */
  backup(file) {
    const abs = resolve(file)
    if (this._copied.has(abs)) {
      return this._destPath(abs)
    }

    const dest = this._destPath(abs)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(abs, dest)
    this._copied.add(abs)
    this._entries.push({ original: abs, backup: dest })

    // SQLite siblings — present for Cursor's .vscdb files
    for (const suffix of ['-wal', '-shm']) {
      const sib = abs + suffix
      try {
        const sibDest = dest + suffix
        copyFileSync(sib, sibDest)
      } catch {
        // sibling doesn't exist — that's fine
      }
    }

    return dest
  }

  /**
   * Write a manifest.json to the backup root summarising the session.
   * @param {Array<{target: import('./sources/claude-code.mjs').Target, applied: number}>} results
   */
  writeManifest(results) {
    if (this._entries.length === 0) return

    mkdirSync(this.dir, { recursive: true })

    const manifest = {
      timestamp: new Date().toISOString(),
      backupDir: this.dir,
      files: this._entries,
      redactionSummary: results.map(r => ({
        source: r.target.source,
        label:  r.target.label,
        applied: r.applied,
      })),
    }

    writeFileSync(join(this.dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  /** @param {string} abs  Absolute original path */
  _destPath(abs) {
    // Strip leading separator so we can join under the backup dir.
    // /home/alice/.claude/... → home/alice/.claude/...
    const relative = abs.startsWith(sep) ? abs.slice(sep.length) : abs
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
