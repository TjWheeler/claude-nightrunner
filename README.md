# nightrunner

A Claude Code plugin that runs long work across fresh sessions, with no restart
prompt pasted in between.

You start a run. When a session reaches a good stopping point, Claude calls the
`handover` tool with a note covering what it was doing, what's done and what
comes next. nightrunner clears the context and sends that note as the first
prompt of a fresh session in the same tab, so the work carries on with a clean
context.

When the context passes the run's budget (200k by default), nightrunner asks
Claude to write a restart prompt and hand over. If a usage limit stops Claude,
the run waits for the limit to reset and then carries on. A run stops after 25
sessions unless you set a different limit.

## Requirements

- Claude Code with mods support. It's tested on 2.1.292. Mods arrived in
  2.1.287, and versions in between are untested. On a version without mods the
  plugin doesn't load, and nothing happens.
- Tested in the VS Code panel and the terminal CLI on Linux (WSL). macOS should
  work but is untested. Native Windows is untested, and saving a default
  budget through Claude needs `HOME` set.

## Install

Install it once at user scope, and it's available in every project. It does
nothing until you start a run in a folder.

At a Claude Code prompt:

```
/plugin install nightrunner --marketplace TjWheeler/claude-nightrunner
```

Answer `y` to add the marketplace, then choose **user** scope.

Or from a terminal:

```sh
claude plugin marketplace add TjWheeler/claude-nightrunner
claude plugin install nightrunner@nightrunner
```

After installing, open a new Claude tab, or reload the VS Code window, so the
plugin loads.

- **Update:** run `claude plugin marketplace update nightrunner`, then
  `claude plugin update nightrunner@nightrunner`, then restart Claude Code.
- **Remove:** run `claude plugin uninstall nightrunner@nightrunner`.

### From a local clone

```sh
claude plugin marketplace add /path/to/claude-nightrunner
claude plugin install nightrunner@nightrunner
```

The plugin is read from the clone in place, so every project runs whatever is
checked out there. After editing it, run `/reload-plugins` or open a new tab.

## Use

```
/nightrunner start [name] [budget=150k] [wait=on|off] [notify=on|off] [sessions=25]   start a run in this tab
/nightrunner status                       show the run, its settings, the context used and other runs in the folder
/nightrunner stop                         stop this tab's run
/nightrunner resume [name|id]             take over a run whose tab was closed
```

The name is an optional label. Anything written as `key=value` is a setting, so
a name can't contain `=`.

You can also ask Claude to start a run, for example "start a nightrunner run
called docs with a 150k budget, then work through plans/docs.md". Claude uses
the `start` tool (`mcp__nightrunner__start`), which takes the same name, budget,
wait, notify and sessions settings. The tool tells Claude to start a run only when you ask
for one. Unless you've allowed the tool or are in auto mode, Claude Code asks
you to approve the call.

### Several tabs

A run belongs to the tab that started it. Each tab can have one run, so several
tabs in the same folder can each run their own. Their handovers, budget nudges,
waits and stops don't affect each other. The runs share the folder's working
tree and git, though, so give them work that won't collide.

`/nightrunner status` lists the folder's other runs. Each one is marked **live**
if its tab is open, or **orphaned** if the tab has been gone for 3 minutes.

If a tab closes mid-run, its run stays active but orphaned:

- **Reopen the conversation**, for example with `claude --resume` or by
  reloading the VS Code window. The tab takes its run back on its own.
- **Or, in another tab,** run `/nightrunner resume`. With no name, it takes the
  only orphaned run; with several, name one. If the last session had handed
  over, nightrunner clears the tab and starts the next session with the note.
  Otherwise, tell Claude what to carry on with, because the new tab has none of
  the run's context.

A new tab never takes a run on its own, and a live run can't be taken.

Then give Claude the work, and say how to hand over. For example:

> Work through the plan in plans/feature.md. When you finish a phase, or
> nightrunner says the context is past its budget, record your progress in the
> plan and call the nightrunner handover tool with "continue" and a restart
> prompt saying where to resume. If you need a decision from me, ask it and
> call handover with "blocked". When the plan is done, call it with "complete".

`handover` takes one of these outcomes:

