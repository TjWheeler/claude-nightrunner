// Standing static gate: `node --check` on every JavaScript module in the repo.
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const SKIP = new Set(['node_modules', '.git', '.nightrunner'])
const files = []
const walk = dir => {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(m?js)$/.test(name)) files.push(p)
  }
}
walk('.')
let failed = 0
for (const f of files.sort()) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (err) { failed++; process.stderr.write(`${f}\n${err.stderr}\n`) }
}
console.log(`node --check: ${files.length - failed} of ${files.length} modules ok`)
process.exit(failed ? 1 : 0)
