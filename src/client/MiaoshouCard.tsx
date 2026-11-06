/**
 * 妙手连接卡。
 *
 * 一张卡同时做三件事：展示妙手账号的积分与套餐（只读）、列出妙手网关上
 * 真正在售的模型、让用户勾选哪些模型出现在 DSH 的模型选择器里。
 *
 * 所有数据都来自宿主插件的三条 loopback 路由；卡片自己从不读凭据文件，
 * 所以浏览器里永远不会出现令牌。
 *
 * @module dsh-connect-miaoshou/client-card
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactElement } from 'react'

import {
  MIAOSHOU_BASE_URL_FIELD,
  MIAOSHOU_CATALOG_PATH,
  MIAOSHOU_ENABLED_MODELS_FIELD,
  MIAOSHOU_LOGIN_PATH,
  MIAOSHOU_QUOTA_PATH,
  MIAOSHOU_SAVE_PATH,
  MIAOSHOU_WRITE_HEADER,
  baseUrlOf,
  classifyQuotaView,
  enabledModelIdsOf,
  formatContext,
  formatCountdown,
  type MiaoshouAccountState,
  type MiaoshouCatalogView,
  type MiaoshouLoginView,
  type MiaoshouModelEntry,
  type MiaoshouQuotaView,
} from './contract.ts'
import type { Translate } from './locales.ts'
import { MIAOSHOU_CARD_CSS } from './styles.ts'

/** 积分自动刷新的间隔。 */
const POLL_INTERVAL_MS = 30 * 1000

/** 倒计时的刷新节拍。 */
const TICK_MS = 1000

/** 宿主注入给卡片的上下文。 */
export interface MiaoshouCardInjected {
  t: Translate
  settingsScope?: {
    getSnapshot(): { status: string; value?: unknown; writable?: boolean }
    subscribe(listener: () => void): () => void
    set(field: string, value: unknown): Promise<boolean | void>
  }
}

/** 卡片 props。`view` 是宿主 slot 传进来的路由键，这里不用。 */
export type MiaoshouCardProps = Partial<MiaoshouCardInjected> & { view?: string }

type T = Translate

const fallbackT: T = key => key

/** 把样式插进文档一次。 */
function useCardStyles(): void {
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (document.getElementById('msq-card-styles') !== null) return
    const element = document.createElement('style')
    element.id = 'msq-card-styles'
    element.textContent = MIAOSHOU_CARD_CSS
    document.head.appendChild(element)
  }, [])
}

const WRITE_HEADERS: Record<string, string> = { [MIAOSHOU_WRITE_HEADER]: '1' }

