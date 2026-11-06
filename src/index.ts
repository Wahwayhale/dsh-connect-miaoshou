/**
 * DSH Connect Miaoshou — 插件入口。
 *
 * 把三块拼起来交给 Harness 的 LLM 缝：
 *
 *   createMiaoshouShim()         loopback HTTP 面 + 妙手对话方言
 *   createMiaoshouAdapter()      pi-ai provider，注册进 ctx.llm
 *   registerMiaoshou*Route       设置卡用的只读积分 / 目录视图 + 设置写入
 *
 * 上游是妙手（美团 CatPaw 桌面端）自己的对话链路：`/api/chat/create` →
 * `/api/chat/agent-stream` → `/api/agent/stream/connect`（SSE）。妙手没有 OpenAI
 * 兼容端点，所以 shim 把这三步翻译成 `POST /v1/chat/completions`。
 *
 * 模型目录来自网关 `/api/gateway/v1/model/providers`，静态表只是兜底。
 *
 * @module dsh-connect-miaoshou
 */
import { createMiaoshouAdapter } from './miaoshou-adapter.ts'
import { createMiaoshouShim } from './miaoshou-shim.ts'
import {
  registerMiaoshouCatalogRoute,
  registerMiaoshouLoginRoute,
  registerMiaoshouQuotaRoute,
  registerMiaoshouSaveRoute,
  type WebServerLike,
} from './miaoshou-status.ts'
import {
  hasPassportToken,
  invalidateCredentialCache,
  loadMiaoshouCredentials,
  passportTokenAt,
  setPassportToken,
} from './miaoshou-auth.ts'
import {
  cancelPassportLogin,
  currentPassportSession,
  fetchPassportProfile,
  pollPassportLoginOnce,
  startPassportLogin,
} from './miaoshou-passport.ts'
import { invalidateGatewayCaches } from './miaoshou-gateway.ts'
import { MIAOSHOU_DEFAULT_BASE_URL } from './miaoshou-upstream.ts'
import { liveModels, refreshModels, invalidateDiscovery, discoverySource } from './miaoshou-discovery.ts'
import {
  MIAOSHOU_CONTEXT_WINDOW,
  MIAOSHOU_MAX_TOKENS,
  MIAOSHOU_MODELS,
  MIAOSHOU_PROVIDER,
  MIAOSHOU_PROVIDER_DISPLAY_NAME,
  enabledModelsOf,
} from './miaoshou-catalog.ts'
import { ENABLED_MODEL_IDS_FIELD, effectiveIds, toolEmulationOf, baseUrlOf } from './miaoshou-config.ts'
import { readStoredSettings, withStoredSettings, writeStoredSetting } from './miaoshou-store.ts'
import type { MiaoshouSettings } from './miaoshou-config.ts'

export const PLUGIN_ID = 'dsh-connect-miaoshou'
export const PLUGIN_NAME = 'DSH Connect Miaoshou'

/**
 * 设置呈现注册过程的诊断轨迹。
 *
 * `settings.configure()` 是让本插件成为一个 settings namespace 的关键，它可能在
 * 四个完全不同的地方失败而不报错：inject 子节点没跑（没有 `settings` 服务）、
 * `ctx.effect` 没跑、调用本身抛了、调用成功但宿主仍不列出我们。这四种从外面看
 * 一模一样（少一个 namespace），所以每一步都记下是否走到，保存路由把它报出来。
 */
export const presentationDiag: {
  injectRan?: boolean
  hasSettings?: boolean
  hasFiber?: boolean
  effectRan?: boolean
  configureRan?: boolean
  error?: string
  editorEntries?: string[]
  editorError?: string
  fiberEntryId?: string
  settingsNs?: string
  /** 生效中的模型筛选（逗号分隔；`(all)` 表示不筛选）。 */
  enabledIds?: string
  /** 按筛选后实际对外提供的模型数。 */
  modelsOffered?: number
  /** `llm/models-updated` 广播的次数，用来确认事件确实发出。 */
  announced?: number
} = {}

/**
 * 插件的 Cordis 名字 —— Loader 与 Settings 服务用作 key 的那个值。
 *
 * 必须是 **entry id**，不能是人类可读标题。两个能工作的兄弟插件
 * （`dsh-connect-trae`、`dsh-connect-workbuddy`）都导出 `name === entry id`，
 * 且都有 namespace；导出标题名的那次尝试里，namespace 是 28 条 describe()
 * 里唯一缺席的那条。显示名不是标识符。
 */
export const name = PLUGIN_ID

