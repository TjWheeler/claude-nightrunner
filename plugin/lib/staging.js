// What the commit tool stages and what it refuses. Patterns use gitignore-style globs: a pattern with no
// slash matches a name at any depth, a trailing slash matches a directory and
// everything in it, `*` stays inside one path segment and `**` crosses them.
// Matching ignores case, so a case-insensitive filesystem can't slip past.

export const DEFAULT_SECRET_PATTERNS = [
  '.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', 'id_rsa*', 'id_ed25519*',
  '.npmrc', '.pypirc', 'credentials*.json', '*.tfstate*',
]

// Never staged. The secret patterns are excluded too, so a secret only reaches
// a commit if it was already staged before the run.
export const DEFAULT_EXCLUSIONS = ['.nightrunner/', ...DEFAULT_SECRET_PATTERNS]

const cache = new Map()

function toRegExp(pattern) {
  let p = String(pattern).trim().replace(/\\/g, '/')
  const dirOnly = p.endsWith('/')
  if (dirOnly) p = p.replace(/\/+$/, '')
  const anchored = p.includes('/')
  p = p.replace(/^\/+/, '')
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i++ }
    } else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else if (ch === '[') {
      const end = p.indexOf(']', i + 1)
      if (end === -1) re += '\\['
      else { re += '[' + p.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = end }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  const prefix = anchored ? '^' : '^(?:.*/)?'
  // A directory pattern matches the directory and everything under it; a file
  // pattern matches the path itself, or a directory the path is inside.
  return new RegExp(prefix + re + '(?:/.*)?$', 'i')
}

export function matchPattern(path, pattern) {
  let re = cache.get(pattern)
  if (!re) { re = toRegExp(pattern); cache.set(pattern, re) }
  return re.test(String(path).replace(/\\/g, '/').replace(/^\.\//, ''))
}

export function firstMatch(path, patterns) {
  return patterns.find(p => matchPattern(path, p))
}

/** Every pattern the commit tool excludes, built-ins first. */
export function exclusionPatterns(settings = {}) {
  return unique([...DEFAULT_EXCLUSIONS, ...(settings.commitExclusions ?? []), ...secretPatterns(settings)])
}

export function secretPatterns(settings = {}) {
  return unique([...DEFAULT_SECRET_PATTERNS, ...(settings.secretPatterns ?? [])])
}

function unique(list) {
  return [...new Set(list.map(s => String(s).trim()).filter(Boolean))]
}

/**
 * Arguments for `git add` that stage everything except the exclusions:
 * `git add -A -- . ':(exclude,glob,icase)**\/.env*' …`.
 */
export function addArgs(exclusions) {
  const specs = []
  for (const raw of exclusions) {
    let p = String(raw).trim().replace(/\\/g, '/').replace(/\/+$/, '')
    const anchored = p.includes('/')
    p = p.replace(/^\/+/, '')
    const base = anchored ? p : `**/${p}`
    specs.push(`:(exclude,glob,icase)${base}`)
    specs.push(`:(exclude,glob,icase)${base}/**`)
  }
  return ['add', '-A', '--', '.', ...specs]
}

/**
 * Parse `git diff --cached --name-status -z` output.
 * @returns {{ status: string, path: string, from?: string }[]}
 */
export function parseNameStatusZ(out) {
  const parts = String(out).split('\0')
  const entries = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i]
    if (!status) { i++; continue }
    if (/^[RC]/.test(status)) {
      entries.push({ status: status[0], from: parts[i + 1], path: parts[i + 2] })
      i += 3
    } else {
      entries.push({ status: status[0], path: parts[i + 1] })
      i += 2
    }
  }
  return entries
}

/**
 * Check what is staged before committing. A file being added or changed that
 * matches a secret pattern refuses the commit; so does one matching an
 * exclusion, which can only be there if it was staged before the run.
 * Deletions don't leak anything and pass.
 * @returns {{ ok: boolean, secrets: {path, pattern}[], excluded: {path, pattern}[], paths: string[] }}
 */
export function checkStaged(entries, settings = {}) {
  const secrets = []
  const excluded = []
  const secretList = secretPatterns(settings)
  const excludeList = exclusionPatterns(settings)
  for (const e of entries) {
    if (e.status === 'D') continue
    const s = firstMatch(e.path, secretList)
    if (s) { secrets.push({ path: e.path, pattern: s }); continue }
    const x = firstMatch(e.path, excludeList)
    if (x) excluded.push({ path: e.path, pattern: x })
  }
  return { ok: !secrets.length && !excluded.length, secrets, excluded, paths: entries.map(e => e.path) }
}
