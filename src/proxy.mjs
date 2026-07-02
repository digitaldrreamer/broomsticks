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
// valid synthetic SSE stream with collapsed deltas. Both assistant text and
// tool-call argument JSON are scanned; extended-thinking blocks are passed
// through untouched so their signatures stay valid.

import { createServer }        from 'node:http'
import { request as tlsReq }  from 'node:https'
import { createHash }          from 'node:crypto'
import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { homedir }                      from 'node:os'
import { join, dirname }               from 'node:path'
import { execFileSync }                from 'node:child_process'

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
// Strategy: accumulate the full payload for each content block index across all
// delta events, redact the complete string, then re-emit one synthetic delta
// per block with the full redacted payload. Both assistant text AND tool-call
// argument JSON are scanned — a model can echo a leaked secret into a tool call
// (e.g. a write_file `content` arg) just as easily as into prose.
//
// Anthropic emits each block's payload under a delta-type-specific field:
//   text_delta       → delta.text          (assistant prose)
//   input_json_delta → delta.partial_json  (streamed tool-use input JSON)
// A block is exactly one type, so blockIndex → field is stable.
//
// thinking_delta / signature_delta are intentionally passed through untouched:
// extended-thinking blocks are cryptographically signed, and rewriting the text
// would invalidate the signature and break multi-turn thinking+tool loops.
const ANTHROPIC_DELTA_FIELD = { text_delta: 'text', input_json_delta: 'partial_json' }

export function redactAnthropicSSE(lines, allowlist, vault) {
  const acc = new Map()   // blockIndex → { field, content }
  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    let ev; try { ev = JSON.parse(raw) } catch { continue }
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'content_block_delta') {
      const field = ANTHROPIC_DELTA_FIELD[ev.delta?.type]
      if (!field) continue
      const i = ev.index ?? 0
      const prev = acc.get(i) ?? { field, content: '' }
      prev.content += ev.delta[field] ?? ''
      acc.set(i, prev)
    }
  }

  const redacted = new Map()
  for (const [i, { content }] of acc) redacted.set(i, redactStr(content, allowlist, vault))

  const emitted = new Set()
  const out = []
  for (const line of lines) {
    if (!line.startsWith('data:')) { out.push(line); continue }
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') { out.push(line); continue }
    let ev; try { ev = JSON.parse(raw) } catch { out.push(line); continue }

    const field = ev.type === 'content_block_delta' && ANTHROPIC_DELTA_FIELD[ev.delta?.type]
    if (field && acc.has(ev.index ?? 0)) {
      const i = ev.index ?? 0
      if (!emitted.has(i)) {
        emitted.add(i)
        out.push('data: ' + JSON.stringify({
          ...ev, delta: { ...ev.delta, [field]: redacted.get(i) ?? '' },
        }))
      }
      // drop subsequent deltas — full payload already emitted above
    } else {
      out.push(line)
    }
  }
  return out
}

