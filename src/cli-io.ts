/**
 * flush-safe stream write helper (issue #12).
 *
 * When stdout is a pipe, Node buffers writes asynchronously; `process.exit`
 * does not wait for libuv to flush that queue, so a large write can be
 * truncated if the process exits right after calling `stream.write`. Every
 * CLI exit path must `await writeAll(...)` before exiting so the callback
 * (which fires only once the chunk has actually been written) has run.
 */

export function writeAll(
  stream: NodeJS.WritableStream,
  chunk: string | Uint8Array,
): Promise<void> {
  if (chunk.length === 0) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    // Prevent an unhandled 'error' event (e.g. EPIPE when the downstream
    // reader closes the pipe) from crashing the process; the write
    // callback below already reports the failure, and per INV-5 veridelta
    // must never be worse than its absence.
    stream.once('error', () => {})
    stream.write(chunk, () => {
      resolve()
    })
  })
}
