/**
 * 给插件 UI 卡片用的只读 HTTP 视图。
 *
 * 挂在 Harness web server 上的 `/plugins/dsh-connect-miaoshou/quota`。
 *
 * 安全：这些响应是**数字视图**，绝不是凭据视图。里面只有积分、套餐名、
 * 账号显示名与模型清单 —— 没有令牌、没有 cookie、没有手机号。处理器从
 * 显式白名单构造 payload，而不是把上游返回的东西直接序列化，所以上游
 * 以后新增的字段不会顺手漏进浏览器。
 *
 * @module dsh-connect-miaoshou/status
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  fetchMiaoshouSnapshot,
  invalidateGatewayCaches,
  type MiaoshouAccount,
  type MiaoshouPlan,
  type MiaoshouQuota,
} from './miaoshou-gateway.ts'
import { MIAOSHOU_MODELS, rateLabel, type MiaoshouModelInfo } from './miaoshou-catalog.ts'
import { describeCredentials, loadMiaoshouCredentials } from './miaoshou-auth.ts'
import type { MiaoshouPassportSession } from './miaoshou-passport.ts'

/** 积分卡片路由。 */
export const MIAOSHOU_QUOTA_PATH = '/plugins/dsh-connect-miaoshou/quota'

/** 模型清单路由（设置卡里的勾选列表用）。 */
export const MIAOSHOU_CATALOG_PATH = '/plugins/dsh-connect-miaoshou/catalog'

/** 设置读写路由。 */
export const MIAOSHOU_SAVE_PATH = '/plugins/dsh-connect-miaoshou/__save'

/** ep 登录路由（不依赖妙手客户端登录）。 */
export const MIAOSHOU_LOGIN_PATH = '/plugins/dsh-connect-miaoshou/__login'

/** 本机浏览器请求允许的 host。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 浏览器带来的 Origin 必须是 loopback。 */
function loopbackOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  // 没有 Origin 是这张卡的**正常**情况：它同源取自己宿主的数据，同源请求不带
  // Origin。信任这种缺席正是下面另外两道检查存在的原因 —— 远端页面只有让
  // Host 撒谎（DNS rebinding）才能伪造成同源，而浏览器总把这种尝试标成
  // cross-site。
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** 每个写请求都必须带的头。 */
export const WRITE_HEADER = 'x-dsh-miaoshou-write'