| Outcome | What happens |
|---|---|
| `continue` (needs a `note`) | Once the turn ends, the context is cleared and a new session starts with the note. |
| `complete` | The run stops, and you get a [notification](#notifications). |
| `blocked` (the note is the question) | The run stops and notifies you with the question, so you can answer it. Start a new run to carry on. |

Only the main session can hand over, and only once per session. Sub-agents are
refused.

Claude can also call the `status` tool (`mcp__nightrunner__status`) to see the
session's context against the budget, for example "Context: 85k of the 200k
budget (43%)". It can use that to decide whether to start more work or hand over.
Outside a run, `status` still reports the context size.

## Context budget

At the end of each turn, nightrunner checks the session's context size. The
first time in a session that it reaches the budget, nightrunner sends one prompt
asking Claude to finish or park its work, record progress, write a restart
prompt and call `handover` with `continue`. Claude chooses the stopping point
and writes the prompt. nightrunner sends that prompt once per session.

The budget comes from the first of these that is set:

1. **This run only:** `/nightrunner start budget=300k`, or ask Claude to change
   the active run's budget (see below).
2. **Your saved default, for every project:** ask Claude, for example "set my
   nightrunner default budget to 150k". It's saved in `~/.claude/nightrunner.json`
   and used by the next `/nightrunner start`, with no restart needed.
3. **The plugin's `contextBudget` option:** set it in `/plugin` (open nightrunner
   and choose configure), or from a terminal:
   ```sh
   echo '{"contextBudget":"150k"}' | claude plugin configure nightrunner@nightrunner --values-stdin
   ```
   Restart Claude Code, or open a new tab, after changing it.
4. **The built-in default:** 200k.

Values are token counts of at least 1000, such as `150k` or `150000`. The run
records which budget it used and where it came from, and `/nightrunner status`
shows both.

## Session limit

