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

/**
 * Failing sink: every write fails with the given error, simulating a
 * downstream failure such as EPIPE or ENOSPC.
 */
function createFailingSink(err: NodeJS.ErrnoException) {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback(err)
    },
  })
  return stream
}

function epipeError(): NodeJS.ErrnoException {
  const err = new Error('EPIPE') as NodeJS.ErrnoException
  err.code = 'EPIPE'
  return err
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
    const stream = createFailingSink(epipeError())

    await expect(writeAll(stream, 'hello')).resolves.toBeUndefined()
  })

  it('rejects when the downstream write fails with a non-EPIPE error (e.g. ENOSPC)', async () => {
    const err = new Error('ENOSPC') as NodeJS.ErrnoException
    err.code = 'ENOSPC'
    const stream = createFailingSink(err)

    await expect(writeAll(stream, 'hello')).rejects.toThrow('ENOSPC')
  })

  it('does not let an unhandled error event crash the process', async () => {
    const stream = createFailingSink(epipeError())
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

  it('does not accumulate error listeners across repeated calls on the same stream', async () => {
    // A stream whose writes succeed, mirroring the common case (repeated
    // writes to process.stdout/process.stderr across many exit paths):
    // regardless of write outcome, only one persistent 'error' listener
    // should ever be registered per stream (issue #12 review follow-up).
    const chunks: Buffer[] = []
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk))
        callback()
      },
    })

    for (let i = 0; i < 12; i++) {
      await writeAll(stream, 'hello')
    }

    expect(stream.listenerCount('error')).toBe(1)
  })

  it('resolves immediately for an empty string chunk', async () => {
    const stream = createFailingSink(epipeError())
    await expect(writeAll(stream, '')).resolves.toBeUndefined()
  })

  it('resolves immediately for an empty Uint8Array chunk', async () => {
    const stream = createFailingSink(epipeError())
    await expect(writeAll(stream, new Uint8Array(0))).resolves.toBeUndefined()
  })
})
