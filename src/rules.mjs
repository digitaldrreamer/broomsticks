// Detection ruleset for broomsticks.
// Patterns derived from gitleaks (MIT), secretlint (MIT), and detect-secrets (Apache-2.0).
//
// Each rule:
//   pattern     — RegExp with `g` and `d` flags (d gives match.indices for precise offsets)
//   secretGroup — which capture group is the secret (default: 0 = whole match)
//   entropy     — minimum Shannon bits/char; match is skipped if below threshold

/**
 * @typedef {'critical'|'high'|'medium'|'low'} Severity
 * @typedef {{ id:string, title:string, severity:Severity, pattern:RegExp, secretGroup?:number, entropy?:number }} Rule
 */

/**
 * Shannon entropy over every character in the string (bits per character).
 * Ported from detect-secrets (Apache-2.0); thresholds: base64 ≥ 4.5, hex ≥ 3.0, generic ≥ 3.5.
 * @param {string} str
 * @returns {number}
 */
export function shannonEntropy(str) {
  if (!str) return 0
  const freq = new Map()
  for (const ch of str) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let e = 0
  for (const count of freq.values()) {
    const p = count / str.length
    e -= p * Math.log2(p)
  }
  return e
}

/** @type {Rule[]} */
export const RULES = [

  // ── Private / Cryptographic Keys ──────────────────────────────────────────
  // Matches PEM blocks: RSA, EC, OpenSSH, PGP, PKCS#8, encrypted variants.
  {
    id: 'private-key',
    title: 'Private key (PEM block)',
    severity: 'critical',
    pattern: /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,8192}?-----END[ A-Z0-9_-]{0,100}(?:PRIVATE KEY|KEY BLOCK)-----/gd,
  },

  // ── AWS ───────────────────────────────────────────────────────────────────
  // Covers AKIA (long-term), ASIA (session), ABIA (billing), ACCA, A3T* families.
  {
    id: 'aws-access-key',
    title: 'AWS access key ID',
    severity: 'high',
    pattern: /\b((?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },
  // 40-char base64 value paired with a secret-key variable name.
  {
    id: 'aws-secret-key',
    title: 'AWS secret access key',
    severity: 'high',
    pattern: /(?:aws_?secret_?access_?key|aws_?secret)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/gid,
    secretGroup: 1,
    entropy: 3.5,
  },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  // Covers api03 and api04 formats; always ends with AA (secretlint pattern).
  {
    id: 'anthropic-key',
    title: 'Anthropic API key',
    severity: 'high',
    pattern: /\b(sk-ant-api0[34]-[A-Za-z0-9_-]{90,128}AA)\b/gd,
    secretGroup: 1,
  },
  {
    id: 'anthropic-admin-key',
    title: 'Anthropic admin API key',
    severity: 'high',
    pattern: /\b(sk-ant-admin01-[A-Za-z0-9_-]{93}AA)\b/gd,
    secretGroup: 1,
  },

  // ── OpenAI ────────────────────────────────────────────────────────────────
  // New-format keys embed "T3BlbkFJ" (base64 for "OpenAI") as a fixed anchor —
  // this dramatically cuts false positives compared to a bare sk- prefix match.
  {
    id: 'openai-key',
    title: 'OpenAI API key',
    severity: 'high',
    pattern: /\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{58,74}T3BlbkFJ[A-Za-z0-9_-]{58,74})\b/gd,
    secretGroup: 1,
  },
  // Legacy 51-char keys, also anchored by T3BlbkFJ.
  {
    id: 'openai-key-legacy',
    title: 'OpenAI API key (legacy sk- format)',
    severity: 'high',
    pattern: /\b(sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})\b/gd,
    secretGroup: 1,
  },

  // ── Hugging Face ──────────────────────────────────────────────────────────
  {
    id: 'huggingface-token',
    title: 'Hugging Face user access token',
    severity: 'high',
    pattern: /\b(hf_[A-Za-z0-9]{34})\b/gd,
    secretGroup: 1,
    entropy: 2,
  },
  {
    id: 'huggingface-org-token',
    title: 'Hugging Face organization API token',
    severity: 'high',
    pattern: /\b(api_org_[A-Za-z0-9]{34})\b/gd,
    secretGroup: 1,
    entropy: 2,
  },

  // ── GitHub ────────────────────────────────────────────────────────────────
  // Classic tokens — each type has a distinct 3-letter prefix + 36 alphanumeric chars.
  {
    id: 'github-pat',
    title: 'GitHub personal access token',
    severity: 'high',
    pattern: /\b(ghp_[0-9A-Za-z]{36})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },
  {
    id: 'github-oauth',
    title: 'GitHub OAuth token',
    severity: 'high',
    pattern: /\b(gho_[0-9A-Za-z]{36})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },
  {
    id: 'github-app-token',
    title: 'GitHub app installation / server-to-server token',
    severity: 'high',
    pattern: /\b(gh[us]_[0-9A-Za-z]{36})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },
  {
    id: 'github-refresh-token',
    title: 'GitHub refresh token',
    severity: 'high',
    pattern: /\b(ghr_[0-9A-Za-z]{36})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },
  // Fine-grained PATs: `github_pat_` + exactly 82 word chars.
  // Uses Unicode property escape \p{L} for tighter boundary — requires `u` flag.
  {
    id: 'github-fine-grained-pat',
    title: 'GitHub fine-grained personal access token',
    severity: 'high',
    pattern: /(?<!\p{L})(github_pat_\w{82})(?!\w)/gud,
    secretGroup: 1,
  },

  // ── Google ────────────────────────────────────────────────────────────────
  {
    id: 'google-api-key',
    title: 'Google API key',
    severity: 'high',
    pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/gd,
    secretGroup: 1,
    entropy: 4,
  },

  // ── Stripe ────────────────────────────────────────────────────────────────
  // Covers secret keys (sk_) and restricted keys (rk_) in live/test/prod.
  {
    id: 'stripe-key',
    title: 'Stripe secret or restricted key',
    severity: 'high',
    pattern: /\b((?:sk|rk)_(?:live|test|prod)_[A-Za-z0-9]{10,99})\b/gd,
    secretGroup: 1,
    entropy: 2,
  },

  // ── Slack ─────────────────────────────────────────────────────────────────
  {
    id: 'slack-bot-token',
    title: 'Slack bot token',
    severity: 'high',
    pattern: /\b(xoxb-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,28})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },
  {
    id: 'slack-user-token',
    title: 'Slack user token',
    severity: 'high',
    pattern: /\b(xoxp-[0-9]{10,13}-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{32})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },
  {
    id: 'slack-app-token',
    title: 'Slack app-level token',
    severity: 'high',
    pattern: /\b(xapp-\d-[A-Z0-9]+-\d+-[a-z0-9]+)\b/gd,
    secretGroup: 1,
    entropy: 2,
  },
  {
    id: 'slack-webhook',
    title: 'Slack incoming webhook URL',
    severity: 'medium',
    pattern: /(https?:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{20,})/gd,
    secretGroup: 1,
  },

  // ── JSON Web Tokens ───────────────────────────────────────────────────────
  // Three dot-separated base64url segments; first two begin with eyJ (= '{"' in base64).
  {
    id: 'jwt',
    title: 'JSON Web Token',
    severity: 'medium',
    pattern: /\b(ey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gd,
    secretGroup: 1,
    entropy: 3,
  },

  // ── Database connection strings ───────────────────────────────────────────
  // Matches scheme://user:pass@host for common databases. Requires at least
  // user:pass@ (the @ is the discriminator — bare scheme://host has no credential).
  {
    id: 'db-url',
    title: 'Database connection string with inline credentials',
    severity: 'high',
    pattern: /((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/[^:@\s]{1,128}:[^@\s]{1,256}@[^\s'"`,)]{8,256})/gd,
    secretGroup: 1,
  },

  // ── Generic secret assignment (entropy-gated, runs last) ─────────────────
  // Catches unknown key formats assigned to recognisably secret-named variables.
  // Only fires when the value's Shannon entropy ≥ 3.5 bits/char, which eliminates
  // placeholder strings, UUIDs with low randomness, and most word-like values.
  {
    id: 'generic-secret',
    title: 'Generic secret assignment',
    severity: 'medium',
    // Value charset includes common password special chars (!@#$%^&*) in addition
    // to base64url chars so we catch real passwords, not just token-shaped strings.
    // The entropy gate (≥3.5 bits/char) prevents false positives on phrases and UUIDs.
    pattern: /(?:api[_\-.]?key|api[_\-.]?secret|auth[_\-.]?token|access[_\-.]?token|secret[_\-.]?key|private[_\-.]?key|client[_\-.]?secret|password|passwd|token|credential)\s*[:=]\s*["']?([A-Za-z0-9+/=_\-!@#$%^&*]{16,})["']?/gid,
    secretGroup: 1,
    entropy: 3.5,
  },
]

export default RULES
