import { describe, expect, it } from 'vitest'
import { redactText } from '../../src/redact.js'

describe('secret redaction (§15, contract §5.6)', () => {
  it('redacts AWS access key ids', () => {
    expect(redactText('key=AKIAIOSFODNN7EXAMPLE end')).toBe(
      'key=[REDACTED:aws-access-key-id] end',
    )
  })

  it('redacts github tokens', () => {
    expect(redactText(`ghp_${'a'.repeat(36)}`)).toBe('[REDACTED:github-token]')
  })

  it('is deterministic', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE and xoxb-1234567890-abc'
    expect(redactText(input)).toBe(redactText(input))
  })

  it('leaves ordinary text alone', () => {
    expect(redactText('expected 500 to be 200')).toBe('expected 500 to be 200')
  })
})
