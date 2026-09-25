/**
 * 大模型请求层（OpenAI 兼容 /chat/completions）
 *
 * - 开发模式（Vite dev）：请求同源 /llm-proxy/*（如 /chat/completions、/models），并通过
 *   x-llm-base-url 请求头携带目标 baseUrl，由 vite.config.ts 中的 dev 中间件
 *   按路径后缀原样转发到真实厂商接口，规避浏览器 CORS 限制；
 * - 生产模式：直接 fetch 厂商地址（后续 Electron 阶段改走主进程转发）。
 *
 * 本模块保持零依赖（不 import 其他 src 模块），便于用 Node 脚本直接做单测。
 */

/** 对话消息（发送给接口的最小结构） */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 模型端点信息（与设置页的一套模型配置字段对应） */
export interface LlmEndpoint {
  baseUrl: string
  apiKey: string
  modelId: string
  temperature: number
  /** 请求超时（秒），作用于建立连接到收到响应头 */
  timeoutSeconds: number
  maxRetries: number
}

export type LlmErrorKind =
  | 'network' // 无法连接到接口服务
  | 'timeout' // 超时
  | 'http' // 服务端返回非 2xx
  | 'aborted' // 用户主动停止
  | 'parse' // 响应解析失败
  | 'invalid' // 请求参数不完整

/** 带分类的大模型请求错误，便于界面按类别给出中文提示 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind
  readonly status?: number

  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind
    this.status = status
  }
}

/** 是否为用户主动中止（停止按钮） */
export function isAbortError(err: unknown): boolean {
  if (err instanceof LlmError) return err.kind === 'aborted'
  return err instanceof DOMException && err.name === 'AbortError'
}

/** 将任意异常翻译成面向用户的中文提示 */
export function describeLlmError(err: unknown, baseUrl?: string): string {
  if (err instanceof LlmError) {
    switch (err.kind) {
      case 'aborted':
        return '已停止生成'
      case 'timeout':
        return `请求超时：等待 ${Math.round(Number(err.message) || 0)} 秒未收到响应，可在设置中调大超时时间后重试`
      case 'network':
        return `网络错误：无法连接到接口服务${baseUrl ? `（${baseUrl}）` : ''}，请检查网络、接口地址是否正确，或本地服务是否已启动`
      case 'http':
        return httpErrorMessage(err.status, err.message)
      case 'parse':
        return `响应解析失败：${err.message}`
      case 'invalid':
        return err.message
    }
  }
  return `请求失败：${err instanceof Error ? err.message : String(err)}`
}

