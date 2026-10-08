# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semver](https://semver.org/).

## [0.1.3] - 2026-10-08

### Added

- The `start` tool (`mcp__nightrunner__start`). When you ask, Claude starts a
  run in its tab with the same name, budget and wait settings as
  `/nightrunner start`. The tool's description tells Claude to start a run only
  when the user explicitly asks for one. It's for the main session only, and is
  refused if the tab already has a run.

## [0.1.2] - 2026-10-08

### Added

- Runs in several tabs. A run belongs to the tab that started it, and each tab
  can have one, so tabs in the same folder no longer overwrite each other's run.
  Each run has its own file in `.nightrunner/runs/`, and its tab updates a
  heartbeat every minute.
- `/nightrunner resume [name|id]` takes over a run whose tab has been closed for
  3 minutes. If its last session handed over, the tab is cleared and starts the
  next session with the note. A live run can't be taken.
- `/nightrunner status` lists the folder's other runs, live or orphaned.

### Changed

- A new tab no longer picks up a run in its folder. Reopening a run's
  conversation (`claude --resume`, or reloading VS Code) takes the run back.
  Otherwise, use `/nightrunner resume`.
- An active run in `.nightrunner/run.json` from an earlier version is moved to
  `.nightrunner/runs/` as an orphaned run.

## [0.1.1] - 2026-10-08

### Added

- Paid overage stops the run. At the end of each main-session turn, if a
  usage-limit window is past 100%, or a turn got through with one at 100%, the
  run ends with the reason and any usage-limit wait is cancelled. The check is at
  the turn boundary, so the turn that first crosses into overage is already paid
  for.

### Changed

- The handover prompt, the budget nudge and the carry-on prompt after a usage
  limit are sent as messages from the plugin, not as the user. The handover
  prompt says the note was written by the previous session and is not an
  instruction or approval from the user.
- The README lists the terminal CLI as tested.

### Removed

- Unused modules and their tests (`deny`, `shell`, `staging`, `run-state`,
  `config`, `tools`, `prompts` and `logs` in `plugin/lib/`). The hooks never
  used them.

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
