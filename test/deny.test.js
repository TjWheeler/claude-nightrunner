import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildDenyList, checkCommand, checkToolCall, checkOpaque, parseEntry, isProtectedPath, describeRemovals } from '../plugin/lib/deny.js'

const { list } = buildDenyList()

const refused = (cmd, l = list) => {
  const r = checkCommand(cmd, l)
  assert.ok(r, `expected refusal: ${JSON.stringify(cmd)}`)
  return r.what
}
const allowed = (cmd, l = list) => {
  const r = checkCommand(cmd, l)
  assert.equal(r, null, `expected allowed: ${JSON.stringify(cmd)} (refused as ${r?.what})`)
}

describe('git allow-list', () => {
  test('read-only subcommands are allowed', () => {
    for (const c of [
      'git status', 'git status --porcelain=v1 -z', 'git diff HEAD~1 -- src', 'git log --oneline -20', 'git show HEAD:README.md',
      'git rev-parse --abbrev-ref HEAD', 'git ls-files -z', 'git blame -L 1,5 x.js', 'git grep -n foo', 'git branch',
      'git branch -a', 'git branch -vv', 'git branch --show-current', 'git branch --list "feat/*"', 'git branch -r --contains abc',
      'git --no-pager log', 'git -C sub status', 'git --git-dir=.git status', 'git --version', 'git', 'GIT_PAGER=cat git log',
      'git log | head -5', 'git diff --stat && git status',
    ]) allowed(c)
  })
  test('every write subcommand is refused', () => {
    for (const sub of ['commit -m x', 'push', 'push origin main', 'merge x', 'rebase main', 'reset --hard', 'checkout x', 'switch x',
      'stash', 'tag v1', 'add -A', 'rm x', 'mv a b', 'cherry-pick a', 'revert a', 'am x', 'apply x', 'fetch', 'pull', 'clean -fd',
      'restore x', 'config user.name x', 'remote add o u', 'update-ref HEAD x', 'worktree add x', 'submodule update', 'gc', 'notes add',
      'filter-branch', 'replace a b', 'symbolic-ref HEAD x', 'init', 'clone u', 'help push']) {
      assert.match(refused(`git ${sub}`), /^git /)
    }
  })
  test('branch changes are refused, listing is not', () => {
    for (const c of ['git branch new', 'git branch -d old', 'git branch -D old', 'git branch -m a b', 'git branch -M b',
      'git branch -c a b', 'git branch -f x HEAD', 'git branch -u origin/x', 'git branch --set-upstream-to=o/x', 'git branch --unset-upstream',
      'git branch --edit-description', 'git branch -av newname']) refused(c)
  })
  test('aliases go through the allow-list', () => {
    for (const c of ['git co main', 'git p', 'git ci -m x', 'git st2', 'git STATUS']) refused(c)
  })
  test('git -c and --config-env are refused', () => {
    assert.equal(refused('git -c core.pager=evil log'), 'git -c')
    assert.equal(refused('git -c alias.status=push status'), 'git -c')
    assert.equal(refused('git -ccore.fsmonitor=x status'), 'git -c')
    assert.equal(refused('git --config-env=core.pager=X log'), 'git -c')
    refused('git -C . -c core.sshCommand=x status')
  })
  test('git -C and other global options are skipped to the subcommand', () => {
    refused('git -C /tmp/x push')
    refused('git -C sub --no-pager commit -m x')
    refused('git --git-dir .git --work-tree . push')
    refused('git --exec-path=/tmp status')
    refused('git -p log')
    refused('git --unknown-option status')
  })
  test('git grep cannot open a pager program', () => {
    refused('git grep -Ovim foo')
    refused('git grep --open-files-in-pager=sh foo')
  })
  test('environment that makes git run a program is refused', () => {
    refused('GIT_EXTERNAL_DIFF=./evil git diff')
    refused('GIT_SSH_COMMAND=x git status')
    refused('PAGER=evil git log')
    refused('export GIT_EXTERNAL_DIFF=./evil; git diff')
    refused('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0=x git log')
    refused('env GIT_DIR=/tmp/x git status')
  })
  test('git-<sub> binaries and odd spellings are git', () => {
    refused('git-push origin')
    refused('/usr/lib/git-core/git-push origin')
    refused('/usr/bin/git push')
    refused('GIT push')
    refused('git.exe push')
    refused('\\git push')
    refused('"git" push')
    refused("g''it push")
    refused("'g'it pu'sh'")
    refused("$'\\x67\\x69\\x74' push")
    refused("$'\\147it' push")
    refused('git pu\\\nsh')
  })
})

