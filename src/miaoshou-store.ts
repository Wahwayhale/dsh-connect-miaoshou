/**
 * 插件自己的设置文件。
 *
 * 与参考实现 dsh-connect-doubao 同样的理由：这条 host line 上插件的 fiber 停在
 * LOADING，宿主设置服务既不会列出也不会接受本插件的写入
 * （`No configurable plugin entry "..."`）。因此设置落在一个本插件拥有的
 * JSON 文件里，写入是原子替换（先写临时文件再 rename）。
 *
 * 优先级：文件 > Loader 传入的 config。文件是唯一能落地写入的地方。
 *
 * @module dsh-connect-miaoshou/store
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  BASE_URL_FIELD,
  ENABLED_MODEL_IDS_FIELD,
  TOOL_EMULATION_FIELD,
  baseUrlOf,
  enabledIdsOf,
  toolEmulationOf,
  type MiaoshouSettings,
} from './miaoshou-config.ts'

/** 设置文件绝对路径。 */
export function settingsFilePath(): string {
  return join(homedir(), '.dsh', 'dsh-connect-miaoshou.settings.json')
}

/** 只接受本插件认识的键。 */
function normalise(raw: unknown): Partial<MiaoshouSettings> {
  const out: Partial<MiaoshouSettings> = {}
  const ids = enabledIdsOf(raw)
  if (ids !== undefined) out.enabledModelIds = ids
  const tools = (raw as { toolEmulation?: unknown } | undefined)?.toolEmulation
  if (typeof tools === 'boolean') out.toolEmulation = tools
  const base = baseUrlOf(raw)
  if (base !== undefined) out.baseUrl = base
  return out
}

/** 读设置；文件缺失或损坏都返回 `{}`，永不抛。 */
export function readStoredSettings(path: string = settingsFilePath()): Partial<MiaoshouSettings> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    return normalise(JSON.parse(text) as unknown)
  } catch {
    return {}
  }
}

/** 文件设置覆盖 Loader 配置。 */
export function withStoredSettings(config: unknown, path: string = settingsFilePath()): MiaoshouSettings {
  const base: MiaoshouSettings = {
    enabledModelIds: enabledIdsOf(config) ?? [],
    toolEmulation: toolEmulationOf(config),
    baseUrl: baseUrlOf(config) ?? '',
  }
  const stored = readStoredSettings(path)
  return {
    enabledModelIds: stored.enabledModelIds ?? base.enabledModelIds,
    toolEmulation: stored.toolEmulation ?? base.toolEmulation,
    baseUrl: stored.baseUrl ?? base.baseUrl,
  }
}

/** 原子写入单个字段。 */
export function writeStoredSetting(field: string, value: unknown, path: string = settingsFilePath()): void {
  if (
    field !== ENABLED_MODEL_IDS_FIELD
    && field !== TOOL_EMULATION_FIELD
    && field !== BASE_URL_FIELD
  ) {
    throw new Error(`field ${field} is not persistable`)
  }
  const next: Partial<MiaoshouSettings> = { ...readStoredSettings(path) }
  if (field === ENABLED_MODEL_IDS_FIELD) {
    if (!Array.isArray(value) || !value.every(entry => typeof entry === 'string')) {
      throw new Error(`invalid value for ${field}`)
    }
    next.enabledModelIds = value.filter((entry): entry is string => typeof entry === 'string')
  } else if (field === TOOL_EMULATION_FIELD) {
    if (typeof value !== 'boolean') throw new Error(`invalid value for ${field}`)
    next.toolEmulation = value
  } else {
    if (typeof value !== 'string') throw new Error(`invalid value for ${field}`)
    next.baseUrl = value
  }
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid.toString()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    renameSync(temp, path)
  } catch (error: unknown) {
    try { unlinkSync(temp) } catch { /* 已经没了 */ }
    throw error
  }
}
