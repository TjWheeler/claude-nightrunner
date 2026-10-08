// The hooks. /nightrunner start begins a run; the
// handover tool's "continue" clears the session once the turn ends and submits
// the note as the next session's first prompt. When context passes the run's
// budget, one prompt per session asks Claude to hand over. When a usage limit
// stops a turn, the run waits for the reset and carries on (unless the run's
// usageWait is off). Each tab owns at most one run, in its own file, so tabs
// in one folder can each run one. With no run active, nothing here changes
// anything. The logic is in ../lib/nightrunner.js.

import {
  RUNS_DIR, LEGACY_RUN_FILE, HEARTBEAT_MS, runFile, newRunId, claimRun, ownedByOther, migrateLegacyRun,
  runForSession, findResumable, otherRunsText, GITIGNORE, GITIGNORE_TEXT, HANDOVER_TOOL, STATUS_TOOL, CONFIGURE_TOOL, START_TOOL, startInput, validateStart, notificationText, notificationRecord, resolveNotify, setRunNotify, NO_RUN, SUBAGENT, ALREADY, USER_FILE, PROJECT_FILE,
  handoverInput, validateHandover, newRun, parseRun, isActive, applyHandover,
  endRun, beginNextSession, statusText, parseStartArgs, resolveBudget,
  shouldNudge, nudgePrompt, formatTokens, configureInput, validateConfigure, setRunBudget,
  configText, parseUserFile, userFileText, settingsFileText, resolveUsageWait, setRunUsageWait,
  classifyTurnEnd, planUsageWait, startWait, endWait, isWaiting, resumePrompt, overageStop,
} from '../lib/nightrunner.js'

const HANDOVER = 'mcp__nightrunner__handover'
const STATUS = 'mcp__nightrunner__status'
const CONFIGURE = 'mcp__nightrunner__configure'
const START = 'mcp__nightrunner__start'
const HELP = '/nightrunner start [name] [budget=150k] [wait=on|off] [notify=on|off] | stop | status | resume [name|id]'

// Which tab owns a run: a token for this process, kept in the run's file.
const owner = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

let run = null // this tab's run
let options = {}
let loaded = false
let clearPending = false // a continue was recorded; clear when the turn ends
let startPending = false // the clear ran; submit the note when the session ends
let writing = Promise.resolve()
let waitTimer = null // the pending resume after a usage limit

// Writes are queued: overlapping whole-file writes corrupted a probe log.
// Top-level because the mods loader only lets $ be passed to such functions.
// A run another tab has taken over is let go, never written, unless this
// write is the claim that takes it.
async function save($, { claim = false } = {}) {
  const snapshot = run
  if (!snapshot?.id) return writing
  writing = writing.then(async () => {
    let onDisk = null
    if (!claim) try { onDisk = parseRun(await $.fs.read(runFile(snapshot.id))) } catch {}
    if (ownedByOther(onDisk, owner)) return letGo($, snapshot.id)
    await $.fs.write(runFile(snapshot.id), JSON.stringify(snapshot, null, 2) + '\n')
  }).catch(() => {})
  return writing
}

// Another tab took this run over with /nightrunner resume.
function letGo($, id) {
  if (run?.id !== id) return
  run = { ...run, active: false, endReason: 'taken over by another tab' }
  clearPending = startPending = false
  if (waitTimer) { waitTimer.cancel(); waitTimer = null }
  try { $.ui.invalidate('tool.describe') } catch {}
}

// The tab is still here: record it, and the session the run is now in.
async function heartbeat($) {
  if (!isActive(run)) return
  try {
    run = { ...run, heartbeatAt: new Date().toISOString(), sessionId: await $.session.id() }
    await save($)
  } catch {}
}

// A run file, read again after a moment if it was caught mid-write by its tab.
async function readRunFile($, path) {
  for (let tries = 0; tries < 2; tries++) {
    try {
      const r = parseRun(await $.fs.read(path))
      if (r) return r
    } catch {}
    if (!tries) await $.clock.sleep(100)
  }
  return null
}

