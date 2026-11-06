/**
 * 浏览器卡片与宿主路由之间的契约。
 *
 * 这里的类型是 `src/miaoshou-status.ts` 实际发出的 payload 的**镜像**。之所以
 * 复制而不是 import：浏览器 bundle 绝不能把 Node 模块（node:http、凭据读取）
 * 拖进渲染层。
 *
 * 安全：这是**数字视图**。令牌、cookie、手机号永远不会穿过这条边界。
 *
 * @module dsh-connect-miaoshou/client-contract
 */

/** 积分卡片读取的路由。 */
export const MIAOSHOU_QUOTA_PATH = '/plugins/dsh-connect-miaoshou/quota'

/** 模型清单路由。 */
export const MIAOSHOU_CATALOG_PATH = '/plugins/dsh-connect-miaoshou/catalog'

/** 设置写入路由。 */
export const MIAOSHOU_SAVE_PATH = '/plugins/dsh-connect-miaoshou/__save'

/** ep 登录路由（不依赖妙手客户端登录）。 */
export const MIAOSHOU_LOGIN_PATH = '/plugins/dsh-connect-miaoshou/__login'

/** 设置字段：勾选的模型 id。 */
export const MIAOSHOU_ENABLED_MODELS_FIELD = 'enabledModelIds'

/** 设置字段：上游 base url 覆盖。 */
export const MIAOSHOU_BASE_URL_FIELD = 'baseUrl'

/** 写请求必须携带的头（非秘密，只是让请求变成非简单请求）。 */
export const MIAOSHOU_WRITE_HEADER = 'x-dsh-miaoshou-write'

/** 套餐视图。 */
export interface MiaoshouPlanView {
  name: string
  pro: boolean
  status: string
  autoRenew: boolean
  expiresAt: number | null
  nextRefreshAt: number | null
}

/** 账号视图。 */
export interface MiaoshouAccountView {
  name: string
  uid: string
}

/** 积分卡片 payload。 */
export interface MiaoshouQuotaView {
  ok: boolean
  loggedIn: boolean
  loginError: string | null
  account: MiaoshouAccountView | null
  credits: string | null
  creditsNumber: number | null
  plan: MiaoshouPlanView | null
  catalogSource: 'gateway' | 'builtin'
  catalogSize: number
  fetchedAt: number
  error: string | null
}

/** ep 登录路由的返回视图。 */
export interface MiaoshouLoginView {
  ok: boolean
  /** 当前令牌来自扫码登录、妙手客户端 auth.json，还是 ep。 */
  source: 'passport' | 'app' | 'ep' | null
  /** 当前是否已登录。 */
  loggedIn: boolean
  /** 进行中的扫码登录；没有则 null。 */
  session: {
    /** 给用户在浏览器打开的地址。 */
    link: string
    /** 剩余等待毫秒。 */
    remainingMs: number
    /** 是否已拿到令牌。 */
    completed: boolean
  } | null
  /** 令牌落盘时间（毫秒），未知则 null。 */
  tokenSavedAt: number | null
  /** 未登录 / 失败原因。 */
  error: string | null
}

/** 卡片看到的账号状态。 */
export type MiaoshouAccountState =
  | 'ok'
  | 'signed_out'
  | 'unreadable'
  | 'session_dead'
  | 'exhausted'
  | 'network'

/**
 * 把 payload 归类成一个账号状态。
 *
 * 归类只能靠宿主给的错误文本 —— 只有宿主看得见上游错误类别。文本匹配故意
 * 宽松：措辞是宿主的事，呈现是这边的事，改词必须退化成 `network` 而不是让
 * 卡片崩掉。
 */
export function classifyQuotaView(view: MiaoshouQuotaView | undefined): MiaoshouAccountState {
  if (view === undefined) return 'unreadable'
  if (view.ok) return 'ok'
  if (view.loggedIn === false) {
    const text = (view.loginError ?? '').toLowerCase()
    if (/missing|unreadable|no_token/.test(text)) return 'unreadable'
    return 'signed_out'
  }
  const text = (view.error ?? '').toLowerCase()
  if (/401|unauthor|token|login|passport|signed_out|session/i.test(text)) return 'signed_out'
  if (/credential|unreadable|parse|json/i.test(text)) return 'unreadable'
  return 'network'
}

/** 毫秒 → 「3h 12m」样式的倒计时。 */
export function formatCountdown(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—'
  const totalMinutes = Math.floor(ms / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return '<1m'
}

/** 把百分比夹到 0-100。 */
export function clampPercent(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

/** 目录项。 */
export interface MiaoshouModelEntry {
  id: string
  name: string
  vendor: string
  vendorLabel: string
  supportsImage: boolean
  reasoning: boolean
  supportsEffort: boolean
  /** 上游是否有独立的 `thinking` 开关（GLM 系列没有，只能靠 effort 控制）。 */
  thinkingOptions: boolean
  /** 上游 `effort` 参数的合法取值，如 `['low','high','max']`。 */
  efforts: string[]
  /** 上游给的默认思考等级；没有 effort 参数时为 `null`。 */
  defaultEffort: string | null
  contextOptions: number[]
  /** 积分消耗倍率（`0.59` 即 0.59×）；`null` 表示上游未提供（Auto）。 */
  rateMultiplier: number | null
  /** 倍率的展示文本（`0.59×` / `免费`）；`null` 表示没有倍率。 */
  rateLabel: string | null
  /** 营销文案，如「限时免费」。 */
  marketingCopy: string | null
}

/** 目录 payload。 */
export interface MiaoshouCatalogView {
  ok: boolean
  models: MiaoshouModelEntry[]
  source: 'gateway' | 'builtin'
  error: string | null
}

/**
 * 读出勾选的 id。
 *
 * 从未保存过的快照带 `undefined`，含义是「从没配过」而不是「一个都没勾」。
 * 那种情况下调用方用整个目录做草稿，免得首次打开看到空列表以为坏了。
 */
export function enabledModelIdsOf(configured: unknown): string[] | undefined {
  const value = (configured as { enabledModelIds?: unknown } | undefined)?.enabledModelIds
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/** 读出 base url 覆盖。 */
export function baseUrlOf(configured: unknown): string {
  const value = (configured as { baseUrl?: unknown } | undefined)?.baseUrl
  return typeof value === 'string' ? value : ''
}

/** 把 token 数格式化成 200K / 1M。 */
export function formatContext(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '—'
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`
  return `${Math.round(tokens / 1000)}K`
}
