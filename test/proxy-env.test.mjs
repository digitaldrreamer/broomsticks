// Proxy shell-profile env install/uninstall round-trip. installProxyEnv appends
// a marked block; uninstallProxyEnv must remove exactly that block and leave
// the user's own lines untouched.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import { installProxyEnv, uninstallProxyEnv } from '../src/proxy.mjs'

test('installProxyEnv → uninstallProxyEnv restores the original profile', (t) => {
  const home     = mkdtempSync(join(tmpdir(), 'broom-env-'))
  const prevHome = process.env.HOME
  process.env.HOME = home

  try {
    // Only meaningful if os.homedir() honors our $HOME override on this platform.
    if (homedir() !== home) {
      return t.skip('homedir() not redirectable via $HOME on this platform')
    }

    const rc       = join(home, '.zshrc')
    const original = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\n'
    writeFileSync(rc, original, 'utf8')

    // Install: block appended, marker present, user content preserved.
    const added = installProxyEnv(7777)
    assert.deepEqual(added, [rc], 'install should report the .zshrc it touched')
    const afterInstall = readFileSync(rc, 'utf8')
    assert.ok(afterInstall.includes('ANTHROPIC_BASE_URL=http://127.0.0.1:7777'))
    assert.ok(afterInstall.includes('OPENAI_BASE_URL=http://127.0.0.1:7777'))
    assert.ok(afterInstall.startsWith(original), 'user content stays at the top')

    // Uninstall: block gone, user content byte-for-byte intact.
    const removed = uninstallProxyEnv()
    assert.deepEqual(removed, [rc], 'uninstall should report the .zshrc it cleaned')
    const afterUninstall = readFileSync(rc, 'utf8')
    assert.ok(!afterUninstall.includes('broomsticks proxy'), 'marker removed')
    assert.ok(!afterUninstall.includes('ANTHROPIC_BASE_URL'), 'env var removed')
    assert.equal(afterUninstall, original, 'profile restored to its original bytes')

    // Idempotent: uninstall again is a no-op.
    assert.deepEqual(uninstallProxyEnv(), [], 'second uninstall touches nothing')
  } finally {
    if (prevHome === undefined) delete process.env.HOME
    else process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  }
})
