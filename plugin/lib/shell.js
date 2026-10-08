// A conservative POSIX-shell reader for the deny matcher. It doesn't
// run anything and doesn't expand anything. It splits a command line into
// simple commands, removes quoting, decodes $'…' strings, and parses every
// $(…), `…`, <(…) and >(…) it meets as commands in their own right. Words
// that depend on an expansion are marked `dynamic`, so the matcher can fail
// closed on them. Input it can't read throws ShellParseError.

export class ShellParseError extends Error {}

const MAX_DEPTH = 16

// Longest first, so `&&` wins over `&`.
const OPERATORS = [
  ';;&', '&>>', '<<<', '<<-',
  '&&', '||', ';;', ';&', '|&', '&>', '>>', '<<', '<>', '>&', '<&', '>|',
  '|', '&', ';', '<', '>', '(', ')',
]
const SEPARATORS = new Set(['&&', '||', ';;&', ';;', ';&', ';', '|', '|&', '&', '(', ')'])
const PIPES = new Set(['|', '|&'])
const REDIRECTS = new Set(['&>>', '<<<', '<<-', '&>', '>>', '<<', '<>', '>&', '<&', '>|', '<', '>'])

// Reserved words that may precede a command and are not themselves run.
const LEADING_KEYWORDS = new Set(['!', '{', '}', 'then', 'else', 'elif', 'do', 'done', 'fi', 'esac', 'if', 'while', 'until', 'time', 'coproc'])
// Segments whose words are never run as a command (their substitutions still are).
const NON_COMMAND_STARTS = new Set(['for', 'select', 'case', '[[', 'in'])

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/

/**
 * Parse a command line.
 * @returns {{ commands: Command[] }} every simple command, nested ones included.
 * A Command is { words, assigns, redirects, piped } where each word is
 * { text, dynamic, glob }.
 */
export function parseShell(src, depth = 0) {
  if (depth > MAX_DEPTH) throw new ShellParseError('nesting too deep')
  const commands = []
  const tokens = lex(String(src), depth, commands)
  buildCommands(tokens, commands)
  return { commands }
}

function lex(src, depth, commands) {
  const tokens = []
  const pendingHeredocs = []
  let expectDelimiter = null
  let i = 0
  const n = src.length

  const nested = text => {
    for (const c of parseShell(text, depth + 1).commands) commands.push(c)
  }

  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue }
    if (ch === '\\' && src[i + 1] === '\n') { i += 2; continue }
    if (ch === '\n') {
      tokens.push({ type: 'newline' })
      i++
      for (const h of pendingHeredocs.splice(0)) i = readHeredocBody(src, i, h, nested)
      continue
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    // Process substitution: <(…) and >(…).
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') {
      const end = findClosingParen(src, i + 2)
      nested(src.slice(i + 2, end))
      tokens.push({ type: 'word', text: src.slice(i, end + 1), dynamic: true, glob: false })
      i = end + 1
      continue
    }
    const op = OPERATORS.find(o => src.startsWith(o, i))
    if (op) {
      const tok = { type: 'op', op }
      tokens.push(tok)
      i += op.length
      if (op === '<<' || op === '<<-') expectDelimiter = tok
      continue
    }
    const word = readWord(src, i, depth, nested)
    i = word.end
    // A word of digits glued to a redirect is a file descriptor, not a word.
    if (/^\d+$/.test(word.raw) && (src[i] === '<' || src[i] === '>')) continue
    const tok = { type: 'word', text: word.text, dynamic: word.dynamic, glob: word.glob }
    tokens.push(tok)
    if (expectDelimiter) {
      const heredoc = { delimiter: word.text, quoted: word.quoted, strip: expectDelimiter.op === '<<-', body: null }
      expectDelimiter.heredoc = heredoc
      pendingHeredocs.push(heredoc)
      expectDelimiter = null
    }
  }
  if (expectDelimiter) throw new ShellParseError('heredoc without a delimiter')
  // A heredoc that never reached its newline has an empty body; its delimiter is all there is.
  for (const h of pendingHeredocs) h.body = ''
  return tokens
}

function readHeredocBody(src, i, heredoc, nested) {
  const lines = []
  while (i <= src.length) {
    let end = src.indexOf('\n', i)
    if (end === -1) end = src.length
    let line = src.slice(i, end)
    if (heredoc.strip) line = line.replace(/^\t+/, '')
    i = end + 1
    if (line === heredoc.delimiter) {
      heredoc.body = lines.join('\n')
      if (!heredoc.quoted) scanExpansions(heredoc.body, nested)
      return i
    }
    lines.push(line)
    if (end === src.length) break
  }
  // Unterminated: bash reads to the end of input, and so do we.
  heredoc.body = lines.join('\n')
  if (!heredoc.quoted) scanExpansions(heredoc.body, nested)
  return src.length
}

