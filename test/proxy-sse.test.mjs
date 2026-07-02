// SSE redaction — regression guard for the tool-call leak: a secret echoed by
// the model inside a tool-call argument (split across streamed delta chunks)
// must be redacted before the client sees it, and the event structure must
// survive so the client can still reconstruct the tool call.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { redactAnthropicSSE, redactOpenAISSE } from '../src/proxy.mjs'

// Assembled from parts so the literal token never appears in-file; shaped to
// match the github-pat rule (ghp_ + 36 alphanumerics).
const SECRET = 'ghp_' + '1234567890abcdefABCDEF1234567890abcd'

/** Join emitted `data:` JSON events back into one string for assertions. */
function joined(lines) {
  return lines.join('\n')
}

test('anthropic: secret split across input_json_delta chunks is redacted', () => {
  const vault = new Map()
  const half = SECRET.length >> 1
  const lines = [
    'event: content_block_start',
    'data: ' + JSON.stringify({ type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'write_file', input: {} } }),
    '',
    'event: content_block_delta',
    'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"content": "' + SECRET.slice(0, half) } }),
    '',
    'event: content_block_delta',
    'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: SECRET.slice(half) + '"}' } }),
    '',
    'event: content_block_stop',
    'data: ' + JSON.stringify({ type: 'content_block_stop', index: 0 }),
  ]

  const out = redactAnthropicSSE(lines, null, vault)
  const text = joined(out)

  assert.ok(!text.includes(SECRET), 'reassembled tool-call args must not contain the secret')
  assert.ok(text.includes('write_file') && text.includes('toolu_1'), 'tool-call structure preserved')
  assert.ok(vault.size === 1, 'secret captured in the vault')

  // The collapsed partial_json fragments must still reassemble into valid JSON.
  const partials = out
    .filter(l => l.startsWith('data:'))
    .map(l => { try { return JSON.parse(l.slice(5)) } catch { return null } })
    .filter(ev => ev?.delta?.type === 'input_json_delta')
    .map(ev => ev.delta.partial_json)
    .join('')
  const parsed = JSON.parse(partials)
  assert.ok(parsed.content.startsWith('«BROOM:'), 'secret replaced with a placeholder')
})

test('anthropic: text_delta path still redacts (no regression)', () => {
  const vault = new Map()
  const lines = [
    'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0,
      delta: { type: 'text_delta', text: 'here is the key ' + SECRET } }),
  ]
  const out = redactAnthropicSSE(lines, null, vault)
  assert.ok(!joined(out).includes(SECRET))
  assert.equal(vault.size, 1)
})

test('anthropic: thinking_delta is passed through unmodified (signature safety)', () => {
  const vault = new Map()
  const original = 'data: ' + JSON.stringify({ type: 'content_block_delta', index: 0,
    delta: { type: 'thinking_delta', thinking: 'let me reason about this' } })
  const out = redactAnthropicSSE([original], null, vault)
  assert.deepEqual(out, [original], 'thinking deltas must pass through byte-for-byte')
})

test('openai: secret split across tool_calls arguments chunks is redacted', () => {
  const vault = new Map()
  const half = SECRET.length >> 1
  const lines = [
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: 'call_1', type: 'function',
        function: { name: 'write_file', arguments: '{"content":"' + SECRET.slice(0, half) } } ] } }] }),
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, function: { arguments: SECRET.slice(half) + '"}' } } ] } }] }),
    'data: [DONE]',
  ]

  const out = redactOpenAISSE(lines, null, vault)
  const text = joined(out)

  assert.ok(!text.includes(SECRET), 'reassembled tool-call args must not contain the secret')
  assert.ok(text.includes('write_file') && text.includes('call_1'), 'tool-call structure preserved')
  assert.equal(vault.size, 1)

  const args = out
    .filter(l => l.startsWith('data:') && l.slice(5).trim() !== '[DONE]')
    .flatMap(l => { try { return JSON.parse(l.slice(5)).choices ?? [] } catch { return [] } })
    .flatMap(c => c.delta?.tool_calls ?? [])
    .map(tc => tc.function?.arguments ?? '')
    .join('')
  const parsed = JSON.parse(args)
  assert.ok(parsed.content.startsWith('«BROOM:'), 'secret replaced with a placeholder')
})

test('openai: content path still redacts (no regression)', () => {
  const vault = new Map()
  const lines = [
    'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'key: ' + SECRET } }] }),
    'data: [DONE]',
  ]
  const out = redactOpenAISSE(lines, null, vault)
  assert.ok(!joined(out).includes(SECRET))
  assert.equal(vault.size, 1)
})
