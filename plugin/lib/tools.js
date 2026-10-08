// The three session tools: their definitions, input checks and result text.
// The host doesn't enforce a declared schema, so every input is checked here. Results
// are plain strings saying what happens next, or why a call was refused and
// what to do instead.

import { OUTCOMES } from './run-state.js'

export const PLUGIN_NAME = 'nightrunner'
export const TOOL_NAMES = ['status', 'handover', 'commit']
export const qualifiedName = tool => `mcp__${PLUGIN_NAME}__${tool}`

export const LIMITS = { reason: 200, note: 8000, progress: 200, notes: 20, noteItem: 2000, subject: 100, body: 10000 }

export const TOOL_DEFINITIONS = {
  status: {
    name: 'status',
    description:
      "Reports this nightrunner run: context used against the soft and hard stops, the session number against the limit, " +
      'and whether a stop was requested. Call it first in every session of a run, and at each checkpoint. ' +
      'Outside a run it says no run is active.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  handover: {
    name: 'handover',
    description:
      'Records how this session of a nightrunner run ends. Call it from the main session only, once per session, as the last action of your turn. ' +
      'outcome "continue": nightrunner clears the context and starts the next session with your note; commit the phase and record state in the repo first. ' +
      '"blocked": a decision needs the user; put the question to them first, then call this, and the run stops with the question on screen. ' +
      '"complete": the work is done. "error": something failed that the next session cannot fix.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: OUTCOMES, description: 'continue, blocked, complete or error.' },
        reason: { type: 'string', description: `One line, at most ${LIMITS.reason} characters. For blocked, the question; it goes in the notification.` },
        note: { type: 'string', description: `Required for continue, at most ${LIMITS.note} characters: what you were doing, what is done and what comes next. The next session starts from it. Name skills in words; never start it with "/".` },
        progress: { type: 'string', description: `Optional progress marker, at most ${LIMITS.progress} characters, such as "phase 3 of 6". Used for the no-progress limit when phase commits are off.` },
        notes: { type: 'array', items: { type: 'string' }, description: `Optional notes for the morning review, at most ${LIMITS.notes}.` },
      },
      required: ['outcome', 'reason'],
      additionalProperties: false,
    },
  },
  commit: {
    name: 'commit',
    description:
      "Makes the phase commit on the run's branch: stages every change except the excluded and secret files, runs the repo's pre-commit hook, " +
      'and commits with the run trailer. Main session only; git commit itself is refused during a run.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: `The commit subject, one line, at most ${LIMITS.subject} characters.` },
        body: { type: 'string', description: `Optional commit body, at most ${LIMITS.body} characters.` },
      },
      required: ['subject'],
      additionalProperties: false,
    },
  },
}

/** Pick a tool's own fields off the hook event (the host adds tool, tool_use_id, agentId and others). */
export function toolInput(tool, e) {
  const props = Object.keys(TOOL_DEFINITIONS[tool].inputSchema.properties)
  const src = e?.input && typeof e.input === 'object' ? e.input : e ?? {}
  const out = {}
  for (const k of props) if (src[k] !== undefined) out[k] = src[k]
  return out
}

const oneLine = s => !/[\r\n]/.test(s)

/** @returns {{ ok: true, value } | { ok: false, error: string }} */
export function validateHandover(input) {
  const { outcome, reason, note, progress, notes } = input ?? {}
  if (!OUTCOMES.includes(outcome)) return bad(`outcome must be one of ${OUTCOMES.join(', ')}; got ${JSON.stringify(outcome)}.`)
  if (typeof reason !== 'string' || !reason.trim()) return bad('reason is required: one line saying why.')
  if (!oneLine(reason)) return bad('reason must be one line.')
  if (reason.length > LIMITS.reason) return bad(`reason is ${reason.length} characters; the limit is ${LIMITS.reason}.`)
  if (outcome === 'continue') {
    if (typeof note !== 'string' || !note.trim()) return bad('note is required for continue: what you were doing, what is done and what comes next.')
  }
  if (note !== undefined) {
    if (typeof note !== 'string') return bad('note must be text.')
    if (note.length > LIMITS.note) return bad(`note is ${note.length} characters; the limit is ${LIMITS.note}. Keep state in the repo and point to it.`)
    if (note.trimStart().startsWith('/')) return bad('note must not start with "/": the next session would read it as a command. Name the skill in words instead.')
  }
  if (progress !== undefined) {
    if (typeof progress !== 'string' || !oneLine(progress)) return bad('progress must be one line of text.')
    if (progress.length > LIMITS.progress) return bad(`progress is ${progress.length} characters; the limit is ${LIMITS.progress}.`)
  }
  if (notes !== undefined) {
    if (!Array.isArray(notes) || notes.some(n => typeof n !== 'string')) return bad('notes must be a list of strings.')
    if (notes.length > LIMITS.notes) return bad(`notes has ${notes.length} items; the limit is ${LIMITS.notes}.`)
    const long = notes.find(n => n.length > LIMITS.noteItem)
    if (long) return bad(`a note is ${long.length} characters; the limit is ${LIMITS.noteItem}.`)
  }
  const value = { outcome, reason: reason.trim() }
  if (note !== undefined && note.trim()) value.note = note.trim()
  if (progress !== undefined && progress.trim()) value.progress = progress.trim()
  if (notes?.length) value.notes = notes.map(n => n.trim()).filter(Boolean)
  return { ok: true, value }
}