/** 读积分。 */
async function fetchQuota(signal?: AbortSignal): Promise<MiaoshouQuotaView | undefined> {
  try {
    const response = await fetch(MIAOSHOU_QUOTA_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    return await response.json() as MiaoshouQuotaView
  } catch {
    return undefined
  }
}

/** 强制刷新积分（POST 会清掉宿主缓存）。 */
async function refreshQuota(signal?: AbortSignal): Promise<MiaoshouQuotaView | undefined> {
  try {
    const response = await fetch(MIAOSHOU_QUOTA_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...WRITE_HEADERS },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    return await response.json() as MiaoshouQuotaView
  } catch {
    return undefined
  }
}

/** 读模型目录。 */
async function fetchCatalog(signal?: AbortSignal): Promise<MiaoshouCatalogView | undefined> {
  try {
    const response = await fetch(MIAOSHOU_CATALOG_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    return await response.json() as MiaoshouCatalogView
  } catch {
    return undefined
  }
}

/** 读登录态。 */
async function fetchLogin(signal?: AbortSignal): Promise<MiaoshouLoginView | undefined> {
  try {
    const response = await fetch(MIAOSHOU_LOGIN_PATH, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    return await response.json() as MiaoshouLoginView
  } catch {
    return undefined
  }
}

/** 发起扫码登录 / 立刻轮询一次 / 登出。 */
async function postLogin(
  action?: 'start' | 'poll' | 'logout',
  signal?: AbortSignal,
): Promise<MiaoshouLoginView | undefined> {
  try {
    const response = await fetch(MIAOSHOU_LOGIN_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json', ...WRITE_HEADERS },
      body: JSON.stringify(action === undefined ? {} : { action }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!response.ok) return undefined
    return await response.json() as MiaoshouLoginView
  } catch {
    return undefined
  }
}

/** 套餐名。 */
function tierLabel(plan: MiaoshouQuotaView['plan'], t: T): string {
  if (plan === null) return t('quota.unknown')
  if (plan.name !== '') return plan.name
  return plan.pro ? t('quota.planPro') : t('quota.planFree')
}

/** 妙手连接卡。 */
export function MiaoshouCard(props: MiaoshouCardProps): ReactElement {
  useCardStyles()
  const t = props.t ?? fallbackT
  const scope = props.settingsScope

  // ---- settings scope ---------------------------------------------------
  const scopedValue = useMemo(() => {
    if (scope === undefined) return undefined
    try {
      return scope.getSnapshot().value
    } catch {
      return undefined
    }
  }, [scope])

  const [stored, setStored] = useState<unknown>(undefined)
  const [storeError, setStoreError] = useState<string | null>(null)
  const [settingsRevision, setSettingsRevision] = useState(0)

  const loadSettings = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch(MIAOSHOU_SAVE_PATH, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const body = await response.json() as { ok?: boolean; value?: unknown }
      setStored(body.value)
      setStoreError(null)
    } catch (error: unknown) {
      setStoreError((error as Error)?.message ?? 'unknown error')
    }
  }, [])

  useEffect(() => { void loadSettings() }, [loadSettings])

  useEffect(() => {
    if (scope === undefined) return undefined
    try {
      return scope.subscribe(() => { setSettingsRevision(previous => previous + 1) })
    } catch {
      return undefined
    }
  }, [scope])

  const configured = stored ?? scopedValue
  // 读到了磁盘（或读失败但宿主路由在）才允许写；否则卡片只读。
  const canWrite = stored !== undefined || storeError === null

  // ---- clock -----------------------------------------------------------
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [])

  // ---- quota -----------------------------------------------------------
  const [quota, setQuota] = useState<MiaoshouQuotaView | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (force: boolean): Promise<void> => {
    const view = force ? await refreshQuota() : await fetchQuota()
    if (view !== undefined) setQuota(view)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => { if (alive) await load(false) })()
    const timer = setInterval(() => { void load(true) }, POLL_INTERVAL_MS)
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [load])

  const onRefresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      await load(true)
    } finally {
      setBusy(false)
    }
  }, [load])

  // ---- catalog ---------------------------------------------------------
  const [catalog, setCatalog] = useState<MiaoshouCatalogView | undefined>(undefined)
  const [catalogBusy, setCatalogBusy] = useState(false)

  const loadCatalog = useCallback(async (): Promise<void> => {
    setCatalogBusy(true)
    try {
      const view = await fetchCatalog()
      if (view !== undefined) setCatalog(view)
    } finally {
      setCatalogBusy(false)
    }
  }, [])

  useEffect(() => { void loadCatalog() }, [loadCatalog])

  const models: MiaoshouModelEntry[] = catalog?.models ?? []

  // ---- draft -----------------------------------------------------------
  const savedIds = useMemo(() => enabledModelIdsOf(configured), [configured])
  const [draft, setDraft] = useState<Set<string> | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  /**
   * 草稿只在「底稿变了」时重建，不在每次点选后重建。
   *
   * 之前这里把 `saved` 放进了依赖并在 `saved === false` 时不 return，结果
   * `toggle()` 里 `setSaved(false)` 触发的重跑立刻把草稿覆盖回磁盘值 ——
   * 表现就是勾选闪一下就没了。改用内容指纹比对：底稿没变就绝不碰草稿。
   */
  const baseIds = savedIds ?? models.map(model => model.id)
  const baseKey = baseIds.join('\n')
  const [draftKey, setDraftKey] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (draftKey === baseKey) return
    setDraft(new Set(baseIds))
    setDraftKey(baseKey)
  }, [baseKey, baseIds, draftKey])

  const dirty = useMemo(() => {
    if (draft === undefined) return false
    const base = new Set(savedIds ?? models.map(model => model.id))
    if (base.size !== draft.size) return true
    for (const id of base) if (!draft.has(id)) return true
    return false
  }, [draft, savedIds, models])

  const toggle = useCallback((id: string): void => {
    setDraft(previous => {
      const next = new Set(previous ?? [])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setSaved(false)
  }, [])

  const selectAll = useCallback((): void => {
    setDraft(new Set(models.map(model => model.id)))
    setSaved(false)
  }, [models])

  const selectNone = useCallback((): void => {
    setDraft(new Set())
    setSaved(false)
  }, [])

  const persistField = useCallback(async (field: string, value: unknown): Promise<unknown> => {
    const response = await fetch(MIAOSHOU_SAVE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...WRITE_HEADERS },
      body: JSON.stringify({ field, value }),
    })
    const body = await response.json() as { ok?: boolean; value?: unknown; error?: string }
    if (response.ok !== true || body.ok === false) throw new Error(body.error ?? `HTTP ${String(response.status)}`)
    setStored(body.value)
    return body.value
  }, [])

  const onSave = useCallback(async (): Promise<void> => {
    if (draft === undefined) return
    setSaveError(null)
    setBusy(true)
    try {
      const ids = [...draft]
      const committed = enabledModelIdsOf(await persistField(MIAOSHOU_ENABLED_MODELS_FIELD, ids))
      // 返回的 value 就是回读，不用再去轮询一个看不到本插件存储的快照。
      if (committed === undefined || committed.length !== ids.length || !ids.every(id => committed.includes(id))) {
        setSaveError(t('models.saveFailed', { reason: '已写入磁盘，但回读的值与提交的不一致' }))
        return
      }
      setSaved(true)
    } catch (error: unknown) {
      setSaveError(t('models.saveFailed', { reason: (error as Error)?.message ?? 'unknown error' }))
    } finally {
      setBusy(false)
    }
  }, [draft, persistField, t])

  // ---- base url --------------------------------------------------------
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null)
  const baseUrl = baseUrlOf(configured)

  const onBaseUrlBlur = useCallback(async (next: string): Promise<void> => {
    setBaseUrlError(null)
    if (baseUrlOf(configured) === next) return
    try {
      await persistField(MIAOSHOU_BASE_URL_FIELD, next)
    } catch (error: unknown) {
      setBaseUrlError(t('diag.saveFailed', { reason: (error as Error)?.message ?? 'unknown error' }))
    }
  }, [configured, persistField, t])

  // ---- 扫码登录 --------------------------------------------------------
  const [login, setLogin] = useState<MiaoshouLoginView | undefined>(undefined)
  const [loginBusy, setLoginBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const view = await fetchLogin()
      if (alive && view !== undefined) setLogin(view)
    })()
    return () => { alive = false }
  }, [])

  // 有进行中的会话时每 2 秒问一次：令牌是服务端轮询拿到的，卡片跟着走就行。
  const waiting = login?.session !== null && login?.session !== undefined && !login.session.completed
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void (async () => {
        const view = await fetchLogin()
        if (view === undefined) return
        setLogin(view)
        if (view.session === null || view.session.completed) {
          // 令牌到了：积分与目录都重读。
          await load(true)
          await loadCatalog()
        }
      })()
    }, 2000)
    return () => { clearInterval(timer) }
  }, [waiting, load, loadCatalog])

  const onStartLogin = useCallback(async (): Promise<void> => {
    setLoginBusy(true)
    try {
      const view = await postLogin('start')
      if (view !== undefined) setLogin(view)
    } finally {
      setLoginBusy(false)
    }
  }, [])

  const onFinishLogin = useCallback(async (): Promise<void> => {
    setLoginBusy(true)
    try {
      const view = await postLogin('poll')
      if (view !== undefined) setLogin(view)
      // 换了令牌就换了账号：积分与目录都要重读。
      await load(true)
      await loadCatalog()
    } finally {
      setLoginBusy(false)
    }
  }, [load, loadCatalog])

  const onLogout = useCallback(async (): Promise<void> => {
    setLoginBusy(true)
    try {
      const view = await postLogin('logout')
      if (view !== undefined) setLogin(view)
      await load(true)
      await loadCatalog()
    } finally {
      setLoginBusy(false)
    }
  }, [load, loadCatalog])

  // ---- render ----------------------------------------------------------
  const state: MiaoshouAccountState = classifyQuotaView(quota)
  const stateText = state === 'ok'
    ? t('account.ok', { name: quota?.account?.name ?? '—' })
    : t(`account.${state}`)
  const stateTone = state === 'ok' ? '' : state === 'exhausted' || state === 'network' ? ' msq-bad' : ' msq-warn'

  const credits = quota?.credits ?? t('quota.unknown')
  const enabledCount = draft?.size ?? 0
  const plan = quota?.plan ?? null

  return (
    <div className="msq-card">
      <div className="msq-head">
        <span className="msq-title">{t('card.title')}</span>
      </div>

      {/* ---- 积分与套餐 ---- */}
      <div className="msq-section">
        <div className="msq-section-title">
          <span>{t('quota.credits')}</span>
          <span className="msq-count">{tierLabel(plan, t)}</span>
        </div>
        <div className="msq-figure">{credits}</div>
        <div className="msq-row-foot">
          <span className="msq-meta">
            {plan === null
              ? t('quota.unknown')
              : plan.expiresAt === null
                ? t('quota.neverExpires')
                : t('quota.expiresAt', { time: formatCountdown((plan.expiresAt ?? 0) - now) })}
          </span>
          <span className="msq-meta">
            {plan === null || plan.nextRefreshAt === null
              ? t('quota.unknown')
              : t('quota.nextRefresh', { time: formatCountdown((plan.nextRefreshAt ?? 0) - now) })}
          </span>
        </div>
        <div className="msq-actions">
          <button type="button" className="msq-btn" onClick={() => void onRefresh()} disabled={busy}>
            {busy ? t('quota.refreshing') : t('quota.refresh')}
          </button>
          <span className="msq-note">{t('quota.autoNote')}</span>
          {quota !== undefined && (
            <span className="msq-meta">{t('quota.updatedAt', { time: formatCountdown(now - quota.fetchedAt) })}</span>
          )}
        </div>
      </div>

      {/* ---- 账号 ---- */}
      <div className="msq-section">
        <div className="msq-section-title">
          <span>{t('account.title')}</span>
          {quota?.account != null && (
            <span className="msq-count">{t('account.uid')}: {quota.account.uid}</span>
          )}
        </div>
        <div className="msq-state">
          <span className={`msq-dot${stateTone}`} />
          <span className="msq-state-text">{stateText}</span>
        </div>
        {login?.source !== null && login?.source !== undefined && (
          <div className="msq-note">
            {login.source === 'passport'
              ? t('account.sourcePassport')
              : login.source === 'ep' ? t('account.sourceEp') : t('account.sourceApp')}
            {login.tokenSavedAt !== null && login.tokenSavedAt !== undefined
              ? ` · ${t('account.tokenSaved')} ${formatCountdown(now - login.tokenSavedAt)}`
              : ''}
          </div>
        )}
        {login?.session !== null && login?.session !== undefined && (
          <div className="msq-note">
            <a href={login.session.link} target="_blank" rel="noreferrer">{t('account.openLink')}</a>
            {' · '}{t('account.loginHint')}
          </div>
        )}
        {waiting && login?.session != null && (
          <div className="msq-note">
            {t('account.waiting', { time: formatCountdown(login.session.remainingMs) })}
          </div>
        )}
        {login?.error !== null && login?.error !== undefined && (
          <div className="msq-error">{t('account.loginFailed', { reason: login.error })}</div>
        )}
        <div className="msq-actions">
          {login?.session == null ? (
            <button
              type="button"
              className="msq-btn msq-primary"
              disabled={loginBusy}
              onClick={() => { void onStartLogin() }}
            >
              {loginBusy ? t('account.loggingIn') : t('account.login')}
            </button>
          ) : (
            <>
              <button
                type="button"
                className="msq-btn msq-primary"
                disabled={loginBusy}
                onClick={() => { void onFinishLogin() }}
              >
                {t('account.loginDone')}
              </button>
              <button
                type="button"
                className="msq-btn"
                disabled={loginBusy}
                onClick={() => { void onLogout() }}
              >
                {t('account.logout')}
              </button>
            </>
          )}
          {login?.session == null && login?.source !== null && login?.source !== undefined && (
            <button
              type="button"
              className="msq-btn"
              disabled={loginBusy}
              onClick={() => { void onLogout() }}
            >
              {t('account.logout')}
            </button>
          )}
        </div>
        {quota?.error !== null && quota?.error !== undefined && (
          <div className="msq-error">{quota.error}</div>
        )}
      </div>

      {/* ---- 模型清单 ---- */}
      <div className="msq-section">
        <div className="msq-section-title">
          <span>{t('models.title')}</span>
          <span className="msq-count">{t('models.enabledCount', { count: enabledCount })}</span>
        </div>
        <div className="msq-note">{t('models.note')}</div>
        {catalog === undefined && <div className="msq-note">{t('models.loadFailed')}</div>}
        {catalog?.ok === true && models.length === 0 && <div className="msq-note">{t('models.empty')}</div>}

        <div className="msq-models">
          {models.map(model => (
            <label key={model.id} className="msq-model">
              <input
                type="checkbox"
                checked={draft?.has(model.id) ?? false}
                disabled={!canWrite || draft === undefined}
                onChange={() => { toggle(model.id) }}
              />
              <span className="msq-model-main">
                <span className="msq-model-name">
                  <span>{model.name}</span>
                  {model.marketingCopy !== null && model.marketingCopy !== ''
                    ? <span className="msq-badge msq-rate-free">{model.marketingCopy}</span>
                    : model.rateLabel !== null && <span className="msq-badge msq-rate">{model.rateLabel}</span>}
                  {model.vendorLabel !== '' && <span className="msq-badge">{model.vendorLabel}</span>}
                  {model.supportsImage && <span className="msq-badge">{t('models.image')}</span>}
                  {model.reasoning && <span className="msq-badge">{t('models.reasoning')}</span>}
                </span>
                <span className="msq-model-desc">
                  {model.contextOptions.length === 0
                    ? ''
                    : t('models.context', { size: formatContext(Math.max(...model.contextOptions)) })}
                  {model.efforts.length > 0 && (
                    <>
                      {model.contextOptions.length === 0 ? '' : ' · '}
                      {t('models.efforts', { levels: model.efforts.join(' / ') })}
                    </>
                  )}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="msq-actions">
          <button type="button" className="msq-btn" onClick={() => void loadCatalog()} disabled={catalogBusy}>
            {catalogBusy ? t('models.refreshing') : t('models.refresh')}
          </button>
          <button type="button" className="msq-btn" onClick={selectAll} disabled={!canWrite}>{t('models.selectAll')}</button>
          <button type="button" className="msq-btn" onClick={selectNone} disabled={!canWrite}>{t('models.selectNone')}</button>
          <button
            type="button"
            className={`msq-btn msq-primary${dirty ? ' msq-dirty' : ''}`}
            onClick={() => void onSave()}
            disabled={!canWrite || !dirty || busy}
          >
            {busy ? t('models.saving') : t('models.save')}
          </button>
          {dirty && <span className="msq-dirty-flag">{t('models.dirty')}</span>}
          {!dirty && saved && <span className="msq-saved">{t('models.saved')}</span>}
          {saveError !== null && <span className="msq-error">{saveError}</span>}
        </div>
      </div>

      {/* ---- 诊断 ---- */}
      <div className="msq-section">
        <div className="msq-section-title"><span>{t('diag.title')}</span></div>
        <div className="msq-row">
          <div className="msq-row-head">
            <span className="msq-label">{t('diag.catalog')}</span>
            <span className="msq-figure-sub">
              {quota?.catalogSize ?? catalog?.models.length ?? 0} · {quota?.catalogSource === 'gateway' ? t('models.sourceGateway') : t('models.sourceBuiltin')}
            </span>
          </div>
        </div>
        <div className="msq-row">
          <div className="msq-row-head">
            <span className="msq-label">{t('diag.baseUrl')}</span>
            <span className="msq-figure-sub">{baseUrl === '' ? t('diag.baseUrlDefault') : baseUrl}</span>
          </div>
          <input
            className="msq-input"
            type="text"
            defaultValue={baseUrl}
            placeholder="https://nocode.cn"
            disabled={!canWrite}
            onBlur={event => void onBaseUrlBlur(event.currentTarget.value.trim())}
          />
          {baseUrlError !== null && <span className="msq-error">{baseUrlError}</span>}
        </div>
        <div className="msq-note">{t('models.source', { source: quota?.catalogSource === 'gateway' ? t('models.sourceGateway') : t('models.sourceBuiltin') })}</div>
      </div>

      {/* now 参与渲染，倒计时才会每秒走；不给它单独一节。 */}
      <span className="msq-meta" hidden>{`rev=${settingsRevision} now=${now}`}</span>
    </div>
  )
}