// Every run in this folder, after moving one left by an older version.
async function readRuns($) {
  try {
    const legacy = parseRun(await $.fs.read(LEGACY_RUN_FILE))
    if (isActive(legacy)) {
      const moved = migrateLegacyRun(legacy)
      await $.fs.write(runFile(moved.id), JSON.stringify(moved, null, 2) + '\n')
      await $.fs.write(LEGACY_RUN_FILE, JSON.stringify(endRun(legacy, `moved to ${runFile(moved.id)}`, Date.now()), null, 2) + '\n')
    }
  } catch {}
  const runs = []
  try {
    for (const entry of await $.fs.list(RUNS_DIR)) {
      if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
      const r = await readRunFile($, `${RUNS_DIR}/${entry.name}`)
      if (r?.id) runs.push(r)
    }
  } catch {}
  return runs
}

// Take a run over in this tab. A recorded handover that never got its clear
// starts a fresh session with the note.
async function takeOver($, found) {
  run = claimRun(found, { owner, sessionId: await $.session.id(), now: Date.now() })
  if (isWaiting(run)) run = endWait(run)
  clearPending = startPending = false
  await save($, { claim: true })
  $.ui.invalidate('tool.describe')
  if (run.pendingNote) {
    startPending = true
    $.clock.after(500, () => {
      void $.command.run({ command: 'clear' }).catch(() => { startPending = false })
    })
  }
}

// The user file's path. Plugin options can't be changed from a session (they
// aren't /config rows), so the configure tool saves the default here.
async function userFilePath($) {
  const home = await $.env.get('HOME')
  return home ? `${home}/${USER_FILE}` : null
}

async function readUserFile($) {
  const path = await userFilePath($)
  if (!path) return {}
  try { return parseUserFile(await $.fs.read(path)) } catch { return {} }
}

async function readProjectFile($) {
  try { return parseUserFile(await $.fs.read(PROJECT_FILE)) } catch { return {} }
}

// The run ended without the user stopping it: tell them through Claude Code's
// notification, which also reaches the phone over Remote Control and is skipped
// while they're at the session. Sent from a timer, not the hook that ended the
// run, and kept with the run so status can say what happened.
function notifyEnded($, detail) {
  const ended = run
  if (!ended?.id || ended.notify === false) return
  const text = notificationText(ended, detail)
  $.clock.after(500, () => { void sendNotification($, ended.id, text) })
}

async function sendNotification($, id, text) {
  let record
  try {
    record = notificationRecord(await $.tool.call({ tool: 'PushNotification', message: text, status: 'proactive' }))
  } catch (err) {
    record = { sent: false, why: String(err) }
  }
  if (run?.id !== id) return
  run = { ...run, notification: { text, at: new Date().toISOString(), ...record } }
  await save($)
}

// Paid overage is in use: end the run, dropping any pending clear or wait.
// True when the run ended.
async function stopIfOverage($, turnEnd) {
  try {
    const rateLimits = (await $.session.usage()).rateLimits ?? []
    const ended = overageStop(run, { ...turnEnd, rateLimits, now: Date.now() })
    if (!ended) return false
    run = ended
    clearPending = startPending = false
    if (waitTimer) { waitTimer.cancel(); waitTimer = null }
    await save($)
    $.ui.invalidate('tool.describe')
    notifyEnded($)
    return true
  } catch { return false }
}

// A usage limit stopped the turn: wait for the reset, or end the run.
async function checkUsageLimit($, stopFailureError) {
  try {
    if (!isActive(run) || isWaiting(run)) return
    if (await stopIfOverage($, { reason: 'error', stopFailureError })) return
    if (run.usageWait === false) return
    const rateLimits = (await $.session.usage()).rateLimits ?? []
    if (classifyTurnEnd({ reason: 'error', stopFailureError, rateLimits }) !== 'usage-limit') return
    if (waitTimer) waitTimer.cancel()
    clearPending = false
    const now = Date.now()
    const plan = planUsageWait({ rateLimits, now, waitingSince: run.waitingSince })
    if (plan.action === 'stop') {
      run = endRun(run, plan.reason, now)
      await save($)
      notifyEnded($)
      return
    }
    run = startWait(run, { until: plan.until, now })
    await save($)
    waitTimer = $.clock.after(plan.ms, () => {
      waitTimer = null
      void resumeAfterWait($)
    })
  } catch {}
}

// The wait is over: carry on in the same session.
async function resumeAfterWait($) {
  if (!isWaiting(run)) return
  run = endWait(run)
  await save($)
  void $.prompt.submit({ text: resumePrompt() }).catch(() => {})
}

