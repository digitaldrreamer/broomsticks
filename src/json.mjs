function document(text, start) {
  try {
    return { text, start, value: JSON.parse(text) }
  } catch {
    return null
  }
}

export function jsonDocuments(text, strictLines = false) {
  if (!strictLines) {
    if (!/^\s*[\[{\"]/.test(text)) return null
    const parsed = document(text, 0)
    if (parsed) return [parsed]
    if (!text.includes('\n')) return null
  }

  const documents = []
  let start = 0
  let line = 1
  while (start < text.length) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline + 1
    const raw = text.slice(start, end)
    if (raw.trim()) {
      const parsed = document(raw, start)
      if (!parsed) {
        if (strictLines) throw new Error(`Invalid JSONL record on line ${line}`)
        return null
      }
      documents.push(parsed)
    }
    start = end
    line++
  }
  return documents.length || strictLines ? documents : null
}

export function mapJsonFindings(literal, findings, start) {
  if (!findings.length) return []
  const boundaries = new Map()
  for (const finding of findings) {
    boundaries.set(finding.start, 0)
    boundaries.set(finding.end, 0)
  }
  let decoded = 0
  for (let index = 1; index < literal.length;) {
    if (boundaries.has(decoded)) boundaries.set(decoded, start + index)
    if (index === literal.length - 1) break
    index += literal[index] === '\\' ? (literal[index + 1] === 'u' ? 6 : 2) : 1
    decoded++
  }
  return findings.map(finding => ({
    ...finding,
    start: boundaries.get(finding.start),
    end: boundaries.get(finding.end),
    ...(finding.jsonDepth === undefined ? {} : { jsonDepth: finding.jsonDepth + 1 }),
  }))
}

export function assertJsonStructure(before, after, strictLines = false) {
  const original = jsonDocuments(before) ?? (strictLines ? jsonDocuments(before, true) : null)
  if (!original) return
  const redacted = jsonDocuments(after) ?? (strictLines ? jsonDocuments(after, true) : null)
  if (!redacted || original.length !== redacted.length) {
    throw new Error('Redaction would change JSON structure or lose records')
  }
  for (let index = 0; index < original.length; index++) {
    compareValues(original[index].value, redacted[index].value,
      sourceKeys(original[index].text), sourceKeys(redacted[index].text))
  }
}

// JSON.parse sorts integer-like keys. Keep source order for pairing entries
// when redaction renames one of those keys to a non-integer placeholder.
function* sourceKeys(text) {
  const colon = /\s*:/y
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)) {
    colon.lastIndex = match.index + match[0].length
    if (colon.test(text)) yield JSON.parse(match[0])
  }
}

function compareValues(before, after, originalKeys, redactedKeys) {
  const fail = () => { throw new Error('Redaction would change JSON structure or merge object entries') }
  if (typeof before === 'string') {
    if (typeof after !== 'string') fail()
    assertJsonStructure(before, after)
  } else if (Array.isArray(before)) {
    if (!Array.isArray(after) || before.length !== after.length) fail()
    before.forEach((value, index) => compareValues(value, after[index], originalKeys, redactedKeys))
  } else if (before !== null && typeof before === 'object') {
    if (after === null || typeof after !== 'object' || Array.isArray(after)) fail()
    const count = Object.keys(before).length
    if (count !== Object.keys(after).length) fail()
    for (let index = 0; index < count; index++) {
      const key = originalKeys.next().value
      const redactedKey = redactedKeys.next().value
      compareValues(key, redactedKey, originalKeys, redactedKeys)
      compareValues(before[key], after[redactedKey], originalKeys, redactedKeys)
    }
  } else if (before !== after && !(typeof after === 'string' && /^«BROOM:[\w-]+:[a-f0-9]{8}»$/.test(after))) {
    fail()
  }
}
