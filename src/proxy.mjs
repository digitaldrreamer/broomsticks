// broomsticks local proxy.
//
// Sits between any AI coding client and the upstream LLM API. On every
// outgoing request it redacts secrets from user messages before they reach
// the model. On every incoming response it redacts any secrets the model may
// have echoed back. Real values are held in an in-memory vault (sha8 → secret)
// so a future hook or shell wrapper can expand them before tool execution.
//
// Routing (detected from request path):
//   POST /v1/messages           → api.anthropic.com  (Anthropic)
//   POST /v1/chat/completions   → api.openai.com     (OpenAI-compatible)
//
// Both streaming (SSE) and non-streaming responses are handled. Streaming
// responses are buffered in full before redaction — a secret that straddles
// two SSE chunks cannot be safely found otherwise. The client receives a
// valid synthetic SSE stream with collapsed text deltas.

import { createServer }        from 'node:http'
import { request as tlsReq }  from 'node:https'
import { createHash }          from 'node:crypto'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { homedir }             from 'node:os'
import { join }                from 'node:path'

import { RULES }                         from './rules.mjs'
import { scanText }                      from './detector.mjs'
import { redactText }                    from './redactor.mjs'
import { loadAllowlist, isAllowlisted }  from './allowlist.mjs'

// ── Routing ───────────────────────────────────────────────────────────────────

const ROUTES = {
  '/v1/messages':         'api.anthropic.com',
  '/v1/chat/completions': 'api.openai.com',
}

function resolveUpstream(path) {
  for (const [prefix, host] of Object.entries(ROUTES)) {
    if (path === prefix || path.startsWith(prefix + '?')) return host
  }
  return null
}

// ── Vault helpers ─────────────────────────────────────────────────────────────

function sha8(secret) {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8)
}

// ── Redaction ─────────────────────────────────────────────────────────────────

function redactStr(text, allowlist, vault) {
  const raw      = scanText(text, RULES)
  const findings = allowlist ? raw.filter(f => !isAllowlisted(f.secret, allowlist)) : raw
  if (findings.length === 0) return text
  for (const f of findings) vault.set(sha8(f.secret), f.secret)
  return redactText(text, findings).text
}

/** Recursively walk a parsed JSON value and redact every string leaf. */
function redactValue(v, allowlist, vault) {
  if (typeof v === 'string')            return redactStr(v, allowlist, vault)
  if (Array.isArray(v))                 return v.map(x => redactValue(x, allowlist, vault))
  if (v !== null && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = redactValue(val, allowlist, vault)
    return out
  }
  return v
}

// ── Stream utilities ──────────────────────────────────────────────────────────

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data',  c  => chunks.push(c))
    stream.on('end',   ()  => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

// ── SSE redaction ─────────────────────────────────────────────────────────────
//
// Strategy: accumulate the full text for each content block index across all
// delta events, redact the complete string, then re-emit one synthetic delta
// per block with the full redacted text. All non-delta events pass through.

function redactAnthropicSSE(lines, allowlist, vault) {
  const accumulated = new Map()   // blockIndex → full text
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    let ev; try { ev = JSON.parse(raw) } catch { continue }
    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const i = ev.index ?? 0
      accumulated.set(i, (accumulated.get(i) ?? '') + (ev.delta.text ?? ''))
    }
  }

  const redacted = new Map()
  for (const [i, text] of accumulated) redacted.set(i, redactStr(text, allowlist, vault))

  const emitted = new Set()
  const out = []
  for (const line of lines) {
    if (!line.startsWith('data:')) { out.push(line); continue }
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') { out.push(line); continue }
    let ev; try { ev = JSON.parse(raw) } catch { out.push(line); continue }

    if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      const i = ev.index ?? 0
      if (!emitted.has(i)) {
        emitted.add(i)
        out.push('data: ' + JSON.stringify({
          ...ev, delta: { ...ev.delta, text: redacted.get(i) ?? '' },
        }))
      }
      // drop subsequent deltas — text already emitted above
    } else {
      out.push(line)
    }
  }
  return out
}

function redactOpenAISSE(lines, allowlist, vault) {
  const accumulated = new Map()   // choiceIndex → full content string
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    let ev; try { ev = JSON.parse(raw) } catch { continue }
    for (const c of ev.choices ?? []) {
      if (typeof c.delta?.content === 'string') {
        const i = c.index ?? 0
        accumulated.set(i, (accumulated.get(i) ?? '') + c.delta.content)
      }
    }
  }

  const redacted = new Map()
  for (const [i, text] of accumulated) redacted.set(i, redactStr(text, allowlist, vault))

  const emitted = new Set()
  const out = []
  for (const line of lines) {
    if (!line.startsWith('data:')) { out.push(line); continue }
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') { out.push(line); continue }
    let ev; try { ev = JSON.parse(raw) } catch { out.push(line); continue }

    const hasContent = (ev.choices ?? []).some(c => typeof c.delta?.content === 'string')
    if (!hasContent) { out.push(line); continue }

    const newChoices = (ev.choices ?? []).map(c => {
      if (typeof c.delta?.content !== 'string') return c
      const i = c.index ?? 0
      if (emitted.has(i)) return { ...c, delta: { ...c.delta, content: '' } }
      emitted.add(i)
      return { ...c, delta: { ...c.delta, content: redacted.get(i) ?? '' } }
    })
    out.push('data: ' + JSON.stringify({ ...ev, choices: newChoices }))
  }
  return out
}

