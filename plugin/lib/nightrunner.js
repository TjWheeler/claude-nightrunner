// A run hands a note from one session to the
// next. On "continue" the hooks clear the session and submit the note as the
// next session's first prompt. Plain logic only; register.js does the I/O.

import { exhaustedWindows, classifyTurnEnd, RESUME_MARGIN_MS } from './usage.js'

export { classifyTurnEnd }

export const RUN_FILE = '.nightrunner/run.json'
export const GITIGNORE = '.nightrunner/.gitignore'
export const GITIGNORE_TEXT = '*\n'
export const OUTCOMES = ['continue', 'complete', 'blocked']
export const NOTE_LIMIT = 8000
export const DEFAULT_BUDGET = 200_000
// The user's saved settings, written by the configure tool: $HOME/USER_FILE.
export const USER_FILE = '.claude/nightrunner.json'
// The project's settings, committed with the repo (relative to its folder).
export const PROJECT_FILE = '.claude/nightrunner.json'

// Usage limits: wait for the reset unless it is further away than this.
export const MAX_WAIT_HOURS = 6
// No reset time reported: try again after this, within MAX_WAIT_HOURS overall.
export const RETRY_WAIT_MS = 30 * 60 * 1000

export const HANDOVER_TOOL = {
  name: 'handover',
  description:
    'Ends this session of a nightrunner run. Call it from the main session only, once per session, as the last action of your turn. ' +
    'outcome "continue": nightrunner clears the context and starts the next session with your note, so record what was done and what comes next. ' +
    '"blocked": a decision needs the user; ask them first, then call this, and the run stops. ' +
    '"complete": the work is done and the run stops.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: OUTCOMES, description: 'continue, complete or blocked.' },
      note: { type: 'string', description: `Required for continue, at most ${NOTE_LIMIT} characters: what you were doing, what is done and what comes next. The next session starts from it. Don't start it with "/".` },
    },
    required: ['outcome'],
    additionalProperties: false,
  },
}

export const STATUS_TOOL = {
  name: 'status',
  description:
    "Reports this session's context use against the nightrunner run's budget, and the run's session number. " +
    'Call it when deciding whether to start more work or hand over. Outside a run it still reports context use.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
}

export const CONFIGURE_TOOL = {
  name: 'configure',
  description:
    "Changes nightrunner's settings when the user asks you to. With no input it reports them. " +
    'defaultBudget saves the user\'s default context budget for every project ("150k", or "default" to go back to the built-in 200k). ' +
    'runBudget changes the budget of the run active in this folder. ' +
    'projectUsageWait sets whether runs in this project wait out a usage limit and carry on ("on", "off", or "default" to remove the project setting; it is written to .claude/nightrunner.json, which the user may commit). ' +
    'runUsageWait sets it for the active run. Only change what the user asked for. Main session only.',
  inputSchema: {
    type: 'object',
    properties: {
      defaultBudget: { type: 'string', description: 'The default context budget for all projects, such as "150k" or "300000"; "default" clears it to the built-in 200k.' },
      runBudget: { type: 'string', description: 'The context budget for the run active in this folder, such as "150k". Needs an active run.' },
      projectUsageWait: { type: 'string', enum: ['on', 'off', 'default'], description: "Whether this project's runs wait for a usage-limit reset and carry on. \"default\" removes the project setting (on)." },
      runUsageWait: { type: 'string', enum: ['on', 'off'], description: 'Whether the active run waits for a usage-limit reset and carries on. Needs an active run.' },
    },
    additionalProperties: false,
  },
}

/** Pick the configure tool's own fields off the hook event. */
export function configureInput(e) {
  const src = e?.input && typeof e.input === 'object' ? e.input : e ?? {}
  return { defaultBudget: src.defaultBudget, runBudget: src.runBudget, projectUsageWait: src.projectUsageWait, runUsageWait: src.runUsageWait }
}

/**
 * @returns {{ ok: true, value: { defaultBudget?: string, runBudget?: number } } | { ok: false, error: string }}
 * defaultBudget comes back as the option's stored text: "" clears it.
 */
