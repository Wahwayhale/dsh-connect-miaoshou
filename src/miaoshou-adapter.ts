/**
 * 妙手的 pi-ai provider，注册进 Harness 的 LLM 接缝。
 *
 * 装配方式沿用 `dsh-llm-pi-ai` 的公开扩展点（与 `dsh-connect-workbuddy` /
 * `dsh-connect-doubao` 一致）：
 *
 *   createProvider(...)  ->  一个 pi-ai Provider，它的所有 model 都指向
 *                           loopback shim 的 OpenAI 形状接口
 *   PiAiAdapter          ->  用解析好的 provider profile 构造的 Harness 适配器
 *
 * 妙手方言与所有入站加固都在 shim 里；这个文件只决定选择器里显示什么、
 * 以及失败怎么归类。
 *
 * @module dsh-connect-miaoshou/adapter
 */
import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider, ProviderStreams } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { MiaoshouShim } from './miaoshou-shim.ts'
import {
  MIAOSHOU_CONTEXT_WINDOW,
  MIAOSHOU_MAX_TOKENS,
  MIAOSHOU_MODELS,
  MIAOSHOU_PROVIDER,
  MIAOSHOU_PROVIDER_DISPLAY_NAME,
  enabledModelsOf,
  modelLabel,
  type MiaoshouModelInfo,
} from './miaoshou-catalog.ts'

/** 单次流式读取挂起时的 provider 空闲上限。 */
export const MIAOSHOU_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * 惰性的 pi-ai 鉴权面。
 *
 * 妙手只通过 shim 的进程内共享密钥（被解析成 OpenAI apiKey）认证，再加上
 * shim 从本机 auth.json 读到的 passport 令牌。pi-ai 自己的凭据生命周期
 * 与环境探测绝不能在这里凭空造出一个凭据。
 */
