// The prompts and notices nightrunner sends.

const label = run => (run.name ? `"${run.name}" (${run.id})` : run.id)

/** The first prompt of a session after a clear or a resume: a fixed preamble, then the note. */
export function handoverPrompt(run, { resumed = false } = {}) {
  const lines = [
    `[nightrunner] This is session ${run.session.number} of at most ${run.settings.sessionLimit} in run ${label(run)}.`,
    resumed
      ? 'The run was suspended and the user resumed it, so this is a fresh session with no memory of the earlier ones.'
      : 'The context was cleared after the last session handed over, so you have no memory of it.',
    'Call the nightrunner status tool first. Then continue from the handover note below.',
  ]
  if (run.afterWait) lines.push(afterWaitLine)
  const note = run.lastHandover?.outcome === 'continue' && run.lastHandover.note
    ? run.lastHandover.note
    : 'The last session ended without a handover note. Work out where things stand from the repo (plan, git log, working tree) and carry on.'
  return `${lines.join(' ')}\n\nHandover note from session ${run.lastHandover?.sessionNumber ?? run.session.number - 1}:\n\n${note}`
}

const afterWaitLine = 'The run waited for a usage-limit reset, so sub-agent work may have been cut off: check the working tree before relying on it.'

/** Sent into the same session when a usage-limit wait ends (no handover, so no clear). */
export function afterWaitPrompt(run) {
  return `[nightrunner] The usage limit has reset and run ${label(run)} carries on in this session. ${afterWaitLine} Call the status tool, then carry on where you stopped.`
}

/** Sent when context passes the hard stop and the turn has been aborted. */
export const HARD_STOP_PROMPT = '[nightrunner] Context is past the hard stop. Record your state in the repo and call handover now.'

/** Sent after an idle period with no handover; a few in a row end the run. */
export function nudgePrompt(run) {
  const left = 3 - run.session.nudges
  return `[nightrunner] This session has been idle with no handover. If the work is done or stuck, call the handover tool with the right outcome. ` +
    `If background work is still running, say what it is in one line and end your turn. ` +
    (left > 0 ? `${left} more idle period${left === 1 ? '' : 's'} without a handover and the run stops as an error.` : 'The next idle period without a handover stops the run as an error.')
}

/** The refusal a driver must treat as a blocker. */
export function denyMessage(what) {
  return `nightrunner: ${what} is owner-only during an autonomous run and was refused. Don't work round it. If the work needs it, call \`handover\` with \`blocked\`.`
}

/** Shown when a run's process stopped; the user resumes or stops it, never nightrunner. */
export function suspendedNotice(run) {
  return `nightrunner: run ${label(run)} was suspended (its Claude Code process stopped during session ${run.session.number}). ` +
    'Use /nightrunner resume to carry it on here, or /nightrunner stop to end it.'
}

export function activeElsewhereNotice(run) {
  return `nightrunner: run ${label(run)} is active in another Claude Code process. This session is not part of it.`
}

const END_TEXT = {
  blocked: 'blocked',
  complete: 'complete',
  error: 'ended with an error',
  stopped: 'stopped by the user',
  'session-limit': 'stopped at the session limit',
  'no-progress': 'stopped: no progress for too many sessions',
  'nudge-limit': 'stopped: idle with no handover',
  'hard-stop-no-handover': 'stopped: no handover after the hard stop',
  'wrong-model': 'stopped: the model pin did not hold',
  'usage-wait-too-long': 'stopped: the usage limit resets too late',
  overage: 'stopped: paid overage would be used',
  'start-failed': 'failed to start',
}

export function endText(reason) {
  return END_TEXT[reason] ?? reason
}

/**
 * The push notification: run, outcome and a one-line reason.
 * Never code, diffs or secrets: the reason is cut to one short line.
 */
export function notificationText(run, reason) {
  const name = run.name || run.id
  const why = String(reason ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  const short = why.length > 140 ? why.slice(0, 139) + '…' : why
  return `nightrunner ${name}: ${endText(run.endReason)}${short ? ` — ${short}` : ''}`
}
