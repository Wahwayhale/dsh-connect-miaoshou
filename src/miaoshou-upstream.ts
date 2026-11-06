/**
 * 妙手上游：nocode.cn 的三步对话链路。
 *
 * 妙手桌面端没有 OpenAI 兼容端点，它的对话是「创建会话 → 提交一轮 → 订阅事件流」
 * 三步拼起来的。以下是实测 2026-11-05 跑通的形状（base `https://nocode.cn`）：
 *
 *   1. POST /api/chat/create
 *      { chatId, source:'catdesk', prompt, images:[], files:[],
 *        type:'COMMON', techStackTemplateId:'default', isAgent }
 *      → { code:0, data:{ chatId, title, ideId, ideUrl, renderUrl, misId } }
 *
 *   2. POST /api/chat/agent-stream
 *      { chatId, messages:[{role,content:[{type:'text',text}],createTime}],
 *        files:[], urls:[], model, manualToolName:'', toolMessageId:'',
 *        isAgent, currentPath:'/', techStackTemplateId:'default',
 *        sourcePlatform:'web', isImportProject:false, frontCreateTime }
 *      → { code:0, data:{ conversationId, roundId, streamMessageId,
 *                          userMessageId, assistantMessageId, success } }
 *
 *   3. POST /api/agent/stream/connect   （SSE）
 *      { timestamp, conversationId, messageIndex, incrementalOnly:false }
 *      → 逐帧 `{"headlessRemoteAgentResp":{...}}`
 *
 * 三个必须照做的细节，全是踩出来的：
 *
 *  - 鉴权头是 `access-token: <raw>` + `client-id: catdesk`；第 3 步还要额外带
 *    `X-Passport-Token` 与 `Cookie: X-Passport-Token=<token>`。`X-Auth-Token`
 *    是**另一个**域名（catx.nocode.cn 网关）的头，在这里无效。
 *  - `incrementalOnly` 必须是 `false`，否则服务端只回最后一帧，没有逐字增量。
 *  - SSE 帧里 `data:` 和 JSON 会被切成两个 chunk，因此**先按 `\n\n` 分帧**，
 *    再在帧内找 `data:` 后的 JSON；按行切会丢 JSON。
 *
 * 多轮：同一个 conversationId 只有 `messageIndex:0` 能拿到回复（实测 1/2 回空）。
 * 因此本插件**每轮新建 chatId**，并把完整历史塞进 `messages` —— 历史才是模型
 * 真正看到的上下文，`messageIndex` 不参与。
 *
 * @module dsh-connect-miaoshou/upstream
 */

/** 上游默认地址；`baseUrl` 设置项可覆盖（测试环境调试用）。 */
export const MIAOSHOU_DEFAULT_BASE_URL = 'https://nocode.cn'

/** 对话链路客户端 id，妙手桌面端自己用的就是这个。 */
const CLIENT_ID = 'catdesk'

/** 单轮整体超时：模型首字慢时也要留够余量。 */
const TURN_TIMEOUT_MS = 300_000

/** 两次 SSE 帧之间允许的最长静默，超过视为断流。 */
const STREAM_IDLE_TIMEOUT_MS = 180_000

/** 一条已经成形的对话消息（插件内部形状）。 */
export interface MiaoshouTurnMessage {
  role: 'user' | 'assistant'
  text: string
  /** ISO 时间；妙手要求每条消息带 createTime。 */
  createTime: string
}

/** 一轮对话的结果。 */
export interface MiaoshouTurnResult {
  /** 拼接好的完整回复文本。 */
  text: string
  /** 妙手侧会话 id。 */
  conversationId: string
  /** 妙手侧轮次号。 */
  roundId: number | undefined
  /** 本轮消耗的积分（字符串小数，服务端原样给出）。 */
  creditCost: string | undefined
  /** 服务端回显的实际模型名（如 `deepseek-v4-flash-0731`）。 */
  modelName: string | undefined
}

