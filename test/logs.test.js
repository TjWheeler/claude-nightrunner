import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as logs from '../plugin/lib/logs.js'
import { createRun, endRun } from '../plugin/lib/run-state.js'
import { resolveSettings } from '../plugin/lib/config.js'

const T0 = Date.parse('2026-10-08T20:00:00Z')
const ID = '20261008-200000-abcd'
const run = () => {
  const c = resolveSettings()
  return createRun({ id: ID, name: 'demo', settings: c.settings, sources: c.sources, branch: 'run/x', startHead: '0123456789abcdef', now: T0, pid: 1, sessionId: 's1', removals: ['kubectl get'] })
}
const at = min => T0 + min * 60000

test('paths (decision 5, D-30)', () => {
  assert.equal(logs.runFile(ID), '.nightrunner/runs/20261008-200000-abcd/run.json')
  assert.equal(logs.eventsFile(ID, 3), '.nightrunner/runs/20261008-200000-abcd/events-0003.jsonl')
  assert.equal(logs.requestsFile(ID, 12), '.nightrunner/runs/20261008-200000-abcd/requests-0012.jsonl')
  assert.equal(logs.GITIGNORE_TEXT, '*\n')
  assert.throws(() => logs.runDir('../../etc'))
})

test('records and JSONL round trip, skipping a torn line', () => {
  const e = logs.event('handover', { outcome: 'continue' }, { now: T0, session: 1 })
  assert.deepEqual(e, { v: 1, at: '2026-10-08T20:00:00.000Z', session: 1, type: 'handover', outcome: 'continue' })
  const r = logs.requestRecord({ requested: { model: 'a', effort: 'high' }, sent: { model: 'b', effort: 'medium' }, answeredModel: 'b', contextTokens: 5 }, { now: T0, session: 1 })
  assert.equal(r.requestedModel, 'a')
  assert.equal(r.sentEffort, 'medium')
  const text = logs.toJsonl([e, r]) + '{"torn":'
  assert.equal(logs.fromJsonl(text).length, 2)
  assert.equal(logs.toJsonl([]), '')
})

test('the summary has a row per session and collects review notes (acceptance 13)', () => {
  const ev = (type, session, min, data = {}) => logs.event(type, data, { now: at(min), session })
  const events = [
    ev('session.start', 1, 0), ev('context', 1, 10, { tokens: 180000 }), ev('commit', 1, 30, { sha: 'aaaaaaaa1' }),
    ev('refusal', 1, 31, { what: 'git push', agentId: 'ag1' }),
    ev('handover', 1, 40, { outcome: 'continue', reason: 'soft stop', notes: ['Proposal: shorter gates'] }),
    ev('session.start', 2, 41), ev('session.end', 2, 70, { peakContext: 90000 }),
    ev('handover', 2, 70, { outcome: 'complete', reason: 'all phases | done' }),
  ]
  const rows = logs.summariseSessions(events)
  assert.equal(rows.length, 2)
  assert.deepEqual([rows[0].outcome, rows[0].peakContext, rows[0].minutes, rows[0].commits, rows[0].refusals], ['continue', 180000, 40, ['aaaaaaaa1'], 1])
  const r = { ...endRun(run(), 'complete', at(70)), sessionCount: 2, lastHandover: { reason: 'all phases | done' } }
  const md = logs.formatSummary(r, events)
  assert.match(md, /^# nightrunner run demo \(20261008-200000-abcd\)/)
  assert.match(md, /\*\*Result:\*\* complete — all phases \\\| done/)
  assert.match(md, /\| 1 \| continue \| soft stop \| 180k \| 40 \| aaaaaaa \| 1 \|/)
  assert.match(md, /\| 2 \| complete \| all phases \\\| done \| 90k \| 29 \| — \| 0 \|/)
  assert.match(md, /- \(session 1\) Proposal: shorter gates/)
  assert.match(md, /Deny removals in force:\*\* kubectl get/)
  assert.match(md, /sub-agent ag1\) git push/)
})

test('pruning keeps the newest runs and never the current one (decision 14)', () => {
  const ids = ['20261001-000000-0001', '20261002-000000-0002', '20261003-000000-0003', 'junk', '20261004-000000-0004']
  assert.deepEqual(logs.runsToPrune(ids, 2, '20261004-000000-0004'), ['20261001-000000-0001', '20261002-000000-0002'])
  assert.deepEqual(logs.runsToPrune(ids, 20, '20261004-000000-0004'), [])
  assert.deepEqual(logs.runsToPrune(ids, 1, '20261004-000000-0004'), ['20261001-000000-0001', '20261002-000000-0002', '20261003-000000-0003'])
})

test('deletes are confined to the runs folder', () => {
  assert.ok(logs.isInsideRuns('/repo', '/repo/.nightrunner/runs/20261001-000000-0001'))
  assert.ok(!logs.isInsideRuns('/repo', '/repo/.nightrunner/runs'))
  assert.ok(!logs.isInsideRuns('/repo', '/repo/.nightrunner/runs/../../src'))
  assert.ok(!logs.isInsideRuns('/repo', '/repo/.nightrunner'))
  assert.ok(!logs.isInsideRuns('/repo', '/other/.nightrunner/runs/x'))
  assert.ok(logs.isInsideRuns('C:\\repo', 'c:\\repo\\.nightrunner\\runs\\x'))
})
