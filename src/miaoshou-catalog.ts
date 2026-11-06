/**
 * 妙手模型目录。
 *
 * 目录与**妙手 App 模型选择器**保持一致（12 条），这是实测唯一能让用户
 * 「看到什么就能选到什么」的口径：
 *
 *  - `id` 是 `/api/chat/agent-stream` 真正接受的调用名，逐个实测通过；
 *  - `name` 是 App 里显示的展示名；
 *  - `rateMultiplier` / `marketingCopy` 是 App 卡片右侧的「×倍率 / 限时免费」。
 *
 * 两套命名并不一致（上游设计如此）：
 *  - App 展示名带版本点号与大写：`DeepSeek-V4.1-Flash`、`Kimi-K3.1-Pro`；
 *  - 调用名大小写敏感且因厂商而异：`glm-5.3-flashx` 必须全小写，
 *    而 `MiniMax-M3.1-Flash`、`LongCat-2.5` 必须保持原样。
 *
 * 所以**不能**统一 lower-case 处理，必须逐条写死（见 {@link MIAOSHOU_MODELS}）。
 *
 * 另有一套网关目录（`GET https://catx.nocode.cn/api/gateway/v1/model/providers`），
 * 返回的是另一批 slug 名（`deepseek-v4-flash`、`glm-5.2`、`kimi-k2.6` …）。
 * 那些也能调通，但 App 里看不到，**不并入**本目录。
 *
 * @module dsh-connect-miaoshou/catalog
 */

/** 本插件拥有的 provider 路由 id。 */
export const MIAOSHOU_PROVIDER = 'miaoshou'

/** 模型选择器里显示的名字。 */
export const MIAOSHOU_PROVIDER_DISPLAY_NAME = '妙手（CatPaw）'

/** 默认上下文窗口（200K，妙手默认档位）。 */
export const MIAOSHOU_CONTEXT_WINDOW = 204_800

/** 输出上限的宽松估计；真实上限由妙手侧决定。 */
export const MIAOSHOU_MAX_TOKENS = 32_000

/** 一条目录项。 */
export interface MiaoshouModelInfo {
  /** 上游 `/api/chat/agent-stream` 接受的调用名，也是 DSH 侧模型 id。 */
  id: string
  /** App 里显示的展示名。 */
  name: string
  /** 厂商 id（LongCat / GLM / Kimi / DeepSeek / MiniMax / Auto）。 */
  vendor: string
  /** 厂商显示名。 */
  vendorLabel: string
  /** 上游是否支持图片输入（shim 仍只发文本，这里只用于展示标记）。 */
  supportsImage: boolean
  /** 是否支持「深度思考」。 */
  reasoning: boolean
  /** 上游是否有独立的 `thinking` 开关参数（`true` 表示可显式关思考）。 */
  thinkingOptions: boolean
  /** 上游 `effort` 参数的合法取值；空数组表示该模型没有思考等级参数。 */
  efforts: string[]
  /** 上游给的 `effort` 默认值；没有 effort 参数时为 `null`。 */
  defaultEffort: string | null
  /** 是否支持「思考等级」（等价于 `efforts.length > 0`）。 */
  supportsEffort: boolean
  /** 可选的上下文档位，空数组表示不可选。 */
  contextOptions: number[]
  /** 默认上下文窗口。 */
  contextWindow: number
  /** 积分消耗倍率（`0.59` 即 0.59×）；`null` 表示上游没给（Auto）。 */
  rateMultiplier: number | null
  /** 营销文案，如「限时免费」；`null` 表示没有。 */
  marketingCopy: string | null
}

/**
 * 静态目录 —— 与妙手 App 模型选择器的 12 条完全一致。
 *
 * `id` 全部实测可调通（`tools/probe-app-canonical.mjs`）；
 * 倍率、上下文档位、参数能力取自 `POST /api/agent/maas/model-types`
 * （`tools/parse-maas3.mjs` 实读）。
 */
