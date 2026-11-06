/**
 * 妙手凭据。
 *
 * 有三个来源，按优先级：
 *
 *  1. **插件自己的扫码登录**（推荐，完全不依赖妙手客户端）
 *
 *     用妙手自己的 passport 流程在浏览器里扫一次码，令牌落盘在
 *     `~/.dsh/dsh-connect-miaoshou.token.json`。流程与实测见 `miaoshou-passport.ts`。
 *
 *  2. **妙手桌面端的登录态文件**（兜底）
 *
 *       %USERPROFILE%\.meituan-catpaw\auth.json
 *
 *     形状（实测 2026-11-05）：
 *
 *       {
 *         "auth": { "loginType": "passport", "accessToken": "AgFPI7A2…", "tokenType": "Bearer" },
 *         "account": { "uid": "9054412766", "loginName": "Uir995901730", "name": "Uir995901730", "entId": "" },
 *         "scopeSuffix": "-9054412766",
 *         "updatedAt": 1793859177597
 *       }
 *
 *  3. **`ep` CLI（EPassport CLI）** —— 只对企业版有意义。
 *
 *     实测：`ep` 是美团**商家**账号体系（`epassport.meituan.com/portal/login` 是商家
 *     中心扫码页），与 CatPaw 账号不是同一套；妙手 App 里只有一份
 *     `skills/epassport-login-cli` 说明，不含任何登录协议实现。个人版请用第 1 条。
 *
 * 两个关键点，都是实测出来的，不是推断：
 *
 *  1. `accessToken` 要**原样**发出去，不能加 `Bearer ` 前缀。妙手的对话链路
 *     （nocode.cn）读 `access-token` 头，网关（catx.nocode.cn）读 `X-Auth-Token`
 *     头，两者都不接受带前缀的值。
 *  2. 令牌会随 App 使用被刷新，所以每次调用都按 mtime 重新读，而不是启动时
 *     缓存一份到进程结束。
 *
 * 插件从不写入 auth.json，也不打印令牌；日志里只出现账号 uid 与令牌长度。
 *
 * @module dsh-connect-miaoshou/auth
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { clearSavedPassportToken, loadSavedPassportToken, savePassportToken } from './miaoshou-passport.ts'

/** 凭据来源。 */
export type MiaoshouCredentialSource = 'passport' | 'app' | 'ep'

/** 妙手用户数据目录（app 的 dataFolderName 是 `.meituan-catpaw`）。 */
export function miaoshouHome(): string {
  return process.env.MIAOSHOU_HOME?.trim() || join(homedir(), '.meituan-catpaw')
}

/** auth.json 的绝对路径。 */
export function authFilePath(): string {
  return join(miaoshouHome(), 'auth.json')
}

/** 一份解析出来的凭据。 */
export interface MiaoshouCredentials {
  ok: true
  /** 原样令牌（不带 Bearer 前缀）。 */
  token: string
  /** 账号 uid，用于诊断与看板（ep 令牌没有 uid，此时为空串）。 */
  uid: string
  /** 登录名（妙手里通常与 name 相同）。 */
  loginName: string
  /** 企业 id，个人版为空串。 */
  enterpriseId: string
  /** 令牌落盘时间（毫秒）。 */
  updatedAt: number | undefined
  /** 这份令牌来自哪里。 */
  source: MiaoshouCredentialSource
}

/** 凭据不可用的原因。 */
export interface MiaoshouCredentialsFailure {
  ok: false
  /** 面向用户的一句话原因。 */
  reason: string
  /** 机器可读的分类。 */
  kind: 'missing_file' | 'unreadable' | 'no_token' | 'logged_out' | 'no_ep'
}

export type MiaoshouCredentialResult = MiaoshouCredentials | MiaoshouCredentialsFailure

/** 令牌缓存（按 mtime + size 失效，避免每个请求都解析 JSON）。 */
let cached: { key: string; value: MiaoshouCredentialResult } | undefined

/**
 * `ep token get` 拿到的令牌（由 `miaoshou-ep.ts` 的后台刷新填进来）。
 *
 * 之所以用「覆盖层」而不是改成本模块异步：调用方（shim / gateway / 看板）全都是
 * 同步读凭据的热路径，改成 async 会把整条链都拖成 Promise。ep 令牌本来就有 60 秒
 * 缓存，后台定时刷新一次足够新。
 */
let epOverlay: { token: string; at: number } | undefined

/** 扫码登录拿到的令牌（写盘 + 内存各一份，内存这份让同步读取立刻生效）。 */
let passportOverlay: { token: string; at: number; uid: string; name: string } | undefined

/** 记录/清除 ep 令牌。传 `undefined` 表示 ep 不可用，回落到 auth.json。 */
export function setEpToken(token: string | undefined): void {
  epOverlay = token === undefined || token === '' ? undefined : { token, at: Date.now() }
  cached = undefined
}

/** 当前是否有 ep 令牌可用。 */
export function hasEpToken(): boolean {
  return epOverlay !== undefined
}

/** ep 令牌落盘时间（毫秒），没有则 undefined。 */
export function epTokenAt(): number | undefined {
  return epOverlay?.at
}

/**
 * 记录一次扫码登录拿到的令牌：立刻生效，并写盘供下次启动使用。
 *
 * 传 `undefined` 表示登出：清内存覆盖层并删掉落盘文件。
 */
