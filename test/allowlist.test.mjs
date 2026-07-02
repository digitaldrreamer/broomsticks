// Allowlist: parsing, built-in demo-secret suppression, regex + literal entries.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseAllowlist, loadAllowlist, isAllowlisted, DEMO_SECRETS,
} from '../src/allowlist.mjs'

test('parseAllowlist separates literals, regexes, and skips comments', () => {
  const { literals, patterns } = parseAllowlist([
    '# a comment',
    '',
    'literal-value',
    '/sk_test_[A-Za-z0-9]{4,}/',
  ])
  assert.ok(literals.has('literal-value'))
  assert.equal(literals.size, 1)
  assert.equal(patterns.length, 1)
})

test('built-in demo secrets are suppressed', () => {
  const allow = loadAllowlist('/nonexistent/allowlist.txt') // built-ins only
  for (const demo of DEMO_SECRETS) {
    assert.ok(isAllowlisted(demo, allow), `demo secret should be allowlisted: ${demo}`)
  }
  assert.ok(!isAllowlisted('ghp_1234567890abcdefABCDEF1234567890abcd', allow))
})

test('regex entry matches; global-flag regex does not desync via lastIndex', () => {
  const allow = parseAllowlist(['/sk_test_[A-Za-z0-9]{4,}/g'])
  assert.ok(isAllowlisted('sk_test_abcd1234', allow))
  // Second call must still match — isAllowlisted resets lastIndex.
  assert.ok(isAllowlisted('sk_test_abcd1234', allow))
})
