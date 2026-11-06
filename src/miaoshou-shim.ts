/**
 * 妙手路由的 loopback shim。
 *
 * pi-ai 的 openai-completions API 只认一个 OpenAI 形状的 HTTP 端点，而妙手说的是
 * 「建会话 → 提交一轮 → 订阅事件流」这套私有方言，凭据还来自桌面端的 auth.json
 * 而不是 bearer token。这个 shim 就是两者的边界：在 127.0.0.1 的临时端口上终结
 * OpenAI 请求，再替调用方去说妙手的话。
 *
 * 入站加固层与 `dsh-connect-workbuddy` / `dsh-connect-doubao` 的 shim 保持一致：
 *
 *   * 只绑 127.0.0.1，端口随机；
 *   * Host 头必须指向 loopback（挡掉 DNS-rebinding 页面）；
 *   * 浏览器带来的 Origin 必须是 loopback；
 *   * 进程内共享密钥，常量时间比对，pi-ai 以 `Authorization: Bearer` 携带；
 *     这个密钥永不离开本进程，也永不转发上游；
 *   * chat POST 必须是 `application/json`；
 *   * 请求体有大小上限。
 *
 * 出站的妙手凭据每次请求重新解析（App 重新登录后无需重启插件）。
 *
 * @module dsh-connect-miaoshou/shim
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { loadMiaoshouCredentials, type MiaoshouCredentialResult } from './miaoshou-auth.ts'
import {
  MIAOSHOU_DEFAULT_BASE_URL,
  MiaoshouUpstreamError,
  runMiaoshouTurn,
  type MiaoshouReasoning,
  type MiaoshouTurnMessage,
} from './miaoshou-upstream.ts'
import { MIAOSHOU_DEFAULT_MODEL_ID, MIAOSHOU_MODELS, findMiaoshouModel } from './miaoshou-catalog.ts'

/** 允许的 loopback 主机名。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** 入站请求体上限。妙手的对话请求就是一段文本，超过这个量级只能是滥用。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** 一次请求最长存活时间。 */
const REQUEST_TIMEOUT_MS = 300_000

/** 从 Host/Origin 里剥掉端口与 IPv6 括号。 */
function hostnameOfHost(host: string): string {
  let hostname = host.trim()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon)
  return hostname
}

/**
 * Host 头必须指向 loopback。
 *
 * DNS-rebinding 页面会把攻击者域名重新解析到 127.0.0.1，但 Host 头里仍是它自己的
 * 域名 —— 这一道在任何路由之前就把它们挡掉。
 */
function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/** 浏览器发来的 Origin 必须是 loopback；非浏览器客户端不带 Origin，直接放行。 */
function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}

/** chat POST 必须是 JSON（simple-request CSRF 会在这一道被挡掉）。 */
function isJsonContentType(req: IncomingMessage): boolean {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

/** 妙手失败分类 → HTTP 状态码。 */
const KIND_STATUS: Readonly<Record<MiaoshouUpstreamError['kind'], number>> = {
  auth: 401,
  rate_limited: 429,
  network: 502,
  upstream: 502,
  aborted: 499,
  invalid_request: 400,
}

/** 写 JSON 响应。 */
function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** OpenAI 形状的错误信封，pi-ai 读的就是这个。 */
function writeOpenAIError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { message, type: code, code } })
}

/** shim 的对外接口。 */
export interface MiaoshouShim {
  /** pi-ai 应该指向的 origin（等端口绑定完成）。 */
  baseUrl(): Promise<string>
  /** 同步视图；端口还没绑定时返回 undefined。 */
  baseUrlSync(): string | undefined
  /** 交给 pi-ai 当 OpenAI apiKey 的进程内密钥。 */
  token(): string
  /** 释放端口。 */
  close(): Promise<void>
}

/** 入站 chat 请求里我们关心字段。 */
interface InboundChatRequest {
  model?: string
  messages?: Array<{ role?: string; content?: unknown; name?: string; tool_call_id?: string }>
  stream?: boolean
  temperature?: number
  max_tokens?: number
  /**
   * pi-ai 把 DSH 选择器里的思考档位经 `thinkingLevelMap` 翻译后放在这里
   * （见 `miaoshou-adapter.ts` 的 `thinkingLevelMap`）。取值约定：
   * `'none'` = 关思考，`'on'` = 只有开关的模型「开思考」，其余为真实 effort。
   */
  reasoning_effort?: string
  /** 妙手 agent 链路不消费 OpenAI 的 tools 字段；这里只用于诊断日志。 */
  tools?: unknown[]
}