// The default budget sources, read fresh: the saved file and the plugin option.
async function budgetDefaults($) {
  return { saved: (await readUserFile($)).contextBudget, option: options?.contextBudget }
}

// Save the default budget ("" clears it); null once written, else why not.
async function saveDefaultBudget($, value) {
  const path = await userFilePath($)
  if (!path) return 'HOME is not set, so there is nowhere to save it.'
  await $.fs.write(path, userFileText(await readUserFile($), value))
  return null
}

// Start a run in this tab, for /nightrunner start and the start tool.
// Returns what to tell the caller, and whether a run started.
async function startRun($, args) {
  if (isActive(run)) return { started: false, text: `This tab already has a run. ${statusText(run)}` }
  const resolved = resolveBudget({ arg: args.budget, ...(await budgetDefaults($)) })
  if (resolved.error) return { started: false, text: `Run not started: ${resolved.error}` }
  const wait = resolveUsageWait({ arg: args.usageWait, project: (await readProjectFile($)).usageWait })
  if (wait.error) return { started: false, text: `Run not started: ${wait.error}` }
  const notify = resolveNotify({ arg: args.notify, project: (await readProjectFile($)).notify, user: (await readUserFile($)).notify })
  if (notify.error) return { started: false, text: `Run not started: ${notify.error}` }
  const now = Date.now()
  run = newRun({ id: newRunId(now), owner, sessionId: await $.session.id(), name: args.name, budget: resolved.budget, budgetSource: resolved.source, usageWait: wait.usageWait, usageWaitSource: wait.source, notify: notify.notify, notifySource: notify.source, now })
  clearPending = startPending = false
  await $.fs.write(GITIGNORE, GITIGNORE_TEXT)
  await save($, { claim: true })
  $.ui.invalidate('tool.describe')
  return { started: true, text: `Run started, context budget ${formatTokens(run.budget)} (${run.budgetSource}), usage-limit wait ${run.usageWait ? 'on' : 'off'} (${run.usageWaitSource}), notifications ${run.notify ? 'on' : 'off'} (${run.notifySource}). Claude calls the handover tool to carry on in a fresh session; past the budget, nightrunner asks it to. Stop with /nightrunner stop.` }
}

// The session's context as $.session.usage() reports it, or null.
async function currentContext($) {
  try { return (await $.session.usage()).context ?? null } catch { return null }
}

// Once per session, past the budget: ask for a handover after the turn ends.
async function checkBudget($) {
  try {
    const sessionId = await $.session.id()
    const tokens = (await currentContext($))?.tokens
    if (!shouldNudge(run, { tokens, sessionId })) return
    run = { ...run, nudgedIn: sessionId }
    await save($)
    const text = nudgePrompt(run, tokens)
    $.clock.after(500, () => {
      void $.prompt.submit({ text }).catch(() => {})
    })
  } catch {}
}

