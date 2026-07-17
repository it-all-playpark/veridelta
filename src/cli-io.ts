/**
 * flush-safe stream write helper (issue #12).
 *
 * When stdout is a pipe, Node buffers writes asynchronously; `process.exit`
 * does not wait for libuv to flush that queue, so a large write can be
 * truncated if the process exits right after calling `stream.write`. Every
 * CLI exit path must `await writeAll(...)` before exiting so the callback
 * (which fires only once the chunk has actually been written) has run.
 */

// Streams for which the persistent no-op 'error' listener below has already
// been registered. Without this guard, every writeAll() call would add
// another listener and never remove it, leaking listeners on long-lived
// streams such as process.stdout/process.stderr (MaxListenersExceededWarning
// on stderr would itself violate the "diagnostics are stderr-only" CLI
// contract).
const streamsWithErrorGuard = new WeakSet<NodeJS.WritableStream>()

function ensureErrorGuard(stream: NodeJS.WritableStream): void {
  if (streamsWithErrorGuard.has(stream)) {
    return
  }
  streamsWithErrorGuard.add(stream)
  // Prevent an unhandled 'error' event (e.g. EPIPE when the downstream
  // reader closes the pipe) from crashing the process. Per INV-5, veridelta
  // must never be worse than its absence, so a downstream pipe closing early
  // must not itself crash the CLI. This listener only silences the event;
  // the write callback below is what actually reports write failures.
  stream.on('error', () => {})
}

export function writeAll(
  stream: NodeJS.WritableStream,
  chunk: string | Uint8Array,
): Promise<void> {
  if (chunk.length === 0) {
    return Promise.resolve()
  }
  ensureErrorGuard(stream)
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => {
      // EPIPE (downstream reader closed the pipe) degrades to a silent
      // no-op per INV-5. Any other write failure (e.g. ENOSPC on a
      // redirected file) is a genuine failure to deliver the report/output
      // and must propagate so the caller's exit code reflects it.
      if (err && (err as NodeJS.ErrnoException).code !== 'EPIPE') {
        reject(err)
        return
      }
      resolve()
    })
  })
}