/** 上游失败的分类；决定重试策略与 HTTP 状态码。 */
export type MiaoshouErrorKind =
  | 'auth' // 登录态缺失/失效，重试无意义
  | 'rate_limited' // 限流或积分不足
  | 'network' // 连接失败/断流
  | 'upstream' // 上游业务错误
  | 'aborted' // 调用方取消
  | 'invalid_request'

/** 带分类的上游错误。 */
export class MiaoshouUpstreamError extends Error {
  readonly kind: MiaoshouErrorKind
  readonly retryable: boolean
  readonly httpStatus: number | undefined
  readonly detail: string | undefined

  constructor(
    kind: MiaoshouErrorKind,
    message: string,
    extra: { retryable?: boolean; httpStatus?: number; detail?: string } = {},
  ) {
    super(message)
    this.name = 'MiaoshouUpstreamError'
    this.kind = kind
    this.retryable = extra.retryable ?? (kind === 'network' || kind === 'rate_limited')
    this.httpStatus = extra.httpStatus
    this.detail = extra.detail
  }
}

/** 造一个妙手格式的 chatId（`desk-` + 两段随机串）。 */
export function newChatId(): string {
  const rand = (): string => Math.random().toString(36).slice(2, 10).padEnd(8, '0')
  return `desk-${rand()}${rand()}`
}

/** 一次调用所需的上下文。 */
export interface MiaoshouRequestContext {
  /** 上游根地址（已去尾斜杠）。 */
  baseUrl: string
  /** 原始 accessToken（不带 Bearer）。 */
  token: string
  /** 取消信号。 */
  signal?: AbortSignal | undefined
}

/** 普通 JSON 请求的头。 */
function jsonHeaders(token: string): Record<string, string> {
  return {
    'access-token': token,
    'client-id': CLIENT_ID,
    'content-type': 'application/json',
  }
}

/** SSE 请求的头（在 JSON 头之上补 passport 双写）。 */
function sseHeaders(token: string): Record<string, string> {
  return {
    ...jsonHeaders(token),
    'X-Passport-Token': token,
    cookie: `X-Passport-Token=${token}`,
    accept: 'text/event-stream',
  }
}

/** 把上游的 `{code,message,msg,data}` 拆开。 */
interface GatewayEnvelope<T> {
  code?: number
  message?: string
  msg?: string
  data?: T
}