function httpErrorMessage(status: number | undefined, detail: string): string {
  switch (status) {
    case 401:
    case 403:
      return `鉴权失败（HTTP ${status}）：API Key 无效或没有权限，请检查密钥是否正确、是否过期${detail ? `；服务端提示：${detail}` : ''}`
    case 404:
      return `接口不存在（HTTP 404）：请检查 baseUrl 是否正确（通常以 /v1 结尾，且不要带 /chat/completions 后缀）${detail ? `；服务端提示：${detail}` : ''}`
    case 429:
      return `请求过于频繁或额度不足（HTTP 429）：请稍后重试或检查账户余额${detail ? `；服务端提示：${detail}` : ''}`
    default:
      return `服务端返回错误（HTTP ${status ?? '未知'}）${detail ? `：${detail}` : ''}`
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/* —— 端点构造：开发走同源代理，生产直连 —— */

const IS_DEV = Boolean(import.meta.env?.DEV)
const PROXY_MOUNT = '/llm-proxy'

/** 规范化 baseUrl：去掉首尾空白与末尾斜杠 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * 把外部 abort 信号（停止按钮）与超时计时合并到内部 AbortController。
 * 注意：联动必须持续到响应体读取结束，否则流式阶段无法中断。
 */
interface LinkedAbort {
  controller: AbortController
  timedOut(): boolean
  /** 停止超时计时（响应头已到达），保留 abort 联动 */
  clearTimer(): void
  /** 解除全部联动并清理计时器 */
  dispose(): void
  /** 仅解除外部信号监听（计时器已清的场景） */
  unlinkSignal(): void
}

function linkAbortSignal(external: AbortSignal | undefined, timeoutMs: number): LinkedAbort {
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const onAbort = () => controller.abort()
  if (external?.aborted) {
    controller.abort()
  } else {
    external?.addEventListener('abort', onAbort, { once: true })
  }
  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    controller,
    timedOut: () => timedOut,
    clearTimer,
    dispose: () => {
      clearTimer()
      external?.removeEventListener('abort', onAbort)
    },
    unlinkSignal: () => {
      external?.removeEventListener('abort', onAbort)
    },
  }
}

/* —— 请求实现 —— */

interface RequestPlan {
  endpoint: LlmEndpoint
  messages: LlmChatMessage[]
  stream: boolean
  signal?: AbortSignal
}

interface PreparedRequest {
  url: string
  headers: Record<string, string>
  body: string
  timeoutLabel: string
}

/** 校验参数并构造请求（开发模式指向同源代理） */
function prepareRequest(plan: RequestPlan): PreparedRequest {
  const baseUrl = normalizeBaseUrl(plan.endpoint.baseUrl)
  const modelId = plan.endpoint.modelId.trim()
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new LlmError('invalid', '接口地址（baseUrl）缺失或不是合法的 http(s) 地址')
  }
  if (!modelId) {
    throw new LlmError('invalid', '模型 ID 不能为空')
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: plan.stream ? 'text/event-stream' : 'application/json',
  }
  const apiKey = plan.endpoint.apiKey.trim()
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  let url: string
  if (IS_DEV) {
    headers['x-llm-base-url'] = baseUrl
    url = `${PROXY_MOUNT}/chat/completions`
  } else {
    url = `${baseUrl}/chat/completions`
  }

  const timeoutSeconds = Math.max(1, plan.endpoint.timeoutSeconds)
  return {
    url,
    headers,
    body: JSON.stringify({
      model: modelId,
      messages: plan.messages,
      temperature: plan.endpoint.temperature,
      stream: plan.stream,
    }),
    timeoutLabel: String(timeoutSeconds),
  }
}

/** 读取非 2xx 响应中的错误信息（OpenAI 风格 {error:{message}}，兼容纯文本） */
async function extractErrorMessage(response: Response): Promise<string> {
  try {
    const text = await response.text()
    if (!text) return ''
    try {
      const data = JSON.parse(text) as {
        error?: { message?: string } | string
        message?: string
      }
      if (typeof data.error === 'string') return data.error
      if (data.error?.message) return data.error.message
      if (data.message) return data.message
    } catch {
      // 非 JSON，按原文返回（截断）
      return text.slice(0, 200)
    }
  } catch {
    // 读取失败时忽略细节
  }
  return ''
}

interface AttemptResult {
  response: Response
  linked: LinkedAbort
}

/**
 * 执行一次请求直到收到响应头（2xx）。
 * 成功时停止超时计时但保留 abort 联动，交由调用方在响应体读取结束后 dispose。
 */
async function attemptOnce(plan: RequestPlan): Promise<AttemptResult> {
  const { url, headers, body, timeoutLabel } = prepareRequest(plan)
  const timeoutMs = Math.max(1, plan.endpoint.timeoutSeconds) * 1000
  const linked = linkAbortSignal(plan.signal, timeoutMs)

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: linked.controller.signal,
    })
  } catch (err) {
    linked.dispose()
    if (linked.timedOut()) {
      throw new LlmError('timeout', timeoutLabel)
    }
    if (plan.signal?.aborted) {
      throw new LlmError('aborted', '已停止生成')
    }
    throw new LlmError('network', errorText(err))
  }

  if (!response.ok) {
    linked.dispose()
    const detail = await extractErrorMessage(response)
    throw new LlmError('http', detail, response.status)
  }

  // 响应头已到达：停表，但保留「停止按钮 → 上游连接」的联动
  linked.clearTimer()
  return { response, linked }
}