const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() {
      throw new Error('dsh-connect-miaoshou: the miaoshou route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

/** 订阅制额度下无法知道每 token 的价格，报零。 */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const

/** 图片请求预算：这条路线是纯文本，上限全部惰性。 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 0,
  requestImagePixelBudget: 0,
  requestImageMaxBytes: 0,
} as const

/**
 * 某个条目的思考档位映射。
 *
 * 这一层是**真实能力翻译**，不是抽象占位：妙手 `POST /api/agent/maas/model-types`
 * 给每个模型声明了 `thinking`（开/关）与 `effort`（`low` / `high` / `max` …）
 * 两个参数，`thinkingLevelMap` 只暴露上游真正接受的档位，选择器就不会让用户
 * 选到一个上游会报错的值（服务端对 `effort` 有 enum 校验）。
 *
 * 约定（shim 侧按同一套字符串解释，见 `miaoshou-shim.ts` 的 `reasoning_effort`）：
 *  - `'none'` → `thinking:'false'`（关掉深度思考）；
 *  - `'on'`   → `thinking:'true'`（模型只有开关、没有等级时用 High 代表「开」）；
 *  - `low` / `medium` / `high` / `xhigh` / `max` → `thinking:'true'` + `effort:<同值>`。
 *
 * 没有声明的档位一律钉成 `null`，pi-ai 就不会把它列进选择器。
 *
 * `off` 只在模型**真的有** `thinking` 开关时暴露：有开关才能把思考关掉；GLM 系列
 * 没有该参数，暴露 `off` 只会让用户选到一个「什么都不发、等于用默认值」的假档位。
 */
function thinkingLevelMap(info: MiaoshouModelInfo): Record<string, string | null> {
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  const none = Object.fromEntries(levels.map(level => [level, null])) as Record<string, string | null>
  if (!info.reasoning) return none
  const mapped: Record<string, string | null> = { ...none }
  if (info.thinkingOptions) mapped.off = 'none'
  if (info.efforts.length === 0) {
    // 只有 thinking 开关的模型（LongCat-2.x / MiniMax-M3）：开/关两态。
    if (info.thinkingOptions) mapped.high = 'on'
    return mapped
  }
  // 有 effort 参数的模型：上游每个取值一一对应到同名档位。
  for (const effort of info.efforts) {
    if ((levels as readonly string[]).includes(effort)) mapped[effort] = effort
  }
  return mapped
}

/** 构造一条指向 loopback shim 的 pi-ai model 描述。 */
function toPiModel(info: MiaoshouModelInfo, baseUrl: string, providerId: string): Model<Api> {
  return {
    id: info.id,
    // 名字里带倍率（`GLM-5.3 · 0.59×`），用户挑模型时不必回 App 对照。
    name: modelLabel(info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    // 妙手的图片上传走 create 的 `images` 字段，实测未打通；shim 侧会把
    // image_url 降级成占位文本。所以这里一律只声明 text —— 否则 UI 会允许
    // 用户附图，而模型实际看不到，比不支持更糟。
    input: ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow ?? MIAOSHOU_CONTEXT_WINDOW,
    maxTokens: MIAOSHOU_MAX_TOKENS,
    reasoning: info.reasoning,
    thinkingLevelMap: thinkingLevelMap(info),
    compat: {
      // pi-ai 只有在 compat.supportsReasoningEffort 为真时才把档位写进
      // `reasoning_effort`。只有开关、没有等级的模型（LongCat-2.x / MiniMax-M3）
      // 同样要靠这条通道送 `thinking`，所以按「是否支持思考」而不是
      // 「是否有 effort 参数」来开关。
      supportsReasoningEffort: info.reasoning,
    },
  } as unknown as Model<Api>
}

export interface MiaoshouAdapter {
  adapter: PiAiAdapter
  /** 重建适配器的 provider 快照；目录变化后调用。 */
  invalidate: () => void
  /**
   * 替换勾选的目录 id 并重建快照。
   *
   * 这是设置卡勾选框的**唯一**作用：决定 DSH 的模型选择器里存在哪些条目。
   * 真正用哪一个由会话决定，按请求以 `model` 字段下发。
   *
   * `undefined` 表示「从未配置」，服务整个目录；`[]` 表示一个都不服务，
   * 这是合法的用户选择。
   */
  setEnabledModelIds(ids: string[] | undefined): void
  /** 替换模型目录来源（网关发现结果），并重建快照。 */
  setCatalog(models: readonly MiaoshouModelInfo[]): void
}

export interface MiaoshouAdapterOptions {
  shim: MiaoshouShim
  /** 初始勾选的 id；`undefined` 表示「从未配置」。 */
  enabledModelIds?: string[] | undefined
  /**
   * 当前目录的来源。默认用静态清单；插件会传入**发现**到的清单，这样妙手
   * 上线的新模型不必等插件发版就能出现在这个 provider 下。每次重建都会调用，
   * 所以它必须便宜。
   */
  modelsProvider?: () => readonly MiaoshouModelInfo[]
}

/**
 * 装配适配器。
 *
 * 每个模型的 `baseUrl` 每次读取都重新解析，这样 shim 的临时端口从启动后的
 * 第一份快照起就生效。
 */
export function createMiaoshouAdapter(options: MiaoshouAdapterOptions): MiaoshouAdapter {
  const { shim } = options
  const providerId = MIAOSHOU_PROVIDER
  const providerName = MIAOSHOU_PROVIDER_DISPLAY_NAME

  /**
   * 当前生效的目录 id；`undefined` 表示「从未配置」（全给）。用户保存了不同
   * 的勾选后由 {@link setEnabledModelIds} 更新。
   */
  let enabledIds: string[] | undefined = options.enabledModelIds

  /** 目录来源；可被发现结果替换。 */
  let catalogSource: () => readonly MiaoshouModelInfo[] = options.modelsProvider ?? (() => MIAOSHOU_MODELS)

  // pi-ai 的 `getModels` 是同步的，而 shim 的端口是异步绑定，所以适配器先预热
  // 一次端口再读settled 值。`invalidate()` 会重读；绑定失败就让目录为空，
  // 而不是发布一个指向 `undefined` 的模型。
  let syncBaseUrl: string | undefined = shim.baseUrlSync()
  if (syncBaseUrl === undefined) {
    void shim.baseUrl().then((resolved) => { syncBaseUrl = resolved }).catch(() => {})
  }

  const buildModels = (): Model<Api>[] => {
    // pi-ai 驱动的 OpenAI SDK 会在 baseURL 后追加 `/chat/completions`，
    // 所以 shim 的路由正好对上 `/v1` 前缀。端口绑好之前没有可发布的东西；
    // 空快照是合法的，下一次读取（`invalidate()` 之后）会填上。
    const address = syncBaseUrl ?? shim.baseUrlSync()
    if (address === undefined) return []
    const baseUrl = `${address}/v1`
    return enabledModelsOf(enabledIds, catalogSource()).map(info => toPiModel(info, baseUrl, providerId))
  }

  const base = createProvider({
    id: providerId,
    name: providerName,
    auth: {
      apiKey: {
        name: 'Miaoshou loopback shim secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'Miaoshou' }
        },
      },
    },
    models: buildModels(),
    // OpenAI-completions 形状本身就是 shim 的契约；shim 把请求的 model
    // 原样转给妙手。
    api: openAICompletionsApi() as ProviderStreams,
  })

  // `getModels` 委托给实时读取，这样流式分派仍走已构造的 provider，而目录
  // 答案可以随时重建。
  const provider: Provider = { ...base, getModels: () => buildModels() }

  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: MIAOSHOU_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-miaoshou retryPolicy'),
    configuredMaxTokens: new Map(),
    // 目录是动态的，启动时没有已知坏掉的模型。这条路线不能预先判死一个
    // shim 其实能服务的模型。
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    // 类型逃逸，故意窄且注明。
    //
    // `dsh-llm-pi-ai` 用它自己依赖树里的 pi-ai 类型声明 `piProvider`，而本模块
    // 直接 import pi-ai。npm 可能装进两份副本（dev pin `^0.85.1`，宿主跑
    // 0.87.1），TypeScript 于是拒绝把两个 `Provider` 类型关联起来 —— 尽管运行时
    // 两者是同一个包、宿主也只提供一份。
    //
    // 差异被限制在本插件从不使用的 API 面上：它唯一构造的 API 是
    // `openAICompletionsApi()`。在这个单一边界上透过 `unknown` 转型，丢弃的是一个
    // 在这条代码路径上不可能出现的差异，而不是掩盖一个真实的差异。
    //
    // 这仅是**开发树**的产物。发布产物把 pi-ai 留在外部（见
    // tsdown.config.ts 的 `neverBundle`），实际加载的是宿主那一份。
    piProvider: provider as unknown as NonNullable<ResolvedPiAiProviderProfile['piProvider']>,
  }

  // 替换（而非原地修改）map，强制下一次 profiles 读取重建。
  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    // shim 的进程内共享密钥成为 OpenAI apiKey，pi-ai 以 `Authorization: Bearer`
    // 发出。shim 校验它，绝不转发上游。
    resolveApiKey: async () => shim.token(),
  })

  const rebuild = (): void => {
    syncBaseUrl ??= shim.baseUrlSync()
    profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
  }

  return {
    adapter,
    invalidate: rebuild,
    setEnabledModelIds: (ids) => {
      enabledIds = ids
      rebuild()
    },
    setCatalog: (models) => {
      const snapshot = [...models]
      catalogSource = () => snapshot
      rebuild()
    },
  }
}
