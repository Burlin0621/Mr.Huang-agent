/**
 * 大模型请求层（OpenAI 兼容 /chat/completions）
 *
 * 请求通道（自动选择）：
 * - 桌面端（preload 暴露 llmForward）：经主进程 fetch 转发（解决生产 CORS），
 *   SSE 原始块经 IPC 逐段回传后走同一套解析逻辑，AbortSignal 经 'llm:abort' 贯穿主进程；
 * - 纯浏览器 / 开发模式：渲染进程直连——开发请求同源 /llm-proxy/*（Vite dev 中间件转发），
 *   生产直连厂商接口。
 * 两条通道的 URL 构造、headers、错误分类、超时与重试语义保持一致。
 *
 * 原设计说明（保留）：本模块尽量保持少依赖（仅依赖 desktop-bridge 的类型与探测函数，
 * 该模块同样零依赖），便于用 Node 脚本直接做单测。
 */

import { hasLlmForward, type LlmForwardDone } from '@/lib/desktop-bridge'

/** function calling 的工具声明（OpenAI tools 参数；与 src/lib/agent-tools.ts 的 schema 对应） */
export interface LlmToolDefinition {
  name: string
  description: string
  /** 简化 JSON Schema（{ type:'object', properties, required }） */
  parameters: Record<string, unknown>
}

/** 模型返回的单个工具调用（arguments 为待解析的 JSON 字符串） */
export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

/** user 消息的视觉内容分片（OpenAI 兼容格式；仅 user 消息使用数组形式） */
export interface LlmContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/** 对话消息（发送给接口的结构；tool 消息用于回传工具结果） */
export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  /**
   * 多数消息为纯文本；user 消息含图片附件时为数组（视觉格式）：
   * [{ type:'text', text }, { type:'image_url', image_url:{ url:dataURL } }...]
   */
  content: string | LlmContentPart[]
  /** assistant 发起工具调用时携带 */
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
  /** role:'tool' 消息对应的调用 id */
  tool_call_id?: string
  /** role:'tool' 消息可携带工具名（部分兼容端点需要） */
  name?: string
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
  /** function calling：工具声明（省略时不带 tools 参数） */
  tools?: LlmToolDefinition[]
  /** function calling：默认 'auto' */
  toolChoice?: 'auto' | 'none' | 'required'
}

interface PreparedRequest {
  url: string
  headers: Record<string, string>
  body: string
  timeoutLabel: string
}