export function register(on, opts) {
  options = opts ?? {}
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'nightrunner', description: 'nightrunner: run work across fresh sessions', argumentHint: '[start [name]|stop|status|resume]', immediate: true })
    await $.tool.register(HANDOVER_TOOL)
    await $.tool.register(STATUS_TOOL)
    await $.tool.register(CONFIGURE_TOOL)
    await $.tool.register(START_TOOL)
    if (!loaded) {
      loaded = true
      // A resumed conversation (or a reloaded plugin) takes its run back; other
      // tabs' runs are left alone. A wait whose process has gone has no timer
      // here: never resume it on our own; the user carries on.
      try {
        const mine = runForSession(await readRuns($), await $.session.id())
        if (mine) {
          run = claimRun(mine, { owner, sessionId: mine.sessionId, now: Date.now() })
          if (isWaiting(run)) run = endWait(run)
          await save($, { claim: true })
        }
      } catch { run = null }
      $.clock.every(HEARTBEAT_MS, () => { void heartbeat($) })
    }
    return next(e)
  })

  // In Claude's tool list during a run, so they needn't be found by tool search.
  on('tool.describe', { tool: HANDOVER }, async ($, e, next) => {
    const d = await next(e)
    return isActive(run) ? { ...d, isDeferred: false } : d
  })
  on('tool.describe', { tool: STATUS }, async ($, e, next) => {
    const d = await next(e)
    return isActive(run) ? { ...d, isDeferred: false } : d
  })

  on('tool.call', { tool: CONFIGURE }, async ($, e) => {
    try {
      if (e.agentId) return { deny: 'configure is for the main session only.' }
      const checked = validateConfigure(configureInput(e), { runActive: isActive(run) })
      if (!checked.ok) return { deny: `nightrunner: ${checked.error}` }
      const done = []
      if (checked.value.defaultBudget !== undefined) {
        const refused = await saveDefaultBudget($, checked.value.defaultBudget)
        if (refused) return { deny: `nightrunner: the default budget wasn't saved: ${refused}` }
        done.push(checked.value.defaultBudget ? `Saved the default budget: ${formatTokens(Number(checked.value.defaultBudget))}.` : 'Cleared the default budget.')
      }
      if (checked.value.projectUsageWait !== undefined) {
        const v = checked.value.projectUsageWait
        await $.fs.write(PROJECT_FILE, settingsFileText(await readProjectFile($), 'usageWait', v === 'default' ? undefined : v))
        done.push(v === 'default' ? `Removed usageWait from ${PROJECT_FILE}, so this project's runs wait (the default).` : `Set usageWait to ${v ? 'on' : 'off'} in ${PROJECT_FILE}. Commit it to share it with the project.`)
      }
      if (checked.value.runUsageWait !== undefined) {
        run = setRunUsageWait(run, checked.value.runUsageWait)
        await save($)
        done.push(`This run's usage-limit wait is now ${checked.value.runUsageWait ? 'on' : 'off'}.`)
      }
      if (checked.value.defaultNotify !== undefined) {
        const v = checked.value.defaultNotify
        const path = await userFilePath($)
        if (!path) return { deny: "nightrunner: the default wasn't saved: HOME is not set, so there is nowhere to save it." }
        await $.fs.write(path, settingsFileText(await readUserFile($), 'notify', v === 'default' ? undefined : v))
        done.push(v === 'default' ? 'Removed your notify default, so runs notify (the default).' : `Your runs now ${v ? 'notify you' : "don't notify you"} by default, in every project.`)
      }
      if (checked.value.projectNotify !== undefined) {
        const v = checked.value.projectNotify
        await $.fs.write(PROJECT_FILE, settingsFileText(await readProjectFile($), 'notify', v === 'default' ? undefined : v))
        done.push(v === 'default' ? `Removed notify from ${PROJECT_FILE}.` : `Set notify to ${v ? 'on' : 'off'} in ${PROJECT_FILE}. Commit it to share it with the project.`)
      }
      if (checked.value.runNotify !== undefined) {
        run = setRunNotify(run, checked.value.runNotify)
        await save($)
        done.push(`This run's notifications are now ${checked.value.runNotify ? 'on' : 'off'}.`)
      }
      if (checked.value.runBudget !== undefined) {
        run = setRunBudget(run, checked.value.runBudget)
        await save($)
        done.push(`This run's budget is now ${formatTokens(run.budget)}.`)
      }
      return { result: [...done, configText(run, { ...(await budgetDefaults($)), project: (await readProjectFile($)).usageWait, projectNotify: (await readProjectFile($)).notify, userNotify: (await readUserFile($)).notify })].join('\n') }
    } catch (err) {
      return { deny: `nightrunner: configure failed (${String(err)}). Tell the user.` }
    }
  }).catch(() => ({ deny: 'nightrunner: configure failed. Tell the user.' }))

  on('tool.call', { tool: START }, async ($, e) => {
    try {
      if (e.agentId) return { deny: 'start is for the main session only.' }
      const args = validateStart(startInput(e))
      if (!args.ok) return { deny: `nightrunner: ${args.error}` }
      const { started, text } = await startRun($, args)
      return started ? { result: `${text} Work on what the user asked, and call the handover tool at a good stopping point.` } : { deny: `nightrunner: ${text}` }
    } catch (err) {
      return { deny: `nightrunner: the run didn't start (${String(err)}). Tell the user.` }
    }
  }).catch(() => ({ deny: "nightrunner: the run didn't start. Tell the user." }))

  on('tool.call', { tool: STATUS }, async ($) => {
    try {
      return { result: statusText(run, await currentContext($)) }
    } catch (err) {
      return { result: `nightrunner: status failed (${String(err)}).` }
    }
  }).catch(() => ({ result: 'nightrunner: status is unavailable right now.' }))

  on('tool.call', { tool: HANDOVER }, async ($, e) => {
    try {
      if (!isActive(run)) return { result: NO_RUN }
      if (e.agentId) return { deny: SUBAGENT }
      const sessionId = await $.session.id()
      if (run.handedOverIn === sessionId) return { deny: ALREADY }
      const checked = validateHandover(handoverInput(e))
      if (!checked.ok) return { deny: `nightrunner: ${checked.error}` }
      const applied = applyHandover(run, checked.value, { sessionId, now: Date.now() })
      run = applied.run
      clearPending = applied.clear
      await save($)
      if (!isActive(run)) notifyEnded($, checked.value.outcome === 'blocked' ? checked.value.note : '')
      return { result: applied.result }
    } catch (err) {
      return { deny: `nightrunner: the handover failed (${String(err)}). Tell the user.` }
    }
  }).catch(() => ({ deny: 'nightrunner: the handover failed and was not recorded. Tell the user.' }))

  // A hook can't run a command while it holds the turn, so the clear goes on a timer.
  on('turn.complete', async ($, e, next) => {
    // Checked first: overage ends the run even when a handover is pending.
    if (!e.agentId && isActive(run) && await stopIfOverage($, { reason: e.reason })) return next(e)
    // The run follows its tab into each new session, so a resumed conversation finds it.
    if (!e.agentId && isActive(run) && run.sessionId !== await $.session.id()) await heartbeat($)
    if (!e.agentId && clearPending && isActive(run)) {
      clearPending = false
      startPending = true
      $.clock.after(500, () => {
        void $.command.run({ command: 'clear' }).catch(() => { startPending = false })
      })
    } else if (!e.agentId && isActive(run) && e.reason === 'error') {
      await checkUsageLimit($)
    } else if (!e.agentId && isActive(run) && !startPending) {
      // A turn got through: any wait is over (the user may have carried on by hand).
      if (e.reason === 'answer' && (run.waitingSince || run.waitUntil)) {
        if (waitTimer) { waitTimer.cancel(); waitTimer = null }
        run = endWait(run, { succeeded: true })
        await save($)
      }
      await checkBudget($)
    }
    return next(e)
  })

  on('classic.StopFailure', async ($, e, next) => {
    if (e.error === 'rate_limit') await checkUsageLimit($, 'rate_limit')
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' && startPending && isActive(run)) {
      startPending = false
      const started = beginNextSession(run)
      run = started.run
      await save($)
      void $.prompt.submit({ text: started.prompt }).catch(() => {})
    }
    return next(e)
  })

  on('command.run', { command: 'nightrunner' }, async ($, e) => {
    const [sub, ...rest] = String(e.args ?? '').trim().split(/\s+/)
    if (sub === 'start') {
      if (isActive(run)) return { text: `This tab already has a run. ${statusText(run)}` }
      const args = parseStartArgs(rest)
      if (!args.ok) return { text: `Run not started: ${args.error}` }
      return { text: (await startRun($, args)).text }
    }
    if (sub === 'stop') {
      if (!isActive(run)) return { text: statusText(run) }
      run = endRun(run, 'stopped by the user', Date.now())
      clearPending = startPending = false
      if (waitTimer) { waitTimer.cancel(); waitTimer = null }
      await save($)
      $.ui.invalidate('tool.describe')
      return { text: 'Run stopped.' }
    }
    if (sub === 'resume') {
      if (isActive(run)) return { text: `This tab already has a run. ${statusText(run)}` }
      const found = findResumable(await readRuns($), rest.join(' '), Date.now())
      if (found.error) return { text: `Nothing resumed: ${found.error}` }
      await takeOver($, found.run)
      return { text: run.pendingNote
        ? `Resumed ${run.name ? `run "${run.name}"` : `run ${run.id}`}. Its last session handed over, so nightrunner clears this tab and starts session ${run.session + 1} with the note.`
        : `Resumed ${run.name ? `run "${run.name}"` : `run ${run.id}`} at session ${run.session}. This tab has none of its context: tell Claude what to carry on with, or to read the plan it was working from.` }
    }
    if (sub === 'status' || !sub) {
      const others = otherRunsText(await readRuns($), { ownId: run?.id, now: Date.now() })
      return { text: [statusText(run, await currentContext($)), others, HELP].filter(Boolean).join('\n') }
    }
    return { text: HELP }
  })
}