/**
 * 把 `reasoning_effort` 翻译成妙手的 `thinking` / `effort` 两个参数。
 *
 * 上游对 `effort` 有 enum 校验（非法值会让整轮一帧不出），所以这里再按模型
 * 真实能力过滤一次：目录里没有的能力一律不发送，避免选择器与上游漂移。
 */
function reasoningOf(parsed: InboundChatRequest): MiaoshouReasoning | undefined {
  const requested = parsed.reasoning_effort
  if (requested === undefined || requested === '') return undefined
  const model = findMiaoshouModel(parsed.model)
  if (requested === 'none') {
    // 没有 thinking 参数的模型（GLM 系列）无法显式关思考，只能不发参数。
    return model.thinkingOptions ? { thinking: 'false' } : undefined
  }
  if (requested === 'on') return { thinking: 'true' }
  if (!model.efforts.includes(requested)) {
    // 目录没声明这个等级：宁可不发，也不让上游因为 enum 校验整轮失败。
    return model.thinkingOptions ? { thinking: 'true' } : undefined
  }
  return { thinking: 'true', effort: requested }
}

/** shim 选项。 */
export interface MiaoshouShimOptions {
  /** 每次请求重新解析凭据；默认读 auth.json。 */
  resolveCredentials?: () => MiaoshouCredentialResult
  /** 上游 baseUrl；默认 https://nocode.cn。 */
  baseUrl?: () => string
  /** 是否以 agent 模式请求（远端会自己跑工具）。 */
  isAgent?: () => boolean
}

/** 把 OpenAI content 拍平成纯文本。 */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    const block = raw as { type?: unknown; text?: unknown; image_url?: unknown }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    // 妙手的 messages 只实测过 text 块；图片与文件在这里降级成一行占位，
    // 免得把整个请求 400 掉。模型会看到「有图但看不到」，比静默丢内容诚实。
    if (block.type === 'image_url') parts.push('[图片已省略：妙手接入暂不支持图片输入]')
    if (block.type === 'input_text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 把 OpenAI 的 messages 转成妙手的一轮对话。
 *
 * 三条映射规则，都由上游的实测行为决定：
 *
 *  - 妙手**忽略** `role: "system"`（实测：传了也不生效），所以 system 与
 *    developer 的内容折叠进第一条 user 文本，用 `【系统指令】` 标注；
 *  - `role: "tool"` 变成一行 `[tool result] …`，让模型知道这是工具结果；
 *  - 连续的 assistant 片段合并成一条，因为妙手要求 role 严格交替。
 */
export function buildMiaoshouMessages(messages: InboundChatRequest['messages']): MiaoshouTurnMessage[] {
  const now = Date.now()
  const systemParts: string[] = []
  const turns: MiaoshouTurnMessage[] = []
  const stamp = (offset: number): string => new Date(now + offset).toISOString()

  for (const raw of messages ?? []) {
    const role = raw.role ?? 'user'
    const text = flattenContent(raw.content).trim()
    if (text === '') continue
    if (role === 'system' || role === 'developer') {
      systemParts.push(text)
      continue
    }
    if (role === 'tool') {
      const label = raw.name !== undefined ? `${raw.name} ` : ''
      turns.push({ role: 'user', text: `[tool result] ${label}${text}`, createTime: stamp(turns.length * 2) })
      continue
    }
    const mapped: 'user' | 'assistant' = role === 'assistant' ? 'assistant' : 'user'
    const last = turns[turns.length - 1]
    // 同角色连续出现时合并，避免上游对 role 交替的假设被打破。
    if (last !== undefined && last.role === mapped) {
      last.text = `${last.text}\n\n${text}`
      continue
    }
    turns.push({ role: mapped, text, createTime: stamp(turns.length * 2) })
  }

  if (systemParts.length > 0) {
    const prefix = `【系统指令】\n${systemParts.join('\n\n')}\n\n`
    const firstUser = turns.find(turn => turn.role === 'user')
    if (firstUser !== undefined) {
      firstUser.text = `${prefix}${firstUser.text}`
    } else {
      turns.unshift({ role: 'user', text: prefix.trimEnd(), createTime: stamp(0) })
    }
  }

  // 上游至少要一条 user。
  if (turns.length === 0) turns.push({ role: 'user', text: '(空请求)', createTime: stamp(0) })
  if (turns[turns.length - 1]?.role === 'assistant') {
    turns.push({ role: 'user', text: '请继续。', createTime: stamp(turns.length * 2) })
  }
  return turns
}

/** 一次请求的取消与存活监控。 */
function createLifecycle(res: ServerResponse): {
  signal: AbortSignal
  onActivity: () => void
  clientGone: () => boolean
  release: () => void
} {
  const abort = new AbortController()
  let gone = false
  const onClose = (): void => {
    // 正常结束时也会触发 close；只有在响应还没写完时的 close 才说明调用方走了。
    if (res.writableEnded) return
    gone = true
    abort.abort()
  }
  res.on('close', onClose)
  let timer: ReturnType<typeof setTimeout> | undefined
  const disarm = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  }
  const onActivity = (): void => {
    disarm()
    timer = setTimeout(() => { abort.abort() }, REQUEST_TIMEOUT_MS)
    timer.unref?.()
  }
  const release = (): void => {
    disarm()
    res.off('close', onClose)
  }
  res.once('finish', release)
  res.once('close', release)
  onActivity()
  return { signal: abort.signal, onActivity, clientGone: () => gone, release }
}