/** Host 头必须指向 loopback。 */
function loopbackHostHeader(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || host.trim() === '') return false
  try {
    const { hostname } = new URL(`http://${host}`)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/**
 * 四条路由共用的一道闸。
 *
 * 顺序有讲究：便宜的头部检查在前，被拒的请求绝不会走到文件系统或凭据存储。
 */
function guard(req: IncomingMessage, res: ServerResponse, options: { write?: boolean } = {}): boolean {
  if (!loopbackHostHeader(req)) {
    json(res, 403, { error: 'host-not-loopback' })
    return false
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    json(res, 403, { error: 'origin-not-trusted' })
    return false
  }
  if (!loopbackOrigin(req)) {
    json(res, 403, { error: 'origin-not-trusted' })
    return false
  }
  if (options.write === true && req.headers[WRITE_HEADER] === undefined) {
    json(res, 403, { error: 'missing-write-header' })
    return false
  }
  return true
}

/** 写 JSON 响应。 */
function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 从错误里剥掉可能带密的内容；上游消息会被引用进 payload，所以截断且只留类别。 */
function safeMessage(error: unknown): string {
  const message = (error as Error)?.message ?? 'unknown error'
  return message.slice(0, 200)
}

/** 卡片看到的套餐视图。 */
export interface PlanView {
  name: string
  pro: boolean
  status: string
  autoRenew: boolean
  /** 到期时间，null 表示不限时（免费版）。 */
  expiresAt: number | null
  /** 下次刷新积分的时刻。 */
  nextRefreshAt: number | null
}

/** 卡片看到的账号视图。 */
export interface AccountView {
  /** 显示名，用于「已连接 xxx」。 */
  name: string
  /** 妙手 uid；不含手机号。 */
  uid: string
}

/** 积分卡片 payload。 */
export interface MiaoshouQuotaView {
  ok: boolean
  /** 登录态：true 表示 auth.json 里有可用令牌。 */
  loggedIn: boolean
  /** 未登录时的一句话原因。 */
  loginError: string | null
  account: AccountView | null
  /** 可用积分（字符串，保精度）。 */
  credits: string | null
  creditsNumber: number | null
  plan: PlanView | null
  /** 模型清单来源：网关（实时）还是内置（离线兜底）。 */
  catalogSource: 'gateway' | 'builtin'
  /** 目录里的模型数量。 */
  catalogSize: number
  fetchedAt: number
  error: string | null
}

/** 只取白名单字段构造套餐视图。 */
function planViewOf(plan: MiaoshouPlan | undefined): PlanView | null {
  if (plan === undefined) return null
  return {
    name: plan.planName === '' ? plan.planId : plan.planName,
    pro: plan.pro,
    status: plan.status,
    autoRenew: plan.autoRenew,
    expiresAt: plan.expireTime,
    nextRefreshAt: plan.nextRefreshTime,
  }
}

/** 只取白名单字段构造账号视图。 */
function accountViewOf(account: MiaoshouAccount | undefined): AccountView | null {
  if (account === undefined) return null
  return { name: account.name === '' ? account.userId : account.name, uid: account.userId }
}

/** 构造积分视图。 */
export async function miaoshouQuotaView(options: { force?: boolean } = {}): Promise<MiaoshouQuotaView> {
  const credentials = loadMiaoshouCredentials()
  if (!credentials.ok) {
    return {
      ok: false,
      loggedIn: false,
      loginError: credentials.reason,
      account: null,
      credits: null,
      creditsNumber: null,
      plan: null,
      catalogSource: 'builtin',
      catalogSize: MIAOSHOU_MODELS.length,
      fetchedAt: Date.now(),
      error: null,
    }
  }
  const snapshot = await fetchMiaoshouSnapshot(options.force === true ? { force: true } : {})
  const quota: MiaoshouQuota | undefined = snapshot.quota
  return {
    ok: quota?.error === undefined,
    loggedIn: true,
    loginError: null,
    account: accountViewOf(snapshot.account),
    credits: quota?.availableCredits ?? null,
    creditsNumber: quota?.availableCreditsNumber ?? null,
    plan: planViewOf(quota?.plan),
    catalogSource: snapshot.catalogSource,
    catalogSize: snapshot.catalog.length,
    fetchedAt: snapshot.fetchedAt,
    error: snapshot.errors.length === 0 ? null : snapshot.errors.join('; '),
  }
}

/** webServer 服务的最小形状。 */
export interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** 卡片勾选列表用的目录项。 */
export interface CatalogEntryView {
  id: string
  name: string
  vendor: string
  vendorLabel: string
  supportsImage: boolean
  reasoning: boolean
  /** 是否支持「思考等级」。 */
  supportsEffort: boolean
  /** 上游是否有独立的 `thinking` 开关（GLM 系列没有，只能靠 effort 控制）。 */
  thinkingOptions: boolean
  /** 上游 `effort` 参数的合法取值，如 `['low','high','max']`。 */
  efforts: string[]
  /** 上游给的默认思考等级；没有 effort 参数时为 `null`。 */
  defaultEffort: string | null
  /** 上下文档位（token 数），用于选择器副标题。 */
  contextOptions: number[]
  /** 积分消耗倍率（`0.59` 即 0.59×）；`null` 表示上游未提供（Auto）。 */
  rateMultiplier: number | null
  /** 倍率的展示文本（`0.59×` / `免费`）；`null` 表示没有倍率。 */
  rateLabel: string | null
  /** 营销文案，如「限时免费」。 */
  marketingCopy: string | null
}

/** 目录视图 payload。 */
export interface MiaoshouCatalogView {
  ok: boolean
  models: CatalogEntryView[]
  source: 'gateway' | 'builtin'
  error: string | null
}

/** 目录项 → 视图项。 */
export function catalogEntriesOf(models: readonly MiaoshouModelInfo[] = MIAOSHOU_MODELS): CatalogEntryView[] {
  return models.map(model => ({
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    vendorLabel: model.vendorLabel,
    supportsImage: model.supportsImage,
    reasoning: model.reasoning,
    supportsEffort: model.supportsEffort,
    thinkingOptions: model.thinkingOptions,
    efforts: [...model.efforts],
    defaultEffort: model.defaultEffort,
    contextOptions: [...model.contextOptions],
    rateMultiplier: model.rateMultiplier,
    rateLabel: rateLabel(model.rateMultiplier),
    marketingCopy: model.marketingCopy,
  }))
}

/** 注册积分路由。返回 disposer。 */
export function registerMiaoshouQuotaRoute(
  ctx: { webServer: WebServerLike },
  deps: { onRefresh?: () => void } = {},
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: MIAOSHOU_QUOTA_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return
      // POST 是用户主动刷新；GET 读缓存。
      const force = req.method === 'POST'
      if (force) {
        invalidateGatewayCaches()
        deps.onRefresh?.()
      }
      try {
        json(res, 200, await miaoshouQuotaView(force ? { force: true } : {}))
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
    },
  })
}

