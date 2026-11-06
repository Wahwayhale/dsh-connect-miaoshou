/**
 * 妙手网关的只读客户端：模型目录、积分余额、账号信息。
 *
 * 这里有一个容易踩的坑：妙手有**两个**网关域，认**不同**的头。
 *
 *  - `catx.nocode.cn` —— Spring 网关。认 `X-Auth-Token: <raw>`。提供模型目录
 *    （`/api/gateway/v1/model/providers`）、积分（`/api/gateway/credit/balance`）、
 *    账号（`/api/gateway/auth/current-user`）。本插件读的所有东西都在这儿。
 *  - `nocode.cn` —— 对话后端。认 `access-token` + `client-id`（SSE 还要
 *    `X-Passport-Token`）。它**不认** `X-Auth-Token`，也没有目录/积分接口。
 *
 * 两个域的令牌是同一个（`auth.json` 里的 passport accessToken），但头名不同，
 * 且都**不带** `Bearer ` 前缀 —— 带上反而 401（实测 `X-Auth-Token: Bearer …`
 * 返回 4011 Authentication failed）。
 *
 * @module dsh-connect-miaoshou/gateway
 */
import { loadMiaoshouCredentials, type MiaoshouCredentialResult } from './miaoshou-auth.ts'
import {
  MIAOSHOU_MODELS,
  catalogFromMaasModels,
  type MiaoshouModelInfo,
} from './miaoshou-catalog.ts'

/** 只读网关的默认 base。 */
export const MIAOSHOU_GATEWAY_BASE_URL = 'https://catx.nocode.cn'

/**
 * 妙手 App 的模型目录服务。
 *
 * 这是**第三个**域：认 `X-Passport-Token: <raw>`（不是 `X-Auth-Token`）。
 * 注意它是 **POST**，body 必填 `tenant` 与 `scene`（GET 会 405，缺字段会
 * `1005010001 "scene 不能为空; tenant 不能为空"`）。
 *
 * 返回 App 模型选择器里真正展示的那 12 条，且带 `extendedInfo.rateMultiplier`
 * （积分倍率）、`extendedInfo.marketingCopy`（"限时免费"）、准确的上下文档位，
 * 以及 `thinking` / `effort` 参数能力 —— 这些字段在 `/api/agent/models?mode=CATX_APP`
 * 上**没有**。
 */
export const MIAOSHOU_APP_MODELS_URL = 'https://catpaw-agent.meituan.com/api/agent/maas/model-types'

/** `maas/model-types` 的固定 body（App 用的就是这三个值）。 */
const APP_MODELS_BODY = { tenant: 'CatDesk', scene: 'CATX_APP', env: 'EXTERNAL' } as const

/** 目录缓存时长：模型目录变化很慢，但新上线的模型要能较快出现。 */
export const CATALOG_TTL_MS = 10 * 60 * 1000

/** 积分缓存时长：余额变化不频繁，而卡片会被反复渲染。 */
export const QUOTA_TTL_MS = 60 * 1000

/** 单次网关请求超时。 */
const REQUEST_TIMEOUT_MS = 20_000

/** 网关统一信封：`{code, message, data}`，`code === 0` 为成功。 */
interface GatewayEnvelope<T> {
  code?: number
  message?: string
  data?: T
  unifyCode?: number
  msg?: string
}

/** 一次网关读取的失败形态。 */
export interface GatewayFailure {
  kind: 'auth' | 'network' | 'upstream'
  reason: string
}

/** 账号信息（`/api/gateway/auth/current-user`）。 */
export interface MiaoshouAccount {
  userId: string
  name: string
  mobile?: string
  authType?: string
}

/** 套餐信息（`credit/balance` 里的 `userPlan`）。 */
export interface MiaoshouPlan {
  planId: string
  planName: string
  pro: boolean
  status: string
  autoRenew: boolean
  startTime: number | null
  expireTime: number | null
  nextRefreshTime: number | null
}

