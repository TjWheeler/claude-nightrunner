import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import * as rs from '../plugin/lib/run-state.js'
import { resolveSettings } from '../plugin/lib/config.js'

const T0 = Date.parse('2026-10-08T20:00:00Z')
const cfg = (run = {}) => resolveSettings({ run })
const make = (over = {}) => {
  const c = cfg(over)
  return rs.createRun({ id: '20261008-200000-abcd', name: 'demo', settings: c.settings, sources: c.sources, branch: 'run/x', startHead: 'h0', now: T0, pid: 10, sessionId: 's1' })
}
const handover = (outcome = 'continue', extra = {}) => ({ outcome, reason: 'r', note: outcome === 'continue' ? 'next' : undefined, ...extra })

describe('ids and branches', () => {
  test('run id format', () => {
    assert.equal(rs.newRunId(Date.parse('2026-10-08T21:05:09Z'), '0f3a'), '20261008-210509-0f3a')
    assert.ok(rs.isValidRunId('20261008-210509-0f3a'))
    assert.ok(!rs.isValidRunId('../x'))
    assert.throws(() => rs.newRunId(T0, 'XYZ1'))
  })
  test('protected branches: main, master, the remote default and additions', () => {
    assert.ok(rs.isProtectedBranch('main'))
    assert.ok(rs.isProtectedBranch('master'))
    assert.ok(rs.isProtectedBranch('trunk', [], 'trunk'))
    assert.ok(rs.isProtectedBranch('release', ['release']))
    assert.ok(!rs.isProtectedBranch('run/x', [], 'main'))
  })
})

describe('start checks', () => {
  const base = { config: cfg(), branch: 'run/x', remoteDefault: 'main', existing: null, now: T0, pid: 1 }
  test('a working branch with valid settings starts', () => {
    assert.deepEqual(rs.startChecks(base), { ok: true, errors: [] })
  })
  test('a protected branch is refused with the reason', () => {
    const r = rs.startChecks({ ...base, branch: 'main' })
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /"main" is a protected branch.*never creates one/)
    assert.equal(rs.startChecks({ ...base, branch: 'develop', remoteDefault: 'develop' }).ok, false)
  })
  test('a detached HEAD is refused', () => {
    assert.match(rs.startChecks({ ...base, branch: null, detached: true }).errors[0], /detached/)
  })
  test('invalid settings are refused with their reasons', () => {
    const r = rs.startChecks({ ...base, config: cfg({ softStopTokens: 400000 }) })
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /softStopTokens/)
  })
  test('another run: active elsewhere, here, or suspended', () => {
    const run = make()
    assert.match(rs.startChecks({ ...base, existing: { ...run, ownerPid: 99 }, now: T0 + 30000 }).errors[0], /another Claude Code process/)
    assert.match(rs.startChecks({ ...base, existing: { ...run, ownerPid: 1 } }).errors[0], /already active/)
    assert.match(rs.startChecks({ ...base, existing: rs.suspend(run) }).errors[0], /suspended.*resume.*stop/)
    assert.match(rs.startChecks({ ...base, existing: { ...run, ownerPid: 99 }, now: T0 + rs.STALE_MS + 1 }).errors[0], /suspended/)
    assert.ok(rs.startChecks({ ...base, existing: rs.endRun(run, 'complete', T0) }).ok)
  })
  test('resume checks', () => {
    const run = rs.suspend(make())
    assert.ok(rs.startChecks({ ...base, existing: run, resuming: true }).ok)
    assert.match(rs.startChecks({ ...base, existing: null, resuming: true }).errors[0], /no suspended run/)
    assert.match(rs.startChecks({ ...base, existing: run, branch: 'other', resuming: true }).errors[0], /ran on "run\/x"/)
    assert.match(rs.startChecks({ ...base, existing: { ...run, sessionCount: 25 }, resuming: true }).errors[0], /all 25 sessions/)
    assert.match(rs.startChecks({ ...base, existing: { ...make(), ownerPid: 99 }, now: T0 + 1000, resuming: true }).errors[0], /another/)
  })
})

describe('ownership', () => {
  test('fresh, stale, mine, suspended, none', () => {
    const run = make()
    assert.equal(rs.ownership(run, { now: T0, pid: 10 }), 'mine')
    assert.equal(rs.ownership(run, { now: T0 + rs.STALE_MS, pid: 11 }), 'elsewhere')
    assert.equal(rs.ownership(run, { now: T0 + rs.STALE_MS + 1, pid: 11 }), 'stale')
    assert.equal(rs.ownership(rs.suspend(run), { now: T0, pid: 10 }), 'suspended')
    assert.equal(rs.ownership(null, { now: T0, pid: 10 }), 'none')
    assert.equal(rs.ownership({ ...rs.enterWait(run, { until: 'x' }), ownerPid: 3 }, { now: T0 + rs.STALE_MS + 1, pid: 1 }), 'stale')
  })
})

