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
 * Open a SQLite database read-only and return all AI-related rows from the
 * known tables. Returns [] if the DB is unreadable or has no matching tables.
 *
 * @param {string} dbPath
 * @returns {Array<{table:string, key:string, value:string}>}
 */
function readAiRows(dbPath) {
  let db
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true })
  } catch {
    return []
  }

  const rows = []

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
      const all = db.prepare(`SELECT key, value FROM [${table}]`).all()
      for (const row of all) {
        if (typeof row.key === 'string' && AI_KEY_RE.test(row.key)) {
          // value may be stored as Buffer (BLOB) or string — normalise to string
          const value = Buffer.isBuffer(row.value)
            ? row.value.toString('utf8')
            : String(row.value ?? '')
          rows.push({ table, key: row.key, value })
        }
      }
    } catch {
      // table unreadable — skip
    }
  }

  db.close()
  return rows
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
    const rows = readAiRows(dbPath)

    for (const { table, key, value } of rows) {
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
          const conn = new DatabaseSync(db, { open: true, readOnly: true })
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