export const MIAOSHOU_MODELS: readonly MiaoshouModelInfo[] = [
  {
    id: 'auto', name: 'Auto', vendor: 'Auto', vendorLabel: '妙手自动选择',
    supportsImage: false, reasoning: false,
    thinkingOptions: false,
    efforts: [], defaultEffort: null,
    supportsEffort: false,
    contextOptions: [], contextWindow: MIAOSHOU_CONTEXT_WINDOW,
    rateMultiplier: null, marketingCopy: null,
  },
  {
    id: 'LongCat-2.5', name: 'LongCat-2.5', vendor: 'LongCat', vendorLabel: 'LongCat 官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: true,
    efforts: [], defaultEffort: null,
    supportsEffort: false,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0, marketingCopy: '限时免费',
  },
  {
    id: 'LongCat-2.0', name: 'LongCat-2.0', vendor: 'LongCat', vendorLabel: 'LongCat 官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: true,
    efforts: [], defaultEffort: null,
    supportsEffort: false,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0, marketingCopy: '限时免费',
  },
  {
    id: 'glm-5.3-flashx', name: 'GLM-5.3-FlashX', vendor: 'GLM', vendorLabel: '智谱 AI（GLM）官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: false,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0.16, marketingCopy: null,
  },
  {
    id: 'glm-5.3-flash', name: 'GLM-5.3-Flash', vendor: 'GLM', vendorLabel: '智谱 AI（GLM）官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: false,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0.06, marketingCopy: null,
  },
  {
    id: 'glm-5.3', name: 'GLM-5.3', vendor: 'GLM', vendorLabel: '智谱 AI（GLM）官方',
    supportsImage: false, reasoning: true,
    thinkingOptions: false,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 800_000], contextWindow: 204_800,
    rateMultiplier: 0.59, marketingCopy: null,
  },
  {
    id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', vendor: 'DeepSeek', vendorLabel: 'DeepSeek 官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: true,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 600_000], contextWindow: 204_800,
    rateMultiplier: 0.06, marketingCopy: null,
  },
  {
    id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', vendor: 'DeepSeek', vendorLabel: 'DeepSeek 官方',
    supportsImage: false, reasoning: true,
    thinkingOptions: true,
    efforts: ['high', 'max'], defaultEffort: 'high',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 700_000], contextWindow: 204_800,
    rateMultiplier: 0.48, marketingCopy: null,
  },
  {
    id: 'MiniMax-M3.1-Flash', name: 'MiniMax-M3.1-Flash', vendor: 'MiniMax', vendorLabel: 'MiniMax 官方',
    supportsImage: false, reasoning: true,
    thinkingOptions: false,
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'low',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0.05, marketingCopy: null,
  },
  {
    id: 'MiniMax-M3', name: 'MiniMax-M3', vendor: 'MiniMax', vendorLabel: 'MiniMax 官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: true,
    efforts: [], defaultEffort: null,
    supportsEffort: false,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0.22, marketingCopy: null,
  },
  {
    id: 'kimi-k3.1-pro', name: 'Kimi-K3.1-Pro', vendor: 'Kimi', vendorLabel: 'Moonshot（Kimi）官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: true,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0.61, marketingCopy: null,
  },
  {
    id: 'kimi-k3', name: 'Kimi-K3', vendor: 'Kimi', vendorLabel: 'Moonshot（Kimi）官方',
    supportsImage: true, reasoning: true,
    thinkingOptions: true,
    efforts: ['low', 'high', 'max'], defaultEffort: 'high',
    supportsEffort: true,
    contextOptions: [204_800, 512_000, 1_024_000], contextWindow: 204_800,
    rateMultiplier: 0.94, marketingCopy: null,
  },
]

/** 默认模型：DeepSeek-V4.1-Flash，App 里最便宜的确定档（0.06×）。 */
export const MIAOSHOU_DEFAULT_MODEL_ID = 'deepseek-v4.1-flash'

/** 倍率的展示文本：`0.06×`；免费档与缺失档返回 `null`（由文案代替）。 */
export function rateLabel(rate: number | null | undefined): string | null {
  if (rate === null || rate === undefined) return null
  if (rate === 0) return '免费'
  const text = rate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  return `${text}×`
}

/**
 * 模型在选择器里的完整标签：`GLM-5.3 · 0.59×`、`LongCat-2.5 · 限时免费`。
 *
 * 倍率直接进标签，用户挑模型时不必再回 App 里对照。
 */