/** @returns {{ ok: true, value } | { ok: false, error: string }} */
export function validateCommit(input) {
  const { subject, body } = input ?? {}
  if (typeof subject !== 'string' || !subject.trim()) return bad('subject is required.')
  if (!oneLine(subject)) return bad('subject must be one line; put detail in body.')
  if (subject.length > LIMITS.subject) return bad(`subject is ${subject.length} characters; the limit is ${LIMITS.subject}.`)
  if (body !== undefined) {
    if (typeof body !== 'string') return bad('body must be text.')
    if (body.length > LIMITS.body) return bad(`body is ${body.length} characters; the limit is ${LIMITS.body}.`)
    if (/^nightrunner-run:/im.test(body)) return bad('body must not carry a Nightrunner-Run trailer; nightrunner adds it.')
  }
  return { ok: true, value: { subject: subject.trim(), body: body?.trim() || undefined } }
}

function bad(error) {
  return { ok: false, error }
}

/** The commit message: subject, body, then the run trailer and any configured trailers. */
export function commitMessage({ subject, body }, { runId, trailers = [] }) {
  const parts = [subject]
  if (body) parts.push(body)
  parts.push([`Nightrunner-Run: ${runId}`, ...trailers].join('\n'))
  return parts.join('\n\n') + '\n'
}

// ---------------------------------------------------------------------------
// Result text

export const RESULTS = {
  noRun: 'No nightrunner run is active, so this did nothing. A run starts with /nightrunner start, which only the user runs.',
  subAgent: tool => `Refused: ${tool} is for the main session only. Report back to the main session instead; it decides how the session ends.`,
  secondHandover: 'Refused: this session already recorded its handover, and nightrunner acts on one per session. End your turn now.',
  malformed: error => `Refused: ${error} Fix the arguments and call handover again.`,
  waiting: 'The run is waiting for a usage-limit reset and will carry on by itself. End your turn.',

  continue: n => `Handover recorded. When this turn ends nightrunner clears the context and starts session ${n} with your note. End your turn now; don't start more work.`,
  stopAtContinue: 'Handover recorded, but the user asked the run to stop, so it ends here and no new session starts. End your turn.',
  limitAtContinue: why => `Handover recorded, but ${why}, so the run ends here and the user is notified. End your turn.`,
  blocked: 'Run ended as blocked. The user is notified; leave the question on screen for them to answer here. End your turn.',
  complete: 'Run ended as complete. The user is notified. End your turn.',
  error: 'Run ended as an error. The user is notified. End your turn.',

  commitOff: 'Refused: phase commits are off for this run, so nothing is committed. Leave the changes in the working tree.',
  commitWrongBranch: (branch, current) => `Refused: the run is on "${branch}" but "${current}" is checked out. Don't switch branches; call handover with blocked.`,
  commitNothing: 'Nothing to commit: no changes outside the excluded files.',
  commitSecret: list => `Refused: staged files match secret patterns: ${list.map(s => `${s.path} (${s.pattern})`).join(', ')}. They were staged before the run or by hand. Don't unstage them yourself; call handover with blocked so the user can check.`,
  commitExcluded: list => `Refused: staged files match commit exclusions: ${list.map(s => `${s.path} (${s.pattern})`).join(', ')}. Call handover with blocked so the user can check.`,
  commitHookChanged: 'Refused: the pre-commit hook changed since the run started, so nightrunner won\'t run it. Call handover with blocked so the user can check it.',
  commitHookFailed: output => `The pre-commit hook failed, so nothing was committed. Fix what it reports and call commit again, or call handover with blocked.\n\n${truncate(output, 4000)}`,
  commitFailed: output => `git commit failed, so nothing was committed:\n\n${truncate(output, 4000)}`,
  committed: ({ sha, branch, files, excluded }) =>
    `Committed ${sha} on ${branch}: ${files} file${files === 1 ? '' : 's'}${excluded ? `; ${excluded} excluded file${excluded === 1 ? '' : 's'} left in the working tree` : ''}.`,
}

export function truncate(text, max) {
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, max) + `\n… (${s.length - max} more characters)`
}

/** The status tool's text: context against the soft and hard stops, and the session count. */
export function statusText(run, { context } = {}) {
  if (!run || run.status === 'ended') return RESULTS.noRun
  const s = run.settings
  const lines = [
    `nightrunner run ${run.name ? `"${run.name}" ` : ''}(${run.id}), session ${run.session.number} of at most ${s.sessionLimit}, on branch ${run.branch}.`,
  ]
  if (context && typeof context.tokens === 'number') {
    const k = n => `${Math.round(n / 1000)}k`
    lines.push(`Context: ${k(context.tokens)} used. Soft stop ${k(s.softStopTokens)}, hard stop ${k(s.hardStopTokens)}.`)
    if (context.tokens >= s.softStopTokens) lines.push('The soft stop is reached: hand over at your next checkpoint (commit the phase, record state, call handover with continue).')
    else lines.push(`About ${k(s.softStopTokens - context.tokens)} to go before the soft stop.`)
  } else lines.push('Context use is not known yet in this session.')
  lines.push(s.phaseCommits ? 'Phase commits are on: commit each finished phase with the commit tool.' : 'Phase commits are off: pass a progress marker with each handover.')
  if (run.noProgressCount) lines.push(`${run.noProgressCount} session${run.noProgressCount === 1 ? '' : 's'} in a row without progress; the limit is ${s.noProgressLimit}.`)
  if (run.stopRequested) lines.push('The user asked the run to stop: finish the current step, record state, and call handover.')
  if (run.session.handover) lines.push('This session has already recorded its handover. End your turn.')
  if (run.status === 'waiting') lines.push(`Waiting for a usage-limit reset until ${run.waitUntil}.`)
  return lines.join('\n')
}
