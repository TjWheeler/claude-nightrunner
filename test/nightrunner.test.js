import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  validateHandover, handoverInput, newRun, parseRun, isActive, applyHandover,
  endRun, beginNextSession, handoverPrompt, statusText, NOTE_LIMIT, HANDOVER_TOOL,
  parseTokens, parseStartArgs, resolveBudget, shouldNudge, nudgePrompt, DEFAULT_BUDGET,
  contextLine, STATUS_TOOL, CONFIGURE_TOOL, configureInput, validateConfigure, setRunBudget, configText,
  parseUserFile, userFileText, parseOnOff, resolveUsageWait, planUsageWait, startWait, endWait,
  isWaiting, resumePrompt, setRunUsageWait, settingsFileText, MAX_WAIT_HOURS, RETRY_WAIT_MS, overageStop,
  newRunId, runFile, isLive, claimRun, ownedByOther, migrateLegacyRun, runForSession, findResumable, otherRunsText,
  STALE_MS, HEARTBEAT_MS, START_TOOL, startInput, validateStart,
} from '../plugin/lib/nightrunner.js'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)

test('continue needs a note', () => {
  assert.equal(validateHandover({ outcome: 'continue' }).ok, false)
  assert.equal(validateHandover({ outcome: 'continue', note: '  ' }).ok, false)
  assert.deepEqual(validateHandover({ outcome: 'continue', note: ' next: step 3 ' }), { ok: true, value: { outcome: 'continue', note: 'next: step 3' } })
})

test('complete and blocked need no note', () => {
  assert.deepEqual(validateHandover({ outcome: 'complete' }), { ok: true, value: { outcome: 'complete' } })
  assert.deepEqual(validateHandover({ outcome: 'blocked', note: 'which db?' }), { ok: true, value: { outcome: 'blocked', note: 'which db?' } })
})

test('bad handovers are refused', () => {
  assert.equal(validateHandover({ outcome: 'error' }).ok, false)
  assert.equal(validateHandover({}).ok, false)
  assert.equal(validateHandover({ outcome: 'continue', note: 5 }).ok, false)
  assert.equal(validateHandover({ outcome: 'continue', note: '/clear' }).ok, false)
  assert.equal(validateHandover({ outcome: 'continue', note: 'x'.repeat(NOTE_LIMIT + 1) }).ok, false)
})

test('input is read from the event or its input field', () => {
  assert.deepEqual(handoverInput({ outcome: 'complete', tool_use_id: 'x' }), { outcome: 'complete', note: undefined })
  assert.deepEqual(handoverInput({ input: { outcome: 'continue', note: 'n' } }), { outcome: 'continue', note: 'n' })
  assert.deepEqual(handoverInput(undefined), { outcome: undefined, note: undefined })
})

test('the tool schema matches the outcomes', () => {
  assert.equal(HANDOVER_TOOL.name, 'handover')
  assert.deepEqual(HANDOVER_TOOL.inputSchema.properties.outcome.enum, ['continue', 'complete', 'blocked'])
})

test('a run file round-trips, and junk is no run', () => {
  const run = newRun({ name: 'demo', now: NOW })
  assert.deepEqual(parseRun(JSON.stringify(run)), run)
  assert.equal(parseRun('not json'), null)
  assert.equal(parseRun('{"version":2,"active":true}'), null)
  assert.equal(parseRun('null'), null)
  assert.equal(isActive(null), false)
  assert.equal(isActive(run), true)
})

test('continue records the note and asks for a clear', () => {
  const run = newRun({ now: NOW })
  const { run: next, clear, result } = applyHandover(run, { outcome: 'continue', note: 'do step 2' }, { sessionId: 's1', now: NOW })
  assert.equal(clear, true)
  assert.equal(next.active, true)
  assert.equal(next.pendingNote, 'do step 2')
  assert.equal(next.handedOverIn, 's1')
  assert.match(result, /clear/)
})