/**
 * 注册只读目录路由，给设置卡的模型勾选列表用。
 *
 * 安全姿态与积分路由一致：白名单字段、同样的 loopback 围栏、不含任何凭据。
 * POST 会清掉缓存，让卡片上的「刷新」能立刻看到服务端刚上线的模型。
 */
export function registerMiaoshouCatalogRoute(
  ctx: { webServer: WebServerLike },
  deps: {
    modelsProvider?: () => readonly MiaoshouModelInfo[]
    /** 当前目录来自网关还是静态兜底（不传则按静态表标注）。 */
    sourceProvider?: () => 'gateway' | 'builtin'
    /** 目录变化后让适配器重建快照。 */
    onCatalogChange?: (models: readonly MiaoshouModelInfo[]) => void
  } = {},
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: MIAOSHOU_CATALOG_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return
      try {
        if (req.method === 'POST') invalidateGatewayCaches()
        const models = deps.modelsProvider === undefined
          ? MIAOSHOU_MODELS
          : deps.modelsProvider()
        deps.onCatalogChange?.(models)
        const payload: MiaoshouCatalogView = {
          ok: true,
          models: catalogEntriesOf(models),
          source: deps.sourceProvider === undefined ? 'builtin' : deps.sourceProvider(),
          error: null,
        }
        json(res, 200, payload)
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
    },
  })
}

/** 只接受本插件认识的键。 */
const WRITABLE_FIELDS = new Set(['enabledModelIds', 'toolEmulation', 'baseUrl'])

/** 读并解析 JSON 请求体，有上限。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    // 与 shim 同一个量级：设置载荷只有几百字节，再大就是误用或攻击。
    if (size > 64 * 1024) throw new Error('body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/**
 * 注册设置读写路由。
 *
 * 为什么存在：卡片里的 `settingsScope.set()` 与宿主侧的 `settings.mutate` 都
 * 存不下本插件 —— 这条 host line 上 fiber 到不了 ACTIVE，宿主报
 * `No configurable plugin entry "..."` 并丢弃写入。这条路由改而写一个插件
 * 自己拥有的 JSON 文件，那也是卡片唯一能读回来的副本。
 *
 * 安全姿态与只读路由一致：只允许 loopback Origin、只允许 GET/POST、封闭的
 * 字段白名单、响应里不含凭据。
 */
export function registerMiaoshouSaveRoute(
  ctx: { webServer: WebServerLike },
  deps: {
    /** 写插件自己的设置文件。 */
    write: (field: string, value: unknown) => void
    /** 读回来，让卡片渲染磁盘上真实的值。 */
    read: () => unknown
    onApplied?: (field: string, value: unknown) => void
    /** 宿主设置注册走到哪一步；写成功时一并返回，因为它解释了这条路由为何存在。 */
    diagnostics?: () => unknown
  },
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: MIAOSHOU_SAVE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return
      // GET 是读的那一半，因为注入的 settings scope 看不到这个插件的文件：
      // 否则卡片会一直渲染默认值，不管存了什么。
      if (req.method === 'GET') {
        try {
          json(res, 200, { ok: true, value: deps.read() })
        } catch (error: unknown) {
          json(res, 500, { ok: false, error: safeMessage(error) })
        }
        return
      }
      try {
        const body = await readJsonBody(req) as { field?: unknown; value?: unknown } | undefined
        const field = body?.field
        if (typeof field !== 'string' || !WRITABLE_FIELDS.has(field)) {
          json(res, 400, { error: `field must be one of: ${[...WRITABLE_FIELDS].join(', ')}` })
          return
        }
        deps.write(field, body?.value)
        deps.onApplied?.(field, body?.value)
        json(res, 200, {
          ok: true,
          value: deps.read(),
          diagnostics: deps.diagnostics === undefined ? null : deps.diagnostics(),
        })
      } catch (error: unknown) {
        json(res, 400, { ok: false, error: safeMessage(error) })
      }
    },
  })
}

