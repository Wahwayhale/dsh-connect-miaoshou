/**
 * 妙手登录用的是官方 EPassport CLI（`ep`），妙手 App 自身并不实现登录协议 ——
 * 它把登录外包给这个 CLI（App 里只带了 `skills/epassport-login-cli` 的说明）。
 *
 * 所以「不依赖妙手客户端」的正路是：直接用 `ep` 登录一次，插件读 `ep token get`。
 *   ep login auth-link --events   → 立刻打印授权链接，用户在浏览器授权
 *   ep token get                  → 明文 accessToken（与妙手 App 写进 auth.json 的是同一个令牌）
 *   ep token validate --json      → 校验有效性
 *
 * 本模块只做三件事：找到 ep、跑 token get、跑 login 拿授权链接。全部带超时、永不抛。
 * @module dsh-connect-miaoshou/ep
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 单次 ep 调用的超时。`ep token get` 正常是秒级。 */
const EP_TIMEOUT_MS = 20_000
/** `ep login` 会在拿到授权链接后继续等待授权，所以只等它把链接吐出来。 */
const EP_LOGIN_TIMEOUT_MS = 8_000

/** 妙手 App 自带的那份 ep 安装目录。 */
function bundledEpPaths(): string[] {
  const home = homedir()
  const names = process.platform === 'win32' ? ['ep.exe', 'ep'] : ['ep']
  const roots = [join(home, 'meituan', 'epassport', 'bin')]
  return roots.flatMap((root) => names.map((name) => join(root, name)))
}

/**
 * ep 可执行文件位置。
 * 优先级：环境变量 `MIAOSHOU_EP_BIN` → 官方安装路径 → PATH 里的 `ep`。
 *
 * 注意 PATH 兜底返回的是**裸名字**：它可能存在也可能不存在，调用方要按
 * ENOENT 处理（见 `epInstalled` 与 `readEpToken` 的失败分支）。
 */
export function epBinaryPath(): string | undefined {
  const explicit = process.env.MIAOSHOU_EP_BIN?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  for (const candidate of bundledEpPaths()) {
    if (existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'ep.exe' : 'ep'
}

/** PATH 里有没有 ep（裸名字兜底时用）。 */
function inPath(): boolean {
  const path = process.env.PATH ?? ''
  const names = process.platform === 'win32' ? ['ep.exe', 'ep'] : ['ep']
  return path.split(process.platform === 'win32' ? ';' : ':').some((dir) => {
    if (dir.trim() === '') return false
    return names.some((name) => existsSync(join(dir, name)))
  })
}

/**
 * ep 在 Windows 上会把 cliguard 签名器解压到 `%TEMP%` 再 fork 执行。实测**不是每个
 * 目录都行**：同一台机器上 `C:\...` 下的 scratch 一律报
 * `fork/exec …cliguard-cli-windows-amd64.exe: The system cannot find the path specified`
 * （解压出的 exe 不见了），而 `E:\...` 下的正常。所以这里不是挑一个目录，而是
 * **按顺序试**，第一个真的拿到授权链接的胜出并记住。
 */
function scratchCandidates(): string[] {
  const explicit = process.env.MIAOSHOU_EP_SCRATCH?.trim()
  const list: string[] = []
  if (explicit !== undefined && explicit !== '') list.push(explicit)
  // 工作目录所在的盘最可能与用户的工程/DSH 在同一盘（实测可用的那种）。
  list.push(join(process.cwd(), '.miaoshou-ep'))
  list.push(join(homedir(), '.dsh', 'dsh-connect-miaoshou-ep'))
  list.push(join(tmpdir(), 'miaoshou-ep'))
  return [...new Set(list)]
}

/** 当前选中的 scratch（登录成功后固定，避免每次重新试错）。 */
let chosenScratch: string | undefined

function envForScratch(scratch: string): NodeJS.ProcessEnv {
  return { ...process.env, TMP: scratch, TEMP: scratch }
}

/**
 * 给 ep 用的环境：优先用已选中的 scratch；还没有就取第一个能建目录的候选。
 *
 * `ep token get` 不走 cliguard，所以这里不挑盘也能用；真正的试错发生在
 * `startEpLogin`。
 */
function epEnv(): NodeJS.ProcessEnv {
  const scratch = chosenScratch ?? scratchCandidates()[0] ?? tmpdir()
  try {
    mkdirSync(scratch, { recursive: true })
  } catch {
    return process.env
  }
  return envForScratch(scratch)
}

export interface EpTokenResult {
  ok: boolean
  token?: string
  /** 面向用户的一句话原因。 */
  reason?: string
}

/** 缓存：ep token get 有 ~1 秒的进程启动开销，没必要每次请求都跑。 */
let cachedToken: { token: string; at: number } | undefined
const TOKEN_CACHE_MS = 60_000

/** 丢掉缓存（用户刚登录/登出后调用）。 */
export function invalidateEpTokenCache(): void {
  cachedToken = undefined
}

/**
 * 用 `ep token get` 取明文令牌。
 * 未安装 ep、未登录、超时，都会折叠成 `{ok:false, reason}`，不抛。
 */
export async function readEpToken(options: { force?: boolean } = {}): Promise<EpTokenResult> {
  if (options.force !== true && cachedToken !== undefined && Date.now() - cachedToken.at < TOKEN_CACHE_MS) {
    return { ok: true, token: cachedToken.token }
  }
  const binary = epBinaryPath()
  if (binary === undefined) return { ok: false, reason: '找不到 ep（EPassport CLI）' }
  try {
    const { stdout } = await execFileAsync(binary, ['token', 'get'], {
      timeout: EP_TIMEOUT_MS,
      windowsHide: true,
      env: epEnv(),
      maxBuffer: 1024 * 1024,
    })
    const token = stdout.trim().replace(/^Bearer\s+/i, '')
    if (token === '') return { ok: false, reason: 'ep token get 输出为空' }
    cachedToken = { token, at: Date.now() }
    return { ok: true, token }
  } catch (error: unknown) {
    const failure = error as { code?: string | number; message?: string; stdout?: string; stderr?: string }
    const detail = `${failure.stderr ?? ''} ${failure.stdout ?? ''} ${failure.message ?? ''}`.trim()
    const reason = /未登录|not logged|login/i.test(detail)
      ? 'ep 未登录'
      : `ep token get 失败（${failure.code ?? 'unknown'}）`
    return { ok: false, reason }
  }
}

/** 校验当前 ep 令牌是否仍然有效（`ep token validate --json`）。 */
export async function validateEpToken(): Promise<{ ok: boolean; reason?: string }> {
  const binary = epBinaryPath()
  if (binary === undefined) return { ok: false, reason: '找不到 ep（EPassport CLI）' }
  try {
    const { stdout } = await execFileAsync(binary, ['token', 'validate', '--json'], {
      timeout: EP_TIMEOUT_MS,
      windowsHide: true,
      env: epEnv(),
      maxBuffer: 1024 * 1024,
    })
    const parsed = JSON.parse(stdout.trim()) as { isValid?: unknown; reason?: unknown }
    if (parsed.isValid === true) return { ok: true }
    return { ok: false, reason: typeof parsed.reason === 'string' ? parsed.reason : '令牌无效' }
  } catch (error: unknown) {
    const failure = error as { message?: string; stdout?: string }
    // 有些版本即使校验失败也以非零退出，但 stdout 里有 JSON —— 先试着解析。
    const text = failure.stdout?.trim() ?? ''
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text) as { isValid?: unknown; reason?: unknown }
        if (parsed.isValid === true) return { ok: true }
        return { ok: false, reason: typeof parsed.reason === 'string' ? parsed.reason : '令牌无效' }
      } catch {
        // 落到下面的兜底
      }
    }
    return { ok: false, reason: failure.message ?? 'ep token validate 失败' }
  }
}

