// Usage limits (Q-5, D-25; build plan decision 10). A usage-limit stop is a
// turn that ended in error (or a StopFailure with `rate_limit`) while a
// rate-limit window reads 100% with a reset time. The run waits until the
// latest such reset plus a margin, unless that is beyond the maximum wait.
// A window past 100%, or one at 100% while turns still succeed, means paid
// overage is in use, and the run stops: overage is never entered.

export const RESUME_MARGIN_MS = 2 * 60 * 1000

/** Windows at or past their limit. */
export function exhaustedWindows(rateLimits = []) {
  return (rateLimits ?? []).filter(w => typeof w?.percentUsed === 'number' && w.percentUsed >= 100)
}

/**
 * Classify how a turn ended.
 * @param {{ reason: string, stopFailureError?: string, rateLimits?: object[] }} e
 * @returns {'ok' | 'usage-limit' | 'overage' | 'error'}
 */
export function classifyTurnEnd({ reason, stopFailureError, rateLimits = [] }) {
  const full = exhaustedWindows(rateLimits)
  if (full.some(w => w.percentUsed > 100)) return 'overage'
  const failed = reason === 'error' || stopFailureError === 'rate_limit'
  if (failed && (full.length || stopFailureError === 'rate_limit')) return 'usage-limit'
  if (failed) return 'error'
  // A turn that succeeded with a window at its limit is being paid for.
  if (full.length) return 'overage'
  return 'ok'
}

/**
 * Plan the wait after a usage-limit stop.
 * @returns {{ action: 'wait', until: string, ms: number, window: string }
 *         | { action: 'stop', reason: string }}
 */
export function planWait({ rateLimits = [], now = Date.now(), maxWaitHours, marginMs = RESUME_MARGIN_MS }) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now)
  const full = exhaustedWindows(rateLimits)
  if (!full.length) return { action: 'stop', reason: 'a usage limit stopped the run but no window reports a reset time' }
  let latest = null
  for (const w of full) {
    const t = Date.parse(w.resetsAt ?? '')
    if (!Number.isFinite(t)) return { action: 'stop', reason: `the ${w.kind} limit is reached and reports no reset time` }
    if (!latest || t > latest.t) latest = { t, kind: w.kind }
  }
  const until = Math.max(latest.t, nowMs) + marginMs
  const ms = until - nowMs
  if (ms > maxWaitHours * 3600 * 1000) {
    return { action: 'stop', reason: `the ${latest.kind} limit resets at ${new Date(latest.t).toISOString()}, beyond the ${maxWaitHours}-hour maximum wait` }
  }
  return { action: 'wait', until: new Date(until).toISOString(), ms, window: latest.kind }
}

/** Milliseconds left of a recorded wait, never negative. */
export function remainingWait(until, now = Date.now()) {
  const t = Date.parse(until)
  if (!Number.isFinite(t)) return 0
  return Math.max(0, t - (typeof now === 'number' ? now : Date.parse(now)))
}
