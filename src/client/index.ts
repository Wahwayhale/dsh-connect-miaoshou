/**
 * 浏览器半边：设置页里的「妙手」卡片。
 *
 * 注册形状照抄参考连接器：`slots` / `locale` 注入、`name`/`key`/`priority`
 * 的 slot 注册、每个 slot 单独 try/catch —— 宿主 API 变了就退化成一个
 * console.error，而不是整页报「插件加载失败」。
 *
 * `inject` 只列两个每条宿主线都提供的服务。Cordis 的依赖闸是硬的：写上一个
 * 本宿主没有的服务，`apply` 直接不跑。所以设置面板用 `ctx.get()` 软探测。
 *
 * @module dsh-connect-miaoshou/client
 */
import type { Context } from '@deepseek-ai/cordis'
// 仅类型导入：这些模块 augment 了 Cordis 的 `LocaleNamespaceMap`，并声明了
// `slots` / `locale` 服务。哪条宿主线带它们就由哪条提供；运行时不 import。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { MiaoshouCard } from './MiaoshouCard.tsx'
import type { MiaoshouCardInjected } from './MiaoshouCard.tsx'
import { NAMESPACE, en, zh, translator } from './locales.ts'
import type { MiaoshouCardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 妙手插件卡片文案。 */
    'settings.miaoshou': MiaoshouCardKey
  }
}

/** 本入口要求的客户端服务；两条宿主线都有。 */
export type MiaoshouClientContext = Context & {
  slots: Context['slots']
  locale: Context['locale']
}

/** 稳定的浏览器插件名。 */
export const name = 'dsh-connect-miaoshou-client'

/** 只列普遍可用的两个座位。 */
export const inject = ['slots', 'locale']

/**
 * 注册卡片文案与卡片本体。
 *
 * 两层 try/catch：整个函数体一层，每个 slot 注册各一层。渲染不了的卡片绝不
 * 能拖垮页面 —— 宿主 provider 不带卡片也能正常提供模型。
 */
export function apply(ctx: MiaoshouClientContext): void {
  try {
    ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'dsh-connect-miaoshou: card copy')
    const t = ctx.locale.bind(NAMESPACE) as MiaoshouCardInjected['t']

    /**
     * 软探测服务。
     *
     * 读未声明的服务属性会 **抛**（"cannot get property X without inject"），
     * `?.` 挡的是 null/undefined，挡不住抛的 getter。所以设置座位必须用
     * `ctx.get()`，它在服务缺席时返回 undefined。
     */
    const softGet = (key: string): unknown =>
      (ctx as unknown as { get(name: string): unknown }).get(key)

    let settingsScope: MiaoshouCardInjected['settingsScope'] | undefined
    const forms = softGet('configForms') as
      | {
          describe(): { getSnapshot(): { view?: { namespaces?: { ns: string }[] } } }
          get(ns: string): MiaoshouCardInjected['settingsScope']
        }
      | undefined
    if (forms !== undefined) {
      // 宿主实际服务的命名空间由宿主决定：profile patch 可能把这个 bundle 挂成
      // `dsh-connect-miaoshou`，也可能挂成 include。别猜 —— 问镜像。宿主按精确
      // 匹配解析 provider 的命名空间，猜错就绑到一个没人服务的 ns，写路径死掉。
      let ns = 'dsh-connect-miaoshou'
      try {
        const namespaces = forms.describe().getSnapshot().view?.namespaces ?? []
        const served = namespaces.find(entry => entry.ns === ns || /miaoshou/i.test(entry.ns))
        if (served !== undefined) ns = served.ns
      } catch {
        // 镜像还没填充：声明的 id 仍然是正确的。
      }
      settingsScope = forms.get(ns)
    }

    const registerCard = (slotName: string, key: string): void => {
      try {
        ctx.slots.inject(slotName as never, () => (ctx.slots as unknown as {
          register(
            options: { name: string; key: string; priority: number; inject: () => MiaoshouCardInjected },
            component: unknown,
          ): () => void
        }).register({
          name: slotName,
          key,
          priority: 30,
          // `inject` 提供 PROPS，不 import 任何东西。卡片写成只靠 `t` 也能跑，
          // 所以没有设置座位的宿主照样渲染一张可用的只读卡片。
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, MiaoshouCard))
      } catch (error: unknown) {
        // 按 slot 隔离：一个注册失败不能把另一个带下去。
        console.error(`[dsh-connect-miaoshou] card slot "${slotName}" failed to register (host provider unaffected):`, error)
      }
    }

    registerCard('plugins.bundle.config', 'dsh-connect-miaoshou')
    registerCard('plugins.row.config', 'dsh-connect-miaoshou#dsh-connect-miaoshou')

    /**
     * 设置左导航的顶层条目。
     *
     * `settings.section` 是宿主自己的设置导航行槽，由
     * `@deepseek-ai/dsh-client-ui-settings-general` 声明；`SettingsRoot` 的
     * `renderSlot("settings.section", {...}, { only: active })` 意味着只有用户
     * 点中的那一节才被挂载。
     *
     * 描述字段是 `id` / `order` / `label` / `inject`，**不是** `plugins.*` 那套
     * `key` / `priority`。DSH 0.1.x 只投影 `id`/`order`/`label`，没有 icon
     * 字段，所以宿主给插件行画一个通用齿轮。
     *
     * `order: 40` 让妙手排在专家团（50）之上。
     */
    const registerSettingsSection = (): void => {
      try {
        ctx.slots.inject('settings.section' as never, () => (ctx.slots as unknown as {
          register(
            options: {
              name: string
              id: string
              order: number
              label: () => string
              inject?: () => MiaoshouCardInjected
            },
            component: unknown,
          ): () => void
        }).register({
          name: 'settings.section',
          id: 'dsh-connect-miaoshou',
          order: 40,
          label: () => t('card.navLabel'),
          inject: () => settingsScope === undefined
            ? { t }
            : { t, settingsScope },
        }, MiaoshouCard))
      } catch (error: unknown) {
        console.error('[dsh-connect-miaoshou] settings.section failed to register (host provider unaffected):', error)
      }
    }

    registerSettingsSection()
  } catch (error: unknown) {
    // 页面上安静退化；开发者能在控制台看到原因。
    console.error('[dsh-connect-miaoshou] client card failed to load (host provider unaffected):', error)
  }
}

export { MiaoshouCard } from './MiaoshouCard.tsx'
export { en, zh, translator } from './locales.ts'
