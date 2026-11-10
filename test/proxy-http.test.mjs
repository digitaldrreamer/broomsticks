import { test } from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { startProxy } from '../src/proxy.mjs'
import { buildPlaceholder } from '../src/redactor.mjs'

const SECRET = 'ghp_' + '1234567890abcdefABCDEF1234567890abcd'
const COLLISION = JSON.stringify({ [SECRET]: 1, [buildPlaceholder('github-pat', SECRET)]: 2 })

async function withProxy(t, request, run) {
  t.mock.method(https, 'request', request)
  syncBuiltinESMExports()
  let server
  try {
    server = await startProxy({ port: 0, allowlistFile: '/nonexistent/broom-test-allowlist.txt' })
    await run('http://127.0.0.1:' + server.address().port)
  } finally {
    if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
}

test('proxy refuses outgoing redaction failures before contacting the provider', async t => {
  let upstreamCalls = 0
  await withProxy(t, () => {
    upstreamCalls++
    throw new Error('Unexpected upstream request')
  }, async base => {
    const response = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: COLLISION }] }),
    })
    assert.equal(response.status, 502)
    assert.match(await response.text(), /JSON structure|object entries/)
    assert.equal(upstreamCalls, 0)
  })
})

test('proxy refuses incoming redaction failures instead of returning secrets', async t => {
  const body = JSON.stringify({ content: COLLISION })
  await withProxy(t, (_options, callback) => {
    const request = new EventEmitter()
    request.end = () => {
      const response = Readable.from([Buffer.from(body)])
      response.headers = { 'content-type': 'application/json' }
      response.statusCode = 200
      callback(response)
    }
    return request
  }, async base => {
    const response = await fetch(base + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    })
    const text = await response.text()
    assert.equal(response.status, 502)
    assert.ok(!text.includes(SECRET))
    assert.match(text, /JSON structure|object entries/)
  })
})