// OpenAI streams assistant text under choices[].delta.content and tool-call
// input under choices[].delta.tool_calls[].function.arguments (fragmented,
// keyed by the tool_call's own `index`). Both carry secrets a model may echo,
// so both are accumulated, redacted, and collapsed into their first occurrence.
export function redactOpenAISSE(lines, allowlist, vault) {
  const accText = new Map()   // choiceIndex          → content string
  const accArgs = new Map()   // `${choiceIndex}:${toolIndex}` → arguments string

  for (const line of lines) {
    if (!line.startsWith('data:')) continue
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') continue
    let ev; try { ev = JSON.parse(raw) } catch { continue }
    if (!ev || typeof ev !== 'object') continue
    for (const c of ev.choices ?? []) {
      const ci = c.index ?? 0
      if (typeof c.delta?.content === 'string') {
        accText.set(ci, (accText.get(ci) ?? '') + c.delta.content)
      }
      for (const tc of c.delta?.tool_calls ?? []) {
        if (typeof tc.function?.arguments === 'string') {
          const key = `${ci}:${tc.index ?? 0}`
          accArgs.set(key, (accArgs.get(key) ?? '') + tc.function.arguments)
        }
      }
    }
  }

  const redText = new Map()
  for (const [k, v] of accText) redText.set(k, redactStr(v, allowlist, vault))
  const redArgs = new Map()
  for (const [k, v] of accArgs) redArgs.set(k, redactStr(v, allowlist, vault))

  const emittedText = new Set()
  const emittedArgs = new Set()
  const out = []
  for (const line of lines) {
    if (!line.startsWith('data:')) { out.push(line); continue }
    const raw = line.slice(5).trim()
    if (!raw || raw === '[DONE]') { out.push(line); continue }
    let ev; try { ev = JSON.parse(raw) } catch { out.push(line); continue }

    const hasText = (ev.choices ?? []).some(c => typeof c.delta?.content === 'string')
    const hasArgs = (ev.choices ?? []).some(c =>
      (c.delta?.tool_calls ?? []).some(tc => typeof tc.function?.arguments === 'string'))
    if (!hasText && !hasArgs) { out.push(line); continue }

    const newChoices = (ev.choices ?? []).map(c => {
      const ci = c.index ?? 0
      let delta = c.delta

      if (typeof delta?.content === 'string') {
        if (emittedText.has(ci)) delta = { ...delta, content: '' }
        else { emittedText.add(ci); delta = { ...delta, content: redText.get(ci) ?? '' } }
      }

      if (Array.isArray(delta?.tool_calls)) {
        const tcs = delta.tool_calls.map(tc => {
          if (typeof tc.function?.arguments !== 'string') return tc
          const key = `${ci}:${tc.index ?? 0}`
          if (emittedArgs.has(key)) return { ...tc, function: { ...tc.function, arguments: '' } }
          emittedArgs.add(key)
          return { ...tc, function: { ...tc.function, arguments: redArgs.get(key) ?? '' } }
        })
        delta = { ...delta, tool_calls: tcs }
      }

      return { ...c, delta }
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
    delete headers['transfer-encoding']  // we send a single buffer, not chunked
    delete headers['accept-encoding']    // need plaintext to scan

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
  const outHeaders = { ...upRes.headers }
  delete outHeaders['transfer-encoding']   // we send a single buffer, not chunked
  outHeaders['content-length'] = String(responseBody.length)
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
    try {
      const contents = readFileSync(file, 'utf8')
      if (contents.includes(BROOM_MARKER)) continue   // already installed
      appendFileSync(file, ENV_BLOCK(port), 'utf8')
      updated.push(file)
    } catch { /* permission error or race — skip silently */ }
  }

  return updated
}

// Matches the whole block installProxyEnv appends: the marker line, the body,
// and the closing rule line. The opening line has only two consecutive box
// chars ("# ── broomsticks…"), so `# ─{3,}` reliably anchors to the closing
// rule and never to the opener. A leading newline (added when the block is
// appended) is consumed so uninstall restores the original file shape.
const PROXY_BLOCK_RE = /\n?# ── broomsticks proxy[\s\S]*?\n# ─{3,}[^\n]*\n?/g

/**
 * Remove the proxy env-var block that installProxyEnv added. Inverse of
 * installProxyEnv: strips the marked block from every shell init file that
 * contains it, leaving the rest of the file untouched.
 *
 * @returns {string[]} paths that were updated
 */
export function uninstallProxyEnv() {
  const home    = homedir()
  const updated = []

  for (const name of PROFILE_CANDIDATES) {
    const file = join(home, name)
    if (!existsSync(file)) continue
    try {
      const contents = readFileSync(file, 'utf8')
      if (!contents.includes(BROOM_MARKER)) continue   // nothing to remove
      const stripped = contents.replace(PROXY_BLOCK_RE, '')
      if (stripped !== contents) {
        writeFileSync(file, stripped, 'utf8')
        updated.push(file)
      }
    } catch { /* permission error or race — skip silently */ }
  }

  return updated
}

// ── Daemon installation ───────────────────────────────────────────────────────

function launchdPlist(nodeBin, broomBin, port) {
  const logFile = join(homedir(), '.broom', 'proxy.log')
  // Escape XML metacharacters — a path like /Users/bob&alice would otherwise
  // produce a malformed plist that launchd refuses to load.
  const esc = (s) => String(s).replace(/[<>&]/g, m => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[m]))
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.broomsticks.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodeBin)}</string>
    <string>${esc(broomBin)}</string>
    <string>proxy</string>
    <string>--port</string>
    <string>${esc(port)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(logFile)}</string>
