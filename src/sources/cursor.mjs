// Source adapter for Cursor AI editor transcripts.
//
// Cursor stores conversation state in SQLite databases:
//   Linux:   ~/.config/Cursor/User/{globalStorage,workspaceStorage/**/}state.vscdb
//   macOS:   ~/Library/Application Support/Cursor/User/{...}/state.vscdb
//   Windows: %APPDATA%\Cursor\User\{...}\state.vscdb
//
// Each database has two tables we care about:
//   ItemTable    — main VS Code key-value store
//   cursorDiskKV — Cursor-specific overflow store
//
// We scan rows whose key matches /chat|composer|aiService|aichat|prompt|cursorai/i
// and return one Target per row (keyed on table+key so writes hit the right row).
// The `.file` property points to the .vscdb so it gets backed up once per DB.

import { readdirSync, existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Keys matching this pattern carry AI conversation content worth scanning. */
const AI_KEY_RE = /chat|composer|aiService|aichat|prompt|cursorai/i

/** Tables present in Cursor's state.vscdb */
const TABLES = ['ItemTable', 'cursorDiskKV']

/**
 * OS-specific root for Cursor's User data directory.
 * @returns {string}
 */
export function cursorUserRoot() {
  const p = platform()
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Cursor', 'User')
  }
  if (p === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cursor', 'User')
  }
  // Linux / other
  return join(homedir(), '.config', 'Cursor', 'User')
}

/**
 * Recursively yield every state.vscdb file under a directory.
 * @param {string} dir
 * @returns {Generator<string>}
 */
function* walkVscdb(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkVscdb(full)
    else if (entry.isFile() && entry.name === 'state.vscdb') yield full
  }
}

/**
 * Open a SQLite database read-only and return the AI-related (table, key) pairs
 * from the known tables. Returns [] if the DB is unreadable or has no matching
 * tables.
 *
 * Only the `key` column is selected here — never `value`. Cursor's tables can
 * hold gigabytes of blobs (embeddings, file caches), so `SELECT key, value …`
 * across a whole table loads every blob into memory at once and OOMs the
 * process. Each row's value is fetched lazily, one at a time, in the Target's
 * `read()`, so discovery only needs the (small) keys.
 *
 * @param {string} dbPath
 * @returns {Array<{table:string, key:string}>}
 */
function readAiKeys(dbPath) {
  let db
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  } catch {
    return []
  }

  const keys = []

  // Check which tables actually exist before querying
  let existingTables
  try {
    existingTables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map(r => r.name)
    )
  } catch {
    db.close()
    return []
  }

  for (const table of TABLES) {
    if (!existingTables.has(table)) continue
    try {
      // key-only projection, streamed via iterate() so we never materialise the
      // full key array either (values are never loaded in bulk — see above)
      for (const row of db.prepare(`SELECT key FROM [${table}]`).iterate()) {
        if (typeof row.key === 'string' && AI_KEY_RE.test(row.key)) {
          keys.push({ table, key: row.key })
        }
      }
    } catch {
      // table unreadable — skip
    }
  }

  db.close()
  return keys
}

/**
 * Discover all Cursor AI conversation rows and return them as Targets.
 * One Target per DB row; multiple Targets may share the same `.file`.
 * Returns [] if Cursor is not installed or has no conversation history.
 *
 * @returns {import('./claude-code.mjs').Target[]}
 */
export function discoverTargets() {
  const userRoot = cursorUserRoot()
  const targets  = []

  for (const dbPath of walkVscdb(userRoot)) {
    for (const { table, key } of readAiKeys(dbPath)) {
      // Capture loop vars in closure-safe consts
      const db   = dbPath
      const tbl  = table
      const k    = key

      targets.push({
        source: 'cursor',
        label:  `${db}:${tbl}:${k}`,
        file:   db,   // backup module copies the .vscdb file (once per file)

        read() {
          // Re-open DB on each read so we always get the current value
          const conn = new DatabaseSync(db, { open: true, readOnly: true })
          try {
            const row = conn.prepare(`SELECT value FROM [${tbl}] WHERE key = ?`).get(k)
            if (!row) return ''
            return Buffer.isBuffer(row.value) ? row.value.toString('utf8') : String(row.value ?? '')
          } finally {
            conn.close()
          }
        },

        write(text) {
          // Read-write handle — an UPDATE against a readOnly connection throws
          // "attempt to write a readonly database".
          const conn = new DatabaseSync(db, { open: true, readOnly: false })
          try {
            conn.prepare(`UPDATE [${tbl}] SET value = ? WHERE key = ?`).run(text, k)
          } finally {
            conn.close()
          }
        },
      })
    }
  }

  return targets
}
