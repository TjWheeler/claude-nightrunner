// The run-scoped deny list.
//
// Entries are a program optionally followed by subcommand words
// (`kubectl`, `gh pr`), or an MCP tool-name pattern (`mcp__<server>__<glob>`).
// Built-in entries apply unless the running user's own settings remove or
// narrow them; any layer may add entries. git is special: every subcommand is
// refused except a read-only allow-list.
//
// Matching is deliberately lenient where it refuses and strict where it
// exempts. It is defence in depth, not a sandbox: a script file that runs git
// internally gets through.

import { parseShell, splitWords, ShellParseError } from './shell.js'

export const BUILTIN_COMMAND_ENTRIES = [
  'git',
  // GitHub writes.
  'gh pr', 'gh release', 'gh api', 'gh repo', 'gh workflow', 'gh run', 'gh secret', 'gh variable', 'gh issue', 'gh gist',
  // Cloud and infrastructure CLIs.
  'az', 'aws', 'gcloud', 'gsutil', 'kubectl', 'helm', 'eksctl', 'doctl', 'flyctl', 'vercel', 'netlify', 'heroku', 'firebase', 'wrangler',
  'terraform apply', 'terraform destroy', 'terraform import', 'terraform state', 'terraform taint', 'terraform untaint', 'terraform force-unlock', 'terraform refresh',
  'tofu apply', 'tofu destroy', 'tofu import', 'tofu state', 'tofu taint', 'tofu untaint', 'tofu force-unlock', 'tofu refresh',
  'pulumi up', 'pulumi update', 'pulumi destroy', 'pulumi refresh', 'pulumi import', 'pulumi state', 'pulumi cancel',
  // Publishing.
  'docker push', 'docker image push', 'docker manifest push', 'docker compose push', 'docker-compose push',
  'docker build --push', 'docker buildx build --push', 'podman push',
  'npm publish', 'npm unpublish', 'pnpm publish', 'yarn publish', 'yarn npm publish', 'cargo publish', 'twine upload', 'gem push',
  'poetry publish', 'uv publish', 'dotnet nuget push', 'nuget push', 'mvn deploy',
]

// MCP servers whose tools are refused except reads. Tool names are matched
// case-insensitively; `*` matches any run of characters.
export const BUILTIN_TOOL_ENTRIES = [
  { pattern: 'mcp__*github*__*', allow: ['get_*', 'list_*', 'search_*'] },
  { pattern: 'mcp__*gitlab*__*', allow: ['get_*', 'list_*', 'search_*'] },
  // A scheduled or remote agent could do anything later, unwatched.
  { pattern: 'RemoteTrigger' },
  { pattern: 'CronCreate' },
]

const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'blame', 'grep', 'branch'])
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '--git-dir', '--work-tree', '--namespace'])
const GIT_GLOBAL_FLAGS = new Set([
  '--no-pager', '--no-replace-objects', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks', '--bare', '--no-lazy-fetch', '--no-advice',
])
const GIT_PRINT_ONLY = new Set(['--version', '-v', '--help', '-h', '--html-path', '--man-path', '--info-path', '--exec-path'])
// Environment that makes git run another program or read another config.
const GIT_DANGEROUS_ENV = /^(GIT_[A-Z0-9_]*|PAGER|EDITOR|VISUAL|LESSOPEN|LESSCLOSE)$/
const GIT_HARMLESS_ENV = new Set(['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT', 'GIT_FLUSH'])
const isDangerousGitEnv = ({ name, value }) =>
  GIT_DANGEROUS_ENV.test(name) && !GIT_HARMLESS_ENV.has(name) && !/^GIT_TRACE/.test(name) &&
  !((name === 'GIT_PAGER' || name === 'PAGER') && (value === '' || value === 'cat'))

