// Run settings (D-14, D-17; build plan decision 3). Layers apply in order —
// built-in defaults, the committed project file (.claude/nightrunner.json),
// the user's plugin options, then run-start arguments — and the later wins.
// List settings add up across layers instead. denyRemove is read only from
// the user's options (D-15). The resolved values are fixed at run start.

import { buildDenyList, parseEntry, splitList } from './deny.js'

export const PROJECT_FILE = '.claude/nightrunner.json'
export const LAYERS = ['default', 'project', 'user', 'run']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

/** Every setting, its type, default and one-line description (README and manifest). */
export const SETTINGS = {
  model: { type: 'string', default: 'claude-opus-5-5', description: 'Model every main-session request is sent on during a run.' },
  effort: { type: 'enum', values: EFFORTS, default: 'medium', description: 'Effort every main-session request is sent at during a run.' },
  softStopTokens: { type: 'int', min: 1, default: 200000, description: 'Context size at which the status tool tells the driver to hand over at its next checkpoint.' },
  hardStopTokens: { type: 'int', min: 1, default: 300000, description: 'Context size at which nightrunner stops the turn and asks for a handover now.' },
  sessionLimit: { type: 'int', min: 1, max: 1000, default: 25, description: 'Most sessions in one run.' },
  noProgressLimit: { type: 'int', min: 1, max: 100, default: 3, description: 'Consecutive sessions without progress before the run stops.' },
  maxUsageWaitHours: { type: 'number', min: 0, max: 168, default: 6, description: 'Longest wait for a usage-limit reset; a later reset ends the run.' },
  phaseCommits: { type: 'bool', default: true, description: 'Whether the driver commits each phase through the commit tool.' },
  notifications: { type: 'enum', values: ['push', 'none'], default: 'push', description: 'Push a notification on blocked, complete and error.' },
  commitTrailers: { type: 'list', default: [], description: 'Extra trailer lines added to every run commit, such as Co-Authored-By.' },
  denyAdd: { type: 'list', default: [], description: 'Commands or MCP tool patterns refused during a run, on top of the built-in list.' },
  denyRemove: { type: 'list', default: [], userOnly: true, description: 'Built-in deny entries to drop or narrow. Your own plugin options only.' },
  protectedBranches: { type: 'list', default: [], description: 'Branches a run refuses to start on, on top of main, master and the remote default.' },
  commitExclusions: { type: 'list', default: [], description: 'Paths never staged by the commit tool, on top of the built-in exclusions.' },
  secretPatterns: { type: 'list', default: [], description: 'File patterns that refuse a commit when staged, on top of the built-in patterns.' },
  runsKept: { type: 'int', min: 1, max: 1000, default: 20, description: 'Run folders kept under .nightrunner/runs; older ones are removed at run start.' },
  idleNudgeMinutes: { type: 'number', min: 1, max: 1440, default: 15, description: 'Idle time with no handover before nightrunner asks for one.' },
}

export function defaults() {
  const out = {}
  for (const [k, s] of Object.entries(SETTINGS)) out[k] = Array.isArray(s.default) ? [...s.default] : s.default
  return out
}

const unset = v => v === undefined || v === null || (typeof v === 'string' && v.trim() === '')

/**
 * Resolve settings from the layers.
 * @param {{ project?: object|null, user?: object|null, run?: object|null, contextWindow?: number }} layers
 * @returns {{ ok: boolean, errors: string[], settings: object, sources: object, deny: { list, removals } }}
 */
export function resolveSettings({ project = null, user = null, run = null, contextWindow } = {}) {
  const errors = []
  const settings = defaults()
  const sources = Object.fromEntries(Object.keys(SETTINGS).map(k => [k, SETTINGS[k].type === 'list' ? [] : 'default']))

  const layers = { project, user, run }
  for (const layer of ['project', 'user', 'run']) {
    const values = layers[layer]
    if (values === null || values === undefined) continue
    if (typeof values !== 'object' || Array.isArray(values)) {
      errors.push(`${layerName(layer)} must be an object of settings`)
      continue
    }
    for (const [key, raw] of Object.entries(values)) {
      const spec = SETTINGS[key]
      if (!spec) {
        errors.push(`${layerName(layer)} has an unknown setting "${key}"`)
        continue
      }
      if (unset(raw) || (Array.isArray(raw) && !raw.length)) continue
      if (spec.userOnly && layer !== 'user') {
        errors.push(`${key} can only be set in your own plugin options, not in ${layerName(layer)}: a repo or a run argument can't loosen the deny list (D-15)`)
        continue
      }
      const parsed = coerce(key, spec, raw)
      if (parsed.error) {
        errors.push(`${key} in ${layerName(layer)}: ${parsed.error}`)
        continue
      }
      if (spec.type === 'list') {
        settings[key] = [...new Set([...settings[key], ...parsed.value])]
        sources[key].push(layer)
      } else {
        settings[key] = parsed.value
        sources[key] = layer
      }
    }
  }

  if (settings.softStopTokens >= settings.hardStopTokens) {
    errors.push(`softStopTokens (${settings.softStopTokens}) must be below hardStopTokens (${settings.hardStopTokens})`)
  }
  if (contextWindow && settings.hardStopTokens >= contextWindow) {
    errors.push(`hardStopTokens (${settings.hardStopTokens}) must be below the model's context window (${contextWindow})`)
  }

  const deny = buildDenyList({ add: settings.denyAdd, remove: settings.denyRemove })
  errors.push(...deny.errors)

  return { ok: errors.length === 0, errors, settings, sources, deny: { list: deny.list } }
}