/** 构造请求 headers（直连与转发共用；转发时去掉代理专用头） */
function buildHeaders(plan: RequestPlan, stream: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
  }
  const apiKey = plan.endpoint.apiKey.trim()
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`
  }
  return headers
}

/** 构造请求 body（直连与转发共用；tools/tool_choice 可选） */
function buildRequestBody(plan: RequestPlan): string {
  const payload: Record<string, unknown> = {
    model: plan.endpoint.modelId.trim(),
    messages: plan.messages,
    temperature: plan.endpoint.temperature,
    stream: plan.stream,
  }
  if (plan.tools && plan.tools.length > 0) {
    payload.tools = plan.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }))
    payload.tool_choice = plan.toolChoice ?? 'auto'
  }
  return JSON.stringify(payload)
}

/** 校验参数并构造请求（开发模式指向同源代理；apiPath 用于 /chat/completions 与 /models） */
function prepareRequest(plan: RequestPlan, apiPath = '/chat/completions'): PreparedRequest {
  const baseUrl = normalizeBaseUrl(plan.endpoint.baseUrl)
  const modelId = plan.endpoint.modelId.trim()
  if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) {
    throw new LlmError('invalid', '接口地址（baseUrl）缺失或不是合法的 http(s) 地址')
  }
  if (!modelId) {
    throw new LlmError('invalid', '模型 ID 不能为空')
  }

  const headers = buildHeaders(plan, plan.stream)
  const body = buildRequestBody(plan)
  if (IS_DEV) {
    headers['x-llm-base-url'] = baseUrl
    return {
      url: `${PROXY_MOUNT}${apiPath}`,
      headers,
      body,
      timeoutLabel: String(Math.max(1, plan.endpoint.timeoutSeconds)),
    }
  }
  return {
    url: `${baseUrl}${apiPath}`,
    headers,
    body,
    timeoutLabel: String(Math.max(1, plan.endpoint.timeoutSeconds)),
  }
}

/* —— 主进程转发通道（桌面端：preload 暴露 llmForward 时自动启用） —— */

interface ForwardAttemptResult {
  /** 结束包（ok/status/errorKind/body） */
  done: LlmForwardDone
  /** 累计的原始响应文本（SSE 原文或完整响应体） */
  rawText: string
}

/**
 * 转发通道单次尝试：主进程 fetch，SSE/响应体原始文本块经 onChunk 累计；
 * stream=true 时把完整行喂给 applySseDataPayload（与直连通道同一解析函数）。
 * 用户中止：external signal → llmAbort(requestId)，主进程回 aborted 结束包。
 */
function forwardOnce(plan: RequestPlan, apiPath: string, handlers: SseDeltaHandlers | null): Promise<ForwardAttemptResult> {
  const prepared = prepareRequest(plan, apiPath)
  const baseUrl = normalizeBaseUrl(plan.endpoint.baseUrl)
  const url = `${baseUrl}${apiPath}`
  const bridge = window.mrHuangDesktop
  const forward = bridge?.llmForward
  const abortForward = bridge?.llmAbort
  if (!forward || !abortForward) {
    return Promise.resolve({
      done: { ok: false, errorKind: 'invalid', message: '桌面桥接缺少 LLM 转发能力' },
      rawText: '',
    })
  }

  return new Promise((resolve) => {
    let buffer = ''
    let rawText = ''
    let settled = false

    const settle = (done: LlmForwardDone): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ done, rawText })
    }

    let requestId = ''
    const onExternalAbort = (): void => {
      if (requestId) abortForward(requestId)
    }

    const cleanup = (): void => {
      plan.signal?.removeEventListener('abort', onExternalAbort)
    }

    const processLine = (rawLine: string): void => {
      const line = rawLine.trimEnd()
      if (!line.trim() || line.startsWith(':') || !line.startsWith('data:')) return
      if (handlers) applySseDataPayload(line.slice(5), handlers)
    }

    const method: 'GET' | 'POST' = apiPath === '/models' ? 'GET' : 'POST'
    requestId = forward(
      {
        url,
        method,
        headers: Object.fromEntries(Object.entries(prepared.headers).filter(([key]) => key !== 'x-llm-base-url')),
        ...(method === 'POST' ? { body: prepared.body } : {}),
        timeoutSeconds: Math.max(1, plan.endpoint.timeoutSeconds),
      },
      {
        onChunk: (text) => {
          rawText += text
          if (!handlers) return
          buffer += text
          for (;;) {
            const newlineIndex = buffer.indexOf('\n')
            if (newlineIndex < 0) break
            processLine(buffer.slice(0, newlineIndex))
            buffer = buffer.slice(newlineIndex + 1)
          }
        },
        onDone: (done) => {
          if (handlers && buffer.trim()) processLine(buffer)
          settle(done)
        },
      },
    )

    if (plan.signal?.aborted) {
      bridge.llmAbort?.(requestId)
    } else {
      plan.signal?.addEventListener('abort', onExternalAbort, { once: true })
    }
  })
}

/** 把转发结束包翻译为 LlmError（ok=true 时返回 null） */
function doneToError(done: LlmForwardDone): LlmError | null {
  if (done.ok) return null
  switch (done.errorKind) {
    case 'aborted':
      return new LlmError('aborted', '已停止生成')
    case 'timeout':
      return new LlmError('timeout', done.message || '0')
    case 'network':
      return new LlmError('network', done.message || '网络错误')
    case 'parse':
      return new LlmError('parse', done.message || '响应解析失败')
    case 'invalid':
      return new LlmError('invalid', done.message || '请求参数不完整')
    default:
      if (done.status !== undefined) {
        return new LlmError('http', done.body ?? '', done.status)
      }
      return new LlmError('network', done.message || '转发请求失败')
  }
}

/** 转发通道 + 重试（语义与直连 requestWithRetry 一致：仅未产出内容时可重试） */
async function forwardWithRetry(
  plan: RequestPlan,
  apiPath: string,
  handlers: SseDeltaHandlers | null,
  hasOutput: () => boolean,
): Promise<ForwardAttemptResult> {
  const maxRetries = Math.max(0, Math.trunc(plan.endpoint.maxRetries))
  let last: ForwardAttemptResult = {
    done: { ok: false, errorKind: 'network', message: '请求失败' },
    rawText: '',
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await delay(400 * attempt)
    last = await forwardOnce(plan, apiPath, handlers)
    const error = doneToError(last.done)
    if (!error) return last
    if (error.kind === 'aborted') throw error
    if (hasOutput()) throw error
    if (attempt === maxRetries || !isRetryableError(error)) throw error
  }
  const error = doneToError(last.done)
  throw error ?? new LlmError('network', '请求失败')
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
  /** function calling：delta.tool_calls 原始增量数组（按 index 拼接由调用方完成） */
  onToolCallDelta?: (deltas: unknown[]) => void
  /** choices[0].finish_reason（如 'tool_calls' / 'stop'），可能多次触发，取最后一次 */
  onFinishReason?: (reason: string) => void
}

export type SseLineResult = 'chunk' | 'done' | 'ignored'

/**
 * 处理一条 SSE data 载荷（不含 "data:" 前缀）：
 * - 合并 choices[0].delta.content → onContent
 * - 兼容 choices[0].delta.reasoning_content → onReasoning
 * - delta.tool_calls 原始增量 → onToolCallDelta（function calling）
 * - finish_reason → onFinishReason
 * - '[DONE]' 返回 'done'
 * 该函数为纯函数，便于直接单测。
 */
export function applySseDataPayload(payload: string, handlers: SseDeltaHandlers): SseLineResult {
  const trimmed = payload.trim()
  if (!trimmed || trimmed.startsWith(':')) return 'ignored'
  if (trimmed === '[DONE]') return 'done'

  let chunk: {
    choices?: Array<{
      delta?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown }
      finish_reason?: unknown
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

  const choice = chunk.choices?.[0]
  const delta = choice?.delta
  if (!delta && choice?.finish_reason === undefined) return 'ignored'

  if (Array.isArray(delta?.tool_calls) && handlers.onToolCallDelta) {
    handlers.onToolCallDelta(delta.tool_calls as unknown[])
  }
  if (typeof choice?.finish_reason === 'string' && handlers.onFinishReason) {
    handlers.onFinishReason(choice.finish_reason)
  }
  if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
    handlers.onReasoning?.(delta.reasoning_content)
  }
  if (typeof delta?.content === 'string' && delta.content) {
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
  /** function calling：工具声明（可选） */
  tools?: LlmToolDefinition[]
  /** function calling：默认 'auto' */
  toolChoice?: 'auto' | 'none' | 'required'
}

/** 发起流式对话：逐 token 回调 onContent / onReasoning，直至 [DONE] 或流结束。
 * 桌面端自动走主进程转发通道；纯浏览器保留直连/同源代理回退。 */
export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  const plan: RequestPlan = {
    endpoint: options.endpoint,
    messages: options.messages,
    stream: true,
    signal: options.signal,
    tools: options.tools,
    toolChoice: options.toolChoice,
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
    onToolCallDelta: options.handlers.onToolCallDelta,
    onFinishReason: options.handlers.onFinishReason,
  }

  // 桌面端：主进程转发（同一套 SSE 解析与重试语义）
  if (hasLlmForward()) {
    await forwardWithRetry(plan, '/chat/completions', inner, () => hasOutput)
    return
  }

  const { response, linked } = await requestWithRetry(plan, () => hasOutput)
  try {
    await consumeSseStream(response, plan, linked, inner)
  } finally {
    linked.unlinkSignal()
  }
}

/** 非流式对话：返回首条回复文本。桌面端走转发通道，浏览器回退直连。 */
export async function chatCompletion(
  endpoint: LlmEndpoint,
  messages: LlmChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const plan: RequestPlan = { endpoint, messages, stream: false, signal }

  let data: {
    choices?: Array<{ message?: { content?: unknown } }>
    error?: { message?: string } | string
  }

  if (hasLlmForward()) {
    const { done, rawText } = await forwardWithRetry(plan, '/chat/completions', null, () => false)
    const error = doneToError(done)
    if (error) throw error
    try {
      data = JSON.parse(rawText) as typeof data
    } catch (err) {
      throw new LlmError('parse', errorText(err))
    }
  } else {
    const { response, linked } = await requestWithRetry(plan, () => false)
    try {
      try {
        data = (await response.json()) as typeof data
      } catch (err) {
        throw new LlmError('parse', errorText(err))
      }
    } finally {
      linked.unlinkSignal()
    }
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

  // 桌面端：模型列表同样走主进程转发（GET /models，body 被忽略）
  if (hasLlmForward()) {
    const mapFailure = (err: unknown): RemoteModelsResult => {
      const llmError = err instanceof LlmError ? err : new LlmError('network', errorText(err))
      return {
        ok: false,
        models: [],
        message: describeModelsError(llmError, baseUrl),
        errorKind: llmError.kind,
        httpStatus: llmError.status,
      }
    }
    try {
      const plan: RequestPlan = {
        endpoint: {
          baseUrl,
          apiKey: endpoint.apiKey,
          modelId: 'models', // 占位：/models 请求不带有效模型，GET 请求主进程忽略 body
          temperature: 0,
          timeoutSeconds,
          maxRetries: 0,
        },
        messages: [],
        stream: false,
      }
      const { done, rawText } = await forwardWithRetry(plan, '/models', null, () => false)
      const error = doneToError(done)
      if (error) return mapFailure(error)
      let data: unknown
      try {
        data = JSON.parse(rawText)
      } catch (err) {
        return mapFailure(new LlmError('parse', `响应不是合法 JSON：${errorText(err)}`))
      }
      return { ok: true, models: extractModelIds(data), message: '' }
    } catch (err) {
      return mapFailure(err)
    }
  }

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

/* —— function calling：agent loop —— */

/** 合并 tool_calls 流式增量：按 index 聚合，id/function.name 覆盖、arguments 逐段拼接。
 * 纯函数（原地更新 existing 并返回），便于直接单测。 */
export function mergeToolCallDeltas(existing: LlmToolCall[], deltas: unknown[]): LlmToolCall[] {
  for (const delta of deltas) {
    if (typeof delta !== 'object' || delta === null) continue
    const record = delta as {
      index?: unknown
      id?: unknown
      function?: { name?: unknown; arguments?: unknown }
    }
    const index = typeof record.index === 'number' && Number.isInteger(record.index) && record.index >= 0
      ? record.index
      : existing.length
    while (existing.length <= index) {
      existing.push({ id: '', name: '', arguments: '' })
    }
    const target = existing[index]
    if (typeof record.id === 'string' && record.id) target.id = record.id
    if (typeof record.function?.name === 'string' && record.function.name) target.name = record.function.name
    if (typeof record.function?.arguments === 'string') target.arguments += record.function.arguments
  }
  return existing
}

/** 单个工具执行步骤信息（供 onStep 回调与 UI 渲染） */
export interface AgentStepInfo {
  /** 第几个模型回合（从 1 开始） */
  step: number
  toolName: string
  /** 模型给出的原始参数 JSON 文本 */
  argsText: string
  /** 工具输出文本（已截断） */
  resultText: string
  durationMs: number
  /** executeTool 抛错或工具返回失败时的错误说明 */
  error?: string
}

/** agent loop 默认步数上限（防失控熔断） */
export const AGENT_LOOP_MAX_STEPS = 8

export interface RunAgentLoopOptions {
  endpoint: LlmEndpoint
  messages: LlmChatMessage[]
  tools: LlmToolDefinition[]
  /** 执行工具：返回结果文本（作为 role:'tool' 消息回传给模型） */
  executeTool: (name: string, argsJson: string) => Promise<string>
  /** 最大工具回合数，默认 AGENT_LOOP_MAX_STEPS */
  maxSteps?: number
  /** 每次工具执行后回调（含耗时/结果/错误），供 UI 渲染工具卡片 */
  onStep?: (info: AgentStepInfo) => void
  signal?: AbortSignal
  /** 文本流式回调（每回合的模型文本都会实时回调） */
  handlers?: StreamHandlers
  toolChoice?: 'auto' | 'none' | 'required'
}

export interface RunAgentLoopResult {
  /** 最终回答文本（最后一回合的模型输出） */
  content: string
  reasoning: string
  /** 全部工具执行步骤（按发生顺序） */
  steps: AgentStepInfo[]
}

/**
 * 工具结果中的图片标记正则：[IMAGE:data:image/...;base64,...]（纯函数可单测）。
 * data URL 内不含 ']'（base64 字符集无该字符），非贪婪匹配到首个 ']' 即可。
 */
const IMAGE_MARKER_PATTERN = /\[IMAGE:(data:image\/[a-z+.+-]+;base64,[A-Za-z0-9+/=]+)\]/

export interface SplitImageMarkerResult {
  /** 去掉图片标记后的文本（保留前缀说明） */
  text: string
  /** 提取出的 data URL；无图片标记时为 null */
  imageDataUrl: string | null
}

/**
 * 从工具结果文本中拆出 [IMAGE:dataURL] 图片标记（纯函数可单测）：
 * - 有标记：返回去掉标记的文本（末尾追加「，见下一条附图」提示）+ 图片 data URL；
 * - 无标记：原样返回，image 为 null。
 * 用途：browser_screenshot 等工具把截图以标记嵌在文本结果里，runAgentLoop
 * 据此把图片转为紧随 tool 消息之后的 user 视觉消息（tool 消息本身保持纯文本）。
 */
export function splitImageMarkerFromToolResult(text: string): SplitImageMarkerResult {
  const match = IMAGE_MARKER_PATTERN.exec(text)
  if (!match) return { text, imageDataUrl: null }
  const cleaned = text.replace(IMAGE_MARKER_PATTERN, '').trim()
  return {
    text: cleaned ? `${cleaned}，图片见下一条附图` : '（见下一条附图）',
    imageDataUrl: match[1],
  }
}

/**
 * function calling 主循环：模型返回 tool_calls → executeTool 执行 → 结果以 role:'tool'
 * 消息追加 → 继续调用，直到模型给出最终回答或达到 maxSteps。
 * executeTool 抛错不中断循环：错误文本作为工具结果回传给模型自行决策。
 * 用户中止（signal）沿 streamChatCompletion 以 LlmError('aborted') 上抛。
 * 兜底：若循环结束时模型未产出任何正文但已发生过工具步骤（如步数被耗尽），
 * 追加一次不带 tools 的收尾请求，让模型基于工具结果直接输出最终回答。
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const maxSteps = Math.max(1, Math.trunc(options.maxSteps ?? AGENT_LOOP_MAX_STEPS))
  const messages: LlmChatMessage[] = [...options.messages]
  const steps: AgentStepInfo[] = []
  let lastContent = ''
  let lastReasoning = ''
  /** 是否提前跳出主循环（达到 maxSteps 或模型空回合）而进入收尾总结 */
  let exited = false

  for (let step = 1; step <= maxSteps && !exited; step++) {
    const content: string[] = []
    const reasoning: string[] = []
    const toolCalls: LlmToolCall[] = []

    await streamChatCompletion({
      endpoint: options.endpoint,
      messages,
      tools: options.tools,
      toolChoice: options.toolChoice,
      signal: options.signal,
      handlers: {
        onContent: (text) => {
          content.push(text)
          options.handlers?.onContent?.(text)
        },
        onReasoning: (text) => {
          reasoning.push(text)
          options.handlers?.onReasoning?.(text)
        },
        onToolCallDelta: (deltas) => {
          mergeToolCallDeltas(toolCalls, deltas)
        },
      },
    })

    lastContent = content.join('')
    lastReasoning = reasoning.join('')

    const validCalls = toolCalls.filter((call) => call.name.trim())
    if (validCalls.length === 0) {
      if (lastContent.trim() || steps.length === 0) {
        return { content: lastContent, reasoning: lastReasoning, steps }
      }
      // 模型未产出文本且此前已有工具步骤：跳出进入收尾总结
      exited = true
      break
    }

    messages.push({
      role: 'assistant',
      content: lastContent,
      tool_calls: validCalls.map((call) => ({
        id: call.id || `call_${step}_${call.name}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    })

    for (const call of validCalls) {
      const startedAt = performance.now()
      let resultText: string
      let error: string | undefined
      try {
        resultText = await options.executeTool(call.name, call.arguments)
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        resultText = `工具执行出错：${error}`
      }
      const info: AgentStepInfo = {
        step,
        toolName: call.name,
        argsText: call.arguments,
        resultText,
        durationMs: Math.round(performance.now() - startedAt),
        ...(error ? { error } : {}),
      }
      steps.push(info)
      options.onStep?.(info)
      // 图片标记注入：工具结果含 [IMAGE:dataURL]（如 browser_screenshot 截图）时，
      // tool 消息保持纯文本，图片转为紧随其后的 user 视觉消息（多数厂商 tool 消息不支持带图）
      const split = splitImageMarkerFromToolResult(resultText)
      messages.push({
        role: 'tool',
        content: split.text,
        tool_call_id: call.id || `call_${step}_${call.name}`,
        name: call.name,
      })
      if (split.imageDataUrl) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: '上面工具调用返回的截图，请结合图片继续回答：' },
            { type: 'image_url', image_url: { url: split.imageDataUrl } },
          ],
        })
      }
    }

    if (step === maxSteps) {
      // 达到步数上限：跳出主循环，进入收尾总结
      exited = true
    }
  }

  // 收尾总结：工具步骤已发生但模型未产出任何正文（典型为 maxSteps 耗尽）时，
  // 追加一次不带 tools 的请求，让模型基于以上工具结果直接输出最终回答正文。
  if (!lastContent.trim() && steps.length > 0) {
    messages.push({
      role: 'user',
      content: '工具调用阶段已结束。请基于以上工具返回的全部信息，直接输出最终回答正文；不要再次调用工具。',
    })
    const content: string[] = []
    const reasoning: string[] = []
    await streamChatCompletion({
      endpoint: options.endpoint,
      messages,
      signal: options.signal,
      handlers: {
        onContent: (text) => {
          content.push(text)
          options.handlers?.onContent?.(text)
        },
        onReasoning: (text) => {
          reasoning.push(text)
          options.handlers?.onReasoning?.(text)
        },
      },
    })
    lastContent = content.join('')
    lastReasoning = reasoning.join('')
  }

  return { content: lastContent, reasoning: lastReasoning, steps }
}