const BRANCH_LIST_FLAGS = new Set([
  '-a', '--all', '-r', '--remotes', '-l', '--list', '-v', '-vv', '--verbose', '--show-current', '-i', '--ignore-case',
  '--color', '--no-color', '--column', '--no-column', '--no-abbrev', '--omit-empty', '-q', '--quiet',
])
const BRANCH_LIST_WITH_VALUE = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--abbrev'])

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'yash', 'tcsh', 'csh'])
// Interpreters that take program text on the command line or stdin.
const CODE_FLAGS = {
  python: ['-c'], python2: ['-c'], python3: ['-c'], pypy: ['-c'], pypy3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'], nodejs: ['-e', '--eval', '-p', '--print'], bun: ['-e', '--eval', '-p', '--print'],
  deno: ['eval'], perl: ['-e', '-E'], ruby: ['-e'], php: ['-r'], rscript: ['-e'], lua: ['-e'], luajit: ['-e'],
  osascript: ['-e'], pwsh: ['-c', '-command'], powershell: ['-c', '-command'], tclsh: [], wish: [],
  awk: [], gawk: [], mawk: [], nawk: [],
}
// Commands that never run their arguments, so a denied program named in them is just a word.
const NON_EXECUTING = new Set([
  'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'less', 'more', 'head', 'tail', 'man', 'info', 'which',
  'type', 'whereis', 'whatis', 'apropos', 'help', 'hash', 'ls', 'test', '[', 'wc', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp',
  'file', 'stat', 'basename', 'dirname', 'realpath', 'readlink', 'touch', 'mkdir', 'declare', 'typeset', 'local', 'export',
  'readonly', 'unset', 'read', 'true', 'false', ':', 'exit', 'return', 'shift', 'set', 'shopt', 'cd', 'pushd', 'popd', 'pwd',
  'git', 'brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'apk', 'snap', 'winget', 'choco', 'scoop',
])
// Commands that write to the paths they are given.
const WRITING = new Set([
  'cp', 'mv', 'rm', 'rmdir', 'tee', 'touch', 'ln', 'link', 'unlink', 'chmod', 'chown', 'chgrp', 'install', 'dd', 'truncate',
  'mkdir', 'rsync', 'shred', 'patch', 'tar', 'unzip', 'cpio', 'split', 'csplit', 'mkfifo', 'mknod', 'setfacl', 'chattr', 'scp',
])
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '<>', '&>', '&>>'])
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'ToolSearch'])
const PATH_KEY = /path|^file$|^files$|^destination$|^target$|^source$|^dest$|^to$|^from$/i

/** A deny entry string → { kind: 'command', words } | { kind: 'tool', pattern }. Throws on a bad entry. */
export function parseEntry(entry) {
  const text = String(entry).trim()
  if (!text) throw new Error('empty deny entry')
  if (/^mcp__/i.test(text) || /^[A-Z][A-Za-z]*$/.test(text)) {
    if (/\s/.test(text)) throw new Error(`deny entry "${text}" has a space in a tool pattern`)
    if (/^mcp__/i.test(text) && !/^mcp__[^_].*__.+/i.test(text)) throw new Error(`deny entry "${text}" must look like mcp__<server>__<tool>`)
    return { kind: 'tool', pattern: text }
  }
  const words = text.split(/\s+/)
  for (const w of words) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+:=-]*$/.test(w) && !/^--?[A-Za-z0-9][A-Za-z0-9-]*$/.test(w)) {
      throw new Error(`deny entry "${text}" must be a program optionally followed by subcommands`)
    }
  }
  return { kind: 'command', words: words.map((w, i) => (i === 0 ? w.toLowerCase() : w)) }
}

/** Split a list setting given as an array or as newline- or comma-separated text. */
export function splitList(value) {
  if (value === undefined || value === null) return []
  const items = Array.isArray(value) ? value : String(value).split(/[\n,]/)
  return items.map(s => String(s).trim()).filter(Boolean)
}

/**
 * Build the effective deny list.
 * @returns {{ ok: boolean, errors: string[], list }}
 */
export function buildDenyList({ add = [], remove = [] } = {}) {
  const errors = []
  const builtins = [
    ...BUILTIN_COMMAND_ENTRIES.map(e => ({ ...parseEntry(e), builtin: true, source: e })),
    ...BUILTIN_TOOL_ENTRIES.map(e => ({ kind: 'tool', pattern: e.pattern, allow: e.allow ?? [], builtin: true, source: e.pattern })),
  ]
  const adds = []
  for (const text of splitList(add)) {
    try { adds.push({ ...parseEntry(text), builtin: false, allow: [], source: text }) } catch (err) { errors.push(err.message) }
  }
  const removals = []
  for (const text of splitList(remove)) {
    let r
    try { r = parseEntry(text) } catch (err) { errors.push(err.message); continue }
    const target = builtins.find(b => removalTargets(b, r))
    if (!target) {
      errors.push(`denyRemove "${text}" doesn't name a built-in deny entry or a narrower form of one`)
      continue
    }
    removals.push({ ...r, source: text, target: target.source })
  }
  return { ok: errors.length === 0, errors, list: { builtins, adds, removals } }
}