export function modelLabel(model: MiaoshouModelInfo): string {
  const rate = rateLabel(model.rateMultiplier)
  const tag = model.marketingCopy !== null && model.marketingCopy !== '' ? model.marketingCopy : rate
  return tag === null ? model.name : `${model.name} · ${tag}`
}

/** 按 id 查目录项，找不到返回默认项。 */
export function findMiaoshouModel(
  id: string | undefined,
  catalog: readonly MiaoshouModelInfo[] = MIAOSHOU_MODELS,
): MiaoshouModelInfo {
  if (id !== undefined) {
    const hit = catalog.find(model => model.id === id)
    if (hit !== undefined) return hit
  }
  return catalog.find(model => model.id === MIAOSHOU_DEFAULT_MODEL_ID)
    ?? (catalog[0] as MiaoshouModelInfo)
}

/**
 * 勾选过滤。
 *
 * `undefined` 表示「从未配置」，服务整个目录；空数组同样服务整个目录（与参考
 * 实现一致：首次安装不该是一个空选择器）。
 */
export function enabledModelsOf(
  ids: string[] | undefined,
  catalog: readonly MiaoshouModelInfo[] = MIAOSHOU_MODELS,
): readonly MiaoshouModelInfo[] {
  if (ids === undefined || ids.length === 0) return catalog
  const wanted = new Set(ids)
  return catalog.filter(model => wanted.has(model.id))
}

/**
 * 把妙手 App 的展示名翻译成 `/api/chat/agent-stream` 真正接受的调用名。
 *
 * 实测规律（12 条逐个验证）：**厂商决定大小写口径**。
 *  - GLM / DeepSeek / Kimi / Auto：调用名是展示名的小写化
 *    （`GLM-5.3-FlashX` → `glm-5.3-flashx`，`DeepSeek-V4.1-Flash` → `deepseek-v4.1-flash`）；
 *  - LongCat / MiniMax：调用名就是展示名原样
 *    （`LongCat-2.5`、`MiniMax-M3.1-Flash` 必须保持大小写，小写会失败）。
 *
 * 这条规则是唯一能让「App 里看到的」和「实际调得通的」对上的映射。
 */
export function canonicalModelId(displayName: string, vendor?: string): string {
  if (vendor === 'LongCat' || vendor === 'MiniMax') return displayName
  return displayName.toLowerCase()
}

/** 一条 maas 模型记录的宽松形状（`POST /api/agent/maas/model-types`）。 */
interface RawMaasModel {
  modelTypeName?: unknown
  description?: unknown
  supportImage?: unknown
  extendedInfo?: unknown
  parameterDefinitions?: unknown
}

/** 从参数定义里取某个参数（含默认值）。 */
function paramOf(
  raw: RawMaasModel,
  id: string,
): { values?: Array<{ value?: unknown }>; defaultValue?: unknown } | undefined {
  const params = Array.isArray(raw.parameterDefinitions) ? raw.parameterDefinitions : []
  return params.find(param => (param as { id?: unknown }).id === id) as
    | { values?: Array<{ value?: unknown }>; defaultValue?: unknown }
    | undefined
}

/**
 * 把 `POST /api/agent/maas/model-types` 的响应归一成目录项。
 *
 * 这是 App 模型选择器的**数据源**：除了展示名，还带 `extendedInfo.rateMultiplier`
 * （积分倍率）、`extendedInfo.marketingCopy`（"限时免费"）、准确的上下文档位，
 * 以及 `thinking` / `effort` 参数能力。
 *
 * 静态表里已有的条目沿用它的厂商信息，但**倍率、档位、参数能力以上游为准** ——
 * 妙手调价或加档位时不必等插件发版。
 */