/** 一次 POST，返回解析后的信封；HTTP 非 2xx 也尽量读出 body 里的错误信息。 */
async function postJson<T>(
  ctx: MiaoshouRequestContext,
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<GatewayEnvelope<T>> {
  let response: Response
  try {
    response = await fetch(`${ctx.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    })
  } catch (error: unknown) {
    if ((error as Error)?.name === 'AbortError') {
      throw new MiaoshouUpstreamError('aborted', '已取消', { retryable: false })
    }
    throw new MiaoshouUpstreamError('network', `连接妙手失败：${(error as Error)?.message ?? 'unknown'}`, {
      retryable: true,
      detail: path,
    })
  }

  const raw = await response.text()
  let parsed: GatewayEnvelope<T> | undefined
  try {
    parsed = JSON.parse(raw) as GatewayEnvelope<T>
  } catch {
    parsed = undefined
  }

  if (response.status === 401 || response.status === 403) {
    throw new MiaoshouUpstreamError(
      'auth',
      '妙手登录态失效，请在妙手桌面端重新登录后再试。',
      { retryable: false, httpStatus: response.status, detail: raw.slice(0, 300) },
    )
  }
  if (response.status === 429) {
    throw new MiaoshouUpstreamError('rate_limited', '妙手限流或积分不足，请稍后再试。', {
      retryable: true,
      httpStatus: 429,
      detail: raw.slice(0, 300),
    })
  }
  if (parsed === undefined) {
    throw new MiaoshouUpstreamError(
      response.ok ? 'upstream' : 'network',
      `妙手返回了非 JSON 响应（HTTP ${response.status.toString()}）`,
      { httpStatus: response.status, detail: raw.slice(0, 300) },
    )
  }
  if (!response.ok) {
    throw new MiaoshouUpstreamError(
      'upstream',
      `妙手接口失败（HTTP ${response.status.toString()}）：${parsed.message ?? parsed.msg ?? raw.slice(0, 200)}`,
      { httpStatus: response.status, detail: raw.slice(0, 300) },
    )
  }
  return parsed
}

/** 第 1 步：建会话。失败不致命（妙手对已存在的 chatId 是幂等的）。 */
async function createChat(
  ctx: MiaoshouRequestContext,
  chatId: string,
  prompt: string,
  isAgent: boolean,
): Promise<void> {
  const envelope = await postJson<unknown>(ctx, '/api/chat/create', {
    chatId,
    source: 'catdesk',
    prompt,
    images: [],
    files: [],
    type: 'COMMON',
    techStackTemplateId: 'default',
    isAgent,
  }, jsonHeaders(ctx.token))
  if (envelope.code !== undefined && envelope.code !== 0) {
    throw new MiaoshouUpstreamError(
      'upstream',
      `妙手建会话失败：${envelope.message ?? envelope.msg ?? `code=${envelope.code.toString()}`}`,
      { retryable: false },
    )
  }
}

/** 妙手的两个思考参数，原样透传给 `/api/chat/agent-stream` 的 `modelParams`。 */
export interface MiaoshouReasoning {
  /** `thinking` 参数的字符串形式（妙手侧是 BOOLEAN 但取值是 `'true'`/`'false'`）。 */
  thinking: 'true' | 'false'
  /** `effort` 参数（`low` / `high` / `max` …）；缺省表示不发送该字段。 */
  effort?: string
}

/** 把思考参数打包成 agent-stream body 顶层的 `modelParams`。 */
function modelParamsOf(reasoning: MiaoshouReasoning | undefined): Record<string, unknown> {
  if (reasoning === undefined) return {}
  const declarativeParams: Record<string, string> = { thinking: reasoning.thinking }
  if (reasoning.effort !== undefined && reasoning.effort !== '') declarativeParams.effort = reasoning.effort
  return { modelParams: { declarativeParams, routingMode: 'CUSTOM' } }
}

/** 第 2 步：提交一轮，拿到 conversationId。 */
async function startRound(
  ctx: MiaoshouRequestContext,
  input: {
    chatId: string
    messages: MiaoshouTurnMessage[]
    model: string
    isAgent: boolean
    reasoning?: MiaoshouReasoning
  },
): Promise<{ conversationId: string; roundId: number | undefined }> {
  const envelope = await postJson<{
    conversationId?: string
    roundId?: number
  }>(ctx, '/api/chat/agent-stream', {
    chatId: input.chatId,
    messages: input.messages.map(message => ({
      role: message.role,
      content: [{ type: 'text', text: message.text }],
      createTime: message.createTime,
    })),
    files: [],
    urls: [],
    model: input.model,
    manualToolName: '',
    toolMessageId: '',
    isAgent: input.isAgent,
    currentPath: '/',
    techStackTemplateId: 'default',
    sourcePlatform: 'web',
    isImportProject: false,
    frontCreateTime: Date.now(),
    // 思考等级 / 思考开关。**必须是 body 的顶层字段**：实测把它包进
    // `modelContext` 或把 `declarativeParams` 直接摊到顶层都会让事件流
    // 一帧不出（60s 空转）。
    ...modelParamsOf(input.reasoning),
  }, jsonHeaders(ctx.token))

  if (envelope.code !== undefined && envelope.code !== 0) {
    throw new MiaoshouUpstreamError(
      'upstream',
      `妙手提交失败：${envelope.message ?? envelope.msg ?? `code=${envelope.code.toString()}`}`,
      { retryable: false },
    )
  }
  const conversationId = envelope.data?.conversationId
  if (typeof conversationId !== 'string' || conversationId === '') {
    throw new MiaoshouUpstreamError('upstream', '妙手没有返回 conversationId', { retryable: false })
  }
  return { conversationId, roundId: envelope.data?.roundId }
}

/** SSE 里一帧 `headlessRemoteAgentResp` 我们关心的字段。 */
interface AgentStreamFrame {
  isHistoryMessage?: boolean
  historyMessages?: unknown[]
  roundInfo?: Array<{ round?: number; creditCost?: string }>
  currentStatus?: string
  statusUpdate?: string
  message?: {
    content?: Array<{ type?: string; text?: string }>
    finished?: boolean
    model?: string
    modelDisplayName?: string
    messageId?: string
  }
}

/** 一帧 SSE 的解析结果：文本增量或元数据。 */
export type AgentStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; creditCost?: string; modelName?: string }
  | { type: 'meta'; creditCost?: string; modelName?: string }

/** 从 `headlessRemoteAgentResp` 抽出所有 text 块。 */
function textOf(frame: AgentStreamFrame): string {
  const blocks = frame.message?.content
  if (!Array.isArray(blocks)) return ''
  // agent 模式下 content 可能混入 tool_use 之类的非文本块，必须过滤。
  return blocks.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

/**
 * 把一帧原始 SSE 文本解析成事件。
 *
 * 帧的形状是 `data:{json}`，但服务端可能把 `data:` 与 JSON 拆到两个 chunk，
 * 所以这里用正则吃掉任意空白后取 JSON。
 */
export function parseFrame(raw: string): AgentStreamEvent | undefined {
  const match = /^data:\s*(\{[\s\S]*\})$/m.exec(raw.trim())
  if (match === null) return undefined
  let parsed: { headlessRemoteAgentResp?: AgentStreamFrame; statusUpdate?: string }
  try {
    parsed = JSON.parse(match[1] as string) as {
      headlessRemoteAgentResp?: AgentStreamFrame
      statusUpdate?: string
    }
  } catch {
    return undefined
  }
  // 结束帧 `{"statusUpdate":"completed"}` 是顶层对象，**不在**
  // `headlessRemoteAgentResp` 包裹里。漏掉它会让流一直挂到空闲超时。
  if (parsed.statusUpdate === 'completed') return { type: 'done' }
  const frame = parsed.headlessRemoteAgentResp
  if (frame === undefined) return undefined

  if (frame.statusUpdate === 'completed') {
    return { type: 'done' }
  }
  if (Array.isArray(frame.roundInfo)) {
    const last = frame.roundInfo[frame.roundInfo.length - 1]
    if (last?.creditCost !== undefined) return { type: 'meta', creditCost: last.creditCost }
    return undefined
  }
  // 历史帧、状态帧没有增量内容。
  if (frame.isHistoryMessage === true) return undefined
  if (frame.message !== undefined) {
    const text = textOf(frame)
    const modelName = frame.message.model
    if (text !== '') return { type: 'delta', text }
    if (frame.message.finished === true) {
      return modelName === undefined ? { type: 'done' } : { type: 'done', modelName }
    }
  }
  return undefined
}

/**
 * 第 3 步：订阅事件流。
 *
 * 这是一个异步生成器，调用方每拿到一个 `delta` 就可以立刻推给 DSH。生成器
 * 结束时 `done` 事件已经发出，调用方只需读 `result`。
 */
export async function* streamRound(
  ctx: MiaoshouRequestContext,
  conversationId: string,
  state: { creditCost?: string; modelName?: string },
): AsyncGenerator<{ type: 'delta'; text: string }, void, undefined> {
  const controller = new AbortController()
  const timeout = setTimeout(() => { controller.abort() }, TURN_TIMEOUT_MS)
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { controller.abort() }, STREAM_IDLE_TIMEOUT_MS)
  }
  const onOuterAbort = (): void => { controller.abort() }
  ctx.signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    let response: Response
    try {
      response = await fetch(`${ctx.baseUrl}/api/agent/stream/connect`, {
        method: 'POST',
        headers: sseHeaders(ctx.token),
        body: JSON.stringify({
          timestamp: Date.now(),
          conversationId,
          messageIndex: 0,
          incrementalOnly: false,
        }),
        signal: controller.signal,
      })
    } catch (error: unknown) {
      if (ctx.signal?.aborted === true) {
        throw new MiaoshouUpstreamError('aborted', '已取消', { retryable: false })
      }
      throw new MiaoshouUpstreamError('network', `订阅妙手事件流失败：${(error as Error)?.message ?? 'unknown'}`, {
        retryable: true,
      })
    }

    if (!response.ok || response.body === null) {
      const detail = await response.text().catch(() => '')
      throw new MiaoshouUpstreamError(
        response.status === 401 || response.status === 403 ? 'auth' : 'upstream',
        `妙手事件流不可用（HTTP ${response.status.toString()}）`,
        { httpStatus: response.status, detail: detail.slice(0, 300), retryable: response.status >= 500 },
      )
    }

    armIdle()
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    // 妙手逐帧给出「整段已生成文本」而不是增量片段，所以自己算差量。
    let emitted = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      armIdle()
      buffer += decoder.decode(value, { stream: true })
      // 关键：先按空行分帧，再把跨 chunk 的残帧留在 buffer 里。
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const raw of frames) {
        const event = parseFrame(raw)
        if (event === undefined) continue
        if (event.type === 'meta') {
          if (event.creditCost !== undefined) state.creditCost = event.creditCost
          if (event.modelName !== undefined) state.modelName = event.modelName
          continue
        }
        if (event.type === 'done') {
          if (event.modelName !== undefined) state.modelName = event.modelName
          return
        }
        const full = event.text
        if (full.length > emitted.length) {
          yield { type: 'delta', text: full.slice(emitted.length) }
          emitted = full
        }
      }
    }
  } catch (error: unknown) {
    if ((error as Error)?.name === 'AbortError') {
      throw new MiaoshouUpstreamError(
        ctx.signal?.aborted === true ? 'aborted' : 'network',
        ctx.signal?.aborted === true ? '已取消' : '妙手事件流超时或被中断',
        { retryable: ctx.signal?.aborted !== true },
      )
    }
    throw error
  } finally {
    clearTimeout(timeout)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    ctx.signal?.removeEventListener('abort', onOuterAbort)
  }
}

/** 完整跑一轮：建会话 → 提交 → 订阅，逐字回调。 */
export async function runMiaoshouTurn(
  ctx: MiaoshouRequestContext,
  input: {
    messages: MiaoshouTurnMessage[]
    model: string
    isAgent: boolean
    /** 思考开关与思考等级；缺省表示由妙手用 App 的默认值。 */
    reasoning?: MiaoshouReasoning
    /** 每收到一段增量就调一次。 */
    onDelta: (text: string) => void
  },
): Promise<MiaoshouTurnResult> {
  const chatId = newChatId()
  const prompt = input.messages[input.messages.length - 1]?.text ?? ''
  await createChat(ctx, chatId, prompt, input.isAgent)
  const started = await startRound(ctx, {
    chatId,
    messages: input.messages,
    model: input.model,
    isAgent: input.isAgent,
    ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
  })

  const state: { creditCost?: string; modelName?: string } = {}
  let text = ''
  for await (const delta of streamRound(ctx, started.conversationId, state)) {
    text += delta.text
    input.onDelta(delta.text)
  }
  return {
    text,
    conversationId: started.conversationId,
    roundId: started.roundId,
    creditCost: state.creditCost,
    modelName: state.modelName,
  }
}