// Find $(…) and `…` in text that is expanded but not split into commands
// (heredoc bodies, ${…} operands) and parse each. Quotes are ignored, which
// can only find more, never fewer.
function scanExpansions(text, nested) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue }
    if (text[i] === '$' && text[i + 1] === '(') {
      const end = findClosingParen(text, i + 2)
      nested(text.slice(i + 2, end))
      i = end
    } else if (text[i] === '`') {
      const { inner, end } = readBackquoted(text, i + 1)
      nested(inner)
      i = end - 1
    }
  }
}

function readWord(src, i, depth, nested) {
  let text = ''
  let raw = ''
  let dynamic = false
  let glob = false
  let quoted = false
  const n = src.length
  const start = i

  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break
    if ((ch === '<' || ch === '>') && src[i + 1] === '(') break
    if (OPERATORS.some(o => src.startsWith(o, i))) break

    if (ch === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue }
      if (i + 1 >= n) throw new ShellParseError('trailing backslash')
      text += src[i + 1]
      quoted = true
      i += 2
      continue
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      if (end === -1) throw new ShellParseError('unterminated single quote')
      text += src.slice(i + 1, end)
      quoted = true
      i = end + 1
      continue
    }
    if (ch === '$' && src[i + 1] === "'") {
      const r = readAnsiC(src, i + 2)
      text += r.text
      quoted = true
      i = r.end
      continue
    }
    if (ch === '"' || (ch === '$' && src[i + 1] === '"')) {
      const r = readDoubleQuoted(src, ch === '$' ? i + 2 : i + 1, nested)
      text += r.text
      dynamic = dynamic || r.dynamic
      quoted = true
      i = r.end
      continue
    }
    if (ch === '`') {
      const { inner, end } = readBackquoted(src, i + 1)
      nested(inner)
      text += src.slice(i, end)
      dynamic = true
      i = end
      continue
    }
    if (ch === '$') {
      const r = readDollar(src, i, nested)
      text += r.text
      dynamic = dynamic || r.dynamic
      i = r.end
      continue
    }
    if (ch === '*' || ch === '?' || ch === '[') glob = true
    if (ch === '{' && /^\{[^}\s]*[,.][^}\s]*\}/.test(src.slice(i))) glob = true
    text += ch
    i++
  }
  raw = src.slice(start, i)
  return { text, raw, dynamic, glob, quoted, end: i }
}

// $name, ${…}, $(…), $((…)) outside double quotes or inside them.
function readDollar(src, i, nested) {
  const next = src[i + 1]
  if (next === '(') {
    const end = findClosingParen(src, i + 2)
    nested(src[i + 2] === '(' ? src.slice(i + 3, end - 1) : src.slice(i + 2, end))
    return { text: src.slice(i, end + 1), dynamic: true, end: end + 1 }
  }
  if (next === '{') {
    const end = findClosingBrace(src, i + 2)
    scanExpansions(src.slice(i + 2, end), nested)
    return { text: src.slice(i, end + 1), dynamic: true, end: end + 1 }
  }
  const m = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]|[@*#?$!-])/.exec(src.slice(i + 1))
  if (m) return { text: '$' + m[0], dynamic: true, end: i + 1 + m[0].length }
  return { text: '$', dynamic: false, end: i + 1 }
}

function readDoubleQuoted(src, i, nested) {
  let text = ''
  let dynamic = false
  while (i < src.length) {
    const ch = src[i]
    if (ch === '"') return { text, dynamic, end: i + 1 }
    if (ch === '\\') {
      const nx = src[i + 1]
      if (nx === '\n') { i += 2; continue }
      if (nx === '$' || nx === '`' || nx === '"' || nx === '\\') { text += nx; i += 2; continue }
      text += ch
      i++
      continue
    }
    if (ch === '`') {
      const { inner, end } = readBackquoted(src, i + 1)
      nested(inner)
      text += src.slice(i, end)
      dynamic = true
      i = end
      continue
    }
    if (ch === '$') {
      const r = readDollar(src, i, nested)
      text += r.text
      dynamic = dynamic || r.dynamic
      i = r.end
      continue
    }
    text += ch
    i++
  }
  throw new ShellParseError('unterminated double quote')
}

const ANSI_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }

function readAnsiC(src, i) {
  let text = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === "'") return { text, end: i + 1 }
    if (ch !== '\\') { text += ch; i++; continue }
    const nx = src[i + 1]
    if (nx === undefined) break
    if (nx in ANSI_ESCAPES) { text += ANSI_ESCAPES[nx]; i += 2; continue }
    let m
    if ((m = /^x([0-9A-Fa-f]{1,2})/.exec(src.slice(i + 1)))) {
      text += String.fromCharCode(parseInt(m[1], 16)); i += 1 + m[0].length; continue
    }
    if ((m = /^u([0-9A-Fa-f]{1,4})/.exec(src.slice(i + 1))) || (m = /^U([0-9A-Fa-f]{1,8})/.exec(src.slice(i + 1)))) {
      const cp = parseInt(m[1], 16)
      if (cp > 0x10ffff) throw new ShellParseError('code point out of range in $\'…\'')
      text += String.fromCodePoint(cp); i += 1 + m[0].length; continue
    }
    if ((m = /^([0-7]{1,3})/.exec(src.slice(i + 1)))) {
      text += String.fromCharCode(parseInt(m[1], 8)); i += 1 + m[0].length; continue
    }
    if ((m = /^c(.)/.exec(src.slice(i + 1)))) {
      text += String.fromCharCode(m[1].charCodeAt(0) & 31); i += 3; continue
    }
    text += '\\' + nx
    i += 2
  }
  throw new ShellParseError("unterminated $'…' string")
}

