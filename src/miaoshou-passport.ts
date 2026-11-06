/**
 * 妙手（CatPaw）passport 直登。
 *
 * 为什么有这条路：妙手的令牌只写在客户端自己的 `auth.json` 里，而且**没有任何
 * 可调用的续期端点**（`/api/gateway/auth/{refresh,token,validate}` 全是 404）。
 * 只要客户端不常驻登录，插件就拿不到令牌。
 *
 * 官方 CLI `ep` 不是答案 —— 它是美团**商家**账号体系（`epassport.meituan.com/portal/login`
 * 是商家中心扫码页，`ep login auth-link` 给出的是「经营宝」下载页），与 CatPaw 账号
 * 不是同一套。实测两轮 180 秒等待后 `ep account --json` 始终 `not_logged_in`。
 *
 * 真正的答案在妙手自己的 `CatxPassportLoginProvider`（`app.asar` 里
 * `dist-electron/catpawEnv-*.js`）。它做三件事，全部实测可复现：
 *
 *  1. `GET {gateway}/api/gateway/passport/login-config`
 *     → `{data:{loginEntryUrl:"https://catpaw.meituan.com/api/gateway/passport/login-entry"}}`
 *     **不需要任何鉴权头**。
 *  2. `GET {loginEntryUrl}?state=<hex>&redirect=<urlencoded>&sid=<hex>`
 *     → 200，21017 字节 HTML，就是妙手的扫码登录页（绿底「一句话，见成果」）。
 *  3. `GET {gateway}/api/gateway/passport/poll-token?sid=<sid>`
 *     → 用户在浏览器授权后，`data` 直接就是那枚 152 字符令牌。
 *
 * 实测拿到的令牌与客户端 `auth.json` 里的 `auth.accessToken` **逐字节相同**，四套
 * 鉴权头（`X-Auth-Token` / `X-Passport-Token` / `access-token`+`client-id` / SSE）全通。
 *
 * 所以插件可以完全不依赖妙手客户端：让用户在浏览器里扫一次码即可。
 *
 * `redirect` 只用来让浏览器有个落点；真正拿令牌的是 `poll-token`，因此这里传
 * `http://127.0.0.1:0/callback` 即可（服务端不校验端口），插件不需要监听端口。
 *
 * passport 令牌**没有 refresh_token**（客户端 `capabilities.canRefresh === false`，
 * 它的 `refreshToken()` 直接返回 `'failed'`），所以过期只能重新扫码。为了不必每次
 * 重启都重扫，令牌落盘在 `~/.dsh/dsh-connect-miaoshou.token.json`（0600）。
 *
 * @module dsh-connect-miaoshou/passport
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** 取 login-config 的网关（与 credit/balance、current-user 同一个域）。 */
export const MIAOSHOU_PASSPORT_GATEWAY = 'https://catx.nocode.cn'

/** login-config 路径。 */
export const MIAOSHOU_PASSPORT_CONFIG_PATH = '/api/gateway/passport/login-config'

/** 换令牌的轮询路径（`?sid=`）。 */
export const MIAOSHOU_PASSPORT_POLL_PATH = '/api/gateway/passport/poll-token'

/** 用令牌换当前账号信息，同时也能当「令牌还有效吗」的探针。 */
export const MIAOSHOU_PASSPORT_USER_PATH = '/api/gateway/auth/current-user'

/** 轮询间隔（客户端是 1 秒）。 */
const POLL_INTERVAL_MS = 1_000

/** 一次登录的有效等待窗口（客户端是 300 秒）。 */
export const MIAOSHOU_PASSPORT_LOGIN_TIMEOUT_MS = 300_000

/** 单次 HTTP 超时。 */
const REQUEST_TIMEOUT_MS = 15_000

/** 浏览器落点；服务端不校验端口，所以端口 0 足够。 */
const REDIRECT_URI = 'http://127.0.0.1:0/callback'

/** 令牌落盘路径。 */
export function passportTokenFilePath(): string {
  return join(homedir(), '.dsh', 'dsh-connect-miaoshou.token.json')
}

/** 落盘形状。 */
interface StoredPassportToken {
  token: string
  savedAt: number
  uid: string
  name: string
}

/** 账号信息（从 current-user 拿到）。 */
export interface MiaoshouPassportProfile {
  uid: string
  name: string
  mobile: string
  authType: string
}

/** 一次登录会话的公开状态。 */
export interface MiaoshouPassportSession {
  /** 给用户在浏览器打开的地址。 */
  link: string
  /** 服务端据此认出这次登录。 */
  sid: string
  /** 防 CSRF 的随机值（回调里会带回来）。 */
  state: string
  /** 会话开始时间（毫秒）。 */
  startedAt: number
  /** 剩余等待毫秒。 */
  remainingMs: number
  /** 拿到令牌后这里会变成 true。 */
  completed: boolean
}

