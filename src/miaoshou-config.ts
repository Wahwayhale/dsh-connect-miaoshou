/**
 * 妙手插件的持久化设置。
 *
 * 只有三个字段：哪些模型出现在 DSH 的模型选择器里、是否开启 prompt 级工具模拟、
 * 以及可选的 baseUrl 覆盖（内网/测试环境调试用）。
 *
 * @module dsh-connect-miaoshou/config
 */
import z from '@deepseek-ai/schemastery'

/** 设置字段名：已勾选的模型 id 列表。 */
export const ENABLED_MODEL_IDS_FIELD = 'enabledModelIds'

/** 设置字段名：prompt 级工具模拟开关。 */
export const TOOL_EMULATION_FIELD = 'toolEmulation'

/** 设置字段名：上游 baseUrl 覆盖。 */
export const BASE_URL_FIELD = 'baseUrl'

/** 本插件的设置形状。 */
export interface MiaoshouSettings {
  /**
   * 已勾选的模型 id。默认 `[]` 表示「还没配置过」，此时服务整个目录；
   * 用户主动取消全部勾选后写入 `[]` 也保持「服务整个目录」的语义，
   * 与参考实现 dsh-connect-doubao 一致。
   */
  enabledModelIds: string[]
  /**
   * 把 DSH 声明的工具写进 prompt，再解析回复里的围栏 JSON 成 tool_calls。
   *
   * 默认关闭：妙手的 `/api/chat/agent-stream` 是远端 agent 链路，它自己跑工具，
   * 不会给我们返回 OpenAI 形状的 tool_calls。开启后模型改用「提示词契约」驱动
   * DSH 本地工具，速度更慢且可能漏调用，属于可选增强。
   */
  toolEmulation: boolean
  /** 上游 baseUrl；空串表示用内置默认 https://nocode.cn。 */
  baseUrl: string
}

/** 读取勾选列表；未配置返回 undefined。 */
export function enabledIdsOf(config: unknown): string[] | undefined {
  const value = (config as { enabledModelIds?: unknown } | undefined)?.enabledModelIds
  if (!Array.isArray(value)) return undefined
  return value.filter((id): id is string => typeof id === 'string')
}

/** 归一化：`[]` 视为「未配置」。 */
export function effectiveIds(config: unknown): string[] | undefined {
  const ids = enabledIdsOf(config)
  return ids === undefined || ids.length === 0 ? undefined : ids
}

/** 读取工具模拟开关，默认 false。 */
export function toolEmulationOf(config: unknown): boolean {
  return (config as { toolEmulation?: unknown } | undefined)?.toolEmulation === true
}

/** 读取 baseUrl 覆盖，未设置返回 undefined。 */
export function baseUrlOf(config: unknown): string | undefined {
  const value = (config as { baseUrl?: unknown } | undefined)?.baseUrl
  return typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\/+$/, '') : undefined
}

/**
 * 把字段标记为 volatile。
 *
 * 这是字段能被设置表单写入的前提：宿主只暴露 volatile 字段，写入闸门对其他
 * 字段直接报 `Plugin entry "<id>" has no volatile fields`。
 */
function asVolatile<T>(schema: T): T {
  const candidate = schema as unknown as { volatile?: () => T }
  return typeof candidate.volatile === 'function' ? candidate.volatile() : schema
}

/**
 * Loader 读取的 `Config` schema。
 *
 * 必须是真正的 schemastery schema：Cordis 会调用 `.validate()`，普通对象字面量
 * 会抛 `TypeError: Cannot read properties of undefined (reading 'validate')`，
 * 整个条目注册失败。
 */
export const Config = z.object({
  enabledModelIds: asVolatile(z.array(z.string()).default([]))
    .description('出现在 DSH 模型选择器里的妙手模型；留空表示全部'),
  toolEmulation: asVolatile(z.boolean().default(false))
    .description('把 DSH 工具写进 prompt 并在回复里解析 tool_calls（较慢，默认关闭）'),
  baseUrl: asVolatile(z.string()).default('')
    .description('上游地址覆盖，留空用 https://nocode.cn'),
})
