// The hooks. /nightrunner start begins a run; the
// handover tool's "continue" clears the session once the turn ends and submits
// the note as the next session's first prompt. When context passes the run's
// budget, one prompt per session asks Claude to hand over. When a usage limit
// stops a turn, the run waits for the reset and carries on (unless the run's
// usageWait is off). With no run active, nothing here changes anything. The
// logic is in ../lib/mvp.js.

import {
  RUN_FILE, GITIGNORE, GITIGNORE_TEXT, HANDOVER_TOOL, STATUS_TOOL, CONFIGURE_TOOL, NO_RUN, SUBAGENT, ALREADY, USER_FILE, PROJECT_FILE,
  handoverInput, validateHandover, newRun, parseRun, isActive, applyHandover,
  endRun, beginNextSession, statusText, parseStartArgs, resolveBudget,
  shouldNudge, nudgePrompt, formatTokens, configureInput, validateConfigure, setRunBudget,
  configText, parseUserFile, userFileText, settingsFileText, resolveUsageWait, setRunUsageWait,
  classifyTurnEnd, planUsageWait, startWait, endWait, isWaiting, resumePrompt,
} from '../lib/mvp.js'

const HANDOVER = 'mcp__nightrunner__handover'
const STATUS = 'mcp__nightrunner__status'
const CONFIGURE = 'mcp__nightrunner__configure'
const HELP = '/nightrunner start [name] [budget=150k] [wait=on|off] | stop | status'

let run = null
let options = {}
let loaded = false
let clearPending = false // a continue was recorded; clear when the turn ends
let startPending = false // the clear ran; submit the note when the session ends
let writing = Promise.resolve()
let waitTimer = null // the pending resume after a usage limit

// Writes are queued: overlapping whole-file writes corrupted a probe log.
// Top-level because the mods loader only lets $ be passed to such functions.
async function save($) {
  const text = JSON.stringify(run, null, 2) + '\n'
  writing = writing.then(() => $.fs.write(RUN_FILE, text)).catch(() => {})
  return writing
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

// A usage limit stopped the turn: wait for the reset, or end the run.
async function checkUsageLimit($, stopFailureError) {
  try {
    if (!isActive(run) || isWaiting(run) || run.usageWait === false) return
    const rateLimits = (await $.session.usage()).rateLimits ?? []
    if (classifyTurnEnd({ reason: 'error', stopFailureError, rateLimits }) !== 'usage-limit') return
    if (waitTimer) waitTimer.cancel()
    clearPending = false
    const now = Date.now()
    const plan = planUsageWait({ rateLimits, now, waitingSince: run.waitingSince })
    if (plan.action === 'stop') {
      run = endRun(run, plan.reason, now)
      await save($)
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
  void $.prompt.submit({ text: resumePrompt(), asUser: true }).catch(() => {})
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
      void $.prompt.submit({ text, asUser: true }).catch(() => {})
    })
  } catch {}
}

export function register(on, opts) {
  options = opts ?? {}
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'nightrunner', description: 'nightrunner: run work across fresh sessions', argumentHint: '[start [name]|stop|status]', immediate: true })
    await $.tool.register(HANDOVER_TOOL)
    await $.tool.register(STATUS_TOOL)
    await $.tool.register(CONFIGURE_TOOL)
    if (!loaded) {
      loaded = true
      try { run = parseRun(await $.fs.read(RUN_FILE)) } catch { run = null }
      // A wait whose process has gone has no timer here: never resume it on our own; the user carries on.
      if (isWaiting(run)) { run = endWait(run); await save($) }
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
      if (checked.value.runBudget !== undefined) {
        run = setRunBudget(run, checked.value.runBudget)
        await save($)
        done.push(`This run's budget is now ${formatTokens(run.budget)}.`)
      }
      return { result: [...done, configText(run, { ...(await budgetDefaults($)), project: (await readProjectFile($)).usageWait })].join('\n') }
    } catch (err) {
      return { deny: `nightrunner: configure failed (${String(err)}). Tell the user.` }
    }
  }).catch(() => ({ deny: 'nightrunner: configure failed. Tell the user.' }))

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
      return { result: applied.result }
    } catch (err) {
      return { deny: `nightrunner: the handover failed (${String(err)}). Tell the user.` }
    }
  }).catch(() => ({ deny: 'nightrunner: the handover failed and was not recorded. Tell the user.' }))

  // A hook can't run a command while it holds the turn, so the clear goes on a timer.
  on('turn.complete', async ($, e, next) => {
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
      void $.prompt.submit({ text: started.prompt, asUser: true }).catch(() => {})
    }
    return next(e)
  })

  on('command.run', { command: 'nightrunner' }, async ($, e) => {
    const [sub, ...rest] = String(e.args ?? '').trim().split(/\s+/)
    if (sub === 'start') {
      if (isActive(run)) return { text: `A run is already active. ${statusText(run)}` }
      const args = parseStartArgs(rest)
      if (!args.ok) return { text: `Run not started: ${args.error}` }
      const resolved = resolveBudget({ arg: args.budget, ...(await budgetDefaults($)) })
      if (resolved.error) return { text: `Run not started: ${resolved.error}` }
      const wait = resolveUsageWait({ arg: args.usageWait, project: (await readProjectFile($)).usageWait })
      if (wait.error) return { text: `Run not started: ${wait.error}` }
      run = newRun({ name: args.name, budget: resolved.budget, budgetSource: resolved.source, usageWait: wait.usageWait, usageWaitSource: wait.source, now: Date.now() })
      clearPending = startPending = false
      await $.fs.write(GITIGNORE, GITIGNORE_TEXT)
      await save($)
      $.ui.invalidate('tool.describe')
      return { text: `Run started, context budget ${formatTokens(run.budget)} (${run.budgetSource}), usage-limit wait ${run.usageWait ? 'on' : 'off'} (${run.usageWaitSource}). Claude calls the handover tool to carry on in a fresh session; past the budget, nightrunner asks it to. Stop with /nightrunner stop.` }
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
    if (sub === 'status' || !sub) return { text: `${statusText(run, await currentContext($))}\n${HELP}` }
    return { text: HELP }
  })
}