describe('handovers', () => {
  test('continue with a commit clears', () => {
    const r = rs.applyHandover(make(), handover(), { sessionId: 's1', runCommits: 1, now: T0 })
    assert.equal(r.action, 'clear')
    assert.equal(r.run.noProgressCount, 0)
    assert.equal(r.run.lastHandover.note, 'next')
    assert.equal(r.run.lastHandover.sessionNumber, 1)
  })
  test('blocked, complete and error end the run as themselves', () => {
    for (const o of ['blocked', 'complete', 'error']) {
      const r = rs.applyHandover(make(), handover(o), { sessionId: 's1', now: T0 })
      assert.equal(r.action, 'end')
      assert.equal(r.run.status, 'ended')
      assert.equal(r.run.endReason, o)
      assert.equal(rs.reportedOutcome(o), o)
    }
  })
  test('the session limit ends the run on the last session\'s continue', () => {
    let run = make({ sessionLimit: '2' })
    run = rs.applyHandover(run, handover(), { sessionId: 's1', runCommits: 1, now: T0 }).run
    run = rs.beginSession(run, { sessionId: 's2', head: 'h1', now: T0 })
    assert.equal(run.sessionCount, 2)
    const r = rs.applyHandover(run, handover(), { sessionId: 's2', runCommits: 1, now: T0 })
    assert.equal(r.endReason, 'session-limit')
    assert.equal(rs.reportedOutcome('session-limit'), 'error')
  })
  test('the no-progress limit counts consecutive sessions without a run commit', () => {
    let run = make()
    for (let i = 1; i <= 2; i++) {
      const r = rs.applyHandover(run, handover(), { sessionId: `s${i}`, runCommits: 0, now: T0 })
      assert.equal(r.action, 'clear')
      run = rs.beginSession(r.run, { sessionId: `s${i + 1}`, head: 'h', now: T0 })
    }
    assert.equal(run.noProgressCount, 2)
    assert.equal(rs.applyHandover(run, handover(), { sessionId: 's3', runCommits: 0, now: T0 }).endReason, 'no-progress')
  })
  test('a commit resets the no-progress count', () => {
    let run = { ...make(), noProgressCount: 2 }
    assert.equal(rs.applyHandover(run, handover(), { sessionId: 's1', runCommits: 2, now: T0 }).run.noProgressCount, 0)
  })
  test('with commits off, progress is a changed marker', () => {
    let run = make({ phaseCommits: 'off' })
    let r = rs.applyHandover(run, handover('continue', { progress: 'step 1' }), { sessionId: 's1', now: T0 })
    assert.equal(r.run.noProgressCount, 0)
    run = rs.beginSession(r.run, { sessionId: 's2', head: 'h', now: T0 })
    r = rs.applyHandover(run, handover('continue', { progress: 'step 1' }), { sessionId: 's2', now: T0 })
    assert.equal(r.run.noProgressCount, 1)
    run = rs.beginSession(r.run, { sessionId: 's3', head: 'h', now: T0 })
    r = rs.applyHandover(run, handover('continue'), { sessionId: 's3', now: T0 })
    assert.equal(r.run.noProgressCount, 2, 'no marker is no progress')
    assert.equal(r.run.lastProgressMarker, 'step 1')
  })
  test('a stop request turns the next continue into the end', () => {
    const flagged = rs.requestStop(make(), { turnRunning: true, now: T0 })
    assert.equal(flagged.action, 'flagged')
    const r = rs.applyHandover(flagged.run, handover(), { sessionId: 's1', runCommits: 1, now: T0 })
    assert.equal(r.endReason, 'stopped')
    assert.equal(r.run.lastHandover.note, 'next', 'the handover is still recorded')
    assert.equal(rs.applyHandover(flagged.run, handover('blocked'), { sessionId: 's1', now: T0 }).endReason, 'blocked')
  })
  test('stop with no turn running, or while waiting, ends at once', () => {
    assert.equal(rs.requestStop(make(), { turnRunning: false, now: T0 }).endReason, 'stopped')
    assert.equal(rs.requestStop(rs.enterWait(make(), { until: 'x' }), { turnRunning: true, now: T0 }).endReason, 'stopped')
  })
  test('notifications: every end but a user stop, and only with push on', () => {
    assert.ok(rs.shouldNotify(rs.endRun(make(), 'complete', T0)))
    assert.ok(rs.shouldNotify(rs.endRun(make(), 'no-progress', T0)))
    assert.ok(!rs.shouldNotify(rs.endRun(make(), 'stopped', T0)))
    assert.ok(!rs.shouldNotify(rs.endRun(make({ notifications: 'none' }), 'blocked', T0)))
    assert.ok(!rs.shouldNotify(make()))
  })
})

