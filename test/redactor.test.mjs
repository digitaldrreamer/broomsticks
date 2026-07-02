// Redaction: correct placeholder, JSON round-trip stays valid, idempotency.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { RULES } from '../src/rules.mjs'
import { scanText } from '../src/detector.mjs'
import { redactText, buildPlaceholder } from '../src/redactor.mjs'

const GH = 'ghp_1234567890abcdefABCDEF1234567890abcd'

test('placeholder format is «BROOM:<ruleId>:<sha8>»', () => {
  const sha8 = createHash('sha256').update(GH).digest('hex').slice(0, 8)
  assert.equal(buildPlaceholder('github-pat', GH), `«BROOM:github-pat:${sha8}»`)
})

test('redactText replaces the secret and reports applied count', () => {
  const text = `here is a key ${GH} in text`
  const findings = scanText(text, RULES)
  const { text: out, applied } = redactText(text, findings)
  assert.equal(applied, 1)
  assert.ok(!out.includes(GH), 'raw secret must be gone')
  assert.ok(out.includes('«BROOM:github-pat:'), 'placeholder must be present')
})

test('multiple secrets on one line all get redacted with valid offsets', () => {
  const db = 'postgres://admin:s3cr3tP4ss@db.host:5432/app'
  const text = `${GH} and ${db} together`
  const { text: out, applied } = redactText(text, scanText(text, RULES))
  assert.equal(applied, 2)
  assert.ok(!out.includes(GH))
  assert.ok(!out.includes(db))
})

test('JSONL line stays valid JSON after redaction', () => {
  const line = JSON.stringify({ role: 'user', text: `my key is ${GH}` })
  const { text: out } = redactText(line, scanText(line, RULES))
  const parsed = JSON.parse(out) // throws if placeholder broke JSON
  assert.ok(parsed.text.includes('«BROOM:github-pat:'))
  assert.ok(!parsed.text.includes(GH))
})

test('redaction is idempotent — a redacted blob has no findings', () => {
  const text = `key ${GH} here`
  const { text: once } = redactText(text, scanText(text, RULES))
  const second = scanText(once, RULES)
  assert.deepEqual(second, [], 'placeholders must not be re-detected')
  const { applied } = redactText(once, second)
  assert.equal(applied, 0)
})