/** 积分余额。 */
export interface MiaoshouQuota {
  /** 服务端给的可用积分，保留原始字符串以免丢精度。 */
  availableCredits: string
  /** 数值视图，卡片画进度条用。 */
  availableCreditsNumber: number
  plan?: MiaoshouPlan
  /** 读取时间。 */
  fetchedAt: number
  /** 读不到时的原因。 */
  error?: string
}

/** 组合的只读快照，供卡片一次取全。 */
export interface MiaoshouSnapshot {
  account?: MiaoshouAccount
  quota?: MiaoshouQuota
  catalog: readonly MiaoshouModelInfo[]
  catalogSource: 'gateway' | 'builtin'
  fetchedAt: number
  errors: string[]
}

/** 带令牌指纹的缓存条目，换账号不串。 */
interface CacheEntry<T> {
  key: string
  value: T
  at: number
}

/** 令牌指纹，用于让缓存跟随登录态。 */
function fingerprint(token: string): string {
  return `${token.length}:${token.slice(0, 8)}:${token.slice(-6)}`
}

/** 按头调用网关。 */
async function gatewayFetch<T>(
  path: string,
  token: string,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<{ ok: true; data: T } | { ok: false; failure: GatewayFailure }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: {
        // 关键：raw 令牌，不带 Bearer。
        'X-Auth-Token': token,
        accept: 'application/json',
      },
      signal: combined,
    })
  } catch (error: unknown) {
    return { ok: false, failure: { kind: 'network', reason: (error as Error)?.message ?? 'network error' } }
  }
  const text = await response.text().catch(() => '')
  if (response.status === 401 || response.status === 403) {
    return { ok: false, failure: { kind: 'auth', reason: `HTTP ${response.status}` } }
  }
  if (!response.ok) {
    return { ok: false, failure: { kind: 'upstream', reason: `HTTP ${response.status}: ${text.slice(0, 200)}` } }
  }
  let envelope: GatewayEnvelope<T>
  try {
    envelope = JSON.parse(text) as GatewayEnvelope<T>
  } catch {
    return { ok: false, failure: { kind: 'upstream', reason: `non-JSON response: ${text.slice(0, 200)}` } }
  }
  // `code === 0` 是成功；有些接口用 `unifyCode === 0`。
  const code = envelope.code ?? envelope.unifyCode
  if (code !== undefined && code !== 0) {
    return {
      ok: false,
      failure: {
        kind: code === 401 || code === 4010 || code === 4011 ? 'auth' : 'upstream',
        reason: envelope.message ?? envelope.msg ?? `gateway code ${code}`,
      },
    }
  }
  return { ok: true, data: envelope.data as T }
}

/** 目录缓存。 */
let catalogCache: CacheEntry<readonly MiaoshouModelInfo[]> | undefined
/** 目录来源。 */
let catalogSource: 'gateway' | 'builtin' = 'builtin'
/** 积分缓存。 */
let quotaCache: CacheEntry<MiaoshouQuota> | undefined
/** 账号缓存。 */
let accountCache: CacheEntry<MiaoshouAccount> | undefined

/** 清空所有缓存（凭据变化后调用）。 */
export function invalidateGatewayCaches(): void {
  catalogCache = undefined
  quotaCache = undefined
  accountCache = undefined
  catalogSource = 'builtin'
}

/**
 * 读模型目录。
 *
 * **唯一口径是妙手 App 的模型选择器**：用户抱怨过一次「你这里获取到的模型和
 * 我在应用里的不一样」，所以目录严格等于
 * `catpaw-agent.meituan.com/api/agent/models?mode=CATX_APP` 返回的那 12 条，
 * 不做任何追加 —— 网关那套 slug 名（`glm-5.1`、`kimi-k2.6` …）App 里根本没有，
 * 混进来又会造成同样的错位。
 *
 * 静态表就是这 12 条的固化版本，所以 App 目录读不到时用户看到的仍是同一套名字。
 */