function removalTargets(builtin, removal) {
  if (builtin.kind !== removal.kind) return false
  if (builtin.kind === 'tool') return globMatch(builtin.pattern, removal.pattern)
  return builtin.words.length <= removal.words.length && builtin.words.every((w, i) => sameWord(w, removal.words[i], i))
}

function sameWord(a, b, i) {
  return i === 0 ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Removals in force, as text for the run start notice and the log. */
export function describeRemovals(list) {
  return list.removals.map(r => (r.kind === 'tool' ? r.pattern : r.words.join(' ')))
}

// ---------------------------------------------------------------------------
// Tool calls

/**
 * Check one tool call against the deny list.
 * @param {string} tool the tool name as the host gives it
 * @param {object} input the tool's input fields
 * @returns {null | { what: string }} what was refused, for the refusal text
 */
export function checkToolCall(tool, input, list) {
  try {
    return checkToolCallInner(tool, input, list)
  } catch {
    // A checker fault must never let a call through unseen.
    return { what: `a ${String(tool)} call nightrunner failed to check` }
  }
}

function checkToolCallInner(tool, input, list) {
  input = input && typeof input === 'object' ? input : {}
  const byName = checkToolName(tool, list)
  if (byName) return byName

  if (tool === 'Bash' || tool === 'Monitor') return checkCommand(stringField(input, ['command', 'cmd']), list)
  if (tool === 'PowerShell') return checkOpaque(stringField(input, ['command']), list)

  if (!READ_ONLY_TOOLS.has(tool)) {
    for (const [key, value] of Object.entries(input)) {
      const values = Array.isArray(value) ? value : [value]
      for (const v of values) {
        if (typeof v !== 'string') continue
        if (PATH_KEY.test(key) && isProtectedPath(v)) return { what: `writing to ${protectedLabel(v)}` }
      }
    }
    // A tool we don't know that carries a command is treated as a shell.
    const command = stringField(input, ['command', 'cmd'])
    if (command) return checkCommand(command, list)
  }
  return null
}

function stringField(input, keys) {
  for (const k of keys) if (typeof input[k] === 'string') return input[k]
  return ''
}

function checkToolName(tool, list) {
  const name = String(tool)
  for (const entry of [...list.adds, ...list.builtins]) {
    if (entry.kind !== 'tool' || !globMatch(entry.pattern, name)) continue
    const toolPart = name.replace(/^mcp__.*?__/i, '')
    if (entry.allow?.some(a => globMatch(a, toolPart))) continue
    if (entry.builtin && list.removals.some(r => r.kind === 'tool' && globMatch(r.pattern, name))) continue
    return { what: name }
  }
  return null
}

export function globMatch(pattern, text) {
  let re = '^'
  for (const ch of pattern) {
    if (ch === '*') re += '.*'
    else if (ch === '?') re += '.'
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$', 'is').test(text)
}

// ---------------------------------------------------------------------------
// Commands

/**
 * Check a shell command line.
 * @returns {null | { what: string }}
 */
export const MAX_COMMAND_LENGTH = 100000

export function checkCommand(src, list) {
  src = String(src ?? '')
  if (src.length > MAX_COMMAND_LENGTH) return checkOpaque(src, list, 'a command too long for nightrunner to parse')
  try {
    const parsed = parseShell(src)
    const ctx = { list, src, depth: 0, env: scriptEnv(parsed.commands) }
    for (const cmd of parsed.commands) {
      const r = checkSimple(cmd, ctx)
      if (r) return r
    }
    return null
  } catch (err) {
    // Any failure, not only a parse error, fails closed on a mention.
    return checkOpaque(src, list, err instanceof ShellParseError ? 'a command nightrunner could not parse' : 'a command nightrunner failed to check')
  }
}

// A command we can't see into. Refused if it mentions anything denied.
export function checkOpaque(text, list, label = 'a command nightrunner could not read') {
  text = String(text ?? '')
  for (const entry of effectiveCommandEntries(list)) {
    const [prog, ...subs] = entry.words
    if (!mentions(text, prog)) continue
    if (prog !== 'git' && !subs.every(s => mentions(text, s))) continue
    return { what: `${label} that mentions \`${entry.words.join(' ')}\`` }
  }
  if (PROTECTED_TEXT.some(re => re.test(text))) return { what: `${label} that mentions a protected git path` }
  return null
}

function effectiveCommandEntries(list) {
  const out = []
  for (const e of [...list.builtins, ...list.adds]) {
    if (e.kind !== 'command') continue
    // A built-in removed whole no longer counts; one narrowed still does.
    if (e.builtin && list.removals.some(r => r.kind === 'command' && r.words.length === e.words.length && r.words.every((w, i) => sameWord(w, e.words[i], i)))) continue
    out.push(e)
  }
  return out
}

function mentions(text, word) {
  const esc = word.replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
  return new RegExp(`(^|[^A-Za-z0-9_.-])${esc}($|[^A-Za-z0-9_])`, 'i').test(text)
}

function checkSimple(cmd, ctx, opts = {}) {
  for (const r of cmd.redirects) {
    if (OUTPUT_REDIRECTS.has(r.op) || (r.op === '>&' && !/^\d+$|^-$/.test(r.target.text))) {
      if (isProtectedPath(r.target.text)) return { what: `writing to ${protectedLabel(r.target.text)}` }
    }
  }
  return checkWords(cmd.words, cmd, ctx, { argsAppended: !!opts.argsAppended, env: [...(ctx.env ?? []), ...cmd.assigns] })
}

// Variables a script sets for later commands: bare assignments and exports.
function scriptEnv(commands) {
  const env = []
  for (const c of commands) {
    if (!c.words.length) env.push(...c.assigns)
    const head = c.words[0]?.text
    if (['export', 'declare', 'typeset', 'local', 'readonly'].includes(head)) {
      for (const w of c.words.slice(1)) {
        const eq = w.text.indexOf('=')
        if (eq > 0) env.push({ name: w.text.slice(0, eq), value: w.text.slice(eq + 1) })
      }
    }
  }
  return env
}

function checkScript(text, ctx) {
  if (ctx.depth > 12) return checkOpaque(text, ctx.list)
  let parsed
  try {
    parsed = parseShell(text)
  } catch (err) {
    if (!(err instanceof ShellParseError)) throw err
    return checkOpaque(text, ctx.list, 'a command nightrunner could not parse')
  }
  const inner = { ...ctx, depth: ctx.depth + 1, env: [...(ctx.env ?? []), ...scriptEnv(parsed.commands)] }
  for (const c of parsed.commands) {
    const r = checkSimple(c, inner)
    if (r) return r
  }
  return null
}

function stdinOf(cmd) {
  for (const r of cmd.redirects) {
    if (r.heredoc) return { text: r.heredoc.body }
    if (r.op === '<<<') return { text: r.target.text }
    if (r.op === '<') return { file: true }
  }
  if (cmd.piped) return { piped: true }
  return null
}

export function normaliseProgram(text) {
  let p = String(text).replace(/\\/g, '/')
  p = p.slice(p.lastIndexOf('/') + 1)
  p = p.replace(/\.(exe|cmd|bat|com)$/i, '')
  return p.toLowerCase()
}

function checkWords(words, cmd, ctx, state) {
  let guard = 0
  while (words.length) {
    if (++guard > 64) return checkOpaque(ctx.src, ctx.list)
    const w0 = words[0]
    if (w0.dynamic || w0.glob) {
      return checkOpaque(ctx.src, ctx.list, 'a command whose program nightrunner could not read')
    }
    let prog = normaliseProgram(w0.text)
    let args = words.slice(1)

    // git-push and friends are git subcommands.
    if (prog.startsWith('git-') && prog.length > 4) {
      args = [{ text: prog.slice(4), dynamic: false, glob: false }, ...args]
      prog = 'git'
    }

    switch (prog) {
      case 'env': {
        const r = stripEnv(args, state)
        if (r.opaque) return checkOpaque(ctx.src, ctx.list)
        words = r.words
        continue
      }
      case 'sudo': case 'doas': {
        const r = stripOptions(args, prog === 'sudo' ? 'ugCDhprtUT' : 'uC', prog === 'sudo' ? ['--user', '--group', '--chdir', '--host', '--prompt', '--role', '--type', '--other-user', '--command-timeout', '--close-from'] : [])
        if (r.opaque) return checkOpaque(ctx.src, ctx.list)
        words = stripAssignments(r.words, state)
        continue
      }
      case 'command': {
        const r = stripOptions(args, '')
        if (r.flags.includes('v') || r.flags.includes('V')) return null
        words = r.words
        continue
      }
      case 'builtin': case 'exec': case 'nohup': case 'setsid': case 'chronic': case 'unbuffer': case 'catchsegv': case 'ionice':
      case 'nice': case 'stdbuf': case 'time': case 'chrt': case 'cgexec': case 'firejail': case 'proxychains': case 'proxychains4': case 'torsocks': {
        const r = stripOptions(args, { exec: 'a', nice: 'n', ionice: 'cnp', stdbuf: 'ioe', time: 'of', cgexec: 'g', setsid: '' }[prog] ?? '')
        if (r.opaque) return checkOpaque(ctx.src, ctx.list)
        words = r.words
        if (prog === 'chrt' && words.length && /^\d+$/.test(words[0].text)) words = words.slice(1)
        continue
      }
      case 'timeout': {
        const r = stripOptions(args, 'sk', ['--signal', '--kill-after'])
        if (r.opaque) return checkOpaque(ctx.src, ctx.list)
        words = r.words.slice(1) // the duration
        continue
      }
      case 'taskset': {
        const r = stripOptions(args, '')
        words = r.flags.includes('p') ? [] : r.words.slice(1)
        continue
      }
      case 'busybox': {
        words = args
        continue
      }
      case 'xargs': case 'parallel': {
        const r = stripOptions(args, prog === 'xargs' ? 'adEeIiLlnPs' : 'jSIdaE', prog === 'xargs' ? ['--arg-file', '--delimiter', '--eof', '--replace', '--max-lines', '--max-args', '--max-procs', '--max-chars', '--process-slot-var'] : ['--jobs', '--sshlogin', '--delimiter', '--arg-file', '--colsep', '--joblog', '--results'])
        if (r.opaque) return checkOpaque(ctx.src, ctx.list)
        state = { ...state, argsAppended: true }
        words = r.words.length ? r.words : [{ text: 'echo', dynamic: false, glob: false }]
        if (prog === 'parallel') {
          const stop = words.findIndex(w => w.text === ':::' || w.text === '::::' || w.text === ':::+')
          if (stop !== -1) words = words.slice(0, stop)
        }
        continue
      }
      case 'flock': {
        const r = stripOptions(args, 'wEc', ['--timeout', '--conflict-exit-code', '--command'])
        if (r.values.c !== undefined) return checkScript(r.values.c, ctx)
        if (r.opaque) return checkOpaque(ctx.src, ctx.list)
        // flock [options] <file> -c <command>, or flock [options] <file> <command…>
        if (['-c', '--command'].includes(r.words[1]?.text)) return r.words[2] ? checkScript(r.words[2].text, ctx) : null
        words = r.words.slice(1) // the lock file
        continue
      }
      case 'watch': {
        const r = stripOptions(args, 'nq', ['--interval', '--differences'])
        return checkScript(r.words.map(w => w.text).join(' '), ctx)
      }
      case 'su': case 'runuser': case 'script': {
        const r = stripOptions(args, 'cgGsuwBTEtIOmq', ['--command', '--group', '--supp-group', '--shell', '--user', '--whitelist-environment', '--log-io', '--log-out', '--log-in', '--log-timing', '--timing'])
        const script = r.values.c ?? r.values['--command']
        if (script !== undefined) return checkScript(script, ctx)
        return checkOpaque(ctx.src, ctx.list)
      }
      case 'ssh': {
        const r = stripOptions(args, 'BbcDEeFIiJLlmOoPpQRSWw')
        if (r.opaque) return checkOpaque(ctx.src, ctx.list)
        const remote = r.words.slice(1)
        if (!remote.length) return null
        if (remote.some(w => w.dynamic)) return checkOpaque(ctx.src, ctx.list)
        return checkScript(remote.map(w => w.text).join(' '), ctx)
      }
      case 'eval': {
        if (args.some(w => w.dynamic)) return checkOpaque(ctx.src, ctx.list)
        return checkScript(args.map(w => w.text).join(' '), ctx)
      }
      case 'trap': {
        if (args[0] && args[0].text !== '-' && !args[0].text.startsWith('-')) return checkScript(args[0].text, ctx)
        return null
      }
      case 'alias': {
        for (const a of args) {
          const eq = a.text.indexOf('=')
          if (eq > 0) {
            const r = checkScript(a.text.slice(eq + 1), ctx)
            if (r) return r
          }
        }
        return null
      }
      case 'cmd': {
        const k = args.findIndex(w => /^\/[ck]$/i.test(w.text))
        if (k === -1) return null
        return checkScript(args.slice(k + 1).map(w => w.text).join(' '), ctx)
      }
      case 'cd': case 'pushd': {
        const target = args.find(w => !w.text.startsWith('-'))
        if (target && isProtectedPath(target.text)) return { what: `changing directory into ${protectedLabel(target.text)}` }
        return null
      }
      case 'find': return checkFind(args, cmd, ctx, state)
      case 'source': case '.': return checkOpaque(ctx.src, ctx.list)
    }

    if (SHELLS.has(prog)) return checkShell(args, cmd, ctx)
    if (prog in CODE_FLAGS) return checkInterpreter(prog, args, cmd, ctx)

    return checkProgram(prog, args, ctx, state, cmd)
  }
  return null
}

function stripEnv(args, state) {
  let i = 0
  const words = []
  while (i < args.length) {
    const t = args[i].text
    if (t === '--') { i++; break }
    if (t === '-' || t === '-i' || t === '-0' || t === '-v' || t === '--null' || t === '--ignore-environment' || t === '--debug') { i++; continue }
    if (t === '-u' || t === '-C' || t === '--unset' || t === '--chdir') { i += 2; continue }
    if (/^(-u|-C).+/.test(t) || /^--(unset|chdir)=/.test(t)) { i++; continue }
    if (t === '-S' || t === '--split-string' || /^-S.+/.test(t) || t.startsWith('--split-string=')) {
      const value = t === '-S' || t === '--split-string' ? args[i + 1]?.text ?? '' : t.replace(/^-S|^--split-string=/, '')
      const step = t === '-S' || t === '--split-string' ? 2 : 1
      let split
      try { split = splitWords(value) } catch { return { opaque: true } }
      return { words: stripAssignments([...split, ...args.slice(i + step)], state) }
    }
    if (/^--?[A-Za-z]/.test(t)) return { opaque: true }
    break
  }
  return { words: stripAssignments([...words, ...args.slice(i)], state) }
}

function stripAssignments(words, state) {
  let k = 0
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k].text)) {
    const eq = words[k].text.indexOf('=')
    state.env = [...(state.env ?? []), { name: words[k].text.slice(0, eq), value: words[k].text.slice(eq + 1) }]
    k++
  }
  return words.slice(k)
}