</dict>
</plist>
`
}

function systemdService(nodeBin, broomBin, port) {
  return `[Unit]
Description=broomsticks secret-redacting proxy
After=network.target

[Service]
ExecStart="${nodeBin}" "${broomBin}" proxy --port ${port}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

/**
 * Install the proxy as a login-persistent daemon.
 * - macOS  : ~/Library/LaunchAgents/com.broomsticks.proxy.plist  (launchd)
 * - Linux  : ~/.config/systemd/user/broom-proxy.service          (systemd)
 *
 * @param {{ port?: number, nodeBin: string, broomBin: string }} opts
 * @returns {{ path: string, platform: string, alreadyRunning: boolean }}
 */
export function installDaemon({ port = 7777, nodeBin, broomBin }) {
  const home = homedir()
  mkdirSync(join(home, '.broom'), { recursive: true })

  if (process.platform === 'darwin') {
    const agentsDir  = join(home, 'Library', 'LaunchAgents')
    const plistPath  = join(agentsDir, 'com.broomsticks.proxy.plist')
    mkdirSync(agentsDir, { recursive: true })
    writeFileSync(plistPath, launchdPlist(nodeBin, broomBin, port), 'utf8')

    // Unload first in case a stale copy is already registered
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }) } catch {}
    execFileSync('launchctl', ['load', '-w', plistPath])

    return { path: plistPath, platform: 'macos' }
  }

  if (process.platform === 'linux') {
    const serviceDir  = join(home, '.config', 'systemd', 'user')
    const servicePath = join(serviceDir, 'broom-proxy.service')
    mkdirSync(serviceDir, { recursive: true })
    writeFileSync(servicePath, systemdService(nodeBin, broomBin, port), 'utf8')

    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' })
    execFileSync('systemctl', ['--user', 'enable', 'broom-proxy'], { stdio: 'ignore' })
    execFileSync('systemctl', ['--user', 'start',  'broom-proxy'], { stdio: 'ignore' })

    return { path: servicePath, platform: 'linux' }
  }

  throw new Error(`Daemon installation is not supported on ${process.platform}. Run \`broom proxy\` manually or add it to your startup scripts.`)
}

/**
 * Remove the daemon installed by installDaemon.
 */
export function uninstallDaemon() {
  const home = homedir()

  if (process.platform === 'darwin') {
    const plistPath = join(home, 'Library', 'LaunchAgents', 'com.broomsticks.proxy.plist')
    if (!existsSync(plistPath)) return false
    try { execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' }) } catch {}
    try { unlinkSync(plistPath) } catch {}
    return true
  }

  if (process.platform === 'linux') {
    const servicePath = join(home, '.config', 'systemd', 'user', 'broom-proxy.service')
    if (!existsSync(servicePath)) return false
    try { execFileSync('systemctl', ['--user', 'stop',    'broom-proxy'], { stdio: 'ignore' }) } catch {}
    try { execFileSync('systemctl', ['--user', 'disable', 'broom-proxy'], { stdio: 'ignore' }) } catch {}
    try { unlinkSync(servicePath) } catch {}
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }) } catch {}
    return true
  }

  return false
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
