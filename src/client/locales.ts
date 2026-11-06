/**
 * 妙手插件卡片的双语文案。
 *
 * 与参考连接器同一套系统：每种语言一张扁平 key 表，注册时绑定一个 `t`。
 * key 就是契约 —— `Translate` 按 `zh` 的 key 定型，所以只加在一边会变成类型
 * 错误而不是运行时的 `undefined`。
 *
 * @module dsh-connect-miaoshou/client-locales
 */

/** 中文文案。key 集合即契约。 */
export const zh = {
  'card.title': '妙手连接',
  'card.navLabel': '妙手',

  'quota.credits': '可用积分',
  'quota.plan': '套餐',
  'quota.planPro': '专业版',
  'quota.planFree': '免费版',
  'quota.refresh': '刷新',
  'quota.refreshing': '刷新中…',
  'quota.autoNote': '每 30 秒自动刷新',
  'quota.updatedAt': '更新于 {time}',
  'quota.expiresAt': '{time} 后到期',
  'quota.neverExpires': '不限时',
  'quota.nextRefresh': '{time} 后发放',
  'quota.unknown': '—',

  'account.title': '账号状态',
  'account.ok': '已连接 {name}',
  'account.signed_out': '未登录：请在妙手客户端登录后重试',
  'account.unreadable': '登录信息读不出来：本机凭据文件无法解析，请检查妙手客户端是否已登录',
  'account.session_dead': '登录态已失效：请在妙手客户端重新登录',
  'account.exhausted': '积分已用尽：可在妙手客户端查看套餐',
  'account.network': '连接妙手失败：请检查网络后重试',
  'account.unknown': '状态未知',
  'account.uid': '账号 ID',
  'account.sourcePassport': '令牌来自扫码登录',
  'account.sourceApp': '令牌来自妙手客户端',
  'account.sourceEp': '令牌来自 ep',
  'account.login': '登录',
  'account.loggingIn': '正在申请登录链接…',
  'account.loginHint': '点开链接，在浏览器里扫码确认；完成后会自动完成登录。',
  'account.loginDone': '我已完成授权',
  'account.loginFailed': '登录失败：{reason}',
  'account.openLink': '打开登录链接',
  'account.logout': '退出登录',
  'account.waiting': '等待扫码…还剩 {time}',
  'account.tokenSaved': '登录令牌已保存',

  'models.title': '模型',
  'models.enabledCount': '已启用 {count} 个',
  'models.note': '清单与妙手 App 的模型选择器一致（12 个）。勾选决定该模型是否出现在 DSH 的模型选择器里；妙手上新模型后这里会自动跟着变。',
  'models.refresh': '刷新',
  'models.refreshing': '刷新中…',
  'models.save': '保存',
  'models.saving': '保存中…',
  'models.discard': '放弃更改',
  'models.selectAll': '全选',
  'models.selectNone': '全不选',
  'models.dirty': '有未保存的更改',
  'models.saved': '已保存',
  'models.saveFailed': '保存失败：{reason}',
  'models.source': '来源：{source}',
  'models.sourceGateway': '网关（实时）',
  'models.sourceBuiltin': '内置（离线兜底）',
  'models.image': '图片',
  'models.noImage': '纯文本',
  'models.reasoning': '思考',
  'models.efforts': '思考等级 {levels}',
  'models.context': '上下文 {size}',
  'models.loadFailed': '模型目录读取失败',
  'models.empty': '没有可用的模型条目',

  'diag.title': '诊断',
  'diag.catalog': '目录条数',
  'diag.baseUrl': '上游地址',
  'diag.baseUrlDefault': '默认（nocode.cn）',
  'diag.saveFailed': '设置保存失败：{reason}',
} as const

/** 中文 key 契约。 */
export type MiaoshouCardKey = keyof typeof zh