/** 授权链接（`ep login auth-link --events` 的第一帧）。 */
export interface EpLoginLink {
  ok: boolean
  link?: string
  reason?: string
}

/**
 * 发起一次授权链接登录，返回给用户去浏览器打开。
 * `ep login` 拿到链接后不会立刻退出（它在等授权），所以这里只等到链接出现就收工。
 *
 * 会按 `scratchCandidates()` 顺序试：cliguard 解压在某些盘上会失败，而失败是
 * **立刻**报的（约 130ms），所以试错成本可以忽略。第一个成功的目录被记住。
 */
export async function startEpLogin(): Promise<EpLoginLink> {
  const binary = epBinaryPath()
  if (binary === undefined) return { ok: false, reason: '找不到 ep（EPassport CLI）' }
  const candidates = chosenScratch === undefined ? scratchCandidates() : [chosenScratch]
  let lastReason: string | undefined
  for (const scratch of candidates) {
    try {
      mkdirSync(scratch, { recursive: true })
    } catch {
      continue
    }
    const attempt = await loginOnce(binary, scratch)
    if (attempt.ok) {
      chosenScratch = scratch
      return attempt
    }
    lastReason = attempt.reason
    // 只在 cliguard 那一类失败时换目录重试；真正的「未登录」之类没有重试价值。
    if (!/cliguard|fork\/exec|cannot find the path/i.test(attempt.reason ?? '')) return attempt
  }
  return { ok: false, reason: lastReason ?? 'ep login 失败' }
}

/** 在指定 scratch 下跑一次 `ep login auth-link --events`。 */
async function loginOnce(binary: string, scratch: string): Promise<EpLoginLink> {
  try {
    const { stdout } = await execFileAsync(binary, ['login', 'auth-link', '--events'], {
      timeout: EP_LOGIN_TIMEOUT_MS,
      windowsHide: true,
      env: envForScratch(scratch),
      maxBuffer: 1024 * 1024,
    })
    const link = extractLink(stdout)
    return link === undefined ? { ok: false, reason: 'ep 没有返回授权链接' } : { ok: true, link }
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    // 正常情况下 ep 拿到链接后会继续等授权，于是这里是被超时打断的 —— 链接已经在 stdout 里。
    const link = extractLink(failure.stdout ?? '')
    if (link !== undefined) return { ok: true, link }
    // 把 stderr 带回去，调用方靠它判断是不是 cliguard 解压失败。
    const detail = `${failure.stderr ?? ''} ${failure.message ?? ''}`.trim()
    return { ok: false, reason: detail === '' ? 'ep login 失败' : detail }
  }
}

/** 从 `--events` 的结构化输出里取授权链接。 */
function extractLink(stdout: string): string | undefined {
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('__EP__:')) continue
    try {
      const payload = JSON.parse(trimmed.slice('__EP__:'.length)) as { type?: unknown; data?: { authLink?: unknown } }
      if (payload.type === 'auth_link' && typeof payload.data?.authLink === 'string') {
        return payload.data.authLink
      }
    } catch {
      // 忽略坏帧
    }
  }
  return undefined
}

/** 是否安装了 ep（用于卡片提示）。 */
export function epInstalled(): boolean {
  const explicit = process.env.MIAOSHOU_EP_BIN?.trim()
  if (explicit !== undefined && explicit !== '') return existsSync(explicit)
  for (const candidate of bundledEpPaths()) {
    if (existsSync(candidate)) return true
  }
  return inPath()
}