function isRetryableError(err: unknown): boolean {
  if (!(err instanceof LlmError)) return false
  if (err.kind === 'network' || err.kind === 'timeout') return true
  if (err.kind === 'http') {
    return err.status === undefined || err.status >= 500 || err.status === 429
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 带重试的请求。仅在「尚未产出任何内容」时才重试，
 * 流式过程中一旦有增量到达，错误将直接上抛（避免内容重复）。
 */
async function requestWithRetry(plan: RequestPlan, hasOutput: () => boolean): Promise<AttemptResult> {
  const maxRetries = Math.max(0, Math.trunc(plan.endpoint.maxRetries))
  let lastError: unknown = null
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await delay(400 * attempt)
    }
    try {
      return await attemptOnce(plan)
    } catch (err) {
      lastError = err
      if (err instanceof LlmError && err.kind === 'aborted') throw err
      if (hasOutput()) throw err
      if (attempt === maxRetries || !isRetryableError(err)) throw err
    }
  }
  throw lastError ?? new LlmError('network', '请求失败')
}

/* —— SSE 流解析 —— */

export interface SseDeltaHandlers {
  onContent?: (text: string) => void
  onReasoning?: (text: string) => void
}

export type SseLineResult = 'chunk' | 'done' | 'ignored'

/**
 * 处理一条 SSE data 载荷（不含 "data:" 前缀）：
 * - 合并 choices[0].delta.content → onContent
 * - 兼容 choices[0].delta.reasoning_content → onReasoning
 * - '[DONE]' 返回 'done'
 * 该函数为纯函数，便于直接单测。
 */
export function applySseDataPayload(payload: string, handlers: SseDeltaHandlers): SseLineResult {
  const trimmed = payload.trim()
  if (!trimmed || trimmed.startsWith(':')) return 'ignored'
  if (trimmed === '[DONE]') return 'done'

  let chunk: {
    choices?: Array<{
      delta?: { content?: unknown; reasoning_content?: unknown }
    }>
    error?: { message?: string } | string
  }
  try {
    chunk = JSON.parse(trimmed)
  } catch {
    // 心跳/非 JSON 行直接忽略
    return 'ignored'
  }

  if (chunk.error) {
    const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message
    throw new LlmError('http', message ?? '服务端在流中返回错误')
  }

  const delta = chunk.choices?.[0]?.delta
  if (!delta) return 'ignored'

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
    handlers.onReasoning?.(delta.reasoning_content)
  }
  if (typeof delta.content === 'string' && delta.content) {
    handlers.onContent?.(delta.content)
  }
  return 'chunk'
}

/** 逐行消费 SSE 流（跨 chunk 的半行数据会先缓冲），支持随时被 abort 中断 */
async function consumeSseStream(
  response: Response,
  plan: RequestPlan,
  linked: LinkedAbort,
  handlers: SseDeltaHandlers,
): Promise<void> {
  if (!response.body) {
    throw new LlmError('parse', '响应不包含可读取的流')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  const processLine = (rawLine: string): boolean => {
    const line = rawLine.trimEnd()
    if (!line.trim() || line.startsWith(':')) return true
    if (!line.startsWith('data:')) return true
    const result = applySseDataPayload(line.slice(5), handlers)
    return result !== 'done'
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const newlineIndex = buffer.indexOf('\n')
        if (newlineIndex < 0) break
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        if (!processLine(line)) {
          reader.cancel().catch(() => undefined)
          return
        }
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      processLine(buffer)
    }
  } catch (err) {
    if (err instanceof LlmError) throw err
    if (linked.timedOut()) {
      throw new LlmError('timeout', String(Math.max(1, plan.endpoint.timeoutSeconds)))
    }
    if (plan.signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new LlmError('aborted', '已停止生成')
    }
    throw new LlmError('parse', errorText(err))
  }
}

/* —— 对外能力 —— */

export interface StreamHandlers extends SseDeltaHandlers {
  onContent: (text: string) => void
}

export interface StreamChatOptions {
  endpoint: LlmEndpoint
  messages: LlmChatMessage[]
  signal?: AbortSignal
  handlers: StreamHandlers
}

