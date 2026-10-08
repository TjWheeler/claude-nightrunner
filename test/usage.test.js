import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyTurnEnd, planWait, remainingWait, RESUME_MARGIN_MS } from '../plugin/lib/usage.js'

const NOW = Date.parse('2026-10-08T22:00:00Z')
const fiveHour = (p, at = '2026-10-08T23:30:00Z') => ({ kind: 'five_hour', percentUsed: p, resetsAt: at })
const sevenDay = (p, at = '2026-10-12T16:00:00Z') => ({ kind: 'seven_day', percentUsed: p, resetsAt: at })

test('a turn that ends in error with a window at 100% is a usage-limit stop', () => {
  assert.equal(classifyTurnEnd({ reason: 'error', rateLimits: [fiveHour(100), sevenDay(60)] }), 'usage-limit')
})

test('a StopFailure rate_limit is a usage-limit stop even before a reading arrives', () => {
  assert.equal(classifyTurnEnd({ reason: 'error', stopFailureError: 'rate_limit', rateLimits: [] }), 'usage-limit')
})

test('an error with no window at its limit is an ordinary error', () => {
  assert.equal(classifyTurnEnd({ reason: 'error', rateLimits: [fiveHour(80)] }), 'error')
})

test('an answered turn under the limits is ok', () => {
  assert.equal(classifyTurnEnd({ reason: 'answer', rateLimits: [fiveHour(99.9)] }), 'ok')
  assert.equal(classifyTurnEnd({ reason: 'answer' }), 'ok')
})

test('overage: a window past 100%, or a turn succeeding at 100%', () => {
  assert.equal(classifyTurnEnd({ reason: 'answer', rateLimits: [{ kind: 'spend_limit', percentUsed: 104 }] }), 'overage')
  assert.equal(classifyTurnEnd({ reason: 'error', rateLimits: [{ kind: 'spend_limit', percentUsed: 101 }] }), 'overage')
  assert.equal(classifyTurnEnd({ reason: 'answer', rateLimits: [fiveHour(100)] }), 'overage')
})

test('the wait runs to the reset plus a two-minute margin', () => {
  const r = planWait({ rateLimits: [fiveHour(100)], now: NOW, maxWaitHours: 6 })
  assert.equal(r.action, 'wait')
  assert.equal(r.until, new Date(Date.parse('2026-10-08T23:30:00Z') + RESUME_MARGIN_MS).toISOString())
  assert.equal(r.ms, 92 * 60 * 1000)
  assert.equal(r.window, 'five_hour')
})

test('with two windows exhausted, the wait runs to the later reset', () => {
  const r = planWait({ rateLimits: [fiveHour(100), sevenDay(100, '2026-10-09T01:00:00Z')], now: NOW, maxWaitHours: 6 })
  assert.equal(r.window, 'seven_day')
})

test('a reset beyond the maximum wait stops the run', () => {
  const r = planWait({ rateLimits: [sevenDay(100)], now: NOW, maxWaitHours: 6 })
  assert.equal(r.action, 'stop')
  assert.match(r.reason, /seven_day limit resets at 2026-10-12T16:00:00.000Z, beyond the 6-hour maximum wait/)
})

test('a maximum wait of 0 never waits', () => {
  assert.equal(planWait({ rateLimits: [fiveHour(100)], now: NOW, maxWaitHours: 0 }).action, 'stop')
})

test('no reset time stops the run', () => {
  assert.equal(planWait({ rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], now: NOW, maxWaitHours: 6 }).action, 'stop')
  assert.equal(planWait({ rateLimits: [], now: NOW, maxWaitHours: 6 }).action, 'stop')
})

test('a reset already past waits only the margin', () => {
  const r = planWait({ rateLimits: [fiveHour(100, '2026-10-08T21:59:00Z')], now: NOW, maxWaitHours: 6 })
  assert.equal(r.ms, RESUME_MARGIN_MS)
})

test('remainingWait', () => {
  assert.equal(remainingWait('2026-10-08T22:10:00Z', NOW), 600000)
  assert.equal(remainingWait('2026-10-08T21:00:00Z', NOW), 0)
  assert.equal(remainingWait('garbage', NOW), 0)
})
