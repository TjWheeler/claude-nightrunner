import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchPattern, exclusionPatterns, secretPatterns, addArgs, parseNameStatusZ, checkStaged, DEFAULT_SECRET_PATTERNS } from '../plugin/lib/staging.js'

test('the default secret patterns', () => {
  assert.deepEqual(DEFAULT_SECRET_PATTERNS, ['.env*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', 'id_rsa*', 'id_ed25519*',
    '.npmrc', '.pypirc', 'credentials*.json', '*.tfstate*'])
})

test('patterns without a slash match at any depth, ignoring case', () => {
  for (const [path, pattern] of [
    ['.env', '.env*'], ['app/.env.local', '.env*'], ['a/b/server.PEM', '*.pem'], ['id_rsa.pub', 'id_rsa*'],
    ['infra/terraform.tfstate.backup', '*.tfstate*'], ['config/credentials-prod.json', 'credentials*.json'],
    ['.nightrunner/runs/x/run.json', '.nightrunner/'], ['sub/.nightrunner/x', '.nightrunner/'], ['.NPMRC', '.npmrc'],
  ]) assert.ok(matchPattern(path, pattern), `${path} ~ ${pattern}`)
})

test('patterns do not over-match', () => {
  for (const [path, pattern] of [
    ['src/environment.js', '.env*'], ['docs/pem.md', '*.pem'], ['keys.json', '*.key'], ['credentials.yaml', 'credentials*.json'],
    ['nightrunner/x', '.nightrunner/'],
  ]) assert.ok(!matchPattern(path, pattern), `${path} !~ ${pattern}`)
})

test('anchored and ** patterns', () => {
  assert.ok(matchPattern('secrets/a/b.txt', 'secrets/'))
  assert.ok(!matchPattern('x/secrets/a.txt', '/secrets/'))
  assert.ok(matchPattern('x/secrets/a.txt', 'secrets/'))
  assert.ok(matchPattern('a/b/c/d.bin', 'a/**/d.bin'))
  assert.ok(matchPattern('a/d.bin', 'a/**/d.bin'))
  assert.ok(matchPattern('cert1.crt', 'cert[0-9].crt'))
})

test('layers add exclusions and secret patterns, never remove', () => {
  const s = { commitExclusions: ['dist/'], secretPatterns: ['*.secret'] }
  assert.ok(exclusionPatterns(s).includes('dist/'))
  assert.ok(exclusionPatterns(s).includes('*.secret'))
  assert.ok(exclusionPatterns(s).includes('.env*'))
  assert.ok(secretPatterns(s).includes('*.secret'))
  assert.ok(!secretPatterns(s).includes('dist/'))
})

test('git add arguments exclude each pattern and its contents', () => {
  const args = addArgs(['.env*', '.nightrunner/', 'config/local/'])
  assert.deepEqual(args.slice(0, 4), ['add', '-A', '--', '.'])
  assert.ok(args.includes(':(exclude,glob,icase)**/.env*'))
  assert.ok(args.includes(':(exclude,glob,icase)**/.nightrunner/**'))
  assert.ok(args.includes(':(exclude,glob,icase)config/local'))
})

test('parseNameStatusZ reads renames and plain entries', () => {
  const out = 'M\0src/a.js\0R100\0old.js\0new.js\0A\0.env\0D\0gone.pem\0'
  assert.deepEqual(parseNameStatusZ(out), [
    { status: 'M', path: 'src/a.js' },
    { status: 'R', from: 'old.js', path: 'new.js' },
    { status: 'A', path: '.env' },
    { status: 'D', path: 'gone.pem' },
  ])
})

test('a staged secret refuses the commit; a deletion does not', () => {
  const r = checkStaged(parseNameStatusZ('M\0src/a.js\0A\0deploy/server.key\0D\0old.pem\0'))
  assert.equal(r.ok, false)
  assert.deepEqual(r.secrets, [{ path: 'deploy/server.key', pattern: '*.key' }])
  assert.equal(checkStaged(parseNameStatusZ('M\0src/a.js\0D\0old.pem\0')).ok, true)
})

test('a staged excluded file refuses the commit', () => {
  const r = checkStaged([{ status: 'A', path: 'dist/app.js' }], { commitExclusions: ['dist/'] })
  assert.equal(r.ok, false)
  assert.equal(r.excluded[0].pattern, 'dist/')
})

test('a rename that brings a secret in is caught by its new path', () => {
  assert.equal(checkStaged(parseNameStatusZ('R090\0notes.txt\0.env.production\0')).ok, false)
})