// Strip leading options. `withValue` is a string of short options that take a
// value, plus long options that take one. Stops at the first non-option or `--`.
function stripOptions(args, withValue, longWithValue = []) {
  const shortWithValue = typeof withValue === 'string' ? withValue : ''
  const flags = []
  const values = {}
  let i = 0
  while (i < args.length) {
    const t = args[i].text
    if (args[i].dynamic) return { opaque: true, words: [], flags, values }
    if (t === '--') { i++; break }
    if (t.startsWith('--')) {
      const [name, inline] = t.split(/=(.*)/s)
      if (longWithValue.includes(name)) {
        if (inline !== undefined) { values[name] = inline; i++ } else { values[name] = args[i + 1]?.text; i += 2 }
      } else i++
      continue
    }
    if (t.startsWith('-') && t.length > 1 && !/^-\d+$/.test(t)) {
      let consumed = false
      for (let k = 1; k < t.length; k++) {
        const f = t[k]
        flags.push(f)
        if (shortWithValue.includes(f)) {
          const rest = t.slice(k + 1)
          if (rest) values[f] = rest
          else { values[f] = args[i + 1]?.text; i++ }
          consumed = true
          break
        }
      }
      i++
      void consumed
      continue
    }
    if (/^-\d+$/.test(t)) { i++; continue } // nice -10
    break
  }
  return { words: args.slice(i), flags, values }
}