/** 英文文案。 */
export const en: Record<MiaoshouCardKey, string> = {
  'card.title': 'Miaoshou Connect',
  'card.navLabel': 'Miaoshou',

  'quota.credits': 'Credits',
  'quota.plan': 'Plan',
  'quota.planPro': 'Pro',
  'quota.planFree': 'Free',
  'quota.refresh': 'Refresh',
  'quota.refreshing': 'Refreshing…',
  'quota.autoNote': 'Auto-refresh every 30s',
  'quota.updatedAt': 'Updated {time}',
  'quota.expiresAt': 'Expires in {time}',
  'quota.neverExpires': 'No expiry',
  'quota.nextRefresh': 'Refills in {time}',
  'quota.unknown': '—',

  'account.title': 'Account',
  'account.ok': 'Connected as {name}',
  'account.signed_out': 'Not signed in: sign in from the Miaoshou app and retry',
  'account.unreadable': 'Credentials unreadable: the local auth file could not be parsed',
  'account.session_dead': 'Session expired: sign in again in the Miaoshou app',
  'account.exhausted': 'Credits exhausted: check the plan in the Miaoshou app',
  'account.network': 'Cannot reach Miaoshou: check your network and retry',
  'account.unknown': 'Unknown state',
  'account.uid': 'Account ID',
  'account.sourcePassport': 'Token from QR sign-in',
  'account.sourceApp': 'Token from the Miaoshou app',
  'account.sourceEp': 'Token from ep',
  'account.login': 'Sign in',
  'account.loggingIn': 'Requesting a sign-in link…',
  'account.loginHint': 'Open the link and confirm the QR code in your browser; sign-in completes automatically.',
  'account.loginDone': 'I have authorized',
  'account.loginFailed': 'Sign-in failed: {reason}',
  'account.openLink': 'Open sign-in link',
  'account.logout': 'Sign out',
  'account.waiting': 'Waiting for the QR scan… {time} left',
  'account.tokenSaved': 'Sign-in token saved',

  'models.title': 'Models',
  'models.enabledCount': '{count} enabled',
  'models.note': 'The list mirrors the Miaoshou app model picker (12 entries). Ticking an entry decides whether it shows up in the DSH model picker; it follows the app when Miaoshou adds a model.',
  'models.refresh': 'Refresh',
  'models.refreshing': 'Refreshing…',
  'models.save': 'Save',
  'models.saving': 'Saving…',
  'models.discard': 'Discard changes',
  'models.selectAll': 'Select all',
  'models.selectNone': 'Select none',
  'models.dirty': 'Unsaved changes',
  'models.saved': 'Saved',
  'models.saveFailed': 'Save failed: {reason}',
  'models.source': 'Source: {source}',
  'models.sourceGateway': 'gateway (live)',
  'models.sourceBuiltin': 'built-in (offline)',
  'models.image': 'Image',
  'models.noImage': 'Text only',
  'models.reasoning': 'Thinking',
  'models.efforts': 'Thinking levels: {levels}',
  'models.context': 'Context {size}',
  'models.loadFailed': 'Failed to read the model catalog',
  'models.empty': 'No model entries available',

  'diag.title': 'Diagnostics',
  'diag.catalog': 'Catalog size',
  'diag.baseUrl': 'Upstream',
  'diag.baseUrlDefault': 'default (nocode.cn)',
  'diag.saveFailed': 'Failed to save settings: {reason}',
}

/** 翻译函数。 */
export type Translate = (key: MiaoshouCardKey, vars?: Record<string, string | number>) => string

/** 把 `{var}` 占位符替换掉。 */
export function translator(table: Record<string, string>): Translate {
  return (key, vars) => {
    const template = table[key] ?? key
    if (vars === undefined) return template
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name: string) => {
      const value = vars[name]
      return value === undefined ? match : String(value)
    })
  }
}

/** 卡片文案的 locale 命名空间。 */
export const NAMESPACE = 'settings.miaoshou'