describe('compound commands', () => {
  test('every separator is split', () => {
    for (const sep of [';', '&&', '||', '|', '&', '\n', '|&']) refused(`echo hi ${sep} git push`)
  })
  test('substitutions are looked inside', () => {
    refused('echo $(git push)')
    refused('echo "$(git push)"')
    refused('echo `git push`')
    refused('echo "`git push`"')
    refused('x=$(git commit -m y)')
    refused('echo ${x:-$(git push)}')
    refused('diff <(git push) <(true)')
    refused('tee >(git push)')
    refused('echo $(echo $(git push))')
    refused('echo $((1 + $(git push)))')
  })
  test('subshells, groups, functions and control flow', () => {
    refused('(git push)')
    refused('{ git push; }')
    refused('f() { git push; }; f')
    refused('function f { git push; }')
    refused('if true; then git push; fi')
    refused('while true; do git push; done')
    refused('for i in 1; do git push; done')
    refused('case x in x) git push;; esac')
    refused('! git push')
    refused('time git push')
    refused('[[ -n x ]] && git push')
  })
  test('heredocs: a shell reading one, and substitutions inside an unquoted one', () => {
    refused('bash <<EOF\ngit push\nEOF')
    refused('sh <<-EOF\n\tgit push\n\tEOF')
    refused("bash <<'EOF'\ngit push\nEOF")
    refused('cat <<EOF\n$(git push)\nEOF')
    allowed("cat <<'EOF' > notes.md\nrun git push later\nEOF")
    refused('bash <<< "git push"')
  })
  test('a shell reading a pipe fails closed when the line mentions git', () => {
    refused('echo "git push" | sh')
    refused('printf "git push" | bash -s')
    allowed('echo hi | sh')
    allowed('cat script | bash -s') // can't see the script and it mentions nothing denied: a known gap
  })
})

