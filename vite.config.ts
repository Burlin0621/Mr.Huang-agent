import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig, type Plugin } from 'vite'

/**
 * 开发期大模型反向代理：浏览器直连厂商 API 会被 CORS 拦截，
 * 因此 src 内的请求层在开发模式下统一请求同源路径 /llm-proxy/chat/completions，
 * 并通过请求头 x-llm-base-url 携带目标 baseUrl，由该中间件原样转发
 * （含 Authorization、请求体），响应（含 SSE 流）也原封不动回传。
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
    sendJsonError(
      502,
      `开发代理无法连接目标接口服务（${target}）：${err instanceof Error ? err.message : String(err)}`,
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