A run uses at most 25 sessions by default. When a session at the limit calls
`handover` with `continue`, nightrunner stops the run instead of starting
another, and sends a [notification](#notifications). Claude is told the run has
stopped, so it can tell you where the work stands. The handover prompt tells
each session its number against the limit, for example "Session 3 of 25", and
tells the last session that it's the last. `complete` and `blocked` work as
usual in any session.

The limit comes from the first of these that is set:

1. **This run only:** `/nightrunner start sessions=40`, or ask Claude to change
   the active run's limit ("let this run use 40 sessions"). A limit at or below
   the current session stops the run at its next `continue`.
2. **For a project:** put `"maxSessions": 40` in the project's
   `.claude/nightrunner.json`, or ask Claude to ("set nightrunner's session
   limit to 40 for this project"). Commit the file to share it.
3. **For every project:** put `"maxSessions": 40` in `~/.claude/nightrunner.json`,
   or ask Claude to ("set my default nightrunner session limit to 40").
4. **The built-in default:** 25.

The limit is a whole number of at least 1. `/nightrunner status` shows the
session against the limit and where the limit came from.

## Usage limits

If a turn fails because a usage limit is reached (the five-hour or weekly
window), nightrunner reads when the limit resets and waits until two minutes
after that. It then sends a prompt telling Claude the limit has reset and to
carry on, checking the working tree first, because sub-agent work in flight may
have been lost. The run stays in the same session, and `/nightrunner status`
shows when it will carry on.

- **Too far away:** if the reset is more than 6 hours off (in practice, the
  weekly limit), the run stops instead. The 6 hours count from the first wait.
- **No reset time:** if the limit doesn't say when it resets, nightrunner tries
  again every 30 minutes, within the same 6 hours.
- **Stop or carry on yourself:** `/nightrunner stop` cancels a wait. If you
  carry on by hand and the turn gets through, the wait is cancelled.
- **Tab closed during a wait:** the run isn't resumed automatically. Reopen the
  conversation, or `/nightrunner resume` the run, and type "continue" when the
  limit has reset.

Waiting is on by default. To turn it off:

1. **This run only:** `/nightrunner start wait=off`, or ask Claude to change it
   for the active run.
2. **For a project:** put `"usageWait": false` in the project's
   `.claude/nightrunner.json`, or ask Claude to ("turn off nightrunner's
   usage-limit wait for this project"). Commit the file to share it.

With waiting off, a usage limit leaves the run idle until you carry on.

### Paid overage

nightrunner never carries a run into paid overage. At the end of each turn it
checks the usage-limit windows. If one is past 100%, or a turn got through with
one at 100%, overage is being billed, so the run stops (and any wait is
cancelled). `/nightrunner status` shows why it stopped. The check happens at the
turn boundary, so the turn that first crosses into overage is already paid for.

### Asking Claude to configure it

Claude has a `configure` tool (`mcp__nightrunner__configure`) and uses it when
you ask it to change nightrunner's settings:

- "Set my nightrunner default budget to 150k" saves your default.
- "Set it back to the default" clears it, so runs use the plugin option or 200k.
- "Change this run's budget to 300k" changes the active run straight away. If
  context is already past the new budget, nightrunner asks for a handover at the
  end of the next turn.
- "Turn off the usage-limit wait for this project" writes
  `.claude/nightrunner.json`. "…for this run" changes only the active run.
- "Turn off nightrunner notifications" saves it as your default. "…for this
  project" or "…for this run" changes only that.
- "Set my default nightrunner session limit to 40" saves it in
  `~/.claude/nightrunner.json`. "…for this project" or "…for this run" changes
  only that.
- "What are my nightrunner settings?" reports them.

Claude can start a run when you ask (see [Use](#use)). It can't stop one except
by handing over with `complete` or `blocked`. You stop a run with
`/nightrunner stop`.

## Notifications

When a run ends without you stopping it, nightrunner sends one notification
through Claude Code. That covers `complete`, `blocked`, the session limit, paid
overage, a usage-limit reset too far off, and a wait that ran out. The
notification names the run and why it ended, for example:

```
nightrunner "docs": blocked: Which database should the migration target?
```

For `blocked`, it carries the question Claude put in the handover note.
Otherwise it never includes code or the run's work.

It's Claude Code's own notification:

- **Desktop:** it shows as a desktop notification.
- **Phone:** it also reaches your phone in the Claude app when Remote Control is
  connected and push notifications are on in Claude Code.
- **While you're at the session:** Claude Code skips it, because you can already
  see the run end.

`/nightrunner status` shows whether the last run's notification was sent, or
why not (for example `user_present`).

Notifications are on by default. To turn them off:

1. **This run only:** `/nightrunner start notify=off`, or ask Claude to change
   it for the active run.
2. **For a project:** put `"notify": false` in the project's
   `.claude/nightrunner.json`, or ask Claude to ("turn off nightrunner
   notifications for this project").
3. **For every project:** put `"notify": false` in `~/.claude/nightrunner.json`,
   or ask Claude to ("turn off nightrunner notifications by default").

The first of these that is set wins, so a project or run can turn them back on.

## How its prompts appear

nightrunner's prompts (the handover note, the budget nudge and the carry-on
after a usage limit) reach Claude as messages from the plugin, not from you.
The handover prompt also says the note was written by Claude in the previous
session, so Claude doesn't treat it as your instruction or approval.

## What it writes

It writes one file per run in `.nightrunner/runs/` in the project folder,
holding the run's state and pending note, and `~/.claude/nightrunner.json` when you save a default
through Claude. `.nightrunner/` contains a `.gitignore` of `*`, so nothing
in it is committed.

## Limits

This is an early release (0.1.6):

- Past the budget, nightrunner asks for a handover once per session, but it
  doesn't force one. Apart from paid overage and the session limit, nothing
  stops a run on cost. Watch a long run, or tell Claude in the prompt when to
  stop.
- The usage-limit wait has been unit-tested but hasn't yet seen a real limit.
- Model, permissions and git are left as you set them. A permission prompt
  pauses the run until you answer it.
- Runs in the same folder share its working tree. nightrunner keeps their
  state apart but doesn't stop their edits or commits colliding.
- Run files aren't deleted, so `.nightrunner/runs/` grows by one small file per
  run.

Later versions are planned to add a model pin, a no-progress limit, guard
rails and commits.

## Development

```sh
npm run check   # syntax-check every module
npm test        # unit tests (node:test, Node 22+)
claude plugin validate .
```

The plugin is in `plugin/`. The hooks module is `plugin/hooks/register.js`, and
its logic is in `plugin/lib/nightrunner.js` and `plugin/lib/usage.js`
(usage-limit classification), each with tests in `test/`. The mods loader only
lets `$` be passed to functions declared at the top level of the module, and
`claude plugin validate` doesn't check this. Run a headless
`claude -p "/nightrunner status" --debug` in a test folder to see load errors.

## License

MIT