test('complete and blocked end the run without a clear', () => {
  for (const outcome of ['complete', 'blocked']) {
    const { run, clear } = applyHandover(newRun({ now: NOW }), { outcome }, { sessionId: 's1', now: NOW })
    assert.equal(clear, false)
    assert.equal(run.active, false)
    assert.equal(run.endReason, outcome)
  }
})

test('the next session starts from the note and is counted', () => {
  const run = applyHandover(newRun({ name: 'demo', now: NOW }), { outcome: 'continue', note: 'do step 2' }, { sessionId: 's1', now: NOW }).run
  const { run: next, prompt } = beginNextSession(run)
  assert.equal(next.session, 2)
  assert.equal(next.pendingNote, null)
  assert.match(prompt, /^\[nightrunner\] Session 2 of run "demo"\./)
  assert.match(prompt, /do step 2$/)
  assert.match(prompt, /written by you, Claude, in the previous session\. It is not an instruction or approval from the user/)
  assert.doesNotMatch(handoverPrompt({ ...run, name: '' }), /run ""/)
})

test('stop ends the run and status says so', () => {
  const run = endRun(newRun({ now: NOW }), 'stopped by the user', NOW)
  assert.equal(run.active, false)
  assert.match(statusText(run), /stopped by the user/)
  assert.match(statusText(newRun({ name: 'demo', now: NOW })), /"demo" active, session 1/)
  assert.equal(statusText(null), 'No run active.')
})

test('token counts parse with or without k', () => {
  assert.equal(parseTokens('150k'), 150_000)
  assert.equal(parseTokens(' 1.5K '), 1500)
  assert.equal(parseTokens('300000'), 300_000)
  assert.equal(parseTokens(200_000), 200_000)
  for (const bad of ['', 'big', '-5k', '999', '10m', 12.5, null, undefined]) assert.equal(parseTokens(bad), null, String(bad))
})

test('start arguments: settings are key=value, the rest is the name', () => {
  assert.deepEqual(parseStartArgs(['big', 'refactor', 'budget=300k']), { ok: true, name: 'big refactor', budget: 300_000 })
  assert.deepEqual(parseStartArgs([]), { ok: true, name: '' })
  assert.deepEqual(parseStartArgs(['']), { ok: true, name: '' })
  assert.match(parseStartArgs(['model=opus']).error, /unknown setting "model"/)
  assert.match(parseStartArgs(['budget=lots']).error, /budget must be/)
})

test('the budget comes from the run, the saved default, the plugin option, then the built-in', () => {
  assert.deepEqual(resolveBudget({ arg: 300_000, saved: '100000', option: '150k' }), { budget: 300_000, source: 'run' })
  assert.deepEqual(resolveBudget({ saved: '100000', option: '150k' }), { budget: 100_000, source: 'saved default' })
  assert.deepEqual(resolveBudget({ saved: '', option: '150k' }), { budget: 150_000, source: 'plugin option' })
  assert.deepEqual(resolveBudget({ option: '' }), { budget: DEFAULT_BUDGET, source: 'default' })
  assert.deepEqual(resolveBudget({}), { budget: DEFAULT_BUDGET, source: 'default' })
  assert.match(resolveBudget({ option: 'lots' }).error, /contextBudget plugin option/)
  assert.match(resolveBudget({ saved: 'lots' }).error, /saved default budget/)
})

test('the user file keeps other keys and clears the budget on ""', () => {
  assert.deepEqual(parseUserFile('{"contextBudget":"150000","x":1}'), { contextBudget: '150000', x: 1 })
  for (const junk of ['', 'nope', '[]', 'null', '3']) assert.deepEqual(parseUserFile(junk), {}, junk)
  assert.deepEqual(JSON.parse(userFileText({ x: 1 }, '150000')), { x: 1, contextBudget: '150000' })
  assert.deepEqual(JSON.parse(userFileText({ x: 1, contextBudget: '150000' }, '')), { x: 1 })
})

