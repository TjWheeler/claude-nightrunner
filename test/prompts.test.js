import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handoverPrompt, afterWaitPrompt, HARD_STOP_PROMPT, nudgePrompt, denyMessage, suspendedNotice, notificationText } from '../plugin/lib/prompts.js'
import { createRun, applyHandover, beginSession, endRun, finishWait, enterWait } from '../plugin/lib/run-state.js'
import { resolveSettings } from '../plugin/lib/config.js'

const T0 = Date.parse('2026-10-08T20:00:00Z')
const base = () => {
  const c = resolveSettings()
  return createRun({ id: '20261008-200000-abcd', name: 'demo', settings: c.settings, sources: c.sources, branch: 'run/x', startHead: 'h', now: T0, pid: 1, sessionId: 's1' })
}
const handedOver = () => beginSession(applyHandover(base(), { outcome: 'continue', reason: 'r', note: 'Resume plan X from its Resume section.' }, { sessionId: 's1', runCommits: 1, now: T0 }).run, { sessionId: 's2', head: 'h', now: T0 })

test('the handover prompt is the preamble then the note', () => {
  const p = handoverPrompt(handedOver())
  assert.match(p, /^\[nightrunner\] This is session 2 of at most 25 in run "demo" \(20261008-200000-abcd\)\./)
  assert.match(p, /context was cleared/)
  assert.match(p, /Call the nightrunner status tool first/)
  assert.ok(p.endsWith('Handover note from session 1:\n\nResume plan X from its Resume section.'))
  assert.ok(!p.startsWith('/'), 'never a command')
  assert.doesNotMatch(p, /sub-agent work/)
})

test('after a wait the preamble says sub-agent work may have been cut off', () => {
  const r = { ...handedOver(), afterWait: true }
  assert.match(handoverPrompt(r), /sub-agent work may have been cut off/)
  assert.match(afterWaitPrompt(finishWait(enterWait(base(), { until: 'x' }))), /usage limit has reset.*sub-agent work may have been cut off/)
})

test('a resumed run with no note says to work it out from the repo', () => {
  const p = handoverPrompt(beginSession(base(), { sessionId: 's2', head: 'h', now: T0 }), { resumed: true })
  assert.match(p, /suspended and the user resumed it/)
  assert.match(p, /without a handover note/)
})

test('fixed texts (decisions 10 and 13)', () => {
  assert.equal(HARD_STOP_PROMPT, '[nightrunner] Context is past the hard stop. Record your state in the repo and call handover now.')
  assert.equal(denyMessage('`git push`'), "nightrunner: `git push` is owner-only during an autonomous run and was refused. Don't work round it. If the work needs it, call `handover` with `blocked`.")
  assert.match(nudgePrompt(base()), /3 more idle periods/)
  assert.match(suspendedNotice(base()), /\/nightrunner resume.*\/nightrunner stop/)
})

test('the notification is one short line with no control characters', () => {
  const r = endRun(base(), 'blocked', T0)
  assert.equal(notificationText(r, 'Which database?'), 'nightrunner demo: blocked — Which database?')
  const long = notificationText(r, 'line1\nline2\t' + 'x'.repeat(300))
  assert.ok(!/[\n\t]/.test(long))
  assert.ok(long.length < 200)
  assert.equal(notificationText(endRun(base(), 'no-progress', T0), ''), 'nightrunner demo: stopped: no progress for too many sessions')
})
