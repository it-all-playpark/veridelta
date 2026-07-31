/**
 * The adapter registry: the one place the core is allowed to know which
 * concrete adapters exist. A static array in a fixed order — no registration
 * API until adapters become external plugins.
 *
 * Detection is deliberately *total*: every adapter's `detect` is evaluated and
 * the outcome distinguishes zero, one, and several matches, because only the
 * registry can tell "no adapter recognizes this argv" (a wrapper command such
 * as `pnpm test`) from "this adapter is not the one". Zero and ambiguous both
 * stay recordable-but-degraded at the call site, never a hard failure (INV-5).
 */
import type { Adapter, CaptureChannel, DetectResult } from '../adapter.js'
import { playwrightAdapter } from './playwright/adapter.js'
import { vitestAdapter } from './vitest/adapter.js'

/** Every known adapter, in a deterministic order. */
export const ADAPTERS: readonly Adapter[] = [vitestAdapter, playwrightAdapter]

/** Known adapter names, in registry order — for diagnostics and `--adapter`. */
export function adapterNames(
  adapters: readonly Adapter[] = ADAPTERS,
): readonly string[] {
  return adapters.map((a) => a.name)
}

/**
 * Look an adapter up by name without failing. Callers that must stay
 * fail-closed rather than abort — the comparator and the gate, which resolve
 * `record.instrument.adapter` from records they did not write — use this.
 */
export function findAdapter(
  name: string,
  adapters: readonly Adapter[] = ADAPTERS,
): Adapter | undefined {
  return adapters.find((a) => a.name === name)
}

/**
 * Resolve an explicitly requested adapter name. An unknown name is user input
 * error, not a degradation path: silently passing through would turn a typo
 * into a silent loss of recording, which is the opposite of INV-5's intent.
 */
export function resolveAdapter(
  name: string,
  adapters: readonly Adapter[] = ADAPTERS,
): Adapter {
  const adapter = findAdapter(name, adapters)
  if (adapter === undefined) {
    throw new Error(
      `unknown adapter '${name}' — known adapters: ${adapterNames(adapters).join(', ')}`,
    )
  }
  return adapter
}

/**
 * The env additions every registered adapter needs to find the channel, in
 * registry order. Exported to the child unconditionally, detection or no
 * detection: a reporter configured in the project itself (spec §4.2 ambient
 * recording) is inert without it, and pre-seam `vdelta run` set it on every
 * child for exactly that reason.
 *
 * Later adapters win on a colliding name. With one single-file channel that
 * collision is the F-2 hazard, not a decision this function can make.
 */
export function ambientChannelEnv(
  channel: CaptureChannel,
  adapters: readonly Adapter[] = ADAPTERS,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const adapter of adapters) {
    Object.assign(env, adapter.channelEnv(channel))
  }
  return env
}

/**
 * Which adapter owns the capture that landed in the channel, or `null` when
 * none claims it. The ambient counterpart of {@link detectAdapter}: the argv
 * said nothing, so the payload decides.
 *
 * Registry order breaks a tie. Two adapters claiming one capture would mean
 * two reporters wrote to the same single-file channel, which is the F-2
 * last-writer-wins hazard rather than an ambiguity the user could resolve —
 * there is no argv to name a winner with, so degrading here would discard a
 * capture that is genuinely present.
 */
export function claimCapture(
  channel: CaptureChannel,
  adapters: readonly Adapter[] = ADAPTERS,
): Adapter | null {
  return adapters.find((a) => a.claimsCapture(channel)) ?? null
}

/**
 * Outcome of evaluating every adapter's `detect` against one child argv.
 * `none` and `ambiguous` are both "the registry declines to choose": the
 * caller degrades to raw passthrough and says why.
 */
export type AdapterDetection =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'unique'
      readonly adapter: Adapter
      readonly detected: DetectResult
    }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly Adapter[] }

/**
 * Evaluate *all* adapters against the argv. Never short-circuits on the first
 * match: two adapters claiming the same argv is a distinguishable outcome that
 * must reach the user as a candidate list, not be hidden by registry order.
 */
export function detectAdapter(
  argv: readonly string[],
  adapters: readonly Adapter[] = ADAPTERS,
): AdapterDetection {
  const matches: { adapter: Adapter; detected: DetectResult }[] = []
  for (const adapter of adapters) {
    const detected = adapter.detect(argv)
    if (detected !== null) matches.push({ adapter, detected })
  }
  if (matches.length === 0) return { kind: 'none' }
  if (matches.length > 1)
    return { kind: 'ambiguous', candidates: matches.map((m) => m.adapter) }
  const only = matches[0]!
  return { kind: 'unique', adapter: only.adapter, detected: only.detected }
}