/** 发起流式对话：逐 token 回调 onContent / onReasoning，直至 [DONE] 或流结束 */
export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  const plan: RequestPlan = {
    endpoint: options.endpoint,
    messages: options.messages,
    stream: true,
    signal: options.signal,
  }

  let hasOutput = false
  const inner: StreamHandlers = {
    onContent: (text) => {
      hasOutput = true
      options.handlers.onContent(text)
    },
    onReasoning: (text) => {
      hasOutput = true
      options.handlers.onReasoning?.(text)
    },
  }

  const { response, linked } = await requestWithRetry(plan, () => hasOutput)
  try {
    await consumeSseStream(response, plan, linked, inner)
  } finally {
    linked.unlinkSignal()
  }
}

/** 非流式对话：返回首条回复文本 */
export async function chatCompletion(
  endpoint: LlmEndpoint,
  messages: LlmChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const plan: RequestPlan = { endpoint, messages, stream: false, signal }
  const { response, linked } = await requestWithRetry(plan, () => false)
  try {
    let data: {
      choices?: Array<{ message?: { content?: unknown } }>
      error?: { message?: string } | string
    }
    try {
      data = (await response.json()) as typeof data
    } catch (err) {
      throw new LlmError('parse', errorText(err))
    }
    if (data.error) {
      const message = typeof data.error === 'string' ? data.error : data.error.message
      throw new LlmError('http', message ?? '服务端返回错误')
    }
    const content = data.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new LlmError('parse', '响应中没有 choices[0].message.content 文本')
    }
    return content
  } finally {
    linked.unlinkSignal()
  }
}

export interface ConnectivityResult {
  ok: boolean
  /** 从发起到收到结果的总耗时（毫秒） */
  durationMs: number
  /** 成功：模型回复摘要；失败：面向用户的中文错误信息 */
  message: string
  errorKind?: LlmErrorKind
  httpStatus?: number
}

/* —— 模型列表拉取（GET /models） —— */

/** 拉取模型列表的超时上限（秒）：列表接口应快速返回，失败也不影响手填模型 ID */
const LIST_MODELS_TIMEOUT_SECONDS = 20

/** listRemoteModels 的入参：仅需 baseUrl / apiKey / timeoutSeconds */
export type RemoteModelsEndpoint = Pick<LlmEndpoint, 'baseUrl' | 'apiKey' | 'timeoutSeconds'>

export interface RemoteModelsResult {
  ok: boolean
  /** 成功：去重并按字母排序后的模型 ID 列表 */
  models: string[]
  /** 失败：面向用户的中文错误信息 */
  message: string
  errorKind?: LlmErrorKind
  httpStatus?: number
}

/** 提取数组元素中指定字段的字符串值（忽略空值/非字符串） */
function collectModelField(items: unknown[], field: 'id' | 'name'): string[] {
  const values: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const value = (item as Record<string, unknown>)[field]
    if (typeof value === 'string' && value.trim()) {
      values.push(value.trim())
    }
  }
  return values
}

function dedupeSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b))
}

/**
 * 从 /models 响应中提取模型 ID 列表（纯函数，便于直接单测）。
 * 按序兼容多种形状：{data:[{id}]}（OpenAI 标准）、{models:[{name}]}（Ollama 原生）、
 * {data:[{name}]}；结果去重并按字母排序；全部无法解析时抛出「响应格式无法识别」。
 */
export function extractModelIds(data: unknown): string[] {
  if (!data || typeof data !== 'object') {
    throw new LlmError('parse', '响应格式无法识别，未能提取模型列表（期望 {data:[{id}]} 或 {models:[{name}]}）')
  }
  const record = data as Record<string, unknown>
  if (Array.isArray(record.data)) {
    const ids = collectModelField(record.data, 'id')
    if (ids.length > 0) return dedupeSorted(ids)
  }
  if (Array.isArray(record.models)) {
    const names = collectModelField(record.models, 'name')
    if (names.length > 0) return dedupeSorted(names)
  }
  if (Array.isArray(record.data)) {
    const names = collectModelField(record.data, 'name')
    if (names.length > 0) return dedupeSorted(names)
  }
  throw new LlmError('parse', '响应格式无法识别，未能提取模型列表（期望 {data:[{id}]} 或 {models:[{name}]}）')
}