/** 取 login-config，失败返回 undefined。 */
async function fetchLoginEntryUrl(signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(`${MIAOSHOU_PASSPORT_GATEWAY}${MIAOSHOU_PASSPORT_CONFIG_PATH}`, {
      method: 'GET',
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = await response.json() as { data?: { loginEntryUrl?: unknown } }
    const url = body?.data?.loginEntryUrl
    return typeof url === 'string' && url !== '' ? url : undefined
  } catch {
    return undefined
  }
}

/** 轮询一次：拿到令牌就返回它。 */
async function pollOnce(sid: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const response = await fetch(
      `${MIAOSHOU_PASSPORT_GATEWAY}${MIAOSHOU_PASSPORT_POLL_PATH}?sid=${encodeURIComponent(sid)}`,
      { method: 'GET', redirect: 'manual', signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    )
    if (!response.ok) return undefined
    const body = await response.json() as { data?: unknown }
    const token = body?.data
    return typeof token === 'string' && token !== '' ? token : undefined
  } catch {
    return undefined
  }
}

/** 用令牌查账号；401 说明令牌失效。 */
export async function fetchPassportProfile(
  token: string,
  signal?: AbortSignal,
): Promise<{ ok: true; profile: MiaoshouPassportProfile } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`${MIAOSHOU_PASSPORT_GATEWAY}${MIAOSHOU_PASSPORT_USER_PATH}`, {
      method: 'GET',
      headers: { 'X-Auth-Token': token, accept: 'application/json' },
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 401) return { ok: false, reason: '令牌已失效，请重新登录' }
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
    const body = await response.json() as { data?: { userId?: unknown; name?: unknown; mobile?: unknown; authType?: unknown } }
    const data = body?.data
    return {
      ok: true,
      profile: {
        uid: typeof data?.userId === 'string' ? data.userId : '',
        name: typeof data?.name === 'string' ? data.name : '',
        mobile: typeof data?.mobile === 'string' ? data.mobile : '',
        authType: typeof data?.authType === 'string' ? data.authType : '',
      },
    }
  } catch (error: unknown) {
    return { ok: false, reason: (error as Error)?.message ?? 'network error' }
  }
}

/** 当前进行中的登录会话（同一时刻只允许一个）。 */
let active:
  | {
    session: MiaoshouPassportSession
    controller: AbortController
    done: Promise<boolean>
  }
  | undefined

/** 正在等授权的会话（给卡片显示进度用），没有则 undefined。 */
export function currentPassportSession(): MiaoshouPassportSession | undefined {
  if (active === undefined) return undefined
  const elapsed = Date.now() - active.session.startedAt
  return {
    ...active.session,
    remainingMs: Math.max(0, MIAOSHOU_PASSPORT_LOGIN_TIMEOUT_MS - elapsed),
    completed: active.session.completed,
  }
}

/** 取消进行中的登录（例如用户关掉了卡片）。 */
export function cancelPassportLogin(): boolean {
  if (active === undefined) return false
  active.controller.abort()
  active = undefined
  return true
}

/**
 * 发起一次扫码登录。
 *
 * 返回后立刻可以在浏览器打开 `link`；令牌在后台轮询，拿到后通过 `onToken` 交给
 * 调用方（调用方负责落盘与刷新缓存）。
 *
 * 返回 `undefined` 表示连 login-config 都取不到（网络/网关不可用）。
 */
export async function startPassportLogin(
  onToken: (token: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<MiaoshouPassportSession | undefined> {
  cancelPassportLogin()

  const loginEntryUrl = await fetchLoginEntryUrl(signal)
  if (loginEntryUrl === undefined) return undefined

  const sid = randomBytes(16).toString('hex')
  const state = randomBytes(16).toString('hex')
  const link = `${loginEntryUrl}?state=${state}&redirect=${encodeURIComponent(REDIRECT_URI)}&sid=${sid}`

  const controller = new AbortController()
  const session: MiaoshouPassportSession = {
    link,
    sid,
    state,
    startedAt: Date.now(),
    remainingMs: MIAOSHOU_PASSPORT_LOGIN_TIMEOUT_MS,
    completed: false,
  }

  const done = (async (): Promise<boolean> => {
    const deadline = Date.now() + MIAOSHOU_PASSPORT_LOGIN_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (controller.signal.aborted) return false
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS)
        controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
      })
      if (controller.signal.aborted) return false
      const token = await pollOnce(sid, controller.signal)
      if (token === undefined) continue
      session.completed = true
      try {
        await onToken(token)
      } catch {
        // 回调失败不该吞掉令牌，调用方自己决定怎么记日志。
      }
      return true
    }
    return false
  })()

  active = { session, controller, done }
  void done.finally(() => {
    if (active !== undefined && active.session.sid === sid) active = undefined
  })

  return currentPassportSession()
}

/**
 * 等一次「立刻轮询一次」：卡片点「我已完成授权」时用。
 *
 * 正常路径是后台轮询自己拿到令牌，这里只是给用户一个不靠后台的确认手段。
 */
export async function pollPassportLoginOnce(sid?: string): Promise<boolean> {
  if (active === undefined) return false
  if (sid !== undefined && active.session.sid !== sid) return false
  if (active.session.completed) return true
  const token = await pollOnce(active.session.sid)
  if (token === undefined) return false
  active.session.completed = true
  return true
}

/** 读落盘的令牌（没有/损坏都返回 undefined，永不抛）。 */
export function loadSavedPassportToken(): StoredPassportToken | undefined {
  try {
    const parsed = JSON.parse(readFileSync(passportTokenFilePath(), 'utf8')) as Partial<StoredPassportToken>
    if (typeof parsed.token !== 'string' || parsed.token === '') return undefined
    return {
      token: parsed.token,
      savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      uid: typeof parsed.uid === 'string' ? parsed.uid : '',
      name: typeof parsed.name === 'string' ? parsed.name : '',
    }
  } catch {
    return undefined
  }
}

/** 原子写落盘（先写 `.tmp` 再 rename，0600）。 */
export function savePassportToken(token: string, profile?: MiaoshouPassportProfile): void {
  const path = passportTokenFilePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    const payload: StoredPassportToken = {
      token,
      savedAt: Date.now(),
      uid: profile?.uid ?? '',
      name: profile?.name ?? '',
    }
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows 上 chmod 只是尽力而为。
    }
  } catch {
    // 落盘失败不该影响这次登录本身。
  }
}

/** 清掉落盘的令牌（登出）。 */
export function clearSavedPassportToken(): void {
  try {
    rmSync(passportTokenFilePath(), { force: true })
  } catch {
    // 删不掉就算了。
  }
}
