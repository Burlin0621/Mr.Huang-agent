import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * 开发期大模型反向代理：浏览器直连厂商 API 会被 CORS 拦截，
 * 因此 src 内的请求层在开发模式下统一请求同源路径 /llm-proxy/*，
 * 并通过请求头 x-llm-base-url 携带目标 baseUrl，由该中间件按剩余路径后缀
 * 原样转发（/llm-proxy/chat/completions → ${baseUrl}/chat/completions，
 * /llm-proxy/models → ${baseUrl}/models，任意后缀均可透传），
 * 含 Authorization、请求体，响应（含 SSE 流）也原封不动回传。
 * 生产模式（后续 Electron 阶段）将改走主进程转发，此处不参与构建。
 */
const LLM_PROXY_MOUNT = '/llm-proxy'

interface LlmProxyPlugin extends Plugin {
  name: 'llm-dev-proxy'
}

function llmDevProxy(): LlmProxyPlugin {
  return {
    name: 'llm-dev-proxy',
    configureServer(server) {
      server.middlewares.use(LLM_PROXY_MOUNT, (req, res, next) => {
        handleLlmProxy(req, res).catch((err: unknown) => next(err))
      })
    },
  }
}

function readRequestBody(req: { method?: string } & AsyncIterable<Uint8Array>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** undici/Node 系统错误的形状：除标准字段外可能携带 code（如 ECONNREFUSED） */
interface CauseErrorLike extends Error {
  code?: unknown
}

/** 连接类错误码：目标服务未启动、域名解析失败、连接超时等 */
const CONNECTION_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
])

/** 证书类错误码：自签、过期或不受信任的 HTTPS 证书 */
const CERT_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

/**
 * Node fetch 失败时 err.message 往往只有 "fetch failed"，真实原因藏在 err.cause 里，
 * 此处从 unknown 中安全取出 cause 的 code 与 message（只做局部形状收窄，不用 any）
 */
function extractFetchCause(err: unknown): { code?: string; message?: string } {
  if (!(err instanceof Error) || !(err.cause instanceof Error)) return {}
  const cause = err.cause as CauseErrorLike
  return {
    code: typeof cause.code === 'string' ? cause.code : undefined,
    // cause.message 可能携带多行堆栈信息，仅保留首行关键描述
    message: cause.message.split('\n')[0] || undefined,
  }
}

/** 按错误码归类，给出一句可操作的排查建议 */
function suggestForErrorCode(code: string | undefined): string {
  if (code && CONNECTION_ERROR_CODES.has(code)) {
    return '请确认目标服务已启动、baseUrl 地址与端口正确'
  }
  if (code && CERT_ERROR_CODES.has(code)) {
    return '如为 https 自签/过期证书可检查证书配置'
  }
  return '请检查网络连接与目标服务地址是否可达'
}

async function handleLlmProxy(
  req: {
    method?: string
    url?: string
    headers: Record<string, string | string[] | undefined>
    on: (event: string, listener: (...args: never[]) => void) => void
  } & AsyncIterable<Uint8Array>,
  res: {
    statusCode: number
    writableEnded: boolean
    setHeader: (name: string, value: string | number) => void
    write: (chunk: Buffer) => boolean
    end: (chunk?: string) => void
    once: (event: string, listener: () => void) => void
    on: (event: string, listener: () => void) => void
  },
): Promise<void> {
  const sendJsonError = (status: number, message: string, extraHeader?: string) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (extraHeader) res.setHeader('x-llm-proxy-error', extraHeader)
    res.end(JSON.stringify({ error: { message } }))
  }

  // connect 挂载前缀后的剩余路径（例如 /chat/completions）
  const path = String(req.url ?? '').split('?')[0]
  const baseUrlHeader = req.headers['x-llm-base-url']
  const baseUrl = Array.isArray(baseUrlHeader) ? baseUrlHeader[0] : baseUrlHeader
  if (!baseUrl) {
    sendJsonError(400, '开发代理缺少 x-llm-base-url 请求头，无法确定目标接口地址')
    return
  }

  const target = `${baseUrl.replace(/\/+$/, '')}${path}`
  const headers: Record<string, string> = {
    accept: 'application/json, text/event-stream',
  }
  if (typeof req.headers['content-type'] === 'string') {
    headers['content-type'] = req.headers['content-type']
  }
  if (typeof req.headers.authorization === 'string') {
    headers.authorization = req.headers.authorization
  }

  // 浏览器中断请求（停止按钮）时，同步中断到上游的转发
  const upstreamAbort = new AbortController()
  res.on('close', () => {
    if (!res.writableEnded) upstreamAbort.abort()
  })

  let body: Buffer | undefined
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await readRequestBody(req)
  }

  let upstream: Response
  try {
    upstream = await fetch(target, {
      method: req.method ?? 'POST',
      headers,
      body: body && body.length > 0 ? body : undefined,
      signal: upstreamAbort.signal,
    })
  } catch (err) {
    // err.message 通常只有 "fetch failed"，优先从 err.cause 提取具体原因（如 ECONNREFUSED）
    const { code, message: causeMessage } = extractFetchCause(err)
    const detail = code
      ? [code, causeMessage].filter(Boolean).join('：')
      : (causeMessage ?? (err instanceof Error ? err.message : String(err)))
    sendJsonError(
      502,
      `开发代理无法连接目标接口服务（${target}）：${detail}。${suggestForErrorCode(code)}`,
      'network',
    )
    return
  }

  res.statusCode = upstream.status
  const contentType = upstream.headers.get('content-type')
  if (contentType) {
    res.setHeader('content-type', contentType)
  }
  res.setHeader('x-llm-proxy', 'hit')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('x-accel-buffering', 'no')

  if (!upstream.body) {
    res.end()
    return
  }

  // 逐块回传，保证 SSE 实时性；处理背压，避免大响应撑爆内存
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    }
    res.end()
  } catch {
    if (!res.writableEnded) res.end()
  }
}

export default defineConfig({
  plugins: [vue(), llmDevProxy()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5173
  }
})