describe('wrappers', () => {
  test('env, sudo, command and friends are stripped', () => {
    for (const c of [
      'env git push', 'env -i PATH=/usr/bin git push', 'env -u HOME git push', 'env -- git push', 'env -S "git push"',
      'env --split-string="git push"', 'sudo git push', 'sudo -u root -E git push', 'sudo -- git push', 'doas git push',
      'command git push', 'command -p git push', 'builtin exec git push', 'exec git push', 'exec -a x git push', 'nohup git push',
      'nice -n 5 git push', 'nice -10 git push', 'ionice -c 3 git push', 'timeout 10 git push', 'timeout -s KILL 5s git push',
      'stdbuf -o0 git push', 'setsid git push', 'xargs git push', 'busybox git push', 'FOO=1 BAR=2 git push',
      'sudo FOO=1 git push', 'taskset 0x1 git push', 'flock /tmp/l git push', 'chrt 1 git push',
    ]) refused(c)
  })
  test('command -v only looks a program up', () => {
    allowed('command -v git')
    allowed('command -V kubectl')
    allowed('type git && which kubectl')
  })
  test('sh -c, bash -c, eval and friends are looked inside', () => {
    refused('sh -c "git push"')
    refused("bash -c 'git push'")
    refused("bash -lc 'git push'")
    refused('bash -o pipefail -ec "cd x && git push"')
    refused("zsh -c 'git commit -m x'")
    refused('eval git push')
    refused('eval "git push"')
    refused('eval "$(echo git push)"')
    refused('su -c "git push" root')
    refused('script -q -c "git push" /dev/null')
    refused('flock /tmp/l -c "git push"')
    refused('watch -n 5 git push')
    refused("ssh host 'git push'")
    refused('ssh -p 22 -i k host git push')
    refused("trap 'git push' EXIT")
    refused("alias gp='git push'; gp")
    refused('cmd /c git push')
    refused("bash -c 'bash -c \"git push\"'")
  })
  test('find -exec and xargs run their arguments', () => {
    refused('find . -name x -exec git add {} \\;')
    refused('find . -execdir git commit -m x {} +')
    refused('echo push | xargs git')
    refused('echo x | xargs -I{} git push {}')
    refused('echo new | xargs git branch')
    refused('ls | parallel git push ::: a')
    allowed('find . -name "*.js" -exec grep -l foo {} +')
    allowed('find . -path ./.git -prune -o -name "*.md" -print')
  })
  test('a denied program run by another program', () => {
    refused('npx kubectl apply -f x')
    refused('docker exec c git push')
    refused('uv run git push')
    refused('npm exec -- git push')
    refused('bundle exec gh pr create')
    allowed('npm test')
    allowed('brew install git')
  })
  test('interpreter code that mentions a denied program fails closed', () => {
    refused('python3 -c "import os; os.system(\'git push\')"')
    refused("node -e \"require('child_process').execSync('git push')\"")
    refused("perl -e 'system(\"git push\")'")
    refused("perl -le 'system(\"git push\")'")
    refused("ruby -e '`git push`'")
    refused("awk 'BEGIN { system(\"git push\") }'")
    refused('python3 - <<EOF\nimport subprocess; subprocess.run(["git","push"])\nEOF')
    refused("sed -n 'e git push' x")
    refused("pwsh -Command 'git push'")
    allowed('python3 -c "print(1)"')
    allowed('node script.js')
    allowed("awk '{print $1}' file")
  })
  test('a dynamic program name fails closed when the line mentions a denied program', () => {
    refused('G=git; $G push')
    refused('$(echo git) push')
    refused('"$X" push # git')
    allowed('"$EDITOR" notes.md')
    allowed('$PYTHON script.py')
  })
})

describe('unparseable input', () => {
  test('fails closed when it mentions a denied program', () => {
    refused('echo "unterminated; git push')
    refused("echo 'x ; kubectl apply")
    refused('echo $(git push')
    assert.match(refused('echo "x; git push'), /could not parse/)
  })
  test('passes when it mentions nothing denied', () => {
    allowed('echo "unterminated')
  })
})

describe('other built-in entries', () => {
  test('GitHub, cloud and publishing commands', () => {
    for (const c of ['gh pr create', 'gh pr merge 1', 'gh release create v1', 'gh api -X POST repos/x/y/pulls', 'gh repo delete x',
      'gh workflow run x', 'gh secret set X', 'az group create', 'aws s3 rm s3://x', 'gcloud run deploy', 'kubectl apply -f x',
      'helm install x', 'terraform apply', 'terraform -chdir=infra apply -auto-approve', 'tofu destroy', 'pulumi up --yes',
      'docker push x', 'docker image push x', 'docker buildx build --push .', 'docker build --push .', 'npm publish',
      'npm --registry https://r publish', 'pnpm publish', 'yarn npm publish', 'cargo publish', 'twine upload dist/*',
      'gem push x.gem', 'npm run publish']) refused(c)
  })
  test('their read or local forms are allowed', () => {
    for (const c of ['terraform plan', 'terraform fmt', 'pulumi preview', 'docker build .', 'docker run --rm alpine true',
      'npm install', 'npm run build', 'cargo build', 'gh --version', 'ghostscript x', 'awkward', 'gitleaks detect']) allowed(c)
  })
})