export function setPassportToken(
  token: string | undefined,
  profile?: { uid?: string; name?: string },
): void {
  if (token === undefined || token === '') {
    passportOverlay = undefined
    clearSavedPassportToken()
    cached = undefined
    return
  }
  passportOverlay = {
    token,
    at: Date.now(),
    uid: profile?.uid ?? '',
    name: profile?.name ?? '',
  }
  savePassportToken(token, {
    uid: profile?.uid ?? '',
    name: profile?.name ?? '',
    mobile: '',
    authType: 'PASSPORT',
  })
  cached = undefined
}

/** 当前是否有扫码登录令牌可用（内存或磁盘）。 */
export function hasPassportToken(): boolean {
  return passportOverlay !== undefined || loadSavedPassportToken() !== undefined
}

/** 扫码登录令牌的落盘时间（毫秒），没有则 undefined。 */
export function passportTokenAt(): number | undefined {
  if (passportOverlay !== undefined) return passportOverlay.at
  return loadSavedPassportToken()?.savedAt
}

/** 丢掉缓存；App 重新登录 / ep 重新登录后调用一次即可立刻生效。 */
export function invalidateCredentialCache(): void {
  cached = undefined
}

/**
 * 读取当前凭据。
 *
 * 永不抛：所有失败都折叠成一个带 `reason` 的失败对象，让 shim 能把它变成
 * 一个 401 的 OpenAI 错误，而不是一个未捕获异常。
 *
 * 有 ep 令牌时优先用它；否则读妙手桌面端的 auth.json。
 */
export function loadMiaoshouCredentials(path: string = authFilePath()): MiaoshouCredentialResult {
  // 1) 扫码登录的令牌：内存里有就用内存，否则读落盘的那份。
  if (passportOverlay !== undefined) {
    return {
      ok: true,
      token: passportOverlay.token,
      uid: passportOverlay.uid,
      loginName: passportOverlay.name,
      enterpriseId: '',
      updatedAt: passportOverlay.at,
      source: 'passport',
    }
  }
  const saved = loadSavedPassportToken()
  if (saved !== undefined) {
    return {
      ok: true,
      token: saved.token,
      uid: saved.uid,
      loginName: saved.name,
      enterpriseId: '',
      updatedAt: saved.savedAt,
      source: 'passport',
    }
  }

  // 2) ep（企业版）。
  if (epOverlay !== undefined) {
    return {
      ok: true,
      token: epOverlay.token,
      uid: '',
      loginName: '',
      enterpriseId: '',
      updatedAt: epOverlay.at,
      source: 'ep',
    }
  }

  let key: string
  try {
    const stat = statSync(path)
    key = `${path}|${stat.mtimeMs}|${stat.size}`
  } catch (error: unknown) {
    cached = undefined
    const code = (error as NodeJS.ErrnoException)?.code
    return {
      ok: false,
      kind: code === 'ENOENT' ? 'missing_file' : 'unreadable',
      reason: code === 'ENOENT'
        ? `找不到妙手登录文件：${path}。请在设置卡里点「扫码登录」，或先启动并登录妙手桌面端。`
        : `读不到妙手登录文件（${code ?? 'unknown'}）：${path}`,
    }
  }
  if (cached !== undefined && cached.key === key) return cached.value

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch (error: unknown) {
    const value: MiaoshouCredentialResult = {
      ok: false,
      kind: 'unreadable',
      reason: `妙手登录文件无法解析（${(error as Error)?.message ?? 'invalid json'}）`,
    }
    cached = { key, value }
    return value
  }

  const auth = (parsed as { auth?: { accessToken?: unknown; loginType?: unknown } } | undefined)?.auth
  const account = (parsed as { account?: { uid?: unknown; loginName?: unknown; name?: unknown; entId?: unknown } } | undefined)?.account
  const token = typeof auth?.accessToken === 'string' ? auth.accessToken.trim() : ''
  if (token === '') {
    const value: MiaoshouCredentialResult = {
      ok: false,
      kind: 'logged_out',
      reason: '妙手登录文件里没有 accessToken。请在妙手桌面端重新登录。',
    }
    cached = { key, value }
    return value
  }
  // 令牌不该带前缀；万一上游写进去了，剥掉再用（两种形状都实测过）。
  const bare = token.replace(/^Bearer\s+/i, '').trim()
  const value: MiaoshouCredentials = {
    ok: true,
    token: bare,
    uid: typeof account?.uid === 'string' ? account.uid : '',
    loginName: typeof account?.loginName === 'string'
      ? account.loginName
      : (typeof account?.name === 'string' ? account.name : ''),
    enterpriseId: typeof account?.entId === 'string' ? account.entId : '',
    updatedAt: typeof (parsed as { updatedAt?: unknown }).updatedAt === 'number'
      ? (parsed as { updatedAt: number }).updatedAt
      : undefined,
    source: 'app',
  }
  cached = { key, value }
  return value
}

/** 是否已登录（不抛）。 */
export function isMiaoshouLoggedIn(): boolean {
  return loadMiaoshouCredentials().ok
}

/**
 * 一条永不泄露令牌的日志摘要。
 *
 * 只报来源、长度与账号 uid —— 排查「是不是没登录 / 令牌换了」够用，且复制日志也带不走凭据。
 */
export function describeCredentials(result: MiaoshouCredentialResult = loadMiaoshouCredentials()): string {
  if (!result.ok) return `未登录（${result.kind}）：${result.reason}`
  const who = result.uid === '' ? `(${result.source})` : result.uid
  return `已登录 via=${result.source} uid=${who} tokenLength=${result.token.length}`
}