/** 模型列表场景的 404 提示与对话接口不同：很多兼容服务不提供 /models，应引导手填 */
function describeModelsError(err: unknown, baseUrl?: string): string {
  if (err instanceof LlmError && err.kind === 'http' && err.status === 404) {
    const detail = err.message
    return `该服务可能不提供模型列表接口（HTTP 404）：请检查 baseUrl 是否正确，或直接手动填写模型 ID${detail ? `；服务端提示：${detail}` : ''}`
  }
  return describeLlmError(err, baseUrl)
}

/**
 * 调用服务的模型列表接口（GET ${baseUrl}/models，OpenAI 兼容标准端点）。
 * - apiKey 为空时不带 Authorization（Ollama 本地可匿名）；
 * - 开发模式同样走 /llm-proxy/models 同源代理；
 * - 超时使用较短上限（20 秒），失败返回 ok:false 的中文错误，不抛出异常。
 */
export async function listRemoteModels(endpoint: RemoteModelsEndpoint): Promise<RemoteModelsResult> {
  const baseUrl = normalizeBaseUrl(endpoint.baseUrl)
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    return {
      ok: false,
      models: [],
      message: '接口地址（baseUrl）缺失或不是合法的 http(s) 地址，无法获取模型列表',
      errorKind: 'invalid',
    }
  }

  const headers: Record<string, string> = { accept: 'application/json' }
  const apiKey = endpoint.apiKey.trim()
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  let url: string
  if (IS_DEV) {
    headers['x-llm-base-url'] = baseUrl
    url = `${PROXY_MOUNT}/models`
  } else {
    url = `${baseUrl}/models`
  }

  const timeoutSeconds = Math.min(
    LIST_MODELS_TIMEOUT_SECONDS,
    Math.max(1, Math.trunc(endpoint.timeoutSeconds) || LIST_MODELS_TIMEOUT_SECONDS),
  )
  const linked = linkAbortSignal(undefined, timeoutSeconds * 1000)

  try {
    let response: Response
    try {
      response = await fetch(url, { method: 'GET', headers, signal: linked.controller.signal })
    } catch (err) {
      if (linked.timedOut()) {
        throw new LlmError('timeout', String(timeoutSeconds))
      }
      throw new LlmError('network', errorText(err))
    }

    if (!response.ok) {
      const detail = await extractErrorMessage(response)
      throw new LlmError('http', detail, response.status)
    }

    let data: unknown
    try {
      data = await response.json()
    } catch (err) {
      throw new LlmError('parse', `响应不是合法 JSON：${errorText(err)}`)
    }
    const models = extractModelIds(data)
    return { ok: true, models, message: '' }
  } catch (err) {
    const llmError = err instanceof LlmError ? err : new LlmError('network', errorText(err))
    return {
      ok: false,
      models: [],
      message: describeModelsError(llmError, baseUrl),
      errorKind: llmError.kind,
      httpStatus: llmError.status,
    }
  } finally {
    linked.dispose()
  }
}

/** 连接测试：发一条 messages=[{role:'user',content:'Hi'}] 的非流式请求（不重试，便于快速定位问题） */
export async function testLlmConnection(endpoint: LlmEndpoint): Promise<ConnectivityResult> {
  const startedAt = performance.now()
  const finish = (partial: Omit<ConnectivityResult, 'durationMs'>): ConnectivityResult => ({
    ...partial,
    durationMs: Math.round(performance.now() - startedAt),
  })
  try {
    // 单次尝试、短超时上限，避免测试按钮长时间挂起
    const content = await chatCompletion(
      { ...endpoint, maxRetries: 0, timeoutSeconds: Math.min(endpoint.timeoutSeconds, 120) },
      [{ role: 'user', content: 'Hi' }],
    )
    const reply = content.trim().replace(/\s+/g, ' ')
    const summary = reply.length > 60 ? `${reply.slice(0, 60)}…` : reply
    return finish({ ok: true, message: summary || '连接成功（模型返回了空回复）' })
  } catch (err) {
    if (err instanceof LlmError) {
      return finish({
        ok: false,
        message: describeLlmError(err, endpoint.baseUrl),
        errorKind: err.kind,
        httpStatus: err.status,
      })
    }
    return finish({
      ok: false,
      message: describeLlmError(err, endpoint.baseUrl),
      errorKind: 'network',
    })
  }
}