export function validateConfigure({ defaultBudget, runBudget, projectUsageWait, runUsageWait } = {}, { runActive }) {
  const value = {}
  if (defaultBudget !== undefined) {
    const text = String(defaultBudget).trim()
    if (text === '' || /^default$/i.test(text)) value.defaultBudget = ''
    else {
      const n = parseTokens(text)
      if (n === null) return { ok: false, error: `defaultBudget must be a token count of at least 1000, such as 150k, or "default"; got "${defaultBudget}".` }
      value.defaultBudget = String(n)
    }
  }
  if (runBudget !== undefined) {
    const n = parseTokens(runBudget)
    if (n === null) return { ok: false, error: `runBudget must be a token count of at least 1000, such as 150k; got "${runBudget}".` }
    if (!runActive) return { ok: false, error: 'runBudget needs an active run, and none is active. The user starts one with /nightrunner start; defaultBudget sets the budget future runs start with.' }
    value.runBudget = n
  }
  if (projectUsageWait !== undefined) {
    if (/^default$/i.test(String(projectUsageWait).trim())) value.projectUsageWait = 'default'
    else {
      const v = parseOnOff(projectUsageWait)
      if (v === null) return { ok: false, error: `projectUsageWait must be on, off or default; got "${projectUsageWait}".` }
      value.projectUsageWait = v
    }
  }
  if (runUsageWait !== undefined) {
    const v = parseOnOff(runUsageWait)
    if (v === null) return { ok: false, error: `runUsageWait must be on or off; got "${runUsageWait}".` }
    if (!runActive) return { ok: false, error: 'runUsageWait needs an active run, and none is active. projectUsageWait sets it for future runs in this project.' }
    value.runUsageWait = v
  }
  return { ok: true, value }
}

export function setRunUsageWait(run, usageWait) {
  return { ...run, usageWait, usageWaitSource: 'set by configure' }
}

const onOff = v => (v ? 'on' : 'off')

/** A new budget for the active run; a fresh nudge is allowed under it. */
export function setRunBudget(run, budget) {
  return { ...run, budget, budgetSource: 'set by configure', nudgedIn: null }
}

/** What the configure tool reports: the default runs start with, and the active run's budget. */
export function configText(run, { saved, option, project } = {}) {
  const resolved = resolveBudget({ saved, option })
  const def = resolved.error
    ? `Default budget: ${resolved.error}`
    : resolved.source === 'default'
      ? `Default budget: not set, so runs use the built-in ${formatTokens(DEFAULT_BUDGET)}.`
      : `Default budget: ${formatTokens(resolved.budget)} (${resolved.source}).`
  const w = resolveUsageWait({ project })
  const wait = w.error
    ? `Usage-limit wait: ${w.error}`
    : `Usage-limit wait for this project: ${onOff(w.usageWait)} (${w.source === 'project' ? 'project file' : 'built-in default'}).`
  const current = isActive(run)
    ? `This folder's run: budget ${formatTokens(run.budget ?? DEFAULT_BUDGET)} (${run.budgetSource ?? 'default'}), usage-limit wait ${onOff(run.usageWait ?? true)} (${run.usageWaitSource ?? 'default'}).`
    : 'No run active in this folder.'
  return `${def}\n${wait}\n${current}\nA run started with /nightrunner start budget=… wait=on|off uses those instead.`
}

/** The host passes the tool's fields on the event, beside its own. */
export function handoverInput(e) {
  const src = e?.input && typeof e.input === 'object' ? e.input : e ?? {}
  return { outcome: src.outcome, note: src.note }
}

/** @returns {{ ok: true, value } | { ok: false, error: string }} */
export function validateHandover({ outcome, note } = {}) {
  if (!OUTCOMES.includes(outcome)) return { ok: false, error: `outcome must be one of ${OUTCOMES.join(', ')}.` }
  if (note !== undefined && typeof note !== 'string') return { ok: false, error: 'note must be text.' }
  const text = (note ?? '').trim()
  if (outcome === 'continue' && !text) return { ok: false, error: 'note is required for continue: what you were doing, what is done and what comes next.' }
  if (text.length > NOTE_LIMIT) return { ok: false, error: `note is ${text.length} characters; the limit is ${NOTE_LIMIT}. Keep detail in the repo and point to it.` }
  if (text.startsWith('/')) return { ok: false, error: 'note must not start with "/": the next session would read it as a command.' }
  return { ok: true, value: text ? { outcome, note: text } : { outcome } }
}

