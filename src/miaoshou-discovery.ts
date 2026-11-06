/**
 * 模型目录发现。
 *
 * 妙手的模型清单来自网关（`GET /api/gateway/v1/model/providers`），而不是写死的
 * 常量。这里做一个**带 TTL 的进程内缓存**，让：
 *  - 设置卡每次打开都能看到最新目录，不必重启；
 *  - 网关不可达时静默退回静态表（{@link MIAOSHOU_MODELS}），不影响对话；
 *  - 适配器的 `modelsProvider` 每次读都是同步的（pi-ai 的 `getModels` 是同步的）。
 *
 * @module dsh-connect-miaoshou/discovery
 */
import { fetchMiaoshouCatalog } from './miaoshou-gateway.ts'
import { MIAOSHOU_MODELS, type MiaoshouModelInfo } from './miaoshou-catalog.ts'

/** 发现结果的有效期；与网关侧目录缓存一致（10 分钟）。 */
export const DISCOVERY_TTL_MS = 10 * 60 * 1000

interface DiscoveryState {
  models: readonly MiaoshouModelInfo[]
  source: 'gateway' | 'builtin'
  at: number
  /** 是否已排过一次后台刷新，避免每次读都重复发起。 */
  refreshing: boolean
}

let state: DiscoveryState = {
  models: MIAOSHOU_MODELS,
  source: 'builtin',
  at: 0,
  refreshing: false,
}

/**
 * 同步读当前目录。
 *
 * 首次调用返回静态表并**在后台**触发一次网关拉取；拉取回来后替换缓存。
 * 这样启动瞬间不会因为等网络而让模型选择器空着。
 */
export function liveModels(): readonly MiaoshouModelInfo[] {
  const age = Date.now() - state.at
  if (age > DISCOVERY_TTL_MS && !state.refreshing) {
    state.refreshing = true
    void refreshModels()
  }
  return state.models
}

/** 强制重新拉取一次目录（设置卡的「刷新」按钮用）。 */
export async function refreshModels(): Promise<readonly MiaoshouModelInfo[]> {
  state.refreshing = true
  try {
    const result = await fetchMiaoshouCatalog({ force: true })
    if (result.models.length > 0) {
      // 目录严格等于妙手 App 的模型选择器（12 条），不做追加 —— 见
      // miaoshou-gateway.ts 的 fetchMiaoshouCatalog 注释。
      state = { models: result.models, source: result.source, at: Date.now(), refreshing: false }
    } else {
      // 空目录视为失败，别把已有的清单覆盖成空。
      state = { ...state, refreshing: false, at: Date.now() }
    }
  } catch {
    state = { ...state, refreshing: false, at: Date.now() }
  }
  return state.models
}

/** 当前目录的来源（网关 / 静态兜底）。 */
export function discoverySource(): 'gateway' | 'builtin' {
  return state.source
}

/** 清空缓存，让下一次读重新拉取。 */
export function invalidateDiscovery(): void {
  state = { ...state, at: 0, refreshing: false }
}