function checkShell(args, cmd, ctx) {
  let i = 0
  let script
  let sawC = false
  while (i < args.length) {
    const t = args[i].text
    if (args[i].dynamic) return checkOpaque(ctx.src, ctx.list)
    if (t === '--' || t === '-') { i++; break }
    if (t === '-o' || t === '+o' || t === '-O' || t === '+O' || t === '--rcfile' || t === '--init-file') { i += 2; continue }
    if (/^[-+][A-Za-z]+$/.test(t)) {
      if (t.startsWith('-') && t.includes('c')) sawC = true
      i++
      continue
    }
    if (t.startsWith('--')) { i++; continue }
    break
  }
  if (sawC) {
    script = args[i]
    if (!script) return null
    if (script.dynamic) return checkOpaque(ctx.src, ctx.list)
    return checkScript(script.text, ctx)
  }
  if (i < args.length) return null // a script file: a known gap (README).
  const stdin = stdinOf(cmd)
  if (stdin?.text !== undefined) return checkScript(stdin.text, ctx)
  if (stdin?.piped || stdin?.file) return checkOpaque(ctx.src, ctx.list, 'a shell reading commands nightrunner could not see')
  return null
}

function checkInterpreter(prog, args, cmd, ctx) {
  const flags = CODE_FLAGS[prog]
  const code = []
  let sawFile = false
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text
    const lower = t.toLowerCase()
    if (flags.includes(lower)) {
      code.push(args[i + 1]?.text ?? '')
      i++
      continue
    }
    // A short-option cluster holding a code flag: -le, -ne 'code', -ecode.
    const letter = /^-[A-Za-z]+/.test(t) && !t.startsWith('--') && flags.filter(f => /^-[a-z]$/i.test(f)).map(f => f[1]).find(l => t.slice(1).includes(l))
    if (letter) {
      const rest = t.slice(t.indexOf(letter, 1) + 1)
      if (rest) code.push(rest)
      else { code.push(args[i + 1]?.text ?? ''); i++ }
      continue
    }
    if (!t.startsWith('-')) {
      // awk, jq and similar take their program as the first operand.
      if (!flags.length && !code.length) { code.push(t); continue }
      sawFile = true
    }
  }
  const stdin = stdinOf(cmd)
  if (stdin?.text !== undefined) code.push(stdin.text)
  if (code.length) {
    for (const c of code) {
      const r = checkOpaque(c, ctx.list, `code passed to ${prog}`)
      if (r) return r
    }
    return null
  }
  if (!sawFile && stdin?.piped) return checkOpaque(ctx.src, ctx.list, `${prog} reading code nightrunner could not see`)
  return null
}

