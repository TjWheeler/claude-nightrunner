// Run logs and the summary (D-30; build plan decisions 5 and 14). `$.fs` can't
// append, so each session's events and requests go in their own files, which
// are rewritten as the session grows. No file ever holds a whole run, so a
// rewrite from memory can never replace one.

import { endText } from './prompts.js'
import { isValidRunId } from './run-state.js'

export const ROOT = '.nightrunner'
export const RUNS = `${ROOT}/runs`
export const CURRENT = `${ROOT}/current.json`
export const GITIGNORE = `${ROOT}/.gitignore`
export const GITIGNORE_TEXT = '*\n'
export const LOG_VERSION = 1

export const runDir = id => {
  if (!isValidRunId(id)) throw new Error(`invalid run id ${JSON.stringify(id)}`)
  return `${RUNS}/${id}`
}
const pad = n => String(n).padStart(4, '0')
export const runFile = id => `${runDir(id)}/run.json`
export const summaryFile = id => `${runDir(id)}/summary.md`
export const eventsFile = (id, session) => `${runDir(id)}/events-${pad(session)}.jsonl`
export const requestsFile = (id, session) => `${runDir(id)}/requests-${pad(session)}.jsonl`

export function event(type, data, { now, session }) {
  return { v: LOG_VERSION, at: new Date(now).toISOString(), session, type, ...data }
}

export function requestRecord({ agentId, requested, sent, answeredModel, contextTokens }, { now, session }) {
  return {
    v: LOG_VERSION,
    at: new Date(now).toISOString(),
    session,
    agentId: agentId ?? null,
    requestedModel: requested?.model ?? null,
    requestedEffort: requested?.effort ?? null,
    sentModel: sent?.model ?? null,
    sentEffort: sent?.effort ?? null,
    answeredModel: answeredModel ?? null,
    contextTokens: contextTokens ?? null,
  }
}

export const toJsonl = records => records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')

/** Parse JSONL, skipping a torn last line rather than failing the whole file. */
export function fromJsonl(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* a torn line */ }
  }
  return out
}

/**
 * Per-session rows for the summary (acceptance 13).
 * @returns {{ session, startedAt, endedAt, minutes, outcome, reason, peakContext, commits, refusals }[]}
 */
export function summariseSessions(events) {
  const rows = new Map()
  const row = n => {
    if (!rows.has(n)) rows.set(n, { session: n, startedAt: null, endedAt: null, minutes: null, outcome: null, reason: null, peakContext: 0, commits: [], refusals: 0, waits: 0 })
    return rows.get(n)
  }
  for (const e of events) {
    if (typeof e.session !== 'number') continue
    const r = row(e.session)
    if (!r.startedAt || e.at < r.startedAt) r.startedAt = e.at
    if (!r.endedAt || e.at > r.endedAt) r.endedAt = e.at
    switch (e.type) {
      case 'handover': r.outcome = e.outcome; r.reason = e.reason; break
      case 'commit': r.commits.push(e.sha); break
      case 'refusal': r.refusals++; break
      case 'wait.start': r.waits++; break
      case 'context': r.peakContext = Math.max(r.peakContext, e.tokens ?? 0); break
      case 'session.end': r.peakContext = Math.max(r.peakContext, e.peakContext ?? 0); break
    }
  }
  for (const r of rows.values()) {
    if (r.startedAt && r.endedAt) r.minutes = Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 60000)
  }
  return [...rows.values()].sort((a, b) => a.session - b.session)
}

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

/** summary.md, written when the run ends. */
export function formatSummary(run, events) {
  const sessions = summariseSessions(events)
  const notes = events.filter(e => e.type === 'handover' && Array.isArray(e.notes) && e.notes.length)
  const lines = [
    `# nightrunner run ${run.name ? `${run.name} (${run.id})` : run.id}`,
    '',
    `- **Result:** ${endText(run.endReason)}${run.lastHandover?.reason && ['blocked', 'complete', 'error'].includes(run.endReason) ? ` — ${cell(run.lastHandover.reason)}` : ''}`,
    `- **Branch:** ${run.branch}, from ${String(run.startHead ?? '').slice(0, 12)}`,
    `- **Started:** ${run.startedAt}; **ended:** ${run.endedAt ?? 'not ended'}`,
    `- **Sessions:** ${run.sessionCount} of at most ${run.settings.sessionLimit}`,
    `- **Model:** ${run.settings.model} at ${run.settings.effort}`,
  ]
  if (run.removals?.length) lines.push(`- **Deny removals in force:** ${run.removals.join(', ')}`)
  lines.push('', '| Session | Outcome | Reason | Peak context | Minutes | Commits | Refusals |', '|---|---|---|---|---|---|---|')
  for (const s of sessions) {
    lines.push(`| ${s.session} | ${s.outcome ?? '—'} | ${cell(s.reason) || '—'} | ${s.peakContext ? `${Math.round(s.peakContext / 1000)}k` : '—'} | ${s.minutes ?? '—'} | ${s.commits.map(c => String(c).slice(0, 7)).join(', ') || '—'} | ${s.refusals} |`)
  }
  lines.push('', '## Notes for review', '')
  if (notes.length) {
    for (const e of notes) for (const n of e.notes) lines.push(`- (session ${e.session}) ${cell(n)}`)
  } else lines.push('None.')
  const refusals = events.filter(e => e.type === 'refusal')
  if (refusals.length) {
    lines.push('', '## Refusals', '')
    for (const e of refusals) lines.push(`- (session ${e.session}${e.agentId ? `, sub-agent ${e.agentId}` : ''}) ${cell(e.what)}`)
  }
  return lines.join('\n') + '\n'
}

/**
 * Run folders to remove at run start (decision 14): the oldest beyond `keep`,
 * never the current run, and only well-formed run ids.
 */
export function runsToPrune(ids, keep, currentId) {
  const valid = ids.filter(isValidRunId).filter(id => id !== currentId).sort()
  const keepOthers = Math.max(0, keep - (currentId ? 1 : 0))
  return valid.slice(0, Math.max(0, valid.length - keepOthers))
}

/**
 * Whether an absolute path is strictly inside the runs folder of a working
 * directory. Used before any delete.
 */
export function isInsideRuns(cwd, target) {
  const norm = p => {
    const parts = []
    for (const seg of String(p).replace(/\\/g, '/').split('/')) {
      if (!seg || seg === '.') continue
      if (seg === '..') { if (!parts.length) return null; parts.pop(); continue }
      parts.push(seg)
    }
    return parts
  }
  const base = norm(`${cwd}/${RUNS}`)
  const t = norm(target)
  if (!base || !t || t.length <= base.length) return false
  const fold = s => (/^[A-Za-z]:$/.test(base[0] ?? '') ? s.toLowerCase() : s)
  return base.every((seg, i) => fold(seg) === fold(t[i]))
}
