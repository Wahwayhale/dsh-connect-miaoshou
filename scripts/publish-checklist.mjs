/**
 * Pre-submission gate: answers one question — "can this be committed and
 * published right now?" — using only local, read-only checks.
 *
 * It NEVER commits, pushes, publishes, or touches the network. The only thing it
 * can do to your repository is read it.
 *
 * Exit codes:  0 = no FAIL (WARN is allowed, print READY TO SUBMIT)
 *              1 = at least one FAIL
 *
 * Run it from anywhere:   node scripts/publish-checklist.mjs
 *
 * WARN vs FAIL is the whole point of this file. A missing screenshot degrades
 * the marketplace card but does not break the submission (only ~23% of published
 * entries carry one), so it must be visible without blocking; a client bundle
 * that is not the __ModuleLoader__ wrapper breaks the desktop UI at startup, so
 * it must block.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
const REPO_SLUG = 'dsh-connect-miaoshou'

function record(level, name, detail) {
  results.push({ level, name, detail })
}

/** Blocking check: a throw is a FAIL. */
function check(name, fn) {
  try {
    const detail = fn()
    record('PASS', name, detail ?? '')
  } catch (error) {
    record('FAIL', name, (error && error.message) || String(error))
  }
}

/** Advisory check: a throw is a WARN, never blocks. */
function warnCheck(name, fn) {
  try {
    const detail = fn()
    record('PASS', name, detail ?? '')
  } catch (error) {
    record('WARN', name, (error && error.message) || String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// --- 1. a real repository ----------------------------------------------------
check('git 仓库存在（.git/）', () => {
  assert(existsSync(join(ROOT, '.git')), '未找到 .git —— 先执行 git init')
  return '.git/ 存在'
})

check('仓库至少有一个 commit', () => {
  const out = execFileSync('git', ['log', '--oneline', '-1'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  assert(out.trim().length > 0, '仓库还没有 commit —— 先 git commit')
  return out.trim()
})

function gitHasHead() {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

// --- 2. marketplace card imagery --------------------------------------------
// The icon is REQUIRED (the entry's `icon` field points at it); the UI
// screenshots are advisory, because they need a live GUI to capture.
warnCheck('市场卡片 icon 在位', () => {
  const rel = 'docs/assets/dsh-connect-miaoshou-icon.png'
  const p = join(ROOT, rel)
  assert(existsSync(p), `缺少 ${rel} —— 市场条目会没有图标`)
  const size = readFileSync(p).length
  assert(size > 4096, `${rel} 只有 ${size} 字节，疑似占位文件`)
  return `${Math.round(size / 1024)} KB`
})

warnCheck('screenshots.json 引用的文件都真实存在', () => {
  const list = JSON.parse(readFileSync(join(ROOT, 'screenshots.json'), 'utf8'))
  assert(Array.isArray(list), 'screenshots.json 不是数组')
  for (const rel of list) {
    assert(existsSync(join(ROOT, rel)), `screenshots.json 引用了不存在的文件：${rel}`)
  }
  return list.length === 0
    ? '空数组 —— 卡片暂无截图（需在桌面端手动截，见 RELEASE-CHECKLIST 第 3 步）'
    : `${list.length} 条引用全部存在`
})

warnCheck('截图已进版本库（有图才会进市场卡片）', () => {
  const listing = gitHasHead()
    ? execFileSync('git', ['ls-tree', '-r', 'HEAD', '--name-only'], { cwd: ROOT, encoding: 'utf8' })
    : execFileSync('git', ['ls-files', '--cached', '--'], { cwd: ROOT, encoding: 'utf8' })
  const tracked = new Set(listing.split('\n').map(l => l.trim()))
  const pngs = readdirSync(join(ROOT, 'docs', 'assets')).filter(f => f.endsWith('.png'))
  const missing = pngs.filter(f => !tracked.has(`docs/assets/${f}`))
  assert(missing.length === 0, `未进库：${missing.join(', ')}（先 git add）`)
  return `${pngs.length} 张 png 均已跟踪`
})

check('docs/assets 下 png 不会被 .gitignore 吞掉', () => {
  const pngs = readdirSync(join(ROOT, 'docs', 'assets')).filter(f => f.endsWith('.png'))
  assert(pngs.length > 0, 'docs/assets 下没有任何 png')
  for (const file of pngs) {
    const rel = `docs/assets/${file}`
    let matched = false
    try {
      execFileSync('git', ['check-ignore', '--no-index', '-q', '--', rel], { cwd: ROOT, stdio: 'ignore' })
      matched = true
    } catch { /* not ignored — the healthy case */ }
    if (matched) {
      let rule = ''
      try {
        rule = execFileSync('git', ['check-ignore', '--no-index', '-v', '--', rel], {
          cwd: ROOT, encoding: 'utf8',
        }).trim()
      } catch { /* no rule */ }
      assert(/^\S+:\d+:\s*!/.test(rule), `${rel} 被 ${rule || '某条 .gitignore 规则'} 挡住了`)
    }
  }
  return `${pngs.length} 张均不会被 ignore 规则吞掉`
})

// --- 3. build artifacts ------------------------------------------------------
check('lib/client.js 在位且为 CJS（客户端入口的硬约束）', () => {
  const p = join(ROOT, 'lib', 'client.js')
  assert(existsSync(p), '缺少 lib/client.js —— 先 npm run build')
  const first = readFileSync(p, 'utf8').split('\n').find(l => l.trim() !== '') ?? ''
  assert(
    first.includes('window.__ModuleLoader__.load('),
    `首行是 ${JSON.stringify(first.slice(0, 60))}，不是 __ModuleLoader__ 包装 —— ESM 产物会让桌面端启动即崩`,
  )
  return `首行: ${first.trim().slice(0, 48)}`
})

check('lib/index.js 在位（宿主 provider 入口）', () => {
  const p = join(ROOT, 'lib', 'index.js')
  assert(existsSync(p), '缺少 lib/index.js —— 先 npm run build')
  return `${Math.round(readFileSync(p).length / 1024)} KB`
})

check('lib/index.d.ts 在位（类型声明）', () => {
  assert(existsSync(join(ROOT, 'lib', 'index.d.ts')), '缺少 lib/index.d.ts')
  return '存在'
})

// --- 4. metadata -------------------------------------------------------------
check('package.json 无 TODO 占位符', () => {
  const found = JSON.stringify(pkg).match(/TODO[A-Z-]*/g)
  assert(!found, `仍有占位符：${[...new Set(found)].join(', ')}`)
  return '干净'
})

check('package.json 声明了 repository / homepage / bugs', () => {
  for (const key of ['repository', 'homepage', 'bugs']) assert(pkg[key], `缺少 ${key}`)
  const repoUrl = typeof pkg.repository === 'string' ? pkg.repository.url : pkg.repository.url
  assert(/git\+https:\/\/github\.com\//.test(repoUrl), `repository.url 应带 git+ 前缀，当前是 ${repoUrl}`)
  return repoUrl
})

check('package.json 的 files 含 docs/assets（否则市场页无图）', () => {
  assert(Array.isArray(pkg.files) && pkg.files.includes('docs/assets'), 'files 里没有 docs/assets')
  return pkg.files.join(', ')
})

check('官方 @deepseek-ai/* 走 peerDependencies（市场 R11）', () => {
  const peers = Object.keys(pkg.peerDependencies ?? {})
  assert(peers.length > 0, 'peerDependencies 为空')
  const leaked = Object.keys(pkg.dependencies ?? {}).filter(d => d.startsWith('@deepseek-ai/'))
  assert(leaked.length === 0, `这些官方包被放进了 dependencies：${leaked.join(', ')}`)
  return `${peers.length} 个 peer 依赖，0 个官方包泄漏到 dependencies`
})

check('cordis.patch.yml 声明了本插件条目', () => {
  const p = join(ROOT, 'cordis.patch.yml')
  assert(existsSync(p), '缺少 cordis.patch.yml')
  const text = readFileSync(p, 'utf8')
  assert(text.includes(REPO_SLUG), `cordis.patch.yml 里没有 ${REPO_SLUG} 条目`)
  return '条目存在'
})

// --- 5. docs -----------------------------------------------------------------
for (const rel of ['README.md', 'README.en.md', 'LICENSE', 'CHANGELOG.md']) {
  check(`必需文件存在：${rel}`, () => {
    const p = join(ROOT, rel)
    assert(existsSync(p), `缺少 ${rel}`)
    return `${readFileSync(p).length} 字节`
  })
}

check('两份 README 的安装段都给出了可执行命令', () => {
  for (const rel of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert(/dsh plugin/.test(text), `${rel} 里没有 dsh plugin 安装命令`)
  }
  return '两份都给了安装命令'
})

check('两份 README 都嵌了卡片主图', () => {
  // The image must be an ABSOLUTE url: npm renders the README from the tarball, and
  // a relative `docs/assets/...` path resolves to nothing there. GitHub accepts both,
  // so the absolute form is the only one that works on both surfaces.
  for (const rel of ['README.md', 'README.en.md']) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    assert(
      /!\[.*\]\(https:\/\/raw\.githubusercontent\.com\/[^)]*dsh-connect-miaoshou[^)]*\.png\)/.test(text),
      `${rel} 没有嵌入绝对 URL 的主图（相对路径在 npm 页面上是坏图）`,
    )
  }
  return '两份都嵌了绝对 URL'
})

// --- 6. submission -----------------------------------------------------------
warnCheck('投稿 YAML 通过规则校验', () => {
  const script = join(ROOT, 'scripts', 'validate-submission.mjs')
  assert(existsSync(script), '缺少 scripts/validate-submission.mjs')
  const out = execFileSync(process.execPath, [script], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
  const summary = out.trim().split('\n').filter(Boolean).pop() ?? ''
  return summary.replace(/^=+\s*/, '')
})

check('投稿 YAML 文件名是 <owner>__<repo>.yml', () => {
  const dir = join(ROOT, 'awesome-dsh-plugin-submission')
  assert(existsSync(dir), '缺少 awesome-dsh-plugin-submission/ 目录')
  const files = readdirSync(dir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
  assert(files.length === 1, `应只有 1 个 yml，实际 ${files.length} 个`)
  assert(files[0] === 'Wahwayhale__dsh-connect-miaoshou.yml',
    `文件名是 ${files[0]}，市场要求 <owner>__<repo>.yml（双下划线）`)
  return files[0]
})

// --- report ------------------------------------------------------------------
const failed = results.filter(r => r.level === 'FAIL')
const warned = results.filter(r => r.level === 'WARN')
const width = Math.max(...results.map(r => r.name.length))

console.log('='.repeat(Math.min(width + 34, 110)))
console.log(`发布前检查 · ${REPO_SLUG}@${pkg.version}`)
console.log('='.repeat(Math.min(width + 34, 110)))
for (const r of results) {
  console.log(`${r.level.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`)
}
console.log('-'.repeat(Math.min(width + 34, 110)))
console.log(`${results.length - failed.length - warned.length} PASS / ${warned.length} WARN / ${failed.length} FAIL`)

if (failed.length === 0) {
  console.log('\nREADY TO SUBMIT')
  if (warned.length > 0) {
    console.log(`注意：${warned.length} 项 WARN 不阻塞提交，但会影响市场卡片观感：`)
    for (const w of warned) console.log(`  - ${w.name}: ${w.detail}`)
  }
  console.log('下一步见 RELEASE-CHECKLIST.md。')
} else {
  console.log(`\nNOT READY —— ${failed.length} 项未通过：`)
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
  process.exitCode = 1
}