function layerName(layer) {
  return { project: `the project file (${PROJECT_FILE})`, user: 'your plugin options', run: 'the run arguments' }[layer]
}

function coerce(key, spec, raw) {
  switch (spec.type) {
    case 'string': {
      const v = String(raw).trim()
      if (key === 'model' && !/^[A-Za-z0-9][A-Za-z0-9._:@/\-[\]]*$/.test(v)) return { error: `"${v}" isn't a model id` }
      return { value: v }
    }
    case 'enum': {
      const v = String(raw).trim().toLowerCase()
      if (!spec.values.includes(v)) return { error: `"${raw}" must be one of ${spec.values.join(', ')}` }
      return { value: v }
    }
    case 'int':
    case 'number': {
      const v = toNumber(raw)
      if (v === null) return { error: `"${raw}" isn't a number` }
      if (spec.type === 'int' && !Number.isInteger(v)) return { error: `"${raw}" must be a whole number` }
      if (spec.min !== undefined && v < spec.min) return { error: `${v} is below the minimum of ${spec.min}` }
      if (spec.max !== undefined && v > spec.max) return { error: `${v} is above the maximum of ${spec.max}` }
      return { value: v }
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { value: raw }
      const v = String(raw).trim().toLowerCase()
      if (['true', 'on', 'yes', '1'].includes(v)) return { value: true }
      if (['false', 'off', 'no', '0'].includes(v)) return { value: false }
      return { error: `"${raw}" must be true or false` }
    }
    case 'list': {
      if (!Array.isArray(raw) && typeof raw !== 'string') return { error: 'must be a list or comma-separated text' }
      const items = splitList(raw)
      for (const item of items) {
        const err = checkListItem(key, item)
        if (err) return { error: err }
      }
      return { value: items }
    }
  }
  return { error: 'unsupported setting type' }
}

function toNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  const m = /^(\d+(?:\.\d+)?|\.\d+)(k)?$/i.exec(String(raw).trim().replace(/_/g, ''))
  if (!m) return null
  return Number(m[1]) * (m[2] ? 1000 : 1)
}

function checkListItem(key, item) {
  if (/[\0\r]/.test(item)) return `"${item}" has a control character`
  switch (key) {
    case 'commitTrailers': {
      if (!/^[A-Za-z][A-Za-z0-9-]*: \S.*$/.test(item)) return `"${item}" must look like "Token: value"`
      if (/^nightrunner-run:/i.test(item)) return 'the Nightrunner-Run trailer is added by nightrunner itself'
      return null
    }
    case 'denyAdd':
    case 'denyRemove': {
      try { parseEntry(item) } catch (err) { return err.message }
      return null
    }
    case 'protectedBranches':
      return /^[A-Za-z0-9._/-]+$/.test(item) && !item.includes('..') ? null : `"${item}" isn't a branch name`
    case 'commitExclusions':
    case 'secretPatterns':
      return item.startsWith('!') ? `"${item}": negated patterns aren't supported; layers can only add` : null
  }
  return null
}

/** Settings as text for the run start notice: one line per non-default value. */
export function describeSettings(settings, sources) {
  const lines = []
  for (const key of Object.keys(SETTINGS)) {
    const src = sources[key]
    const value = settings[key]
    if (Array.isArray(value)) {
      if (value.length) lines.push(`${key}: ${value.join(', ')} (from ${src.join(', ')})`)
    } else if (src !== 'default') lines.push(`${key}: ${value} (from ${src})`)
  }
  return lines
}
