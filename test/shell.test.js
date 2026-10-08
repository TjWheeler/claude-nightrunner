import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseShell, ShellParseError } from '../plugin/lib/shell.js'

const words = src => parseShell(src).commands.map(c => c.words.map(w => w.text))

test('splits on every separator and newline', () => {
  assert.deepEqual(words('a 1; b && c || d | e & f\ng'), [['a', '1'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']])
})

test('removes quoting and decodes $\'…\'', () => {
  assert.deepEqual(words(`echo 'a b' "c d" e\\ f $'\\x41\\n' g''h`), [['echo', 'a b', 'c d', 'e f', 'A\n', 'gh']])
})

test('nested substitutions are commands of their own, and mark the word dynamic', () => {
  const { commands } = parseShell('echo "x $(inner a) `back b`" $HOME')
  const outer = commands.find(c => c.words[0].text === 'echo')
  assert.ok(outer.words[1].dynamic)
  assert.ok(outer.words[2].dynamic)
  assert.ok(commands.some(c => c.words[0]?.text === 'inner'))
  assert.ok(commands.some(c => c.words[0]?.text === 'back'))
})

test('assignments, redirects and heredocs', () => {
  const { commands } = parseShell('A=1 B="x y" cmd arg 2>&1 > out.txt <<EOF\nbody $(sub)\nEOF\nnext')
  const c = commands.find(x => x.words[0]?.text === 'cmd')
  assert.deepEqual(c.assigns.map(a => [a.name, a.value]), [['A', '1'], ['B', 'x y']])
  assert.deepEqual(c.words.map(w => w.text), ['cmd', 'arg'])
  assert.deepEqual(c.redirects.map(r => r.op), ['>&', '>', '<<'])
  assert.equal(c.redirects[2].heredoc.body, 'body $(sub)')
  assert.ok(commands.some(x => x.words[0]?.text === 'sub'))
  assert.ok(commands.some(x => x.words[0]?.text === 'next'))
})

test('keywords before a command are skipped; for/case headers run nothing', () => {
  assert.deepEqual(words('if x; then y; fi'), [['x'], ['y']])
  assert.deepEqual(words('for i in a b; do z; done'), [['z']])
})

test('a piped command is marked', () => {
  const { commands } = parseShell('a | b')
  assert.equal(commands[0].piped, false)
  assert.equal(commands[1].piped, true)
})

test('unreadable input throws ShellParseError', () => {
  for (const s of ['echo "x', "echo 'x", 'echo $(x', 'echo `x', 'echo ${x', 'cat <', "echo $'x"]) {
    assert.throws(() => parseShell(s), ShellParseError, s)
  }
})