/** "150k", "150000" or a number to whole tokens; null if it isn't one. */
export function parseTokens(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1000 ? value : null
  const m = /^\s*(\d+(?:\.\d+)?)\s*(k)?\s*$/i.exec(String(value ?? ''))
  if (!m) return null
  const n = Math.round(Number(m[1]) * (m[2] ? 1000 : 1))
  return n >= 1000 ? n : null
}

/**
 * `/nightrunner start` arguments: `key=value` settings, everything else the name.
 * @returns {{ ok: true, name: string, budget?: number } | { ok: false, error: string }}
 */
export function parseStartArgs(words) {
  const name = []
  const out = { ok: true }
  for (const w of words.filter(Boolean)) {
    const eq = w.indexOf('=')
    if (eq < 0) { name.push(w); continue }
    const key = w.slice(0, eq)
    const value = w.slice(eq + 1)
    if (key === 'wait') {
      const wait = parseOnOff(value)
      if (wait === null) return { ok: false, error: `wait must be on or off; got "${value}".` }
      out.usageWait = wait
      continue
    }
    if (key !== 'budget') return { ok: false, error: `unknown setting "${key}". The run settings are budget (e.g. budget=150k) and wait (wait=on or wait=off).` }
    const budget = parseTokens(value)
    if (budget === null) return { ok: false, error: `budget must be a token count of at least 1000, such as 150k or 150000; got "${value}".` }
    out.budget = budget
  }
  out.name = name.join(' ')
  return out
}

const isSet = v => v !== undefined && v !== null && String(v).trim() !== ''

/**
 * The context budget: the run argument, then the saved default (the configure
 * tool's file), then the plugin option, then the built-in default.
 * @returns {{ budget: number, source: 'run' | 'saved default' | 'plugin option' | 'default' } | { error: string }}
 */
export function resolveBudget({ arg, saved, option }) {
  if (arg !== undefined) return { budget: arg, source: 'run' }
  if (isSet(saved)) {
    const budget = parseTokens(saved)
    if (budget === null) return { error: `the saved default budget "${saved}" in ~/${USER_FILE} isn't a token count of at least 1000. Ask Claude to set it again with the nightrunner configure tool, or pass budget= to start.` }
    return { budget, source: 'saved default' }
  }
  if (isSet(option)) {
    const budget = parseTokens(option)
    if (budget === null) return { error: `the contextBudget plugin option "${option}" isn't a token count of at least 1000, such as 150k. Fix it in /plugin, or pass budget= to start.` }
    return { budget, source: 'plugin option' }
  }
  return { budget: DEFAULT_BUDGET, source: 'default' }
}

/** "on"/"off" (or true/false, yes/no) to a boolean; null if it isn't one. */
export function parseOnOff(value) {
  if (typeof value === 'boolean') return value
  const v = String(value ?? '').trim().toLowerCase()
  if (['on', 'true', 'yes'].includes(v)) return true
  if (['off', 'false', 'no'].includes(v)) return false
  return null
}

/**
 * Whether to wait out a usage limit: the run argument, then the project file,
 * then on.
 * @returns {{ usageWait: boolean, source: 'run' | 'project' | 'default' } | { error: string }}
 */
export function resolveUsageWait({ arg, project }) {
  if (arg !== undefined) return { usageWait: arg, source: 'run' }
  if (project !== undefined && project !== null) {
    const v = parseOnOff(project)
    if (v === null) return { error: `usageWait in ${PROJECT_FILE} must be true or false; got ${JSON.stringify(project)}.` }
    return { usageWait: v, source: 'project' }
  }
  return { usageWait: true, source: 'default' }
}

