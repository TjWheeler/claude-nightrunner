import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { validateHandover, validateCommit, commitMessage, toolInput, statusText, RESULTS, TOOL_DEFINITIONS, qualifiedName, LIMITS } from '../plugin/lib/tools.js'
import { createRun, applyHandover, requestStop } from '../plugin/lib/run-state.js'
import { resolveSettings } from '../plugin/lib/config.js'

const T0 = Date.parse('2026-10-08T20:00:00Z')
const run = (over = {}) => {
  const c = resolveSettings({ run: over })
  return createRun({ id: '20261008-200000-abcd', name: 'demo', settings: c.settings, sources: c.sources, branch: 'run/x', startHead: 'h', now: T0, pid: 1, sessionId: 's1' })
}

describe('handover input', () => {
  test('accepts each outcome with what it needs', () => {
    assert.ok(validateHandover({ outcome: 'continue', reason: 'soft stop', note: 'Resume the plan from its Resume section.' }).ok)
    for (const o of ['blocked', 'complete', 'error']) assert.ok(validateHandover({ outcome: o, reason: 'x' }).ok, o)
  })
  test('trims and keeps only the given optional fields', () => {
    const r = validateHandover({ outcome: 'continue', reason: ' r ', note: ' n ', progress: ' p ', notes: [' a ', ''] })
    assert.deepEqual(r.value, { outcome: 'continue', reason: 'r', note: 'n', progress: 'p', notes: ['a'] })
  })
  test('malformed calls are refused with a reason', () => {
    const cases = [
      [{ outcome: 'maybe', reason: 'x' }, /outcome must be one of continue, blocked, complete, error/],
      [{ reason: 'x' }, /outcome must be/],
      [{ outcome: 'complete' }, /reason is required/],
      [{ outcome: 'complete', reason: 'a\nb' }, /one line/],
      [{ outcome: 'complete', reason: 'x'.repeat(201) }, /201 characters; the limit is 200/],
      [{ outcome: 'continue', reason: 'x' }, /note is required for continue/],
      [{ outcome: 'continue', reason: 'x', note: '   ' }, /note is required/],
      [{ outcome: 'continue', reason: 'x', note: 'x'.repeat(LIMITS.note + 1) }, /limit is 8000/],
      [{ outcome: 'continue', reason: 'x', note: '/orchestrator resume' }, /must not start with "\/"/],
      [{ outcome: 'continue', reason: 'x', note: 'n', progress: 3 }, /progress must be one line/],
      [{ outcome: 'continue', reason: 'x', note: 'n', notes: 'a' }, /notes must be a list/],
      [{ outcome: 'continue', reason: 'x', note: 'n', notes: Array(21).fill('a') }, /limit is 20/],
      [null, /outcome must be/],
    ]
    for (const [input, re] of cases) {
      const r = validateHandover(input)
      assert.equal(r.ok, false, JSON.stringify(input))
      assert.match(r.error, re)
      assert.match(RESULTS.malformed(r.error), /^Refused: .* Fix the arguments and call handover again\.$/s)
    }
  })
})

describe('commit input and message', () => {
  test('validates subject and body', () => {
    assert.ok(validateCommit({ subject: 'Phase 2: hooks' }).ok)
    assert.equal(validateCommit({}).ok, false)
    assert.equal(validateCommit({ subject: 'a\nb' }).ok, false)
    assert.equal(validateCommit({ subject: 'x'.repeat(101) }).ok, false)
    assert.match(validateCommit({ subject: 's', body: 'x\nNightrunner-Run: fake' }).error, /trailer/)
  })
  test('message: subject, body, run trailer, configured trailers', () => {
    assert.equal(
      commitMessage({ subject: 'S', body: 'B' }, { runId: 'R', trailers: ['Co-Authored-By: C <c@x>'] }),
      'S\n\nB\n\nNightrunner-Run: R\nCo-Authored-By: C <c@x>\n',
    )
    assert.equal(commitMessage({ subject: 'S' }, { runId: 'R' }), 'S\n\nNightrunner-Run: R\n')
  })
})

describe('definitions and input', () => {
  test('three tools, named as the session sees them', () => {
    assert.deepEqual(Object.keys(TOOL_DEFINITIONS), ['status', 'handover', 'commit'])
    assert.equal(qualifiedName('handover'), 'mcp__nightrunner__handover')
  })
  test('toolInput takes the tool\'s own fields off the event', () => {
    const e = { tool: 'mcp__nightrunner__handover', tool_use_id: 't', agentId: undefined, outcome: 'complete', reason: 'r', extra: 1 }
    assert.deepEqual(toolInput('handover', e), { outcome: 'complete', reason: 'r' })
    assert.deepEqual(toolInput('commit', { input: { subject: 's' } }), { subject: 's' })
  })
})

describe('status text', () => {
  test('outside a run', () => {
    assert.equal(statusText(null, {}), RESULTS.noRun)
  })
  test('reports context against the stops and what to do', () => {
    const t = statusText(run(), { context: { tokens: 120000, window: 1000000 } })
    assert.match(t, /session 1 of at most 25/)
    assert.match(t, /Context: 120k used\. Soft stop 200k, hard stop 300k\./)
    assert.match(t, /About 80k to go/)
    const past = statusText(run(), { context: { tokens: 205000 } })
    assert.match(past, /soft stop is reached: hand over at your next checkpoint/)
  })
  test('reports a stop request and a recorded handover', () => {
    const r = requestStop(run(), { turnRunning: true, now: T0 }).run
    assert.match(statusText(r, {}), /asked the run to stop/)
    const h = applyHandover(run(), { outcome: 'continue', reason: 'r', note: 'n' }, { sessionId: 's1', runCommits: 1, now: T0 }).run
    assert.match(statusText(h, {}), /already recorded its handover/)
  })
  test('results say what to do next', () => {
    assert.match(RESULTS.subAgent('handover'), /main session only/)
    assert.match(RESULTS.secondHandover, /one per session/)
    assert.match(RESULTS.continue(3), /starts session 3/)
    assert.match(RESULTS.commitHookFailed('x'.repeat(5000)), /more characters/)
    assert.equal(RESULTS.committed({ sha: 'abc1234', branch: 'run/x', files: 1, excluded: 0 }), 'Committed abc1234 on run/x: 1 file.')
  })
})