test('a nudge comes once per session, past the budget, before a handover', () => {
  const run = newRun({ budget: 150_000, budgetSource: 'run', now: NOW })
  assert.equal(shouldNudge(run, { tokens: 149_999, sessionId: 's1' }), false)
  assert.equal(shouldNudge(run, { tokens: 150_000, sessionId: 's1' }), true)
  assert.equal(shouldNudge({ ...run, nudgedIn: 's1' }, { tokens: 180_000, sessionId: 's1' }), false)
  assert.equal(shouldNudge({ ...run, nudgedIn: 's1' }, { tokens: 180_000, sessionId: 's2' }), true)
  assert.equal(shouldNudge({ ...run, handedOverIn: 's1' }, { tokens: 180_000, sessionId: 's1' }), false)
  assert.equal(shouldNudge(run, { tokens: undefined, sessionId: 's1' }), false)
  assert.equal(shouldNudge(endRun(run, 'complete', NOW), { tokens: 180_000, sessionId: 's1' }), false)
  assert.equal(shouldNudge(null, { tokens: 180_000, sessionId: 's1' }), false)
})

test('the nudge names the context, the budget and the handover tool', () => {
  const text = nudgePrompt(newRun({ budget: 150_000, now: NOW }), 162_400)
  assert.match(text, /162k, past this run's budget of 150k/)
  assert.match(text, /handover tool with outcome "continue"/)
  assert.match(statusText(newRun({ budget: 150_000, budgetSource: 'option', now: NOW })), /Context budget 150k \(option\)/)
})

test('status shows context against the budget', () => {
  const run = newRun({ budget: 200_000, budgetSource: 'option', now: NOW })
  assert.equal(contextLine(run, { tokens: 85_000, window: 1_000_000 }), 'Context: 85k of the 200k budget (43%), window 1000k.')
  assert.match(contextLine(run, { tokens: 210_000, window: 1_000_000 }), /\(105%\).*Past the budget/)
  assert.equal(contextLine(null, { tokens: 85_000, window: 1_000_000 }), 'Context: 85k, window 1000k.')
  assert.match(contextLine(run, null), /not measured yet/)
  assert.match(contextLine(run, { window: 1_000_000 }), /not measured yet/)
  assert.match(statusText(run, { tokens: 85_000 }), /Context budget 200k \(option\)\. Usage-limit wait on \(default\)\.\nContext: 85k of the 200k budget \(43%\)\.$/)
  assert.match(statusText(null, { tokens: 85_000 }), /^No run active\.\nContext: 85k\.$/)
  assert.equal(statusText(null), 'No run active.')
  assert.equal(STATUS_TOOL.name, 'status')
})

test('configure checks its inputs', () => {
  assert.deepEqual(validateConfigure({}, { runActive: false }), { ok: true, value: {} })
  assert.deepEqual(validateConfigure({ defaultBudget: '150k' }, { runActive: false }), { ok: true, value: { defaultBudget: '150000' } })
  assert.deepEqual(validateConfigure({ defaultBudget: 'Default' }, { runActive: false }), { ok: true, value: { defaultBudget: '' } })
  assert.deepEqual(validateConfigure({ defaultBudget: '' }, { runActive: false }), { ok: true, value: { defaultBudget: '' } })
  assert.match(validateConfigure({ defaultBudget: 'lots' }, { runActive: false }).error, /defaultBudget must be/)
  assert.deepEqual(validateConfigure({ runBudget: '300k' }, { runActive: true }), { ok: true, value: { runBudget: 300_000 } })
  assert.match(validateConfigure({ runBudget: '300k' }, { runActive: false }).error, /needs an active run/)
  assert.match(validateConfigure({ runBudget: 'x' }, { runActive: true }).error, /runBudget must be/)
  assert.deepEqual(configureInput({ input: { runBudget: '1k', other: 1 } }), { defaultBudget: undefined, runBudget: '1k', projectUsageWait: undefined, runUsageWait: undefined })
  assert.equal(CONFIGURE_TOOL.name, 'configure')
})

test('a new run budget allows a fresh nudge', () => {
  const run = setRunBudget({ ...newRun({ now: NOW }), nudgedIn: 's1' }, 300_000)
  assert.equal(run.budget, 300_000)
  assert.equal(run.budgetSource, 'set by configure')
  assert.equal(shouldNudge(run, { tokens: 310_000, sessionId: 's1' }), true)
})

test('configure reports the default and the run', () => {
  assert.match(configText(null), /^Default budget: not set, so runs use the built-in 200k\.\nUsage-limit wait for this project: on \(built-in default\)\.\nNo run active/)
  assert.match(configText(null, { saved: '150000', option: '300k' }), /^Default budget: 150k \(saved default\)\./)
  assert.match(configText(null, { option: '300k' }), /^Default budget: 300k \(plugin option\)\./)
  assert.match(configText(null, { saved: 'lots' }), /isn't a token count/)
  assert.match(configText(newRun({ budget: 50_000, budgetSource: 'run', now: NOW }), {}), /This tab's run: budget 50k \(run\), usage-limit wait on \(default\)\./)
})

test('on/off values', () => {
  for (const v of ['on', 'ON', 'true', 'yes', true]) assert.equal(parseOnOff(v), true, String(v))
  for (const v of ['off', 'false', 'No', false]) assert.equal(parseOnOff(v), false, String(v))
  for (const v of ['', 'maybe', 1, null, undefined]) assert.equal(parseOnOff(v), null, String(v))
})

test('wait= is a run setting', () => {
  assert.deepEqual(parseStartArgs(['x', 'wait=off', 'budget=100k']), { ok: true, name: 'x', usageWait: false, budget: 100_000 })
  assert.match(parseStartArgs(['wait=sometimes']).error, /wait must be on or off/)
})

test('usage wait comes from the run, then the project, then on', () => {
  assert.deepEqual(resolveUsageWait({ arg: true, project: false }), { usageWait: true, source: 'run' })
  assert.deepEqual(resolveUsageWait({ project: false }), { usageWait: false, source: 'project' })
  assert.deepEqual(resolveUsageWait({}), { usageWait: true, source: 'default' })
  assert.match(resolveUsageWait({ project: 'perhaps' }).error, /usageWait in \.claude\/nightrunner\.json/)
  const run = newRun({ now: NOW })
  assert.equal(run.usageWait, true)
  assert.equal(setRunUsageWait(run, false).usageWait, false)
})

const window = (kind, percentUsed, resetsAt) => ({ kind, percentUsed, resetsAt })

test('a usage limit waits to the reset plus two minutes', () => {
  const reset = new Date(NOW + 90 * 60_000).toISOString()
  const plan = planUsageWait({ rateLimits: [window('five_hour', 100, reset), window('seven_day', 40)], now: NOW })
  assert.equal(plan.action, 'wait')
  assert.equal(plan.ms, 92 * 60_000)
  assert.equal(plan.until, new Date(NOW + 92 * 60_000).toISOString())
  assert.match(plan.why, /five_hour/)
})

test('the latest reset among full windows wins', () => {
  const plan = planUsageWait({ rateLimits: [window('five_hour', 100, new Date(NOW + 60_000).toISOString()), window('seven_day', 100, new Date(NOW + 3 * 3600_000).toISOString())], now: NOW })
  assert.equal(plan.ms, 3 * 3600_000 + 2 * 60_000)
})

test('a reset beyond six hours stops the run', () => {
  const plan = planUsageWait({ rateLimits: [window('seven_day', 100, new Date(NOW + 30 * 3600_000).toISOString())], now: NOW })
  assert.equal(plan.action, 'stop')
  assert.match(plan.reason, /seven_day limit resets at .* beyond the 6-hour maximum wait/)
})

test('six hours counts from the first wait', () => {
  const waitingSince = new Date(NOW - 5 * 3600_000).toISOString()
  const plan = planUsageWait({ rateLimits: [window('five_hour', 100, new Date(NOW + 2 * 3600_000).toISOString())], now: NOW, waitingSince })
  assert.equal(plan.action, 'stop')
})

test('no reset time: try again in 30 minutes, until six hours have passed', () => {
  const plan = planUsageWait({ rateLimits: [], now: NOW })
  assert.deepEqual([plan.action, plan.ms], ['wait', RETRY_WAIT_MS])
  assert.match(plan.why, /no reset time/)
  assert.equal(planUsageWait({ rateLimits: [window('five_hour', 100)], now: NOW }).action, 'wait')
  const late = planUsageWait({ rateLimits: [], now: NOW, waitingSince: new Date(NOW - (MAX_WAIT_HOURS * 3600_000 - 60_000)).toISOString() })
  assert.equal(late.action, 'stop')
})

test('wait state starts, ends and clears after a turn gets through', () => {
  let run = startWait(newRun({ now: NOW }), { until: 'T1', now: NOW })
  assert.equal(isWaiting(run), true)
  assert.equal(run.waitingSince, new Date(NOW).toISOString())
  run = startWait(endWait(run), { until: 'T2', now: NOW + 1000 })
  assert.equal(run.waitingSince, new Date(NOW).toISOString(), 'a second wait keeps the first start')
  assert.match(statusText(run), /Waiting for the usage limit to reset; carrying on at T2\./)
  run = endWait(run, { succeeded: true })
  assert.deepEqual([run.waitUntil, run.waitingSince, isWaiting(run)], [null, null, false])
  assert.equal(isWaiting(endRun(startWait(newRun({ now: NOW }), { until: 'T', now: NOW }), 'x', NOW)), false)
  assert.match(resumePrompt(), /usage limit has reset/)
})

test('configure takes the usage-wait settings', () => {
  assert.deepEqual(validateConfigure({ projectUsageWait: 'off' }, { runActive: false }), { ok: true, value: { projectUsageWait: false } })
  assert.deepEqual(validateConfigure({ projectUsageWait: 'default' }, { runActive: false }), { ok: true, value: { projectUsageWait: 'default' } })
  assert.match(validateConfigure({ projectUsageWait: 'maybe' }, { runActive: false }).error, /projectUsageWait must be/)
  assert.deepEqual(validateConfigure({ runUsageWait: 'off' }, { runActive: true }), { ok: true, value: { runUsageWait: false } })
  assert.match(validateConfigure({ runUsageWait: 'off' }, { runActive: false }).error, /needs an active run/)
  assert.match(configText(null, { project: false }), /Usage-limit wait for this project: off \(project file\)\./)
  assert.deepEqual(JSON.parse(settingsFileText({ a: 1, usageWait: true }, 'usageWait', undefined)), { a: 1 })
})

const at = (kind, percentUsed) => ({ kind, percentUsed, resetsAt: '2026-10-08T15:00:00Z' })

test('a window past its limit ends the run as paid overage, whatever the turn did', () => {
  for (const reason of ['answer', 'error', 'aborted']) {
    const ended = overageStop(newRun({ now: NOW }), { reason, rateLimits: [at('five_hour', 40), at('seven_day', 100.5)], now: NOW })
    assert.equal(ended.active, false)
    assert.equal(ended.endReason, 'paid overage: the seven_day usage limit is at 100.5%, so further turns would be billed as overage')
    assert.equal(ended.endedAt, new Date(NOW).toISOString())
  }
})

test('a turn that got through with a window at its limit ends the run as paid overage', () => {
  const ended = overageStop(newRun({ now: NOW }), { reason: 'answer', rateLimits: [at('five_hour', 100)], now: NOW })
  assert.match(ended.endReason, /^paid overage: the five_hour usage limit is at 100%/)
  assert.match(statusText(ended), /The last run ended: paid overage/)
})

test('a failed turn at the limit, or windows under it, is not overage', () => {
  const run = newRun({ now: NOW })
  assert.equal(overageStop(run, { reason: 'error', rateLimits: [at('five_hour', 100)], now: NOW }), null, 'a usage-limit stop waits instead')
  assert.equal(overageStop(run, { reason: 'error', stopFailureError: 'rate_limit', rateLimits: [at('five_hour', 100)], now: NOW }), null)
  assert.equal(overageStop(run, { reason: 'answer', rateLimits: [at('five_hour', 99.9)], now: NOW }), null)
  assert.equal(overageStop(run, { reason: 'answer', rateLimits: [], now: NOW }), null)
  assert.equal(overageStop(run, { reason: 'answer', now: NOW }), null)
})

test('overage leaves an ended run alone, and ends a waiting one', () => {
  const ended = endRun(newRun({ now: NOW }), 'complete', NOW)
  assert.equal(overageStop(ended, { reason: 'answer', rateLimits: [at('five_hour', 101)], now: NOW }), null)
  const waiting = startWait(newRun({ now: NOW }), { until: 'T', now: NOW })
  const stopped = overageStop(waiting, { reason: 'answer', rateLimits: [at('five_hour', 101)], now: NOW })
  assert.equal(isWaiting(stopped), false)
})

const tabRun = (id, { name = '', owner = 'tab-' + id, sessionId = 'sess-' + id, beatAgo = 0, active = true } = {}) => {
  const r = newRun({ id, owner, sessionId, name, now: NOW - beatAgo })
  return active ? r : endRun(r, 'complete', NOW)
}

test('run ids sort by start time and differ by a random suffix', () => {
  assert.equal(newRunId(NOW, () => 0), '20261008-120000-0000')
  assert.equal(newRunId(NOW, () => 0.5), '20261008-120000-8000')
  assert.equal(runFile('abc'), '.nightrunner/runs/abc.json')
})

test('a run is live while its heartbeat is recent', () => {
  assert.ok(HEARTBEAT_MS < STALE_MS)
  assert.equal(isLive(tabRun('a'), NOW), true)
  assert.equal(isLive(tabRun('a', { beatAgo: STALE_MS - 1 }), NOW), true)
  assert.equal(isLive(tabRun('a', { beatAgo: STALE_MS }), NOW), false)
  assert.equal(isLive(tabRun('a', { active: false }), NOW), false)
  assert.equal(isLive({ ...tabRun('a'), heartbeatAt: null }, NOW), false)
})

test('a new run belongs to the tab and session that started it', () => {
  const r = newRun({ id: 'x', owner: 'me', sessionId: 's1', now: NOW })
  assert.deepEqual([r.id, r.owner, r.sessionId, r.heartbeatAt], ['x', 'me', 's1', new Date(NOW).toISOString()])
})

test('claiming a run moves it to this tab and session, and keeps its progress', () => {
  const old = { ...tabRun('a', { beatAgo: STALE_MS * 2 }), session: 4, pendingNote: 'next' }
  const mine = claimRun(old, { owner: 'me', sessionId: 's9', now: NOW })
  assert.deepEqual([mine.owner, mine.sessionId, mine.heartbeatAt], ['me', 's9', new Date(NOW).toISOString()])
  assert.deepEqual([mine.session, mine.pendingNote, mine.id], [4, 'next', 'a'])
})

test('a run file claimed by another tab is not this tab\'s to write', () => {
  assert.equal(ownedByOther({ owner: 'other' }, 'me'), true)
  assert.equal(ownedByOther({ owner: 'me' }, 'me'), false)
  assert.equal(ownedByOther({ owner: null }, 'me'), false, 'a moved run has no owner yet')
  assert.equal(ownedByOther(null, 'me'), false, 'no file yet')
})

test('a run from run.json gets a fixed id and no owner', () => {
  const legacy = { ...newRun({ name: 'old', now: NOW }), id: undefined, owner: undefined, sessionId: undefined, session: 3 }
  const moved = migrateLegacyRun(legacy)
  assert.equal(moved.id, '20261008-120000-legacy')
  assert.deepEqual(migrateLegacyRun(legacy), moved, 'two tabs moving it write the same file')
  assert.deepEqual([moved.owner, moved.sessionId, moved.heartbeatAt, moved.session, moved.name], [null, null, null, 3, 'old'])
  assert.equal(isLive(moved, NOW), false)
})

test('a resumed conversation finds its own active run, and no other', () => {
  const runs = [tabRun('a'), tabRun('b'), tabRun('c', { active: false })]
  assert.equal(runForSession(runs, 'sess-b').id, 'b')
  assert.equal(runForSession(runs, 'sess-c'), null, 'an ended run stays ended')
  assert.equal(runForSession(runs, 'sess-new'), null)
  assert.equal(runForSession([{ ...tabRun('m'), sessionId: null }], null), null)
})

test('resume with no name takes the only orphaned run', () => {
  const live = tabRun('live', { name: 'one' })
  const orphan = tabRun('orph', { name: 'two', beatAgo: STALE_MS + 1 })
  assert.equal(findResumable([live, orphan, tabRun('done', { active: false })], '', NOW).run.id, 'orph')
  assert.match(findResumable([live], '', NOW).error, /live in another tab/)
  assert.match(findResumable([], '', NOW).error, /no active run in this folder/)
  const second = tabRun('orph2', { beatAgo: STALE_MS + 1 })
  assert.match(findResumable([orphan, second], undefined, NOW).error, /several runs are orphaned: "two" \(orph\), orph2\. Name one/)
})

test('resume by name, id or id prefix, never a live run', () => {
  const runs = [tabRun('20261008-1', { name: 'docs', beatAgo: STALE_MS + 1 }), tabRun('20261008-2', { name: 'api' })]
  assert.equal(findResumable(runs, 'docs', NOW).run.id, '20261008-1')
  assert.equal(findResumable(runs, '20261008-1', NOW).run.id, '20261008-1')
  assert.match(findResumable(runs, '20261008', NOW).error, /matches several runs/)
  assert.match(findResumable(runs, 'api', NOW).error, /"api" \(20261008-2\) is live in another tab .* try again in 3 minutes/)
  assert.match(findResumable(runs, 'nope', NOW).error, /no active run in this folder matches "nope"/)
})

test('status lists the other runs in the folder, live or orphaned', () => {
  const runs = [tabRun('mine'), tabRun('b', { name: 'api' }), { ...tabRun('c', { beatAgo: STALE_MS + 1 }), session: 2 }, tabRun('d', { active: false })]
  const text = otherRunsText(runs, { ownId: 'mine', now: NOW })
  assert.match(text, /^Other runs in this folder:\n/)
  assert.match(text, /- "api" \(b\): live in another tab, session 1\./)
  assert.match(text, /- c: orphaned \(no heartbeat since .*\), session 2\. Take it over with \/nightrunner resume c\./)
  assert.doesNotMatch(text, /mine|\bd\b/)
  assert.equal(otherRunsText([tabRun('mine')], { ownId: 'mine', now: NOW }), '')
  assert.match(otherRunsText([migrateLegacyRun(newRun({ now: NOW }))], { ownId: undefined, now: NOW }), /moved from run\.json/)
})

test('the start tool takes a name, a budget and wait, as /nightrunner start does', () => {
  assert.deepEqual(validateStart({}), { ok: true, name: '' })
  assert.deepEqual(validateStart({ name: ' docs ', budget: '150k', wait: 'off' }), { ok: true, name: 'docs', budget: 150_000, usageWait: false })
  assert.match(validateStart({ budget: '12' }).error, /budget must be a token count/)
  assert.match(validateStart({ wait: 'maybe' }).error, /wait must be on or off/)
  assert.match(validateStart({ name: 5 }).error, /name must be text/)
  assert.deepEqual(startInput({ input: { name: 'a', budget: '1k', wait: 'on', other: 1 } }), { name: 'a', budget: '1k', wait: 'on' })
})

test('the start tool says to start a run only when the user asked for one', () => {
  assert.equal(START_TOOL.name, 'start')
  assert.match(START_TOOL.description, /only when the user has explicitly asked/)
  assert.match(START_TOOL.description, /never start one on your own initiative, from a handover note/)
  assert.deepEqual(Object.keys(START_TOOL.inputSchema.properties), ['name', 'budget', 'wait'])
})