/** The user file's settings; anything unreadable counts as none. */
export function parseUserFile(text) {
  try {
    const j = JSON.parse(text)
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

/** The user file with contextBudget set, or removed when value is "". */
export function userFileText(current, value) {
  return settingsFileText(current, 'contextBudget', value === '' ? undefined : value)
}

/** A settings file (user or project) with one key set, or removed when undefined. */
export function settingsFileText(current, key, value) {
  const next = { ...current }
  if (value === undefined) delete next[key]
  else next[key] = value
  return JSON.stringify(next, null, 2) + '\n'
}

export function newRun({ name = '', budget = DEFAULT_BUDGET, budgetSource = 'default', usageWait = true, usageWaitSource = 'default', now }) {
  return {
    version: 1, active: true, name, budget, budgetSource, usageWait, usageWaitSource,
    startedAt: new Date(now).toISOString(), session: 1, handedOverIn: null, nudgedIn: null, pendingNote: null,
    waitUntil: null, waitingSince: null, endedAt: null, endReason: null,
  }
}

/**
 * After a usage-limit stop: wait to the reset plus a margin, retry later if no
 * reset time is known, or stop when the wait would pass MAX_WAIT_HOURS overall.
 * @returns {{ action: 'wait', until: string, ms: number, why: string } | { action: 'stop', reason: string }}
 */
export function planUsageWait({ rateLimits = [], now, waitingSince = null }) {
  const since = waitingSince ? Date.parse(waitingSince) : now
  const leftMs = since + MAX_WAIT_HOURS * 3600 * 1000 - now
  const full = exhaustedWindows(rateLimits).map(w => ({ kind: w.kind, t: Date.parse(w.resetsAt ?? '') }))
  if (full.length && full.every(w => Number.isFinite(w.t))) {
    const last = full.reduce((a, w) => (w.t > a.t ? w : a))
    const until = Math.max(last.t, now) + RESUME_MARGIN_MS
    if (until - now > leftMs) {
      return { action: 'stop', reason: `usage limit: the ${last.kind} limit resets at ${new Date(last.t).toISOString()}, beyond the ${MAX_WAIT_HOURS}-hour maximum wait` }
    }
    return { action: 'wait', until: new Date(until).toISOString(), ms: until - now, why: `the ${last.kind} usage limit resets` }
  }
  if (leftMs < RETRY_WAIT_MS) return { action: 'stop', reason: `usage limit: no reset time was reported, and the run has waited ${MAX_WAIT_HOURS} hours` }
  return { action: 'wait', until: new Date(now + RETRY_WAIT_MS).toISOString(), ms: RETRY_WAIT_MS, why: 'no reset time was reported, so nightrunner tries again' }
}

export function startWait(run, { until, now }) {
  return { ...run, waitUntil: until, waitingSince: run.waitingSince ?? new Date(now).toISOString() }
}

/** The wait is over (the timer fired, or a turn succeeded). */
export function endWait(run, { succeeded = false } = {}) {
  return { ...run, waitUntil: null, waitingSince: succeeded ? null : run.waitingSince }
}

export const isWaiting = run => isActive(run) && Boolean(run.waitUntil)

export function resumePrompt() {
  return (
    '[nightrunner] The usage limit has reset, so this run carries on. Your last turn was cut off by the limit, ' +
    'and any sub-agent work in flight may have been lost: check the working tree, then continue from where you were. ' +
    'If a handover prompt above went unanswered, follow it now.'
  )
}

/**
 * At the end of a main-session turn: if paid overage is in use (a window past
 * its limit, or a turn that got through with one at it), the run ends.
 * @returns the ended run, or null when the run carries on
 */
export function overageStop(run, { reason, stopFailureError, rateLimits = [], now }) {
  if (!isActive(run)) return null
  if (classifyTurnEnd({ reason, stopFailureError, rateLimits }) !== 'overage') return null
  const w = exhaustedWindows(rateLimits).reduce((a, b) => (b.percentUsed > a.percentUsed ? b : a))
  return endRun(run, `paid overage: the ${w.kind} usage limit is at ${w.percentUsed}%, so further turns would be billed as overage`, now)
}

/** One nudge per session, once context reaches the budget and no handover is recorded. */
export function shouldNudge(run, { tokens, sessionId }) {
  return isActive(run) && typeof tokens === 'number' && tokens >= (run.budget ?? DEFAULT_BUDGET) &&
    run.handedOverIn !== sessionId && run.nudgedIn !== sessionId
}

export function nudgePrompt(run, tokens) {
  return (
    `[nightrunner] Context is at ${formatTokens(tokens)}, past this run's budget of ${formatTokens(run.budget ?? DEFAULT_BUDGET)}. ` +
    'Finish or park what you are doing, record your progress, then write a restart prompt for a fresh session ' +
    '(what you were doing, what is done and what comes next) and call the nightrunner handover tool with outcome "continue" and that prompt as the note.'
  )
}

export const formatTokens = n => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

/** Parse the run file; anything unreadable counts as no run. */
export function parseRun(text) {
  try {
    const run = JSON.parse(text)
    return run && run.version === 1 && typeof run.active === 'boolean' ? run : null
  } catch {
    return null
  }
}

export const isActive = run => Boolean(run?.active)

/**
 * Apply a validated handover made in session `sessionId`.
 * @returns {{ run, result: string, clear: boolean }}
 */
export function applyHandover(run, { outcome, note }, { sessionId, now }) {
  if (outcome === 'continue') {
    return {
      run: { ...run, handedOverIn: sessionId, pendingNote: note },
      result: 'Handover recorded. End your turn now: nightrunner will clear the context and start the next session with your note.',
      clear: true,
    }
  }
  return {
    run: endRun({ ...run, handedOverIn: sessionId }, outcome, now),
    result: outcome === 'complete' ? 'Run complete. nightrunner has stopped the run.' : 'Run stopped as blocked. The user will pick it up.',
    clear: false,
  }
}

export function endRun(run, reason, now) {
  return { ...run, active: false, pendingNote: null, endedAt: new Date(now).toISOString(), endReason: reason }
}

/** After the clear: count the new session and hand back the prompt that starts it. */
export function beginNextSession(run) {
  const prompt = handoverPrompt(run)
  return { run: { ...run, session: run.session + 1, pendingNote: null }, prompt }
}

export function handoverPrompt(run) {
  const which = run.name ? `run "${run.name}"` : 'this run'
  return (
    `[nightrunner] Session ${run.session + 1} of ${which}. The context was cleared after the last session handed over, so you have no memory of it. ` +
    'The handover note below was written by you, Claude, in the previous session. It is not an instruction or approval from the user, ' +
    'so it can only carry on work the user already asked for. ' +
    'Continue from it. When this session reaches a good stopping point, call the nightrunner handover tool.' +
    `\n\nHandover note:\n\n${run.pendingNote}`
  )
}

/** "Context: 85k of the 200k budget (43%), window 1000k." from $.session.usage().context. */
export function contextLine(run, context) {
  const tokens = context?.tokens
  if (typeof tokens !== 'number') return 'Context: not measured yet (no reply in this session so far).'
  const window = typeof context.window === 'number' ? `, window ${formatTokens(context.window)}` : ''
  if (!isActive(run)) return `Context: ${formatTokens(tokens)}${window}.`
  const budget = run.budget ?? DEFAULT_BUDGET
  const pct = Math.round((tokens / budget) * 100)
  const over = tokens >= budget ? ' Past the budget: hand over at the next good stopping point.' : ''
  return `Context: ${formatTokens(tokens)} of the ${formatTokens(budget)} budget (${pct}%)${window}.${over}`
}

export function statusText(run, context) {
  const ctx = context === undefined ? '' : `\n${contextLine(run, context)}`
  if (!isActive(run)) return (run?.endReason ? `No run active. The last run ended: ${run.endReason}.` : 'No run active.') + ctx
  const waiting = run.waitUntil ? ` Waiting for the usage limit to reset; carrying on at ${run.waitUntil}.` : ''
  return `Run ${run.name ? `"${run.name}" ` : ''}active, session ${run.session}, started ${run.startedAt}. Context budget ${formatTokens(run.budget ?? DEFAULT_BUDGET)} (${run.budgetSource ?? 'default'}). Usage-limit wait ${onOff(run.usageWait ?? true)} (${run.usageWaitSource ?? 'default'}).${waiting}` + ctx
}

export const NO_RUN = 'No nightrunner run is active, so there is nothing to hand over. Start one with /nightrunner start.'
export const SUBAGENT = 'handover is for the main session only. Report back to the main session instead.'
export const ALREADY = 'This session has already handed over. End your turn now.'
