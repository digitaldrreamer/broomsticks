// Detector + ruleset tests: planted secrets of each shape must be found;
// decoys must not match. Runs on the built-in node:test runner (no deps).

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RULES, shannonEntropy } from '../src/rules.mjs'
import { scanText } from '../src/detector.mjs'

/** Return the set of ruleIds scanText finds in `text`. */
function ruleIds(text) {
  return new Set(scanText(text, RULES).map(f => f.ruleId))
}

// One planted sample per rule we want to guarantee coverage for. Each value is
// synthetic (not a live credential) but shaped to match the corresponding rule.
const SAMPLES = {
  'private-key':
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEArandombase64content1234567890\n-----END RSA PRIVATE KEY-----',
  'aws-access-key': 'AKIAIOSFODNN7EXAMPLE',
  'anthropic-key': 'sk-ant-api03-' + 'x'.repeat(90) + 'AA',
  'openai-key': 'sk-proj-' + 'a'.repeat(58) + 'T3BlbkFJ' + 'b'.repeat(58),
  'github-pat': 'ghp_1234567890abcdefABCDEF1234567890abcd',
  'github-fine-grained-pat': 'github_pat_' + 'A'.repeat(82),
  'google-api-key': 'AIzaSyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY',
  // Assembled from parts so the literal token text never appears in-file
  // (avoids tripping upstream secret scanners on a synthetic fixture).
  'slack-bot-token': ['xoxb', '2494792170', '2503138584', 'aZ9xK2mQ7wL4pR8vT1nY6bC3'].join('-'),
  'jwt':
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'db-url': 'postgres://admin:s3cr3tP4ss@db.example.com:5432/app',
  'generic-secret': 'api_key = "aZ9xK2mQ7wL4pR8vT1nY6bC3dE5fG0hJ"',
}

for (const [ruleId, sample] of Object.entries(SAMPLES)) {
  test(`detects ${ruleId}`, () => {
    assert.ok(
      ruleIds(sample).has(ruleId),
      `expected ${ruleId} in findings for: ${sample.slice(0, 40)}…`,
    )
  })
}

test('every declared rule has a sample in the coverage table', () => {
  // Guards against silently adding a rule with no regression sample.
  const covered = new Set(Object.keys(SAMPLES))
  // These rules are intentionally exercised elsewhere or are near-duplicates
  // of a covered rule; list them so the assertion stays honest.
  const knownUncovered = new Set([
    'aws-secret-key', 'anthropic-admin-key', 'openai-key-legacy',
    'huggingface-token', 'huggingface-org-token', 'github-oauth',
    'github-app-token', 'github-refresh-token', 'stripe-key',
    'slack-user-token', 'slack-app-token', 'slack-webhook',
  ])
  for (const rule of RULES) {
    assert.ok(
      covered.has(rule.id) || knownUncovered.has(rule.id),
      `rule '${rule.id}' has no sample and is not in knownUncovered`,
    )
  }
})

test('decoys do not match any rule', () => {
  const decoys = [
    'The quick brown fox jumps over the lazy dog.',
    'password = "aaaaaaaaaaaaaaaa"',            // 16 chars, entropy 0 → below gate
    'See commit 1234567890abcdef1234567890abcdef12345678 for details', // bare sha
    'Connect to https://example.com/path?q=1',  // url, no inline credentials
    'const timeout = 30000',
  ]
  for (const d of decoys) {
    assert.deepEqual([...ruleIds(d)], [], `unexpected match in decoy: ${d}`)
  }
})

test('overlapping matches resolve to a single non-nested finding', () => {
  // A db-url that also contains an assignment-shaped substring should yield
  // exactly one finding covering the URL, not two overlapping spans.
  const text = 'DATABASE_URL=postgres://admin:s3cr3tP4ssword@db.host:5432/app'
  const findings = scanText(text, RULES)
  for (let i = 0; i < findings.length; i++) {
    for (let j = i + 1; j < findings.length; j++) {
      const a = findings[i], b = findings[j]
      assert.ok(a.end <= b.start || b.end <= a.start, 'findings must not overlap')
    }
  }
})

test('--extra literal and /regex/ entries are honored', () => {
  const text = 'internal token WIDGET-7712 and marker ZZZ-alpha'
  const ids = new Set(scanText(text, RULES, ['WIDGET-7712', '/ZZZ-[a-z]+/']).map(f => f.ruleId))
  assert.ok(ids.has('extra-0'))
  assert.ok(ids.has('extra-1'))
})

test('shannonEntropy: uniform vs repeated', () => {
  assert.equal(shannonEntropy(''), 0)
  assert.equal(shannonEntropy('aaaa'), 0)
  assert.ok(shannonEntropy('abcd') > 1.9) // 4 distinct chars → 2 bits
})
