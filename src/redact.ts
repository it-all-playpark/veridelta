/**
 * Deterministic secret redaction (spec §15, §3.5; shapes fixed by
 * docs/conformance-harness.md §5.6). Runs before persistence and before
 * digesting; replacement is `[REDACTED:<kind>]`. Redaction is the sole
 * permitted value-level rewriting of evidence (CE-5) and MUST NOT be used
 * to normalize non-secret volatile values.
 */

interface RedactionRule {
  kind: string
  pattern: RegExp
  /** Replace only a capture group (bearer keeps its prefix). */
  keepPrefixGroup?: number
}

const RULES: readonly RedactionRule[] = [
  {
    kind: 'private-key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/g },
  { kind: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{36,255}/g },
  { kind: 'github-token', pattern: /github_pat_[A-Za-z0-9_]{22,255}/g },
  { kind: 'slack-token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'jwt', pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{10,}/g },
  {
    kind: 'bearer-token',
    pattern: /([Bb]earer\s+)[A-Za-z0-9._~+/=-]{16,}/g,
    keepPrefixGroup: 1,
  },
  { kind: 'api-key', pattern: /sk-[A-Za-z0-9_-]{20,}/g },
]

export function redactText(text: string): string {
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (...args) =>
      rule.keepPrefixGroup !== undefined
        ? `${args[rule.keepPrefixGroup] as string}[REDACTED:${rule.kind}]`
        : `[REDACTED:${rule.kind}]`,
    )
  }
  return out
}

/** Recursively redact every string in a JSON-like structure. */
export function redactValue<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactValue(v)) as unknown as T
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v)
    }
    return out as unknown as T
  }
  return value
}
