import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSettings, defaults, SETTINGS, describeSettings } from '../plugin/lib/config.js'

test('a fresh install runs on the defaults with no setup', () => {
  const r = resolveSettings()
  assert.equal(r.ok, true, r.errors.join('; '))
  assert.deepEqual(r.settings, defaults())
  assert.equal(r.settings.model, 'claude-opus-5-5')
  assert.equal(r.settings.effort, 'medium')
  assert.equal(r.settings.softStopTokens, 200000)
  assert.equal(r.settings.hardStopTokens, 300000)
  assert.equal(r.settings.sessionLimit, 25)
  assert.equal(r.settings.noProgressLimit, 3)
  assert.equal(r.settings.maxUsageWaitHours, 6)
  assert.equal(r.settings.phaseCommits, true)
  assert.equal(r.settings.notifications, 'push')
  assert.equal(r.settings.runsKept, 20)
  assert.equal(r.settings.idleNudgeMinutes, 15)
  assert.equal(r.sources.model, 'default')
})

test('later layers win for single values', () => {
  const r = resolveSettings({
    project: { softStopTokens: 150000, sessionLimit: 10, model: 'claude-sonnet-5-5' },
    user: { sessionLimit: '12', model: '' },
    run: { sessionLimit: '8' },
  })
  assert.ok(r.ok, r.errors.join('; '))
  assert.equal(r.settings.softStopTokens, 150000)
  assert.equal(r.sources.softStopTokens, 'project')
  assert.equal(r.settings.sessionLimit, 8)
  assert.equal(r.sources.sessionLimit, 'run')
  assert.equal(r.settings.model, 'claude-sonnet-5-5', 'an empty user option is unset, not an override')
})

test('list settings add up across layers', () => {
  const r = resolveSettings({
    project: { denyAdd: ['make deploy'], commitTrailers: ['Co-Authored-By: A <a@x>'] },
    user: { denyAdd: 'psql', commitTrailers: 'Reviewed-By: B' },
    run: { denyAdd: 'sqlcmd' },
  })
  assert.ok(r.ok, r.errors.join('; '))
  assert.deepEqual(r.settings.denyAdd, ['make deploy', 'psql', 'sqlcmd'])
  assert.deepEqual(r.sources.denyAdd, ['project', 'user', 'run'])
  assert.equal(r.settings.commitTrailers.length, 2)
})

test('denyRemove is refused outside the user options', () => {
  for (const layer of ['project', 'run']) {
    const r = resolveSettings({ [layer]: { denyRemove: 'kubectl get' } })
    assert.equal(r.ok, false)
    assert.match(r.errors[0], /denyRemove can only be set in your own plugin options/)
  }
  const ok = resolveSettings({ user: { denyRemove: 'kubectl get' } })
  assert.ok(ok.ok, ok.errors.join('; '))
  assert.equal(ok.deny.list.removals.length, 1)
})

test('unknown keys refuse the run, naming the key', () => {
  const r = resolveSettings({ project: { softStop: 1 } })
  assert.equal(r.ok, false)
  assert.match(r.errors[0], /unknown setting "softStop"/)
  assert.match(r.errors[0], /\.claude\/nightrunner\.json/)
})

test('invalid configurations are refused with a reason', () => {
  const cases = [
    [{ run: { softStopTokens: 300000 } }, /softStopTokens \(300000\) must be below hardStopTokens \(300000\)/],
    [{ run: { softStopTokens: '400k' } }, /must be below hardStopTokens/],
    [{ run: { hardStopTokens: 1000000 } , contextWindow: 1000000 }, /must be below the model's context window/],
    [{ run: { effort: 'turbo' } }, /effort .*must be one of low, medium, high, xhigh, max/],
    [{ run: { notifications: 'email' } }, /must be one of push, none/],
    [{ run: { sessionLimit: '0' } }, /below the minimum/],
    [{ run: { sessionLimit: '2.5' } }, /whole number/],
    [{ run: { noProgressLimit: 'three' } }, /isn't a number/],
    [{ run: { maxUsageWaitHours: '200' } }, /above the maximum/],
    [{ run: { phaseCommits: 'maybe' } }, /true or false/],
    [{ run: { model: 'claude opus' } }, /isn't a model id/],
    [{ run: { commitTrailers: 'not a trailer' } }, /Token: value/],
    [{ run: { commitTrailers: 'Nightrunner-Run: x' } }, /added by nightrunner itself/],
    [{ run: { denyAdd: 'rm -rf /' } }, /program optionally followed/],
    [{ user: { denyRemove: 'make' } }, /doesn't name a built-in/],
    [{ run: { protectedBranches: 'a..b' } }, /isn't a branch name/],
    [{ run: { secretPatterns: '!.env.example' } }, /negated patterns/],
    [{ project: ['x'] }, /must be an object/],
  ]
  for (const [layers, re] of cases) {
    const r = resolveSettings(layers)
    assert.equal(r.ok, false, JSON.stringify(layers))
    assert.ok(r.errors.some(e => re.test(e)), `${JSON.stringify(layers)}: ${r.errors.join('; ')}`)
  }
})

test('every error is reported, not just the first', () => {
  const r = resolveSettings({ run: { effort: 'x', sessionLimit: '0', bogus: 1 } })
  assert.equal(r.errors.length, 3)
})

test('numbers take a k suffix and underscores; booleans take on/off', () => {
  const r = resolveSettings({ run: { softStopTokens: '150k', hardStopTokens: '250_000', phaseCommits: 'off' } })
  assert.ok(r.ok, r.errors.join('; '))
  assert.equal(r.settings.softStopTokens, 150000)
  assert.equal(r.settings.hardStopTokens, 250000)
  assert.equal(r.settings.phaseCommits, false)
})

test('every setting has a description and a default', () => {
  for (const [k, s] of Object.entries(SETTINGS)) {
    assert.ok(s.description, k)
    assert.ok('default' in s, k)
  }
})

test('describeSettings lists what differs from the defaults', () => {
  const r = resolveSettings({ project: { sessionLimit: 10, denyAdd: 'psql' } })
  assert.deepEqual(describeSettings(r.settings, r.sources), ['sessionLimit: 10 (from project)', 'denyAdd: psql (from project)'])
})