export function catalogFromMaasModels(payload: unknown, base: readonly MiaoshouModelInfo[] = MIAOSHOU_MODELS): MiaoshouModelInfo[] {
  const root = payload as { data?: unknown } | unknown[] | undefined
  const list = Array.isArray(root) ? root : (root as { data?: unknown } | undefined)?.data
  if (!Array.isArray(list)) return []
  const byId = new Map(base.map(model => [model.id, model]))
  const byName = new Map(base.map(model => [model.name, model]))
  const out: MiaoshouModelInfo[] = []
  for (const rawModel of list) {
    const raw = rawModel as RawMaasModel
    const displayName = typeof raw.description === 'string' && raw.description !== ''
      ? raw.description
      : typeof raw.modelTypeName === 'string' ? raw.modelTypeName : ''
    if (displayName === '') continue
    // App 里 `modelTypeName` 有时已经是调用名（`glm-5.3-flashx`），
    // 展示名则在 `description`（`GLM-5.3-FlashX`）。两条都试一遍。
    const modelTypeName = typeof raw.modelTypeName === 'string' ? raw.modelTypeName : ''
    const known = byName.get(displayName)
      ?? byName.get(modelTypeName)
      ?? byId.get(modelTypeName)
      ?? byId.get(canonicalModelId(displayName, undefined))
    const vendor = known?.vendor ?? vendorOfDisplayName(displayName)
    const extended = (raw.extendedInfo ?? {}) as { rateMultiplier?: unknown; marketingCopy?: unknown }
    const rateRaw = extended.rateMultiplier
    const rate = typeof rateRaw === 'string' && rateRaw !== ''
      ? Number.parseFloat(rateRaw)
      : typeof rateRaw === 'number' ? rateRaw : null
    const copy = typeof extended.marketingCopy === 'string' && extended.marketingCopy !== ''
      ? extended.marketingCopy
      : null
    const contextParam = paramOf(raw, 'context')
    const contexts = contextParam?.values === undefined
      ? []
      : contextParam.values
        .map(entry => Number.parseInt(String(entry.value ?? ''), 10))
        .filter(value => Number.isFinite(value) && value > 0)
    const thinkingParam = paramOf(raw, 'thinking')
    const effortParam = paramOf(raw, 'effort')
    // 有 effort 参数就一定有思考（GLM / MiniMax-M3.1-Flash 没有 thinking 开关，
    // 但它们的思考强度正是由 effort 控制的）。pi-ai 的 getSupportedThinkingLevels()
    // 在 `reasoning:false` 时会直接短路成 ['off']，所以这两者必须合并判断。
    const efforts = effortParam?.values === undefined
      ? []
      : effortParam.values
        .map(entry => String(entry.value ?? ''))
        .filter(value => value !== '')
    const defaultEffort = typeof effortParam?.defaultValue === 'string' && effortParam.defaultValue !== ''
      ? effortParam.defaultValue
      : (efforts.length === 0 ? null : (efforts[0] as string))
    out.push({
      id: known?.id ?? modelTypeName ?? canonicalModelId(displayName, vendor),
      name: known?.name ?? displayName,
      vendor,
      vendorLabel: known?.vendorLabel ?? `${vendor} 官方`,
      supportsImage: raw.supportImage === true,
      reasoning: thinkingParam !== undefined || efforts.length > 0,
      thinkingOptions: thinkingParam !== undefined,
      efforts,
      defaultEffort,
      supportsEffort: efforts.length > 0,
      contextOptions: contexts.length === 0
        ? (known?.contextOptions ?? [MIAOSHOU_CONTEXT_WINDOW])
        : contexts,
      contextWindow: contexts.length === 0
        ? (known?.contextWindow ?? MIAOSHOU_CONTEXT_WINDOW)
        : (contexts[0] as number),
      rateMultiplier: Number.isFinite(rate) ? (rate as number) : null,
      marketingCopy: copy,
    })
  }
  return out
}

/** 按展示名前缀猜厂商（只用于 App 目录里出现的新模型）。 */
export function vendorOfDisplayName(displayName: string): string {
  if (/^LongCat/i.test(displayName)) return 'LongCat'
  if (/^GLM/i.test(displayName)) return 'GLM'
  if (/^Kimi/i.test(displayName)) return 'Kimi'
  if (/^DeepSeek/i.test(displayName)) return 'DeepSeek'
  if (/^MiniMax/i.test(displayName)) return 'MiniMax'
  return 'Auto'
}