/** 凭据诊断（仅供 CLI doctor 使用，绝不进浏览器 payload）。 */
export function credentialDiagnostics(): string {
  return describeCredentials()
}

/** 登录路由返回的视图。 */
export interface MiaoshouLoginView {
  ok: boolean
  /** 当前令牌来自哪里；未登录时 null。 */
  source: 'passport' | 'app' | 'ep' | null
  /** 登录态。 */
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

/**
 * 注册登录路由：用妙手自己的 passport 扫码流程登录，从而不再依赖妙手客户端常驻。
 *
 * - `GET`  看当前登录态与进行中的会话（不触发任何动作）。
 * - `POST {"action":"start"}`  发起一次扫码登录，返回 `link` 给用户在浏览器打开。
 * - `POST {"action":"poll"}`   立刻轮询一次（用户点「我已完成授权」时用）。
 * - `POST {"action":"logout"}` 清掉落盘令牌。
 *
 * 路由只回链接与状态，**绝不回令牌**。
 */
export function registerMiaoshouLoginRoute(
  ctx: { webServer: WebServerLike },
  deps: {
    /** 发起登录；返回会话（含 link），拿不到 login-config 时返回 undefined。 */
    start: () => Promise<MiaoshouPassportSession | undefined>
    /** 当前进行中的会话。 */
    current: () => MiaoshouPassportSession | undefined
    /** 立刻轮询一次。 */
    poll: () => Promise<boolean>
    /** 登出。 */
    logout: () => void
    /** 当前令牌来源。 */
    sourceProvider?: () => 'passport' | 'app' | 'ep' | null
    /** 令牌落盘时间。 */
    tokenSavedAt?: () => number | undefined
  },
): () => void {
  return ctx.webServer.register({
    kind: 'exact',
    path: MIAOSHOU_LOGIN_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      if (!guard(req, res, { write: req.method === 'POST' })) return
      try {
        const source = deps.sourceProvider === undefined ? null : deps.sourceProvider()
        const view = (extra: Partial<MiaoshouLoginView> = {}): MiaoshouLoginView => {
          const session = deps.current()
          return {
            ok: true,
            source,
            loggedIn: source !== null,
            session: session === undefined
              ? null
              : { link: session.link, remainingMs: session.remainingMs, completed: session.completed },
            tokenSavedAt: deps.tokenSavedAt?.() ?? null,
            error: null,
            ...extra,
          }
        }

        if (req.method === 'GET') {
          json(res, 200, view())
          return
        }

        const body = await readJsonBody(req).catch(() => undefined) as { action?: unknown } | undefined
        const action = typeof body?.action === 'string' ? body.action : 'start'

        if (action === 'logout') {
          deps.logout()
          json(res, 200, view({ source: deps.sourceProvider?.() ?? null, loggedIn: false }))
          return
        }

        if (action === 'poll') {
          const done = await deps.poll()
          json(res, 200, view({
            error: done ? null : '还没有拿到令牌：请先在浏览器完成扫码授权，再点一次「我已完成授权」。',
          }))
          return
        }

        const session = await deps.start()
        if (session === undefined) {
          json(res, 200, view({ ok: false, error: '取不到登录入口（login-config）。检查网络后重试。' }))
          return
        }
        json(res, 200, view())
      } catch (error: unknown) {
        json(res, 500, { error: safeMessage(error) })
      }
    },
  })
}
