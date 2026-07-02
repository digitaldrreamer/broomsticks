// Supply-chain / privacy invariant: the scan+clean pipeline never makes a
// network call. We assert that no scanner module imports a networking API.
//
// The proxy (src/proxy.mjs) is the one intentional network component — it sits
// between an AI client and the upstream API — so it is explicitly exempt. Every
// other src/ module (the code that reads and rewrites your transcripts) must be
// network-free.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

const NETWORK_IMPORT = /from\s+['"]node:(?:https?|net|tls|dgram|http2)['"]|\bfetch\s*\(/

// Modules allowed to touch the network. Only the proxy.
const EXEMPT = new Set(['proxy.mjs'])

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (entry.name.endsWith('.mjs')) yield full
  }
}

test('scanner modules import no networking APIs', () => {
  const offenders = []
  for (const file of walk(SRC)) {
    if (EXEMPT.has(file.split('/').pop())) continue
    const code = readFileSync(file, 'utf8')
    if (NETWORK_IMPORT.test(code)) offenders.push(file)
  }
  assert.deepEqual(offenders, [], `network APIs found in scanner modules: ${offenders.join(', ')}`)
})

test('proxy remains the only network-capable module', () => {
  // Documents the exemption: if proxy.mjs ever stops importing http, revisit
  // whether the exemption is still warranted.
  const code = readFileSync(join(SRC, 'proxy.mjs'), 'utf8')
  assert.ok(NETWORK_IMPORT.test(code), 'proxy.mjs is expected to use the network')
})
