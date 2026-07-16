import { createHash } from 'node:crypto'
import { canonicalJson } from './canonical.js'

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Digest rendering per spec §3: `sha256:<64-hex>`. */
export function sha256Digest(input: string | Buffer): string {
  return `sha256:${sha256Hex(input)}`
}

/** Canonical-JSON digest of a structured value. */
export function canonicalDigest(value: unknown): string {
  return sha256Digest(canonicalJson(value))
}