export async function fetchMiaoshouCatalog(
  options: { signal?: AbortSignal; force?: boolean } = {},
): Promise<{ models: readonly MiaoshouModelInfo[]; source: 'gateway' | 'builtin'; error?: string }> {
  const credentials = loadMiaoshouCredentials()
  if (!credentials.ok) {
    return { models: MIAOSHOU_MODELS, source: 'builtin', error: credentials.reason }
  }
  const key = fingerprint(credentials.token)
  const cached = catalogCache
  if (cached !== undefined && cached.key === key && !options.force && Date.now() - cached.at < CATALOG_TTL_MS) {
    return { models: cached.value, source: catalogSource }
  }

  const app = await fetchMiaoshouAppModels(options.signal === undefined ? {} : { signal: options.signal })
  if (app.models.length === 0) {
    // App 目录读不到：退回静态表（内容与 App 一致），别拿网关那套 slug 顶替。
    return { models: MIAOSHOU_MODELS, source: 'builtin', ...(app.error === undefined ? {} : { error: app.error }) }
  }
  const models = app.models
  catalogCache = { key, value: models, at: Date.now() }
  catalogSource = 'gateway'
  return { models, source: 'gateway' }
}

/** 读积分余额。读不到时返回一个带 `error` 的对象而不是抛。 */
export async function fetchMiaoshouQuota(
  options: { baseUrl?: string; signal?: AbortSignal; force?: boolean } = {},
): Promise<MiaoshouQuota | undefined> {
  const credentials = loadMiaoshouCredentials()
  if (!credentials.ok) return undefined
  const baseUrl = options.baseUrl ?? MIAOSHOU_GATEWAY_BASE_URL
  const key = fingerprint(credentials.token)
  const cached = quotaCache
  if (cached !== undefined && cached.key === key && !options.force && Date.now() - cached.at < QUOTA_TTL_MS) {
    return cached.value
  }

  interface RawBalance {
    availableCredits?: string | number
    userPlan?: {
      planId?: string
      planName?: string
      pro?: boolean
      status?: string
      autoRenew?: boolean
      startTime?: number | null
      expireTime?: number | null
      nextRefreshTime?: number | null
    }
  }
  const result = await gatewayFetch<RawBalance>('/api/gateway/credit/balance', credentials.token, baseUrl, options.signal)
  if (!result.ok) {
    const failure = result.failure
    const value: MiaoshouQuota = {
      availableCredits: '0',
      availableCreditsNumber: 0,
      fetchedAt: Date.now(),
      error: `${failure.kind}: ${failure.reason}`,
    }
    return value
  }
  const raw = result.data
  const creditsRaw = raw.availableCredits ?? '0'
  const creditsText = typeof creditsRaw === 'number' ? creditsRaw.toFixed(2) : String(creditsRaw)
  const numeric = Number.parseFloat(creditsText)
  const plan = raw.userPlan === undefined ? undefined : {
    planId: raw.userPlan.planId ?? '',
    planName: raw.userPlan.planName ?? '',
    pro: raw.userPlan.pro === true,
    status: raw.userPlan.status ?? '',
    autoRenew: raw.userPlan.autoRenew === true,
    startTime: raw.userPlan.startTime ?? null,
    expireTime: raw.userPlan.expireTime ?? null,
    nextRefreshTime: raw.userPlan.nextRefreshTime ?? null,
  }
  const value: MiaoshouQuota = {
    availableCredits: creditsText,
    availableCreditsNumber: Number.isFinite(numeric) ? numeric : 0,
    fetchedAt: Date.now(),
    ...(plan === undefined ? {} : { plan }),
  }
  quotaCache = { key, value, at: Date.now() }
  return value
}