export * from './miaoshou-auth.ts'
export * from './miaoshou-upstream.ts'
export * from './miaoshou-gateway.ts'
export * from './miaoshou-catalog.ts'
export * from './miaoshou-config.ts'
export * from './miaoshou-passport.ts'
export {
  liveModels,
  refreshModels,
  invalidateDiscovery,
  discoverySource,
  DISCOVERY_TTL_MS,
} from './miaoshou-discovery.ts'
export { createMiaoshouAdapter, MIAOSHOU_STREAM_IDLE_TIMEOUT_MS } from './miaoshou-adapter.ts'
export { createMiaoshouShim, type MiaoshouShim } from './miaoshou-shim.ts'
export {
  miaoshouQuotaView,
  registerMiaoshouQuotaRoute,
  registerMiaoshouCatalogRoute,
  registerMiaoshouSaveRoute,
  registerMiaoshouLoginRoute,
  MIAOSHOU_QUOTA_PATH,
  MIAOSHOU_CATALOG_PATH,
  MIAOSHOU_SAVE_PATH,
  MIAOSHOU_LOGIN_PATH,
} from './miaoshou-status.ts'
// `Config` 是从 './miaoshou-config.ts' 再导出的（不是这里重新定义）：Loader 需要
// 这个 entry 模块上挂一个真的 schemastery schema。

/**
 * 本插件触碰的 context 的最小结构类型。
 *
 * 用结构声明而不是从 `@deepseek-ai/cordis` 导入，这样包在没有装 peer 依赖时也能
 * 构建与类型检查。运行时 Cordis 传进来的是真 `Context`，它满足这个形状。
 */
export interface MiaoshouPluginContext {
  llm: {
    registerAdapter(ids: string[], adapter: unknown): () => void
    registerConfigurableProviders(entries: Array<{
      provider: string
      displayName: string
      settingsNs: string
      settingsPath: string[]
      declared: boolean
    }>): () => void
    registerModelDiscovery(
      ns: string,
      fn: (request: { provider?: string }) => Promise<Array<{
        id: string
        name: string
        contextWindow: number
        maxTokens: number
        inputModalities: ('text' | 'image')[]
      }>>,
    ): () => void
  }
  inject(names: string[], apply: (ctx: never) => void): void
  on(name: string, listener: (config?: MiaoshouSettings) => void): unknown
  /**
   * 广播宿主事件。用来通知选择器重读模型目录（`llm/models-updated`）：
   * 只在适配器内部换快照的话，UI 手里那份列表是启动时抓的，不会自己更新。
   */
  emit?(name: string, ...args: unknown[]): void
  effect(fn: () => (() => void) | void): void
  logger: { error(message: string, error?: unknown): void; warn?(message: string, error?: unknown): void }
  get?(name: string): unknown
}

/**
 * 注册 provider 前必须就位的服务。
 *
 * `inject: ['llm']` 是**必需**的，不是装饰。Cordis 只把声明过的服务暴露给插件，
 * 没声明就碰 `ctx.llm` 会在 `apply()` 里抛 `cannot get property "llm" without
 * inject` —— 整个插件静默消失：没有 provider、没有路由，只剩一行日志。
 *
 * `webServer` 故意不在这里：它挂得晚，桌面端可能永远不出现，列上它会把整个插件
 * 永久卡住。路由改用嵌套的 `ctx.inject(['webServer'], ...)` 等它。
 *
 * `settings` 是软探针（`ctx.get`），不进 inject：settings 面随宿主线路不同，
 * 而 Cordis 的闸门够硬 —— 点名一个宿主不提供的服务会让 `apply` 根本不跑。
 */
export const inject = ['llm']

/** 宿主实际为这个插件服务的 namespace（= Loader entry id）。 */
export function settingsNamespaceOf(ctx: unknown): string {
  const entry = (ctx as { fiber?: { entry?: { options?: { id?: string } } } }).fiber?.entry
  return entry?.options?.id ?? PLUGIN_ID
}

/**
 * 接上 provider 与只读路由。
 *
 * `apply` 把所有 disposer 收进一个 `ctx.effect`，卸载插件时释放 shim 端口、
 * 适配器、目录条目、发现回调和 HTTP 路由 —— 没有任何东西活过插件。
 */