describe('turns, nudges and the hard stop', () => {
  test('a turn ending without a handover goes idle; with one, clears', () => {
    assert.equal(rs.onTurnComplete(make(), { now: T0 }).action, 'idle')
    const run = rs.applyHandover(make(), handover(), { sessionId: 's1', runCommits: 1, now: T0 }).run
    assert.equal(rs.onTurnComplete(run, { now: T0 }).action, 'clear')
  })
  test('three nudges in a row, then the run ends as an error', () => {
    let run = make()
    for (let i = 0; i < rs.MAX_NUDGES; i++) {
      const r = rs.onIdle(run, { now: T0 })
      assert.equal(r.action, 'nudge')
      run = rs.onTurnStart(r.run, { byNudge: true })
    }
    const r = rs.onIdle(run, { now: T0 })
    assert.equal(r.endReason, 'nudge-limit')
  })
  test('a turn not started by a nudge resets the count', () => {
    let run = rs.onIdle(rs.onIdle(make(), { now: T0 }).run, { now: T0 }).run
    assert.equal(run.session.nudges, 2)
    run = rs.onTurnStart(run, { byNudge: false })
    assert.equal(run.session.nudges, 0)
  })
  test('no nudge once a handover is recorded', () => {
    const run = rs.applyHandover(make(), handover(), { sessionId: 's1', runCommits: 1, now: T0 }).run
    assert.equal(rs.onIdle(run, { now: T0 }).action, 'none')
  })
  test('the hard stop aborts once, prompts, then ends if no handover follows', () => {
    let r = rs.onContext(make(), 250000)
    assert.equal(r.action, 'none')
    assert.equal(r.run.session.peakContext, 250000)
    r = rs.onContext(r.run, 300000)
    assert.equal(r.action, 'abort')
    assert.equal(rs.onContext(r.run, 310000).action, 'none', 'aborts only once')
    let t = rs.onTurnComplete(r.run, { now: T0 })
    assert.equal(t.action, 'hard-stop-prompt')
    t = rs.onTurnComplete(t.run, { now: T0 })
    assert.equal(t.endReason, 'hard-stop-no-handover')
  })
  test('a handover after the hard-stop prompt clears normally', () => {
    let run = rs.onContext(make(), 300000).run
    run = rs.onTurnComplete(run, { now: T0 }).run
    run = rs.applyHandover(run, handover(), { sessionId: 's1', runCommits: 1, now: T0 }).run
    assert.equal(rs.onTurnComplete(run, { now: T0 }).action, 'clear')
  })
})

describe('waits, suspension and resume', () => {
  test('a wait keeps the session; finishing it marks the next prompt as after a wait', () => {
    let run = rs.enterWait(make(), { until: '2026-10-08T23:32:00Z' })
    assert.equal(run.status, 'waiting')
    run = rs.finishWait(run)
    assert.equal(run.status, 'active')
    assert.equal(run.afterWait, true)
    assert.equal(run.sessionCount, 1)
    assert.equal(run.waitUntil, null)
  })
  test('resume starts a new session from the last handover, same counts', () => {
    let run = rs.applyHandover(make(), handover(), { sessionId: 's1', runCommits: 0, now: T0 }).run
    run = rs.suspend(run)
    const resumed = rs.resumeRun(run, { sessionId: 's9', head: 'h9', now: T0 + 1e6, pid: 77 })
    assert.equal(resumed.status, 'active')
    assert.equal(resumed.sessionCount, 2)
    assert.equal(resumed.noProgressCount, 1)
    assert.equal(resumed.ownerPid, 77)
    assert.equal(resumed.session.id, 's9')
    assert.equal(resumed.lastHandover.note, 'next')
  })
  test('a run suspended while waiting resumes as after a wait', () => {
    const run = rs.suspend(rs.enterWait(make(), { until: 'x' }))
    assert.equal(rs.resumeRun(run, { sessionId: 's2', head: 'h', now: T0, pid: 1 }).afterWait, true)
  })
})

describe('the model pin check', () => {
  test('matches', () => {
    assert.ok(rs.modelMatches('claude-opus-5-5', 'claude-opus-5-5'))
    assert.ok(rs.modelMatches('claude-haiku-4-5', 'claude-haiku-4-5-20251001'))
    assert.ok(rs.modelMatches('claude-opus-5-5[1m]', 'claude-opus-5-5'))
    assert.ok(rs.modelMatches('claude-opus-5-5', undefined))
  })
  test('mismatches', () => {
    assert.ok(!rs.modelMatches('claude-opus-5-5', 'claude-sonnet-5-5'))
    assert.ok(!rs.modelMatches('claude-opus-5', 'claude-opus-5-5'))
  })
})