/** 读账号信息。 */
export async function fetchMiaoshouAccount(
  options: { baseUrl?: string; signal?: AbortSignal; force?: boolean } = {},
): Promise<MiaoshouAccount | undefined> {
  const credentials = loadMiaoshouCredentials()
  if (!credentials.ok) return undefined
  const baseUrl = options.baseUrl ?? MIAOSHOU_GATEWAY_BASE_URL
  const key = fingerprint(credentials.token)
  const cached = accountCache
  if (cached !== undefined && cached.key === key && !options.force && Date.now() - cached.at < CATALOG_TTL_MS) {
    return cached.value
  }
  const result = await gatewayFetch<Partial<MiaoshouAccount>>(
    '/api/gateway/auth/current-user',
    credentials.token,
    baseUrl,
    options.signal,
  )
  if (!result.ok) return undefined
  const value: MiaoshouAccount = {
    userId: result.data.userId ?? credentials.uid,
    name: result.data.name ?? credentials.loginName,
    ...(result.data.mobile === undefined ? {} : { mobile: result.data.mobile }),
    ...(result.data.authType === undefined ? {} : { authType: result.data.authType }),
  }
  accountCache = { key, value, at: Date.now() }
  return value
}

/**
 * 读妙手 App 的模型目录（`POST /api/agent/maas/model-types`）。
 *
 * 与网关目录的区别：这里返回的 `description` 就是 App 里显示的展示名
 * （`DeepSeek-V4.1-Flash`、`GLM-5.3-FlashX` …），并且带倍率与营销文案。
 * 调用名要按厂商口径转换（见 `canonicalModelId`）。
 *
 * 头用 `X-Passport-Token`：该域不认 `X-Auth-Token`，也不认 `access-token`
 * （带那两个会 302 到 SSO）。
 */
export async function fetchMiaoshouAppModels(
  options: { signal?: AbortSignal } = {},
): Promise<{ models: MiaoshouModelInfo[]; error?: string }> {
  const credentials = loadMiaoshouCredentials()
  if (!credentials.ok) return { models: [], error: credentials.reason }
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout])
  let response: Response
  try {
    response = await fetch(MIAOSHOU_APP_MODELS_URL, {
      method: 'POST',
      headers: {
        'X-Passport-Token': credentials.token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(APP_MODELS_BODY),
      signal: combined,
      redirect: 'manual',
    })
  } catch (error: unknown) {
    return { models: [], error: (error as Error)?.message ?? 'network error' }
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) return { models: [], error: `HTTP ${response.status}` }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { models: [], error: 'non-JSON response' }
  }
  const envelope = payload as { code?: unknown; unifyCode?: unknown; msg?: unknown }
  if (typeof envelope.code === 'number' && envelope.code !== 0) {
    return { models: [], error: String(envelope.msg ?? `code ${envelope.code}`) }
  }
  const models = catalogFromMaasModels(payload, MIAOSHOU_MODELS)
  return models.length === 0
    ? { models: [], error: 'empty app model list' }
    : { models }
}

/** 一次取全卡片要的东西；任一失败都不影响其余。 */
export async function fetchMiaoshouSnapshot(
  options: { baseUrl?: string; signal?: AbortSignal; force?: boolean } = {},
): Promise<MiaoshouSnapshot> {
  const errors: string[] = []
  const [catalog, quota, account] = await Promise.all([
    fetchMiaoshouCatalog(options),
    fetchMiaoshouQuota(options),
    fetchMiaoshouAccount(options),
  ])
  if (catalog.error !== undefined) errors.push(`catalog: ${catalog.error}`)
  if (quota?.error !== undefined) errors.push(`quota: ${quota.error}`)
  return {
    ...(account === undefined ? {} : { account }),
    ...(quota === undefined ? {} : { quota }),
    catalog: catalog.models,
    catalogSource: catalog.source,
    fetchedAt: Date.now(),
    errors,
  }
}

/** 给诊断用的凭据摘要。 */
export function describeGatewayCredentials(): { ok: boolean; uid?: string; reason?: string } {
  const credentials: MiaoshouCredentialResult = loadMiaoshouCredentials()
  return credentials.ok
    ? { ok: true, uid: credentials.uid }
    : { ok: false, reason: credentials.reason }
}