/** 构造 shim。 */
export function createMiaoshouShim(options: MiaoshouShimOptions = {}): MiaoshouShim {
  const resolveCredentials = options.resolveCredentials ?? loadMiaoshouCredentials
  const resolveBaseUrl = options.baseUrl ?? ((): string => MIAOSHOU_DEFAULT_BASE_URL)
  const isAgent = options.isAgent ?? ((): boolean => true)

  // 进程内共享密钥，只活在内存里。pi-ai 以 Bearer 发出，shim 校验它，
  // 它不会被转发给妙手 —— 妙手认的是 auth.json 里的 passport 令牌。
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** 常量时间比对；缺失或不匹配一律拒。 */
  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1] as string
    const a = Buffer.from(presented)
    const b = Buffer.from(SHARED_SECRET)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  /** 读取有上限的请求体。 */
  function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let aborted = false
      req.on('data', (chunk: Buffer) => {
        if (aborted) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          aborted = true
          resolve(undefined)
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)) })
      req.on('error', () => { if (!aborted) resolve(undefined) })
    })
  }

  /** 把一次妙手失败翻译成 OpenAI 错误信封。 */
  function writeFailure(res: ServerResponse, error: unknown): void {
    if (res.writableEnded || res.destroyed) return
    const kind: MiaoshouUpstreamError['kind'] = error instanceof MiaoshouUpstreamError ? error.kind : 'network'
    const message = (error as Error)?.message ?? '妙手上游失败'
    const status = KIND_STATUS[kind]
    const retryable = error instanceof MiaoshouUpstreamError ? error.retryable : true
    if (!res.headersSent) res.setHeader('x-should-retry', retryable ? 'true' : 'false')
    const code = kind === 'auth'
      ? 'SESSION_DEAD'
      : (kind === 'rate_limited' ? 'RATE_LIMIT' : (retryable ? 'TIMEOUT' : 'SERVER'))
    writeOpenAIError(res, status, code, message)
  }

  /** 把一轮妙手对话流式回写成 OpenAI SSE。 */
  async function streamCompletion(
    res: ServerResponse,
    turns: MiaoshouTurnMessage[],
    parsed: InboundChatRequest,
    credentials: { token: string },
    lifecycle: ReturnType<typeof createLifecycle>,
  ): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (payload: unknown): void => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(payload)}\n\n`)
    }
    let roleSent = false
    const ensureRole = (): void => {
      if (roleSent) return
      send({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      roleSent = true
    }

    try {
      const reasoning = reasoningOf(parsed)
      const result = await runMiaoshouTurn(
        { baseUrl: resolveBaseUrl(), token: credentials.token, signal: lifecycle.signal },
        {
          messages: turns,
          model: parsed.model ?? MIAOSHOU_DEFAULT_MODEL_ID,
          isAgent: isAgent(),
          ...(reasoning === undefined ? {} : { reasoning }),
          onDelta: (delta) => {
            lifecycle.onActivity()
            ensureRole()
            send({ choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })
          },
        },
      )
      ensureRole()
      // 妙手不返回 token 用量（它按积分计费），但积分消耗可以当作可观测证据，
      // 放在 `usage` 之外的自定义字段里，不影响 OpenAI 客户端解析。
      send({
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        ...(result.creditCost !== undefined
          ? { miaoshou: { creditCost: result.creditCost, conversationId: result.conversationId, model: result.modelName } }
          : {}),
      })
      if (!res.writableEnded) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    } catch (error: unknown) {
      // 客户端已经走了（停止按钮、关窗、宿主退出）：写只会产生 EPIPE 噪音。
      if (lifecycle.clientGone()) return
      const kind = error instanceof MiaoshouUpstreamError ? error.kind : 'network'
      send({
        error: {
          message: (error as Error)?.message ?? '妙手上游失败',
          type: kind === 'auth' ? 'SESSION_DEAD' : (kind === 'rate_limited' ? 'RATE_LIMIT' : 'SERVER'),
        },
      })
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n')
        res.end()
      }
    }
  }

  /** 非流式路径。 */
  async function completeOnce(
    res: ServerResponse,
    turns: MiaoshouTurnMessage[],
    parsed: InboundChatRequest,
    credentials: { token: string },
    lifecycle: ReturnType<typeof createLifecycle>,
  ): Promise<void> {
    const reasoning = reasoningOf(parsed)
    const result = await runMiaoshouTurn(
      { baseUrl: resolveBaseUrl(), token: credentials.token, signal: lifecycle.signal },
      {
        messages: turns,
        model: parsed.model ?? MIAOSHOU_DEFAULT_MODEL_ID,
        isAgent: isAgent(),
        ...(reasoning === undefined ? {} : { reasoning }),
        onDelta: () => { lifecycle.onActivity() },
      },
    )
    writeJson(res, 200, {
      id: `miaoshou-${Date.now().toString()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.modelName ?? parsed.model ?? 'miaoshou',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: result.text === '' ? ' ' : result.text },
        finish_reason: 'stop',
      }],
      ...(result.creditCost !== undefined ? { miaoshou: { creditCost: result.creditCost } } : {}),
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }

      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        writeJson(res, 200, {
          object: 'list',
          data: MIAOSHOU_MODELS.map(model => ({
            id: model.id,
            object: 'model',
            owned_by: model.vendor,
          })),
        })
        return
      }

      const isChat = url.startsWith('/v1/chat/completions')
      if (!isChat || req.method !== 'POST') {
        writeOpenAIError(res, 404, 'not_found', 'unsupported route')
        return
      }
      if (!isJsonContentType(req)) {
        writeOpenAIError(res, 415, 'unsupported_media_type', 'chat requests must be application/json')
        return
      }

      const credentials = resolveCredentials()
      if (!credentials.ok) {
        writeOpenAIError(res, 401, 'SESSION_DEAD', credentials.reason)
        return
      }

      const raw = await readBody(req)
      if (raw === undefined) {
        writeOpenAIError(res, 413, 'payload_too_large', 'request body exceeds the size limit')
        return
      }
      let parsed: InboundChatRequest
      try {
        parsed = JSON.parse(raw.toString('utf8')) as InboundChatRequest
      } catch {
        writeOpenAIError(res, 400, 'invalid_request', 'request body is not valid JSON')
        return
      }

      const turns = buildMiaoshouMessages(parsed.messages)
      const lifecycle = createLifecycle(res)
      try {
        if (parsed.stream === false) {
          await completeOnce(res, turns, parsed, { token: credentials.token }, lifecycle)
        } else {
          await streamCompletion(res, turns, parsed, { token: credentials.token }, lifecycle)
        }
      } finally {
        lifecycle.release()
      }
    } catch (error: unknown) {
      writeFailure(res, error)
    }
  }

  const server: Server = createServer((req, res) => { void handle(req, res) })
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve())
    server.once('error', reject)
  })
  server.listen(0, '127.0.0.1')

  const baseUrlSync = (): string | undefined => {
    const address = server.address()
    if (address === null || typeof address === 'string') return undefined
    return `http://127.0.0.1:${address.port}`
  }

  return {
    async baseUrl() {
      await ready.catch(() => {})
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('miaoshou shim has no listening address')
      return `http://127.0.0.1:${address.port}`
    },
    baseUrlSync,
    token: () => SHARED_SECRET,
    async close() {
      await ready.catch(() => {})
      // server.close() 只停止接受新连接，会等每条存活连接自己结束；一个正在流的
      // 请求或一个 keep-alive 客户端能让 dispose 挂上几分钟，所以先显式丢弃 socket。
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2_000)
        timer.unref?.()
        server.close(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}