export function apply(
  ctx: MiaoshouPluginContext,
  config: MiaoshouSettings = { enabledModelIds: [], toolEmulation: false, baseUrl: '' },
): void {
  let shim: ReturnType<typeof createMiaoshouShim> | undefined
  let adapterRelease: (() => void) | undefined
  let directoryRelease: (() => void) | undefined
  let discoveryRelease: (() => void) | undefined

  const settingsNs = settingsNamespaceOf(ctx)

  /**
   * 生效中的配置，每次写入后替换。
   *
   * 初始值来自插件**自己的文件**，它优先于 Loader config：这条宿主线上 fiber
   * 到不了 ACTIVE，Loader 既不能暴露也不能接受本插件的设置写入
   * （`No configurable plugin entry "dsh-connect-miaoshou"`）。文件是唯一能落盘
   * 的地方，所以它优先 —— 信 Loader 的值会让任何保存过的开关又悄悄回退。
   */
  let current: MiaoshouSettings = withStoredSettings(config)

  try {
    shim = createMiaoshouShim({
      // 每次请求现读，改设置不用重启宿主。
      baseUrl: () => baseUrlOf(current) ?? MIAOSHOU_DEFAULT_BASE_URL,
      isAgent: () => false,
    })
    const { adapter, invalidate, setEnabledModelIds, setCatalog } = createMiaoshouAdapter({
      shim,
      // 用 current 而不是 config：文件里存过的勾选优先于 Loader 的默认值，
      // 否则宿主重启后用户上次保存的模型筛选会悄悄失效。
      enabledModelIds: effectiveIds(current),
      // 目录来自发现缓存：妙手上线的新模型不必等插件发版。
      modelsProvider: liveModels,
    })

    // 先注册适配器：空注册是非法（`INVALID_ADAPTER`），而释放已落地的总是合法。
    adapterRelease = ctx.llm.registerAdapter([MIAOSHOU_PROVIDER], adapter)
    directoryRelease = ctx.llm.registerConfigurableProviders([
      {
        provider: MIAOSHOU_PROVIDER,
        displayName: MIAOSHOU_PROVIDER_DISPLAY_NAME,
        settingsNs,
        settingsPath: [],
        declared: false,
      },
    ])

    ctx.effect(() => () => {
      adapterRelease?.()
      directoryRelease?.()
      discoveryRelease?.()
      void shim?.close()
      shim = undefined
    })

    // shim 端口是临时分配的、按模型读取实时解析，所以启动后第一份快照就指向活端口。
    invalidate()
    // 端口是异步绑定的：绑定完成后再重建一次快照，保证任何早于端口就绪的读取
    // （宿主启动时的模型枚举）不会留下空目录。
    void shim.baseUrl().then(() => { invalidate() }).catch(() => {})

    // 模型发现把目录发布出去，按用户勾选的条目过滤。
    try {
      discoveryRelease = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
        if (request.provider !== undefined && request.provider !== MIAOSHOU_PROVIDER) return []
        return enabledModelsOf(effectiveIds(current), liveModels()).map(model => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow ?? MIAOSHOU_CONTEXT_WINDOW,
          maxTokens: MIAOSHOU_MAX_TOKENS,
          // 与 adapter 保持一致：妙手这条路线实际只送得进文本，见
          // miaoshou-adapter.ts 的 toPiModel 注释。
          inputModalities: ['text' as const],
        }))
      })
    } catch (error: unknown) {
      // 发现是可选的：没有它 provider 照样流式。
      ctx.logger.error('dsh-connect-miaoshou: model discovery registration failed', error)
    }

    /**
     * 扫码登录拿到的令牌落定后要做的事。
     *
     * 换令牌等于换账号：三个缓存一起清，否则卡片还显示旧账号的数字。
     */
    const applyPassportToken = (token: string): void => {
      setPassportToken(token, { uid: '', name: '' })
      invalidateCredentialCache()
      invalidateGatewayCaches()
      invalidateDiscovery()
      // 顺手补上账号信息：卡片里显示的 uid / 名字来自这里。
      void fetchPassportProfile(token).then(result => {
        if (!result.ok) return
        setPassportToken(token, { uid: result.profile.uid, name: result.profile.name })
      })
    }

    // 启动时如果磁盘上有令牌，直接可用；这里只做一次有效性确认，失败就清掉。
    if (hasPassportToken()) {
      const saved = loadMiaoshouCredentials()
      if (saved.ok && saved.source === 'passport') {
        void fetchPassportProfile(saved.token).then(result => {
          if (result.ok) {
            setPassportToken(saved.token, { uid: result.profile.uid, name: result.profile.name })
            return
          }
          // 401 才清；网络错误不该把用户的登录态丢掉。
          if (/失效|401/i.test(result.reason)) setPassportToken(undefined)
        })
      }
    }

    /**
     * 设置呈现，通过嵌套的 `ctx.inject(['settings'], ...)`。
     *
     * 这曾是 apply 时刻的一次软 `ctx.get('settings')` 探测，也正是本插件设置行
     * 不存在的原因：`apply` 可能跑在 settings 服务挂载之前，探测返回
     * `undefined`，`configure()` 就再没被调用过 —— 没错误、没重试，namespace
     * 永远缺席。
     *
     * 两个能工作的兄弟都用 inject 子节点正是为此：子节点被扣住直到服务存在，
     * 服务被替换时还会重跑。软探测只留作宿主根本不提供 `settings` 时的兜底。
     */
    const presentationOwner = (ctx as unknown as { fiber?: unknown }).fiber
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['settings'], (settingsCtx: never) => {
          const child = settingsCtx as unknown as {
            settings?: { configure(presentation: { auto?: boolean }, owner?: unknown): () => void }
            effect?: (fn: () => unknown) => unknown
          }
          presentationDiag.injectRan = true
          presentationDiag.hasSettings = child.settings !== undefined
          presentationDiag.hasFiber = presentationOwner !== undefined
          presentationDiag.fiberEntryId = String(
            (presentationOwner as { entry?: { options?: { id?: unknown } } } | undefined)?.entry?.options?.id,
          )
          presentationDiag.settingsNs = settingsNs
          const settings = child.settings
          if (settings === undefined || typeof settings.configure !== 'function') return
          // `auto: true` 会让宿主按 schema 合成表单，而本插件自带卡片。
          const claim = (): unknown => {
            presentationDiag.effectRan = true
            const dispose = settings.configure({ auto: false }, presentationOwner)
            presentationDiag.configureRan = true
            return dispose
          }
          if (typeof child.effect === 'function') child.effect.call(settingsCtx, claim)
          else claim()
        })
        // 仅供诊断的兄弟节点。`ConfigEditor.entries()` 只在父节点是 include 且 id
        // 在 profile 内唯一时才保留条目，所以对保存路由来说「不在 configEditor」
        // 与「不唯一」是同一个症状。多问一个服务不会影响卡片工作。
        ctx.inject(['configEditor'], (editorCtx: never) => {
          try {
            const editor = editorCtx as unknown as {
              configEditor?: {
                entries?: () => Array<{
                  options?: { id?: unknown }
                  parent?: { tree?: { ctx?: { fiber?: { entry?: { id?: unknown } } } } }
                  fiber?: { state?: unknown; runtime?: { Config?: unknown } }
                }>
              }
            }
            const rows = typeof editor.configEditor?.entries === 'function' ? editor.configEditor.entries() : undefined
            if (rows === undefined) {
              presentationDiag.editorError = 'configEditor present but no entries()'
              return
            }
            presentationDiag.editorEntries = rows.map(row => {
              const runtime = row.fiber?.runtime as { Config?: unknown } | null | undefined
              const config = runtime?.Config as { toJSON?: unknown } | undefined
              const ours = String(row.options?.id) === PLUGIN_ID ? ':ours' : ''
              return `${String(row.options?.id)}@${String(row.fiber?.state)}${config === undefined ? ':noschema' : ':schema'}${ours}`
            })
          } catch (error: unknown) {
            presentationDiag.editorError = (error as Error)?.message ?? String(error)
          }
        })
      }
    } catch (error: unknown) {
      presentationDiag.error = (error as Error)?.message ?? String(error)
      ctx.logger.error('dsh-connect-miaoshou: settings presentation registration failed', error)
    }

    /**
     * 让宿主 UI 重新拉一次模型列表。
     *
     * 适配器换快照只影响「下一次请求怎么解析模型」；选择器里那份列表是它自己
     * 缓存的，不广播 `llm/models-updated` 就一直是旧的 —— 表现为「勾了 2 个，
     * 下拉里还是 12 个」。事件是可选的：没有 emit 的宿主线路照样能流式。
     */
    const announceModels = (): void => {
      try {
        ctx.emit?.('llm/models-updated', MIAOSHOU_PROVIDER)
        // 选择器同时监听这个事件（provider 的展示元数据也变了：名字里带倍率）。
        ctx.emit?.('llm/adapters-updated', MIAOSHOU_PROVIDER)
        presentationDiag.announced = (presentationDiag.announced ?? 0) + 1
      } catch { /* 该线路不广播事件 */ }
    }

    // 用户保存了不同勾选后重新过滤选择器。
    const onSettingsChanged = (next?: MiaoshouSettings): void => {
      if (next !== undefined) current = next
      const ids = effectiveIds(current)
      setEnabledModelIds(ids)
      invalidate()
      // 诊断：保存后宿主侧到底提供几条模型。选择器若仍显示全部，就能一眼区分
      // 「宿主还在给 12 条」与「宿主只给 2 条、只是 UI 没重拉」。
      presentationDiag.enabledIds = ids === undefined ? '(all)' : ids.join(',')
      presentationDiag.modelsOffered = enabledModelsOf(ids, liveModels()).length
      announceModels()
    }
    try {
      ;(ctx as unknown as { on(name: string, listener: () => void): unknown })
        .on('loader/volatile-update', onSettingsChanged)
    } catch { /* 这条宿主线上没有该事件 */ }

    // 只读路由。`webServer` 可能晚于本行挂载（桌面端甚至可能永不挂载），所以
    // 响应式等待，而不是只采样一次 ctx.get()。
    ctx.inject(['webServer'], (webCtx) => {
      try {
        const disposeQuota = registerMiaoshouQuotaRoute(webCtx, {
          onRefresh: () => {
            // 卡片上的刷新同时刷新凭据与网关缓存：用户可能刚在妙手里重新登录，
            // 或者刚在浏览器里扫码完成。
            invalidateCredentialCache()
            invalidateGatewayCaches()
            invalidateDiscovery()
          },
        })
        const disposeCatalog = registerMiaoshouCatalogRoute(webCtx, {
          modelsProvider: liveModels,
          sourceProvider: discoverySource,
          onCatalogChange: (models) => {
            setCatalog(models)
            invalidate()
            announceModels()
          },
        })
        const disposeSave = registerMiaoshouSaveRoute(
          {
            webServer: (webCtx as unknown as { webServer: WebServerLike }).webServer,
          },
          {
            // 写入落到插件**自己的**文件。宿主设置路径对本插件不可用
            // （fiber 卡在 LOADING ⇒ 没有 `runtime.Config` ⇒
            // `No configurable plugin entry`），文件是唯一能落盘的地方。
            write: (field: string, value: unknown) => { writeStoredSetting(field, value) },
            read: () => readStoredSettings(),
            diagnostics: () => ({ ...presentationDiag, pluginName: name, catalogSource: discoverySource() }),
            // 让活配置跟上通过这条路由做的写入：宿主的变更事件不保证每条线都发，
            // 只落盘的话要重启才生效。
            onApplied: (field: string, value: unknown) => {
              const next: MiaoshouSettings = { ...current }
              if (field === ENABLED_MODEL_IDS_FIELD && Array.isArray(value)) {
                next.enabledModelIds = value.filter((id): id is string => typeof id === 'string')
              } else if (field === 'toolEmulation' && typeof value === 'boolean') {
                next.toolEmulation = value
              } else if (field === 'baseUrl' && typeof value === 'string') {
                next.baseUrl = value
                // 换地址可能换账号：两个缓存都清，否则卡片还会显示旧账号的数字。
                invalidateCredentialCache()
                invalidateGatewayCaches()
              }
              onSettingsChanged(next)
            },
          },
        )
        const disposeLogin = registerMiaoshouLoginRoute(
          {
            webServer: (webCtx as unknown as { webServer: WebServerLike }).webServer,
          },
          {
            // 发起扫码登录；令牌在后台轮询拿到后立刻生效并落盘。
            start: () => startPassportLogin(applyPassportToken),
            current: currentPassportSession,
            poll: () => pollPassportLoginOnce(),
            logout: () => {
              cancelPassportLogin()
              setPassportToken(undefined)
              invalidateCredentialCache()
              invalidateGatewayCaches()
              invalidateDiscovery()
            },
            sourceProvider: () => {
              const credentials = loadMiaoshouCredentials()
              return credentials.ok ? credentials.source : null
            },
            tokenSavedAt: passportTokenAt,
          },
        )
        ctx.effect(() => () => {
          disposeQuota()
          disposeCatalog()
          disposeSave()
          disposeLogin()
        })
      } catch (error: unknown) {
        ctx.logger.error('dsh-connect-miaoshou: web route registration failed', error)
      }
    })
  } catch (error: unknown) {
    ctx.logger.error('dsh-connect-miaoshou: provider registration failed', error)
    // 释放抛之前已落地的东西；半注册的 provider 会出现在模型选择器里却不可路由。
    adapterRelease?.()
    directoryRelease?.()
    discoveryRelease?.()
    void shim?.close()
    shim = undefined
  }
}

/** 便利：给卡片/诊断用的登录态探测。 */
export function isLoggedIn(): boolean {
  return loadMiaoshouCredentials().ok
}

/** 静态目录条数（离线时的期望值）。 */
export const BUILTIN_CATALOG_SIZE = MIAOSHOU_MODELS.length

/** 让发现缓存立即刷新；CLI doctor 用。 */
export async function warmCatalog(): Promise<number> {
  return (await refreshModels()).length
}

export default { name, inject, apply }
