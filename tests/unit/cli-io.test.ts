import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { writeAll } from '../../src/cli-io.js'

/**
 * Slow sink: mimics a downstream pipe (e.g. `| head`) that only accepts a
 * small chunk per tick. `_write` defers its callback via `setImmediate` so
 * that `writeAll`'s promise cannot resolve before libuv has actually
 * delivered every byte to the sink (issue #12 regression).
 */
function createSlowSink() {
  const chunks: Buffer[] = []
  const stream = new Writable({
    highWaterMark: 16,
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      setImmediate(callback)
    },
  })
  return { stream, chunks }
}

/** Failing sink: every write fails, simulating a downstream EPIPE. */
function createFailingSink() {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('EPIPE'))
    },
  })
  return stream
}

describe('writeAll (issue #12)', () => {
  it('resolves only after the slow sink has received every byte', async () => {
    const { stream, chunks } = createSlowSink()
    const input = 'x'.repeat(1024 * 1024 + 37)

    await writeAll(stream, input)

    const received = Buffer.concat(chunks)
    expect(received.equals(Buffer.from(input))).toBe(true)
  })

  it('resolves (does not reject or crash) when the downstream write fails with EPIPE', async () => {
    const stream = createFailingSink()

    await expect(writeAll(stream, 'hello')).resolves.toBeUndefined()
  })

  it('does not let an unhandled error event crash the process', async () => {
    const stream = createFailingSink()
    let crashed = false
    const onUncaught = () => {
      crashed = true
    }
    process.once('uncaughtException', onUncaught)

    await writeAll(stream, 'hello')
    // Give any stray 'error' event a tick to propagate before asserting.
    await new Promise((resolve) => setImmediate(resolve))

    process.removeListener('uncaughtException', onUncaught)
    expect(crashed).toBe(false)
  })

  it('resolves immediately for an empty string chunk', async () => {
    const stream = createFailingSink()
    await expect(writeAll(stream, '')).resolves.toBeUndefined()
  })

  it('resolves immediately for an empty Uint8Array chunk', async () => {
    const stream = createFailingSink()
    await expect(writeAll(stream, new Uint8Array(0))).resolves.toBeUndefined()
  })
})
