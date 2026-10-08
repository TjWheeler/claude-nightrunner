# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org/).

## [0.1.0] - 2026-10-08

### Added

- `/nightrunner start [name]`, `/nightrunner stop` and `/nightrunner status`.
- The `handover` tool (`mcp__nightrunner__handover`). On `continue`, it clears the
  session and starts the next one with the note. `complete` and `blocked` stop
  the run.
- The `status` tool (`mcp__nightrunner__status`) and `/nightrunner status`: the
  session's context against the budget, and the run's session number.
- A context budget (default 200k). Once per session, past the budget,
  nightrunner asks Claude to write a restart prompt and hand over. It's set by
  `/nightrunner start budget=…`, a saved default (through the `configure` tool),
  or the `contextBudget` plugin option.
- The `configure` tool (`mcp__nightrunner__configure`): at the user's request,
  Claude saves a default budget (`~/.claude/nightrunner.json`), changes the
  active run's budget, or reports the settings.
- Usage-limit waits (on by default). When a usage limit stops a turn, the run
  waits until 2 minutes after the reset and carries on. It stops instead if the
  reset is more than 6 hours away. It's turned off per run with `wait=off`, or
  per project with `"usageWait": false` in `.claude/nightrunner.json`. The
  `configure` tool can set both.
- Run state in `.nightrunner/run.json`, which is ignored by git.