// Returns the index of the `)` closing a group whose `(` is just before i.
function findClosingParen(src, i) {
  let depth = 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (ch === '"') {
      i = skipDoubleQuoted(src, i + 1)
      continue
    }
    if (ch === '`') { i = readBackquoted(src, i + 1).end; continue }
    if (ch === '(') depth++
    else if (ch === ')' && --depth === 0) return i
    i++
  }
  throw new ShellParseError('unterminated $( or (')
}

function findClosingBrace(src, i) {
  let depth = 1
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1)
      if (end === -1) break
      i = end + 1
      continue
    }
    if (ch === '"') { i = skipDoubleQuoted(src, i + 1); continue }
    if (ch === '$' && src[i + 1] === '(') { i = findClosingParen(src, i + 2) + 1; continue }
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i
    i++
  }
  throw new ShellParseError('unterminated ${')
}

function skipDoubleQuoted(src, i) {
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '"') return i + 1
    if (ch === '$' && src[i + 1] === '(') { i = findClosingParen(src, i + 2) + 1; continue }
    if (ch === '`') { i = readBackquoted(src, i + 1).end; continue }
    i++
  }
  throw new ShellParseError('unterminated double quote')
}

// Inside backquotes a backslash escapes `, \ and $; the rest is kept.
function readBackquoted(src, i) {
  let inner = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && i + 1 < src.length) {
      const nx = src[i + 1]
      inner += nx === '`' || nx === '\\' || nx === '$' ? nx : ch + nx
      i += 2
      continue
    }
    if (ch === '`') return { inner, end: i + 1 }
    inner += ch
    i++
  }
  throw new ShellParseError('unterminated backquote')
}

function buildCommands(tokens, out) {
  let cur = newCommand()
  let piped = false
  const flush = nextPiped => {
    const cmd = finishCommand(cur)
    if (cmd) { cmd.piped = piped; out.push(cmd) }
    cur = newCommand()
    piped = nextPiped
  }
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]
    if (tok.type === 'newline') { flush(false); continue }
    if (tok.type === 'op') {
      if (SEPARATORS.has(tok.op)) {
        flush(PIPES.has(tok.op))
        continue
      }
      if (REDIRECTS.has(tok.op)) {
        const target = tokens[k + 1]
        if (!target || target.type !== 'word') throw new ShellParseError(`redirect ${tok.op} without a target`)
        cur.redirects.push({ op: tok.op, target, heredoc: tok.heredoc })
        k++
        continue
      }
    }
    cur.raw.push(tok)
  }
  flush(false)
}

function newCommand() {
  return { raw: [], redirects: [] }
}

function finishCommand(cur) {
  let words = cur.raw
  // Skip reserved words that only introduce a command.
  while (words.length && !words[0].dynamic && LEADING_KEYWORDS.has(words[0].text)) {
    words = words.slice(1)
    if (words.length && words[0].text === '-p' && cur.raw[0]?.text === 'time') words = words.slice(1)
  }
  if (words.length && !words[0].dynamic && words[0].text === 'function') words = words.slice(2)
  if (words.length && !words[0].dynamic && NON_COMMAND_STARTS.has(words[0].text)) words = []
  const assigns = []
  while (words.length && ASSIGNMENT.test(words[0].text)) {
    const w = words[0]
    const eq = w.text.indexOf('=')
    assigns.push({ name: w.text.slice(0, eq).replace(/\[.*$/, '').replace(/\+$/, ''), value: w.text.slice(eq + 1) })
    words = words.slice(1)
  }
  if (!words.length && !assigns.length && !cur.redirects.length) return null
  return {
    words: words.map(w => ({ text: w.text, dynamic: w.dynamic, glob: w.glob })),
    assigns,
    redirects: cur.redirects.map(r => ({
      op: r.op,
      target: { text: r.target.text, dynamic: r.target.dynamic },
      heredoc: r.heredoc ? { body: r.heredoc.body ?? '', quoted: r.heredoc.quoted } : undefined,
    })),
  }
}

/** Split a string into words the way a shell would, for `env -S` and `watch`. */
export function splitWords(text) {
  const { commands } = parseShell(text)
  return commands[0]?.words ?? []
}