function checkFind(args, cmd, ctx, state) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      const end = args.findIndex((w, k) => k > i && (w.text === ';' || w.text === '+'))
      const inner = args.slice(i + 1, end === -1 ? args.length : end)
      const r = checkWords(inner, { ...cmd, redirects: [] }, ctx, { ...state, argsAppended: true })
      if (r) return r
      i = end === -1 ? args.length : end
    }
    if (t === '-delete' || t.startsWith('-fprint') || t === '-fls') {
      if (args.some(w => isProtectedPath(w.text))) return { what: 'writing to .git/' }
    }
  }
  return null
}

function checkProgram(prog, args, ctx, state, cmd) {
  if (prog === 'git') {
    const r = checkGit(args, ctx.list, state)
    if (r) return r
  }
  for (const entry of [...ctx.list.adds, ...ctx.list.builtins]) {
    if (entry.kind !== 'command' || entry.words[0] !== prog || (prog === 'git' && entry.builtin)) continue
    if (!subcommandsMatch(entry.words.slice(1), args, state.argsAppended)) continue
    if (entry.builtin && exempted(entry, args, ctx.list)) continue
    return { what: entry.words.join(' ') }
  }

  // Writes into .git/ and git's own config.
  if (WRITING.has(prog) || (prog === 'sed' && args.some(isInPlaceFlag))) {
    const hit = args.find(w => isProtectedPath(w.text) || PROTECTED_TEXT.some(re => re.test(w.text)))
    if (hit) return { what: `writing to ${protectedLabel(hit.text)}` }
  }

  // sed's `e` command and `s///e` flag run the pattern space as a command.
  if (prog === 'sed') {
    for (const w of args) {
      if (/(^|[;\n{]\s*)e(\s|$)|^s(.).*\2.*\2[gpIiMm0-9w]*e/.test(w.text)) {
        const r = checkOpaque(w.text, ctx.list, 'a sed script')
        if (r) return r
      }
    }
  }

  // A denied program named as an argument of a command that may run it
  // (npx, uv run, docker exec, …). Commands that never run their arguments are skipped.
  if (!NON_EXECUTING.has(prog)) {
    for (let j = 0; j < args.length; j++) {
      if (args[j].dynamic || args[j].glob) continue
      const name = normaliseProgram(args[j].text)
      if (!isDeniedProgram(name, ctx.list)) continue
      const r = checkWords(args.slice(j), { ...cmd, redirects: [] }, ctx, { ...state, argsAppended: true })
      if (r) return r
    }
  }
  return null
}

function isInPlaceFlag(w) {
  return w.text === '--in-place' || w.text.startsWith('--in-place=') || /^-[A-Za-z]*i/.test(w.text)
}

function isDeniedProgram(name, list) {
  const base = name.startsWith('git-') ? 'git' : name
  return effectiveCommandEntries(list).some(e => e.words[0] === base)
}

// Lenient: each subcommand word appears among the arguments, in order. With
// no operand but arguments appended from stdin, or a dynamic first operand,
// a missing one counts as present.
function subcommandsMatch(subs, args, argsAppended) {
  if (!subs.length) return true
  let k = 0
  for (const a of args) {
    const t = subs[k].startsWith('--') ? a.text.split('=')[0] : a.text
    if (t.toLowerCase() === subs[k].toLowerCase()) {
      if (++k === subs.length) return true
    }
  }
  const firstOperand = args.find(a => !a.text.startsWith('-'))
  if (!firstOperand) return !!argsAppended
  return firstOperand.dynamic
}

// Strict: the removal's words follow the program immediately and exactly.
function exempted(entry, args, list) {
  return list.removals.some(r => {
    if (r.kind !== 'command' || r.words[0] !== entry.words[0]) return false
    if (!entry.words.every((w, i) => sameWord(w, r.words[i], i))) return false
    const subs = r.words.slice(1)
    return subs.length <= args.length && subs.every((s, i) => !args[i].dynamic && args[i].text === s)
  })
}

function checkGit(args, list, state) {
  const gitEntryRemoved = !effectiveCommandEntries(list).some(e => e.builtin && e.words.length === 1 && e.words[0] === 'git')
  if (gitEntryRemoved) return null
  const dangerousEnv = (state.env ?? []).find(isDangerousGitEnv)
  if (dangerousEnv) return { what: `git with ${dangerousEnv.name} set` }

  let i = 0
  let sub
  while (i < args.length) {
    const a = args[i]
    if (a.dynamic || a.glob) return { what: 'git with arguments nightrunner could not read' }
    const t = a.text
    if (t === '-c' || (t.startsWith('-c') && t.length > 2 && !t.startsWith('-C')) || t.startsWith('--config-env')) return { what: 'git -c' }
    if (GIT_GLOBAL_WITH_VALUE.has(t)) { i += 2; continue }
    if (/^(--git-dir|--work-tree|--namespace)=/.test(t) || /^-C./.test(t)) { i++; continue }
    if (GIT_GLOBAL_FLAGS.has(t)) { i++; continue }
    if (GIT_PRINT_ONLY.has(t)) return null
    if (t.startsWith('-')) return { what: `git ${t}` }
    sub = t
    break
  }
  if (sub === undefined) return state.argsAppended ? { what: 'git' } : null
  const rest = args.slice(i + 1)

  const exempt = list.removals.some(r => r.kind === 'command' && r.words[0] === 'git' && r.words.length > 1 &&
    r.words[1] === sub && r.words.slice(2).every((s, k) => rest[k] && !rest[k].dynamic && rest[k].text === s))
  if (exempt) return null

  if (!GIT_READ_ONLY.has(sub)) return { what: `git ${sub}` }
  // Arguments from stdin could name a branch to create or a pager program.
  if (state.argsAppended && (sub === 'branch' || sub === 'grep')) return { what: `git ${sub} with arguments from stdin` }
  if (sub === 'grep' && rest.some(w => w.text.startsWith('-O') || w.text.startsWith('--open-files-in-pager'))) return { what: 'git grep --open-files-in-pager' }
  if (sub === 'branch' && !isBranchListing(rest)) return { what: 'git branch (changing branches)' }
  if (rest.some(w => w.dynamic) && sub === 'branch') return { what: 'git branch with arguments nightrunner could not read' }
  return null
}

function isBranchListing(args) {
  const listMode = args.some(w => w.text === '--list' || /^-[a-z]*l[a-z]*$/.test(w.text))
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text
    if (BRANCH_LIST_FLAGS.has(t)) continue
    if (BRANCH_LIST_WITH_VALUE.has(t)) { i++; continue }
    if ([...BRANCH_LIST_WITH_VALUE].some(f => t.startsWith(f + '=')) || /^--(color|column)=/.test(t)) continue
    if (/^-[arlviq]+$/.test(t)) continue
    if (t.startsWith('-')) return false
    if (!listMode) return false // a name without --list creates a branch
  }
  return true
}

// ---------------------------------------------------------------------------
// Protected paths: .git/ anywhere, and git's own config files.

const PROTECTED_TEXT = [
  /(^|[\s/\\'"=:;,(<>|&])\.git($|[\s/\\'"),;<>|&])/i,
  /(^|[\s/\\'"=:;,(])\.gitconfig($|[^A-Za-z0-9_-])/i,
  /(^|[\s/\\'"=:;,(])\.config[/\\]git($|[/\\\s'"])/i,
]

export function isProtectedPath(p) {
  const parts = String(p).replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean)
  if (parts.some(s => s === '.git')) return true
  if (parts.length && parts[parts.length - 1] === '.gitconfig') return true
  for (let i = 0; i + 1 < parts.length; i++) if (parts[i] === '.config' && parts[i + 1] === 'git') return true
  return false
}

function protectedLabel(p) {
  return /\.gitconfig|\.config[/\\]git/i.test(p) ? "git's config" : '.git/'
}
