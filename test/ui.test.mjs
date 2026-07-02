// UI helpers: colour gating, "did you mean" suggestions, and non-blocking
// prompts. The prompts must never hang when stdin/stdout aren't TTYs (the
// case in CI and the test runner).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { paint, closest, confirm, select } from '../src/ui.mjs'

test('closest suggests near commands and ignores far ones', () => {
  const cmds = ['scan', 'clean', 'sweep', 'sources', 'install', 'proxy']
  assert.equal(closest('sacn', cmds), 'scan')
  assert.equal(closest('clena', cmds), 'clean')
  assert.equal(closest('swep', cmds), 'sweep')
  assert.equal(closest('xyzzy', cmds), null, 'nothing within edit distance 2')
})

test('paint respects NO_COLOR / FORCE_COLOR', () => {
  const prevNo = process.env.NO_COLOR
  const prevForce = process.env.FORCE_COLOR
  try {
    delete process.env.NO_COLOR
    process.env.FORCE_COLOR = '1'
    assert.ok(paint('red', 'x').includes('\x1b['), 'FORCE_COLOR enables ANSI')

    process.env.NO_COLOR = '1'
    assert.equal(paint('red', 'x'), 'x', 'NO_COLOR wins over FORCE_COLOR')
  } finally {
    if (prevNo === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prevNo
    if (prevForce === undefined) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prevForce
  }
})

test('confirm / select return defaults immediately when non-interactive', async () => {
  // stdin/stdout are not TTYs under the test runner → no prompt, return default.
  assert.equal(await confirm('proceed?', false), false)
  assert.equal(await confirm('proceed?', true), true)
  assert.equal(await select('pick one', [{ label: 'a', value: 'a' }]), null)
})