// ── Upstream forwarding ───────────────────────────────────────────────────────

function forwardRequest(upstreamHost, req, body) {
  return new Promise((resolve, reject) => {
    const headers = { ...req.headers, host: upstreamHost }
    headers['content-length'] = String(body.length)
    delete headers['accept-encoding']   // need plaintext to scan

    const upReq = tlsReq(
      { host: upstreamHost, port: 443, path: req.url, method: req.method, headers },
      resolve,
    )
    upReq.on('error', reject)
    upReq.end(body)
  })
}

// ── Core handler ──────────────────────────────────────────────────────────────

async function handleRequest(req, res, allowlist, vault, verbose) {
  const upstreamHost = resolveUpstream(req.url ?? '/')

  if (!upstreamHost) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: { message: `broom proxy: no route for ${req.method} ${req.url}` },
    }))
    return
  }

  // ── Redact outgoing request body ──────────────────────────────────────────
  const rawBody = await collect(req)
  let outBody   = rawBody
  const vaultBefore = vault.size

  if (req.headers['content-type']?.includes('application/json')) {
    try {
      const json     = JSON.parse(rawBody.toString('utf8'))
      const cleaned  = redactValue(json, allowlist, vault)
      outBody = Buffer.from(JSON.stringify(cleaned), 'utf8')
    } catch { /* non-JSON — forward as-is */ }
  }

  if (verbose && vault.size > vaultBefore) {
    console.error(`  ← request: redacted ${vault.size - vaultBefore} secret(s) (vault size: ${vault.size})`)
  }

  // ── Forward to upstream ───────────────────────────────────────────────────
  const upRes  = await forwardRequest(upstreamHost, req, outBody)
  const upBody = await collect(upRes)

  // ── Redact incoming response body ─────────────────────────────────────────
  const isSSE   = upRes.headers['content-type']?.includes('text/event-stream')
  const vaultMid = vault.size
  let responseBody

  if (isSSE) {
    const lines        = upBody.toString('utf8').split('\n')
    const isAnthropic  = upstreamHost.includes('anthropic')
    const cleanedLines = isAnthropic
      ? redactAnthropicSSE(lines, allowlist, vault)
      : redactOpenAISSE(lines, allowlist, vault)
    responseBody = Buffer.from(cleanedLines.join('\n'), 'utf8')
  } else {
    try {
      const json    = JSON.parse(upBody.toString('utf8'))
      const cleaned = redactValue(json, allowlist, vault)
      responseBody  = Buffer.from(JSON.stringify(cleaned), 'utf8')
    } catch {
      responseBody = upBody
    }
  }

  if (verbose && vault.size > vaultMid) {
    console.error(`  → response: redacted ${vault.size - vaultMid} secret(s) from model output`)
  }

  // ── Write response ────────────────────────────────────────────────────────
  const outHeaders = { ...upRes.headers, 'content-length': String(responseBody.length) }
  res.writeHead(upRes.statusCode ?? 200, outHeaders)
  res.end(responseBody)
}

// ── Shell profile installation ────────────────────────────────────────────────

const PROFILE_CANDIDATES = ['.zshrc', '.bashrc', '.bash_profile', '.profile']

const ENV_BLOCK = (port) => `
# ── broomsticks proxy ────────────────────────────────────────────────────────
# Route AI API calls through the local broomsticks proxy so secrets are
# redacted before they reach the model. Start with: broom proxy
export ANTHROPIC_BASE_URL=http://127.0.0.1:${port}
export OPENAI_BASE_URL=http://127.0.0.1:${port}
# ────────────────────────────────────────────────────────────────────────────
`

const BROOM_MARKER = '# ── broomsticks proxy'

/**
 * Append proxy env-var exports to every shell init file found in $HOME.
 * Idempotent: skips files that already contain the marker.
 *
 * @param {number} port
 * @returns {string[]} paths that were updated
 */
export function installProxyEnv(port = 7777) {
  const home    = homedir()
  const updated = []

  for (const name of PROFILE_CANDIDATES) {
    const file = join(home, name)
    if (!existsSync(file)) continue
    const contents = readFileSync(file, 'utf8')
    if (contents.includes(BROOM_MARKER)) continue   // already installed
    appendFileSync(file, ENV_BLOCK(port), 'utf8')
    updated.push(file)
  }

  return updated
}

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Start the broomsticks proxy.
 *
 * @param {{ port?: number, verbose?: boolean, allowlistFile?: string }} opts
 * @returns {Promise<import('node:http').Server>}
 */
export function startProxy({ port = 7777, verbose = false, allowlistFile } = {}) {
  const allowlist = loadAllowlist(allowlistFile)
  const vault     = new Map()

  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, allowlist, vault, verbose)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'broom proxy: ' + err.message } }))
      }
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
