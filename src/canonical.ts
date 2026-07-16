/**
 * Canonical JSON serialization (spec §3.5): lexicographically sorted keys,
 * UTF-8, no insignificant whitespace, numbers restricted to integers.
 * Used for run_id derivation and every digest input.
 */

export class NonCanonicalValueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NonCanonicalValueError'
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, '$')
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isInteger(value)) {
        throw new NonCanonicalValueError(
          `non-integer number at ${path}: ${value}`,
        )
      }
      if (!Number.isSafeInteger(value)) {
        throw new NonCanonicalValueError(`unsafe integer at ${path}: ${value}`)
      }
      return String(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => serialize(v === undefined ? null : v, `${path}[${i}]`)).join(',')}]`
      }
      const record = value as Record<string, unknown>
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k], `${path}.${k}`)}`).join(',')}}`
    }
    default:
      throw new NonCanonicalValueError(
        `unserializable ${typeof value} at ${path}`,
      )
  }
}