describe('writes into .git/', () => {
  test('Write, Edit and other path tools are refused', () => {
    for (const [tool, input] of [
      ['Write', { file_path: '/repo/.git/hooks/pre-commit', content: 'x' }],
      ['Edit', { file_path: '.git/config', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: '/repo/.GIT/HEAD', edits: [] }],
      ['NotebookEdit', { notebook_path: '/repo/.git/x.ipynb' }],
      ['Write', { file_path: '/home/u/.gitconfig' }],
      ['Write', { file_path: '/home/u/.config/git/config' }],
      ['Write', { file_path: '/repo/sub/.git' }],
      ['mcp__filesystem__write_file', { path: '/repo/.git/hooks/post-checkout' }],
    ]) assert.ok(checkToolCall(tool, input, list), `${tool} ${JSON.stringify(input)}`)
  })
  test('ordinary paths and reads are not', () => {
    assert.equal(checkToolCall('Write', { file_path: '/repo/.github/workflows/ci.yml' }, list), null)
    assert.equal(checkToolCall('Write', { file_path: '/repo/.gitignore' }, list), null)
    assert.equal(checkToolCall('Edit', { file_path: '/repo/src/git.js' }, list), null)
    assert.equal(checkToolCall('Read', { file_path: '/repo/.git/HEAD' }, list), null)
    assert.equal(checkToolCall('Grep', { pattern: 'x', path: '/repo/.git' }, list), null)
  })
  test('shell writes into .git/ are refused', () => {
    for (const c of ['echo x > .git/hooks/pre-commit', 'echo x >> .git/config', 'cat x | tee .git/hooks/pre-push',
      'cp evil .git/hooks/pre-commit', 'mv x ./.git/HEAD', 'rm -rf .git', 'chmod +x .git/hooks/pre-commit',
      'ln -s ../../x .git/hooks/pre-commit', "sed -i 's/a/b/' .git/config", 'dd if=x of=.git/config', 'cd .git && rm hooks/x',
      'cd .git', 'pushd .git/hooks', 'echo x > ~/.gitconfig', 'find .git -delete']) refused(c)
  })
  test('reading .git/ is allowed', () => {
    allowed('cat .git/HEAD')
    allowed('ls .git/hooks')
    allowed("sed -n '1p' .git/config")
  })
})

describe('MCP and other tool names', () => {
  test('GitHub MCP writes are refused, reads allowed', () => {
    assert.ok(checkToolCall('mcp__github__create_pull_request', {}, list))
    assert.ok(checkToolCall('mcp__github__merge_pull_request', {}, list))
    assert.ok(checkToolCall('mcp__claude_ai_GitHub__push_files', {}, list))
    assert.ok(checkToolCall('mcp__plugin_github_github__update_issue', {}, list))
    assert.equal(checkToolCall('mcp__github__get_pull_request', {}, list), null)
    assert.equal(checkToolCall('mcp__github__list_commits', {}, list), null)
    assert.equal(checkToolCall('mcp__github__search_code', {}, list), null)
  })
  test('remote and scheduled agents are refused', () => {
    assert.ok(checkToolCall('RemoteTrigger', {}, list))
    assert.ok(checkToolCall('CronCreate', {}, list))
  })
  test('a Bash call and an unknown tool carrying a command are checked', () => {
    assert.ok(checkToolCall('Bash', { command: 'git push', description: 'x' }, list))
    assert.ok(checkToolCall('Monitor', { command: 'git push' }, list))
    assert.ok(checkToolCall('SomeNewShell', { command: 'git push' }, list))
    assert.ok(checkToolCall('PowerShell', { command: 'git push origin' }, list))
    assert.equal(checkToolCall('Bash', { command: 'npm test' }, list), null)
    assert.equal(checkToolCall('mcp__nightrunner__commit', { subject: 'x' }, list), null)
  })
  test('configured MCP patterns', () => {
    const { list: l } = buildDenyList({ add: 'mcp__jira__create_*, mcp__*__deploy*' })
    assert.ok(checkToolCall('mcp__jira__create_issue', {}, l))
    assert.ok(checkToolCall('mcp__vercel__deploy_project', {}, l))
    assert.equal(checkToolCall('mcp__jira__get_issue', {}, l), null)
  })
})

