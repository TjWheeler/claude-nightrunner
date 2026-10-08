// The run state machine (build plan decisions 5–7, 10; D-12, D-18, D-21 –
// D-23, D-26, Q-6, Q-7). Every function is pure: it takes the run record and
// returns a new one plus the action the hooks layer should take.

export const SCHEMA_VERSION = 1
export const HEARTBEAT_MS = 60 * 1000
export const STALE_MS = 3 * 60 * 1000
export const MAX_NUDGES = 3
export const BUILTIN_PROTECTED = ['main', 'master']
export const OUTCOMES = ['continue', 'blocked', 'complete', 'error']

// Why a run ended, and the outcome it is reported as.
export const END_REASONS = {
  blocked: 'blocked',
  complete: 'complete',
  error: 'error',
  stopped: 'stopped',
  'session-limit': 'error',
  'no-progress': 'error',
  'nudge-limit': 'error',
  'hard-stop-no-handover': 'error',
  'wrong-model': 'error',
  'usage-wait-too-long': 'error',
  overage: 'error',
  'start-failed': 'error',
}

const iso = now => new Date(now).toISOString()

/** `YYYYMMDD-HHMMSS-<4 hex>` in UTC (decision 5). */
export function newRunId(now, hex4) {
  if (!/^[0-9a-f]{4}$/.test(hex4)) throw new Error('hex4 must be four lowercase hex digits')
  const s = iso(now)
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}-${hex4}`
}

export function isValidRunId(id) {
  return /^\d{8}-\d{6}-[0-9a-f]{4}$/.test(String(id))
}

export function isProtectedBranch(branch, extra = [], remoteDefault) {
  const list = new Set([...BUILTIN_PROTECTED, ...extra, ...(remoteDefault ? [remoteDefault] : [])])
  return list.has(branch)
}

/**
 * Who owns a run on disk, seen from this process.
 * @returns {'none' | 'mine' | 'elsewhere' | 'stale' | 'suspended'}
 */
export function ownership(run, { now, pid }) {
  if (!run || run.status === 'ended') return 'none'
  if (run.status === 'suspended') return 'suspended'
  if (run.ownerPid === pid) return 'mine'
  const beat = Date.parse(run.heartbeatAt ?? '')
  if (!Number.isFinite(beat) || now - beat > STALE_MS) return 'stale'
  return 'elsewhere'
}

/**
 * The checks `/nightrunner start` and `/nightrunner resume` run.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function startChecks({ config, branch, detached, remoteDefault, existing, now, pid, resuming = false }) {
  const errors = []
  if (config && !config.ok) errors.push(...config.errors)
  if (detached || !branch) {
    errors.push('HEAD is detached. Check out a branch for the run first; nightrunner never creates one.')
  } else if (isProtectedBranch(branch, config?.settings?.protectedBranches ?? [], remoteDefault)) {
    errors.push(`"${branch}" is a protected branch. Check out a working branch for the run first; nightrunner never creates one.`)
  }
  const owner = ownership(existing, { now, pid })
  if (resuming) {
    if (!existing || existing.status === 'ended') errors.push('There is no suspended run to resume.')
    else if (owner === 'elsewhere') errors.push(`Run ${existing.id} is active in another Claude Code process.`)
    else if (existing.status !== 'suspended' && owner !== 'stale') errors.push(`Run ${existing.id} is already running here.`)
    else if (existing.sessionCount >= existing.settings.sessionLimit) errors.push(`Run ${existing.id} has used all ${existing.settings.sessionLimit} sessions.`)
    else if (branch && existing.branch !== branch) errors.push(`Run ${existing.id} ran on "${existing.branch}", but "${branch}" is checked out.`)
  } else if (owner === 'elsewhere') {
    errors.push(`Run ${existing.id} is active in another Claude Code process. Stop it there first.`)
  } else if (owner === 'mine') {
    errors.push(`Run ${existing.id} is already active in this session.`)
  } else if (owner === 'suspended' || owner === 'stale') {
    errors.push(`Run ${existing.id} is suspended. Use /nightrunner resume to carry it on, or /nightrunner stop to end it.`)
  }
  return { ok: errors.length === 0, errors }
}

export function createRun({ id, name, settings, sources, removals = [], branch, startHead, now, pid, sessionId, preCommitHook = null }) {
  return {
    version: SCHEMA_VERSION,
    id,
    name: name || null,
    status: 'active',
    endReason: null,
    endedAt: null,
    settings,
    sources,
    removals,
    branch,
    startHead,
    preCommitHook,
    startedAt: iso(now),
    sessionCount: 1,
    noProgressCount: 0,
    session: newSession(1, sessionId, startHead, now),
    lastHandover: null,
    lastProgressMarker: null,
    stopRequested: false,
    waitUntil: null,
    afterWait: false,
    ownerPid: pid,
    heartbeatAt: iso(now),
  }
}

function newSession(number, id, startHead, now) {
  return { number, id, startHead, startedAt: iso(now), handover: null, nudges: 0, hardStop: null, peakContext: 0 }
}

export function heartbeat(run, { now, pid }) {
  return { ...run, ownerPid: pid, heartbeatAt: iso(now) }
}

export function endRun(run, reason, now) {
  if (!(reason in END_REASONS)) throw new Error(`unknown end reason ${reason}`)
  return { ...run, status: 'ended', endReason: reason, endedAt: iso(now), waitUntil: null }
}

export function reportedOutcome(reason) {
  return END_REASONS[reason]
}

/** Every outcome but the user's own stop is notified (D-29). */
export function shouldNotify(run) {
  return run.status === 'ended' && run.endReason !== 'stopped' && run.settings.notifications === 'push'
}

/**
 * Whether a session made progress (D-26).
 * @param {{ phaseCommits: boolean, runCommits: number, marker?: string|null, lastMarker?: string|null }} p
 */
export function progressMade({ phaseCommits, runCommits = 0, marker, lastMarker }) {
  if (phaseCommits) return runCommits > 0
  return typeof marker === 'string' && marker !== '' && marker !== lastMarker
}

/**
 * Apply a handover the tools layer has already validated.
 * @returns {{ run, action: 'clear' | 'end', endReason?: string }}
 */
export function applyHandover(run, handover, { sessionId, runCommits = 0, now }) {
  const recorded = { ...handover, sessionNumber: run.session.number, sessionId, at: iso(now) }
  const progressed = progressMade({
    phaseCommits: run.settings.phaseCommits,
    runCommits,
    marker: handover.progress,
    lastMarker: run.lastProgressMarker,
  })
  let next = {
    ...run,
    lastHandover: recorded,
    lastProgressMarker: handover.progress ?? run.lastProgressMarker,
    session: { ...run.session, handover: recorded, progressed, runCommits },
    noProgressCount: progressed ? 0 : run.noProgressCount + 1,
  }
  if (handover.outcome !== 'continue') {
    return { run: endRun(next, handover.outcome, now), action: 'end', endReason: handover.outcome }
  }
  const stop = reason => ({ run: endRun(next, reason, now), action: 'end', endReason: reason })
  if (run.stopRequested) return stop('stopped')
  if (next.noProgressCount >= run.settings.noProgressLimit) return stop('no-progress')
  if (run.sessionCount >= run.settings.sessionLimit) return stop('session-limit')
  return { run: next, action: 'clear' }
}

/** The fresh session after a clear (or a resume). */
export function beginSession(run, { sessionId, head, now }) {
  const number = run.sessionCount + 1
  return { ...run, sessionCount: number, session: newSession(number, sessionId, head, now) }
}

/**
 * A turn starts. Nudges count only while nothing but a nudge starts turns.
 */
export function onTurnStart(run, { byNudge }) {
  if (byNudge) return run
  return { ...run, session: { ...run.session, nudges: 0 } }
}

/**
 * The idle timer fired: no turn running and no handover this session.
 * @returns {{ run, action: 'nudge' | 'end' | 'none', endReason?: string }}
 */
export function onIdle(run, { now }) {
  if (run.status !== 'active' || run.session.handover) return { run, action: 'none' }
  if (run.session.nudges >= MAX_NUDGES) {
    return { run: endRun(run, 'nudge-limit', now), action: 'end', endReason: 'nudge-limit' }
  }
  return { run: { ...run, session: { ...run.session, nudges: run.session.nudges + 1 } }, action: 'nudge' }
}

/**
 * A model request reported its context size.
 * @returns {{ run, action: 'abort' | 'none' }}
 */
export function onContext(run, tokens) {
  if (run.status !== 'active') return { run, action: 'none' }
  const peak = Math.max(run.session.peakContext, tokens || 0)
  let next = peak === run.session.peakContext ? run : { ...run, session: { ...run.session, peakContext: peak } }
  if (tokens >= run.settings.hardStopTokens && !next.session.hardStop && !next.session.handover) {
    next = { ...next, session: { ...next.session, hardStop: 'aborting' } }
    return { run: next, action: 'abort' }
  }
  return { run: next, action: 'none' }
}

/**
 * A main-session turn ended. Drives the hard stop (D-22).
 * @returns {{ run, action: 'clear' | 'hard-stop-prompt' | 'end' | 'idle', endReason?: string }}
 */
export function onTurnComplete(run, { now }) {
  if (run.status !== 'active') return { run, action: 'none' }
  if (run.session.handover) return { run, action: 'clear' }
  if (run.session.hardStop === 'aborting') {
    return { run: { ...run, session: { ...run.session, hardStop: 'prompted' } }, action: 'hard-stop-prompt' }
  }
  if (run.session.hardStop === 'prompted') {
    return { run: endRun(run, 'hard-stop-no-handover', now), action: 'end', endReason: 'hard-stop-no-handover' }
  }
  return { run, action: 'idle' }
}

/**
 * The user asked to stop. With no turn running (or while waiting) the run ends
 * now; otherwise at the next handover (acceptance 11).
 */
export function requestStop(run, { turnRunning, now }) {
  if (run.status === 'waiting' || run.status === 'suspended' || !turnRunning) {
    return { run: endRun(run, 'stopped', now), action: 'end', endReason: 'stopped' }
  }
  return { run: { ...run, stopRequested: true }, action: 'flagged' }
}

export function enterWait(run, { until }) {
  return { ...run, status: 'waiting', waitUntil: until }
}

/** The wait is over: the same session carries on (no handover, so no clear: D-22). */
export function finishWait(run) {
  return { ...run, status: 'active', waitUntil: null, afterWait: true, session: { ...run.session, nudges: 0, hardStop: null } }
}

export function suspend(run) {
  return { ...run, status: 'suspended' }
}

/**
 * Carry on a suspended run in this process (D-21): a new session that starts
 * from the last recorded handover.
 */
export function resumeRun(run, { sessionId, head, now, pid }) {
  const wasWaiting = run.status === 'waiting' || !!run.waitUntil
  const next = beginSession({ ...run, status: 'active', waitUntil: null, stopRequested: false, afterWait: wasWaiting }, { sessionId, head, now })
  return heartbeat(next, { now, pid })
}

/** The answering model matches the pin (D-23). A date suffix or a [1m] tag is the same model. */
export function modelMatches(pinned, answered) {
  if (!answered) return true
  const strip = m => String(m).replace(/\[[^\]]*\]$/, '').toLowerCase()
  const p = strip(pinned)
  const a = strip(answered)
  return a === p || (a.startsWith(p + '-') && /^-\d{8}$/.test(a.slice(p.length)))
}