describe('additions and removals', () => {
  test('any layer adds entries', () => {
    const { list: l } = buildDenyList({ add: ['make deploy', 'psql'] })
    refused('make deploy', l)
    refused('psql -c "drop table x"', l)
    allowed('make test', l)
  })
  test('a removal drops a built-in entry', () => {
    const { list: l, ok } = buildDenyList({ remove: 'kubectl' })
    assert.ok(ok)
    allowed('kubectl apply -f x', l)
    assert.deepEqual(describeRemovals(l), ['kubectl'])
  })
  test('a removal narrows a built-in to a subcommand', () => {
    const { list: l } = buildDenyList({ remove: 'kubectl get\nkubectl describe' })
    allowed('kubectl get pods', l)
    allowed('kubectl describe pod x', l)
    refused('kubectl apply -f x', l)
    refused('kubectl -n get delete pod x', l) // options before the subcommand don't exempt
    refused('kubectl --context prod get pods', l)
  })
  test('a git removal allows one more read-only subcommand', () => {
    const { list: l } = buildDenyList({ remove: 'git describe, git remote -v' })
    allowed('git describe --tags', l)
    allowed('git remote -v', l)
    refused('git remote add x y', l)
    refused('git -c x=y describe', l)
    refused('git push', l)
  })
  test('a removal of the whole of git allows git', () => {
    const { list: l } = buildDenyList({ remove: 'git' })
    allowed('git push', l)
    allowed('git -c a=b log', l)
  })
  test('an addition beats a removal', () => {
    const { list: l } = buildDenyList({ add: 'kubectl', remove: 'kubectl' })
    refused('kubectl get pods', l)
  })
  test('a removal must name a built-in entry or a narrower form', () => {
    for (const r of ['make', 'gh', 'terraform', 'mcp__*__*', 'mcp__github__*x']) {
      const { ok, errors } = buildDenyList({ remove: r })
      if (r === 'mcp__github__*x') { assert.ok(ok, r); continue }
      assert.equal(ok, false, r)
      assert.match(errors[0], /doesn't name a built-in/)
    }
  })
  test('MCP removals narrow the GitHub entry', () => {
    const { list: l } = buildDenyList({ remove: 'mcp__github__create_issue' })
    assert.equal(checkToolCall('mcp__github__create_issue', {}, l), null)
    assert.ok(checkToolCall('mcp__github__merge_pull_request', {}, l))
  })
  test('a partly removed entry still fails closed in opaque code', () => {
    const { list: l } = buildDenyList({ remove: 'kubectl get' })
    assert.ok(checkOpaque("subprocess.run(['kubectl','apply'])", l))
  })
})

describe('entries', () => {
  test('parseEntry', () => {
    assert.deepEqual(parseEntry('kubectl get'), { kind: 'command', words: ['kubectl', 'get'] })
    assert.deepEqual(parseEntry('mcp__x__y*'), { kind: 'tool', pattern: 'mcp__x__y*' })
    assert.throws(() => parseEntry('rm -rf /; x'))
    assert.throws(() => parseEntry('mcp__bad'))
    assert.throws(() => parseEntry(''))
  })
  test('isProtectedPath', () => {
    assert.ok(isProtectedPath('.git'))
    assert.ok(isProtectedPath('a\\.git\\hooks'))
    assert.ok(!isProtectedPath('.github/x'))
    assert.ok(!isProtectedPath('.gitignore'))
  })
})

describe('faults fail closed', () => {
  test('an out-of-range code point is a parse error, not a crash', () => {
    assert.doesNotThrow(() => checkCommand("echo $'\\U110000'", list))
    assert.ok(checkCommand("$'\\U110000' git push", list))
  })
  test('a fault inside the checker refuses the call', () => {
    const broken = { builtins: null, adds: null, removals: null }
    assert.ok(checkToolCall('Bash', { command: 'ls' }, broken))
  })
  test('a very long command is checked as opaque text', () => {
    assert.ok(checkCommand('echo ' + 'x'.repeat(200000) + ' ; git push', list))
    assert.equal(checkCommand('echo ' + 'x'.repeat(200000), list), null)
  })
  test('pathological input finishes quickly', () => {
    const t = Date.now()
    for (const s of ['{'.repeat(20000), '$('.repeat(2000), '"'.repeat(30001), '\\'.repeat(50001), '<<'.repeat(5000), "$'".repeat(5000)]) checkCommand(s, list)
    assert.ok(Date.now() - t < 5000, `took ${Date.now() - t} ms`)
  })
})
