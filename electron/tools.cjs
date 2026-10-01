/**
 * 主进程工具注册表与统一调用入口（tool:call IPC）。
 *
 * 结构：{ name, description, inputSchema(简化 JSON Schema), handler, requiresConfirm, timeoutMs }
 * - 仅信任自家渲染进程：入口由 main.cjs 的 ipcMain.handle('tool:call') 暴露，
 *   contextIsolation 开启时外部页面无法触达；
 * - requiresConfirm 的工具在执行前弹原生确认框，用户拒绝返回 { ok:false, error, canceled:true }；
 *   实际是否确认由渲染层透传的 context.permissionMode（权限模式）决策：
 *   · 'full'：完全访问，所有工具自动放行，不再弹确认框；
 *   · 'auto-edit'：自动编辑，文件编辑类（vault_write / fs_write / fs_edit）放行，http_post_json 仍需确认；
 *   · 'plan'：计划模式，写类工具（vault_write / http_post_json / fs_write / fs_edit / memory_write / memory_append）直接拒绝（渲染层已拦截，此处兜底）；
 *   · 缺省 / 'confirm'：变更前确认（默认档），requiresConfirm=true 的工具弹窗确认，其余放行；
 *     fs_write（覆盖）/ fs_edit 的确认框展示行级 diff 预览（buildLineDiff），而非 JSON 参数；
 * - 统一超时与输出截断（返回给模型的文本上限 OUTPUT_MAX_BYTES ≈ 20KB）；
 * - callTool/registerToolIpc 支持渲染层透传 context（如当前模型配置 { apiKey, baseUrl }），
 *   供 web_search 等需要密钥的工具使用；未透传时相关工具返回友好错误文本而非抛错。
 *
 * ⚠️ 同步义务：本文件的 description/inputSchema 与 src/lib/agent-tools.ts 的 AGENT_TOOLS
 * 一一对应（.cjs 与 TS 无法直接互引，故手工复制）。任何 schema 变更必须同步两边，
 * name 是渲染进程、LLM 与本注册表三方的唯一关联键。
 */
const { dialog, BrowserWindow } = require('electron')
const path = require('node:path')
const fsp = require('node:fs/promises')
const checkpoints = require('./checkpoints.cjs')
const browserControl = require('./browser.cjs')
const vault = require('./vault.cjs')
const fsTools = require('./fs-tools.cjs')
const shellTools = require('./shell-tools.cjs')
const gitTools = require('./git-tools.cjs')
const memoryStore = require('./memory-store.cjs')

/** 返回给模型的工具输出文本上限（约 20KB，按 UTF-8 字符数近似截断） */
const OUTPUT_MAX_CHARS = 20_000
/** HTTP 工具默认超时（毫秒） */
const HTTP_TIMEOUT_MS = 15_000
/** 兜底工具超时（毫秒） */
const DEFAULT_TIMEOUT_MS = 20_000
/** 请求方 UA 标识 */
const USER_AGENT = 'MrHuangAgent/0.1 (Electron main; tool-call)'

/** 把 HTML 粗略转为纯文本：去 script/style、去标签、还原常见实体、压缩空白 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

/** 截断到输出上限，并标注已截断；含 [IMAGE:dataURL] 标记的结果放行（截图需完整传给模型） */
function truncateOutput(text) {
  if (typeof text !== 'string') text = String(text ?? '')
  if (text.includes('[IMAGE:') || text.length <= OUTPUT_MAX_CHARS) return text
  return `${text.slice(0, OUTPUT_MAX_CHARS)}\n\n[输出超过上限，已截断：原始长度 ${text.length} 字符]`
}

/** 校验 URL 仅允许 http/https，返回 null 表示合法 */
function validateHttpUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return 'URL 无法解析，请提供完整的 http(s) 地址'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `仅支持 http/https 协议，收到：${parsed.protocol}`
  }
  return null
}

/** 解析 vault 工具的根目录：优先取 args.rootPath，缺省回退渲染层注入的 context.vaultRoot */
function resolveVaultRoot(args, context) {
  const root = typeof args.rootPath === 'string' ? args.rootPath.trim() : ''
  if (root) return root
  const injected = typeof context?.vaultRoot === 'string' ? context.vaultRoot.trim() : ''
  if (injected) return injected
  throw new Error('当前工作区未关联文件夹，请先在工作区设置中关联笔记文件夹')
}

/** 字节数格式化为人类可读文本（B / KB / MB） */
function formatBytes(size) {
  if (!Number.isFinite(size) || size < 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(2)} MB`
}

/**
 * 生成统一风格的行级文本 diff（零依赖纯函数，Node 环境可直接单测）：
 * - `- ` 删行、`+ ` 增行、`  ` 上下文行，上下文各 2 行；
 * - 最多显示 maxLines 行，超出时保留头尾并标注省略行数；
 * - 算法：去公共前缀/后缀行后，中间旧文全部记为删行、新文全部记为增行
 *   （简单行级对比，不做最小编辑距离，避免大文件 O(n·m) 开销）。
 */
function buildLineDiff(oldText, newText, maxLines = 40, contextSize = 2) {
  const oldLines = oldText === '' ? [] : String(oldText ?? '').split('\n')
  const newLines = String(newText ?? '').split('\n')
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1
  }
  let endOld = oldLines.length
  let endNew = newLines.length
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1
    endNew -= 1
  }
  const rows = []
  for (let i = Math.max(0, start - contextSize); i < start; i += 1) rows.push(`  ${oldLines[i]}`)
  for (let i = start; i < endOld; i += 1) rows.push(`- ${oldLines[i]}`)
  for (let i = start; i < endNew; i += 1) rows.push(`+ ${newLines[i]}`)
  const tailStart = Math.min(endNew + contextSize, newLines.length)
  for (let i = endNew; i < tailStart; i += 1) rows.push(`  ${newLines[i]}`)
  if (rows.length <= maxLines) {
    return rows.length > 0 ? rows.join('\n') : '（无变化）'
  }
  const headCount = Math.floor((maxLines - 1) / 2)
  const tailCount = maxLines - 1 - headCount
  const omitted = rows.length - headCount - tailCount
  return [
    ...rows.slice(0, headCount),
    `…（diff 已省略 ${omitted} 行）`,
    ...rows.slice(rows.length - tailCount),
  ].join('\n')
}

/**
 * 写类工具确认弹窗的 diff 预览构造器：toolName → async (args, context) => detail 文本。
 * 预检失败（如 old_string 不匹配）时降级为 JSON 参数预览，由执行阶段给出精确错误。
 */
const CONFIRM_DETAIL_BUILDERS = {
  async fs_write(args, context) {
    const rootPath = resolveVaultRoot(args, context)
    const preview = await fsTools.previewWorkspaceWrite(
      rootPath,
      String(args.path),
      String(args.content ?? ''),
      args.overwrite === true,
    )
    return [
      `文件：${args.path}`,
      preview.existed
        ? `操作：覆盖已有文件（${formatBytes(Buffer.byteLength(preview.oldText, 'utf-8'))} → ${formatBytes(preview.size)}）`
        : `操作：新建文件（${formatBytes(preview.size)}）`,
      '',
      buildLineDiff(preview.oldText, String(args.content ?? '')),
    ].join('\n')
  },
  async fs_edit(args, context) {
    const rootPath = resolveVaultRoot(args, context)
    const preview = await fsTools.previewWorkspaceEdit(
      rootPath,
      String(args.path),
      String(args.old_string ?? ''),
      String(args.new_string ?? ''),
      args.replace_all === true,
    )
    return [
      `文件：${args.path}${args.replace_all === true ? '（replace_all）' : ''}`,
      `替换：${preview.replaced} 处`,
      '',
      buildLineDiff(preview.oldText, preview.newText),
    ].join('\n')
  },
  async shell_exec(args) {
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '工作区根目录'
    const command = String(args.command ?? '')
    const timeoutMs = typeof args.timeout_ms === 'number' ? Math.trunc(args.timeout_ms) : 60000
    return `命令：\n${command}\n\n工作目录：${cwd}\n超时：${timeoutMs}ms`
  },
  async git_commit(args, context) {
    const rootPath = resolveVaultRoot({}, context)
    return gitTools.previewCommit(rootPath, args.stage_all === true, String(args.message ?? ''))
  },
}

/** 带超时与 UA 的 fetch；返回 { ok, status, text } 或抛 Error */
async function httpFetch(url, init, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) },
      signal: controller.signal,
      redirect: 'follow',
    })
    const raw = await response.text()
    return { ok: response.ok, status: response.status, text: raw }
  } finally {
    clearTimeout(timer)
  }
}

/** web_fetch 响应体大小上限（2MB） */
const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024
/** web_fetch 请求超时（毫秒） */
const WEB_FETCH_TIMEOUT_MS = 20_000

/**
 * web_fetch 专用 HTML → 文本转换：在 htmlToText 的剥离逻辑基础上，
 * 额外保留标题/链接/列表的轻量 Markdown 结构（零依赖，正则实现）：
 * - h1-h6 → `#` 标题行；li → `- ` 列表项；a → `[文本](href)`（仅 http(s) 链接）；
 * - 去除 script/style/noscript/svg 注释等噪音块，再统一剥标签、还原实体、压缩空白。
 */
function htmlToReadableText(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<(svg|template|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // 链接 → Markdown（剥离前处理，保留 href）
    .replace(/<a\s[^>]*href\s*=\s*["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, inner) => {
      const label = String(inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return label ? `[${label}](${href})` : ''
    })
    // 标题 → Markdown 井号（成对标签整体替换，避免标签名丢失层级）
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level, inner) => {
      const content = String(inner).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return content ? `\n\n${'#'.repeat(Number(level))} ${content}\n\n` : ' '
    })
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6]|ul|ol|table|section|article|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
  return text
}

/** 从 HTML 中提取 <title> 文本；缺失返回空串 */
function extractHtmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  if (!match) return ''
  return match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * web_fetch 抓取实现：fetch（自动跟随重定向）+ 20s 超时 + 2MB 流式截断；
 * 按 content-type 判定：HTML 走 htmlToReadableText 提取正文，其余按纯文本返回。
 * 返回 { ok, status, finalUrl, contentType, title, body, truncatedBySize }。
 */
async function fetchWebPage(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS)
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': USER_AGENT, accept: 'text/html, text/*, application/json; q=0.9, */*; q=0.5' },
      signal: controller.signal,
      redirect: 'follow',
    })
  } finally {
    clearTimeout(timer)
  }

  // 流式读取并按字节数截断，避免超大响应把内存/上下文撑爆
  const chunks = []
  let received = 0
  let truncatedBySize = false
  const reader = response.body?.getReader()
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      if (received >= WEB_FETCH_MAX_BYTES) {
        truncatedBySize = true
        await reader.cancel().catch(() => {})
        break
      }
    }
  }
  const buffer = Buffer.concat(chunks).subarray(0, WEB_FETCH_MAX_BYTES)
  let text = buffer.toString('utf-8')
  if (text.includes('\uFFFD')) {
    // 常见中文页面 utf-8 解码失败时回退 latin1，避免整篇替换符
    const latin = buffer.toString('latin1')
    if (!latin.includes('\uFFFD')) text = latin
  }

  const contentType = response.headers.get('content-type') || ''
  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /<html|<!doctype html|<body/i.test(text)
  let title = ''
  let body = text
  if (isHtml) {
    title = extractHtmlTitle(text)
    body = htmlToReadableText(text)
  }
  return {
    ok: response.ok,
    status: response.status,
    finalUrl: response.url || url,
    contentType: contentType.split(';')[0].trim(),
    title,
    body,
    truncatedBySize,
  }
}

/** 从透传 context 中取出当前 workspaceId；缺失/非法时抛中文错误（memory 工具用） */
function requireWorkspaceId(context) {
  const workspaceId = typeof context?.workspaceId === 'string' ? context.workspaceId : ''
  if (!memoryStore.isValidWorkspaceId(workspaceId)) {
    throw new Error('无法获取当前工作区，请先选择一个工作区')
  }
  return workspaceId
}

/** 工具注册表：name → 定义（与 src/lib/agent-tools.ts 的 AGENT_TOOLS 保持同步） */
const TOOL_REGISTRY = {
  current_time: {
    description: '获取当前的本地日期与时间（含时区与星期）',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler() {
      const now = new Date()
      const weekday = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][now.getDay()]
      const pad = (v) => String(v).padStart(2, '0')
      return (
        `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ` +
        `${weekday}（时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}）`
      )
    },
  },

  http_get: {
    description: '发起 HTTP GET 请求，抓取 URL 内容并转为纯文本返回（仅 http/https，超时 15 秒，输出截断）',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的完整 URL，必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
    requiresConfirm: false,
    timeoutMs: HTTP_TIMEOUT_MS,
    async handler(args) {
      const urlError = validateHttpUrl(args.url)
      if (urlError) throw new Error(urlError)
      const { ok, status, text } = await httpFetch(args.url, { method: 'GET' }, HTTP_TIMEOUT_MS)
      const body = /<html|<!doctype html|<body/i.test(text)
        ? htmlToText(text)
        : text
      const prefix = ok ? `HTTP ${status}` : `HTTP ${status}（请求返回非 2xx）`
      return `${prefix}\n\n${truncateOutput(body)}`
    },
  },

  web_fetch: {
    description:
      '联网抓取指定 URL 的网页并转为可读文本返回（自动跟随重定向，超时 20 秒，响应上限 2MB，输出截断）。' +
      'HTML 页面会剥离 script/style 与标签并提取 <title> 与正文文本；txt/json/md 等纯文本内容原样返回。' +
      '需要完整阅读某个网页/文档链接的内容时优先使用本工具（比 http_get 的正文提取更完整）。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要抓取的完整 URL，必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
    requiresConfirm: false,
    timeoutMs: 30_000,
    async handler(args) {
      const urlError = validateHttpUrl(args.url)
      if (urlError) throw new Error(urlError)
      const { ok, status, finalUrl, contentType, title, body, truncatedBySize } = await fetchWebPage(
        String(args.url),
      )
      const headerLines = [
        `HTTP ${status}${ok ? '' : '（请求返回非 2xx）'}`,
        `最终地址：${finalUrl}`,
        `类型：${contentType || '（未知）'}`,
        title ? `标题：${title}` : null,
        truncatedBySize ? '（响应超过 2MB，已截断）' : null,
      ].filter(Boolean)
      return `${headerLines.join('\n')}\n\n${truncateOutput(body)}`
    },
  },

  http_post_json: {
    description: '发送 POST 请求（application/json），返回响应文本（仅 http/https，超时 15 秒，输出截断）',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标 URL，必须以 http:// 或 https:// 开头' },
        body: { type: 'string', description: '要发送的 JSON 字符串（必须是合法 JSON）' },
      },
      required: ['url', 'body'],
    },
    requiresConfirm: true,
    timeoutMs: HTTP_TIMEOUT_MS,
    async handler(args) {
      const urlError = validateHttpUrl(args.url)
      if (urlError) throw new Error(urlError)
      let bodyText = args.body
      try {
        bodyText = JSON.stringify(JSON.parse(args.body))
      } catch {
        throw new Error('body 不是合法的 JSON 字符串')
      }
      const { ok, status, text } = await httpFetch(
        args.url,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyText },
        HTTP_TIMEOUT_MS,
      )
      const prefix = ok ? `HTTP ${status}` : `HTTP ${status}（请求返回非 2xx）`
      return `${prefix}\n\n${truncateOutput(text)}`
    },
  },

  browser_navigate: {
    description:
      '用内置无头浏览器打开指定网页（仅 http/https，操作超时 30 秒）。要浏览动态渲染的网页内容时先调用本工具，再用 browser_read 读取。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的完整 URL，必须以 http:// 或 https:// 开头' },
      },
      required: ['url'],
    },
    requiresConfirm: false,
    timeoutMs: 75_000,
    async handler(args) {
      const urlError = validateHttpUrl(args.url)
      if (urlError) throw new Error(urlError)
      const { title, url } = await browserControl.navigate(args.url)
      return `已打开页面\n标题：${title || '（无标题）'}\n地址：${url}\n可调用 browser_read 读取正文内容`
    },
  },

  browser_read: {
    description:
      '读取内置浏览器当前打开页面的内容：页面标题 + 正文纯文本（已剥离脚本、导航、页脚等噪音）+ 链接列表，超长内容截断。必须先用 browser_navigate 打开页面。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresConfirm: false,
    timeoutMs: 45_000,
    async handler() {
      const data = await browserControl.readPage()
      if (!data) {
        throw new Error('尚未打开任何页面，请先调用 browser_navigate 打开目标网页')
      }
      const linkBlock = data.links.length > 0 ? `\n\n页面链接（最多 50 条）：\n${data.links.join('\n')}` : ''
      return `标题：${data.title || '（无标题）'}\n地址：${data.url}\n\n${truncateOutput(data.text)}${linkBlock}`
    },
  },

  browser_screenshot: {
    description:
      '对内置浏览器当前打开的页面截取全页 PNG，并把截图作为图片提供给模型查看，用于 UI 走查、版式核对等视觉场景。必须先调用 browser_navigate 打开页面。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresConfirm: false,
    timeoutMs: 45_000,
    async handler() {
      const data = await browserControl.screenshot()
      if (!data) {
        throw new Error('尚未打开任何页面，请先调用 browser_navigate 打开目标网页')
      }
      // 图片以 [IMAGE:dataURL] 标记嵌入：渲染层 runAgentLoop 会拆出该标记，
      // 把图片转为紧随 tool 消息之后的 user 视觉消息传给模型
      return `已截图（${data.width}x${data.height}）：[IMAGE:${data.dataUrl}]`
    },
  },

  browser_close: {
    description: '关闭内置浏览器并释放资源。完成网页浏览任务后调用，或浏览器状态异常时调用以便下次重新启动。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler() {
      await browserControl.closeBrowser()
      return '浏览器已关闭，资源已释放'
    },
  },

  web_search: {
    description:
      '联网关键词搜索，返回结构化结果列表（标题/摘要/链接/来源/日期），适合热点、资讯、时事类检索；查"最近/今天/最新"的内容时优先使用本工具而不是用 http_get 猜网址。依赖智谱开放平台 API Key（baseUrl 为 open.bigmodel.cn 的模型配置）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        count: { type: 'number', description: '返回结果条数（1-50，默认 10）' },
        recency: {
          type: 'string',
          description: '时间范围过滤："oneDay"|"oneWeek"|"oneMonth"|"noLimit"，默认 "oneWeek"',
        },
      },
      required: ['query'],
    },
    requiresConfirm: false,
    timeoutMs: 20_000,
    async handler(args, context) {
      const apiKey = context?.apiKey
      if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return 'web_search 需要智谱开放平台 API Key：请在「设置 → 模型配置」选用 baseUrl 为 open.bigmodel.cn 且已填密钥的配置'
      }
      const baseUrl = typeof context?.baseUrl === 'string' ? context.baseUrl.trim() : ''
      let endpoint = 'https://open.bigmodel.cn/api/paas/v4/web_search'
      try {
        const origin = new URL(baseUrl).origin
        if (origin === 'https://open.bigmodel.cn' || origin === 'http://open.bigmodel.cn') {
          endpoint = `${origin}/api/paas/v4/web_search`
        }
      } catch {
        // baseUrl 非法（如第三方端点格式不同）时回退默认官方端点
      }

      const query = String(args.query).trim()
      const recency = typeof args.recency === 'string' ? args.recency.trim() : ''
      const validRecency = ['noLimit', 'oneDay', 'oneWeek', 'oneMonth']
      if (recency && !validRecency.includes(recency)) {
        throw new Error(`参数 recency 仅支持 ${validRecency.join(' | ')}，收到：${recency}`)
      }
      let count = 10
      if (args.count !== undefined) {
        count = Math.trunc(args.count)
        if (!Number.isFinite(count) || count < 1 || count > 50) {
          throw new Error('参数 count 必须是 1-50 之间的整数')
        }
      }

      const payload = {
        search_engine: 'search_std',
        search_query: query,
        count,
        search_recency_filter: recency || 'oneWeek',
        content_size: 'medium',
      }
      const { ok, status, text } = await httpFetch(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify(payload),
        },
        20_000,
      )
      if (!ok) {
        return `web_search 请求失败（HTTP ${status}）：${truncateOutput(text.slice(0, 500))}`
      }
      let data
      try {
        data = JSON.parse(text)
      } catch {
        return `web_search 响应不是合法 JSON：${truncateOutput(text.slice(0, 500))}`
      }
      const results = Array.isArray(data.search_result) ? data.search_result : []
      if (results.length === 0) {
        return '未搜索到结果'
      }
      const lines = results.map((item, index) => {
        const title = typeof item?.title === 'string' ? item.title : ''
        const link = typeof item?.link === 'string' ? item.link : ''
        const content = typeof item?.content === 'string' ? item.content : ''
        const media = typeof item?.media === 'string' ? item.media : ''
        const publishDate = typeof item?.publish_date === 'string' ? item.publish_date : ''
        return [
          `${index + 1}. ${title}`,
          media ? `   来源：${media}` : null,
          publishDate ? `   日期：${publishDate}` : null,
          link ? `   链接：${link}` : null,
          content ? `   摘要：${content}` : null,
        ]
          .filter(Boolean)
          .join('\n')
      })
      return lines.join('\n\n')
    },
  },

  image_generate: {
    description:
      '调用智谱 GLM-Image 生成一张图片，返回图片 URL。适合公众号封面、文章插图、配图等场景。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述（最大 1000 字符，超出会自动截断）' },
        size: {
          type: 'string',
          description:
            '图片尺寸"宽x高"（如 1280x1280），宽高均在 512-2048 之间且为 32 的整数倍，默认 "1280x1280"（推荐 1728x960 / 1472x1088 / 1280x1280）',
        },
      },
      required: ['prompt'],
    },
    requiresConfirm: false,
    // 高分辨率生图经常超过 60 秒，放宽到 180 秒避免频繁超时
    timeoutMs: 180_000,
    async handler(args, context) {
      const apiKey = context?.apiKey
      if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
        return 'image_generate 需要智谱开放平台 API Key：请在「设置 → 模型配置」选用 baseUrl 为 open.bigmodel.cn 且已填密钥的配置'
      }
      const baseUrl = typeof context?.baseUrl === 'string' ? context.baseUrl.trim() : ''
      let endpoint = 'https://open.bigmodel.cn/api/paas/v4/images/generations'
      try {
        const origin = new URL(baseUrl).origin
        if (origin === 'https://open.bigmodel.cn' || origin === 'http://open.bigmodel.cn') {
          endpoint = `${origin}/api/paas/v4/images/generations`
        }
      } catch {
        // baseUrl 非法（如第三方端点格式不同）时回退默认官方端点
      }

      // prompt 截断（GLM-Image 上限 1000 字符）
      let prompt = String(args.prompt ?? '').trim()
      let truncatedNote = ''
      if (prompt.length > 1000) {
        prompt = prompt.slice(0, 1000)
        truncatedNote = '\n（注：prompt 超过 1000 字符上限，已自动截断）'
      }

      // size 校验：宽x高，均在 512-2048 之间且为 32 的整数倍
      const size = typeof args.size === 'string' && args.size.trim() ? args.size.trim() : '1280x1280'
      const sizeMatch = size.match(/^(\d+)x(\d+)$/)
      if (!sizeMatch) {
        throw new Error(`参数 size 格式应为 "宽x高"（如 1280x1280），收到：${size}`)
      }
      const isValidSide = (value) => value >= 512 && value <= 2048 && value % 32 === 0
      const width = Number(sizeMatch[1])
      const height = Number(sizeMatch[2])
      if (!isValidSide(width) || !isValidSide(height)) {
        throw new Error(
          `参数 size 的宽高必须在 512-2048 之间且为 32 的整数倍，收到：${size}（推荐 1728x960 / 1472x1088 / 1280x1280）`,
        )
      }

      const { ok, status, text } = await httpFetch(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify({ model: 'glm-image', prompt, size }),
        },
        175_000,
      )
      if (!ok) {
        return `image_generate 请求失败（HTTP ${status}）：${truncateOutput(text.slice(0, 500))}`
      }
      let data
      try {
        data = JSON.parse(text)
      } catch {
        return `image_generate 响应不是合法 JSON：${truncateOutput(text.slice(0, 500))}`
      }
      const url = Array.isArray(data?.data) ? data.data[0]?.url : undefined
      if (!url || typeof url !== 'string') {
        return `image_generate 响应中没有图片 URL：${truncateOutput(text.slice(0, 500))}`
      }
      return `图片生成成功\nURL: ${url}\n尺寸: ${size}${truncatedNote}`
    },
  },

  vault_list: {
    description:
      '列出当前工作区关联的 Obsidian 笔记文件夹（vault）中的全部 .md 笔记（扁平清单：相对路径/文件名/大小/修改时间，跳过隐藏目录）。需要浏览笔记有哪些、决定读哪篇时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        subPath: { type: 'string', description: '可选，限定列出的子目录（vault 内相对路径）' },
      },
      required: [],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await vault.listVaultTree(rootPath)
      let files = data.files
      let truncated = data.truncated
      if (typeof args.subPath === 'string' && args.subPath.trim()) {
        const prefix = `${args.subPath.trim().replace(/\/+$/, '')}/`
        files = files.filter((item) => item.path.startsWith(prefix))
      }
      if (files.length === 0) {
        return 'vault 中没有找到 .md 笔记'
      }
      const lines = files.map((item) => {
        const kb = item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KB`
        return `${item.path}（${kb}）`
      })
      if (truncated) lines.push('…（文件数超出上限，清单已截断）')
      return `共 ${files.length} 篇笔记：\n${lines.join('\n')}`
    },
  },

  vault_read: {
    description:
      '读取当前工作区关联 vault 中的一篇 .md 笔记的完整内容（单篇上限 2MB，超长截断）。需要查看笔记正文时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '笔记在 vault 内的相对路径（以 / 分隔，如「日记/2026-09-27.md」）' },
      },
      required: ['path'],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await vault.readVaultFile(rootPath, String(args.path))
      return `笔记：${String(args.path)}\n\n${truncateOutput(data.content)}`
    },
  },

  vault_write: {
    description:
      '向当前工作区关联的 vault 写入一篇 .md 笔记（自动创建父目录；默认不覆盖已存在文件，需要覆盖时显式传 overwrite=true）。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '笔记在 vault 内的相对路径（以 / 分隔，如「AI 笔记/2026-09-27.md」）' },
        content: { type: 'string', description: '笔记正文（Markdown 文本）' },
        overwrite: { type: 'boolean', description: '目标笔记已存在时是否覆盖，默认 false' },
      },
      required: ['path', 'content'],
    },
    requiresConfirm: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await vault.writeVaultFile(
        rootPath,
        String(args.path),
        String(args.content),
        args.overwrite === true,
      )
      return `已写入笔记：${data.path}（${data.size} 字节）`
    },
  },

  vault_search: {
    description:
      '在当前工作区关联的 vault 中全文检索关键词（大小写不敏感按行匹配，返回笔记路径/行号/上下文片段，最多 100 条）。需要按内容查找笔记时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: 'vault 根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        query: { type: 'string', description: '搜索关键词' },
      },
      required: ['query'],
    },
    requiresConfirm: false,
    timeoutMs: 30_000,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await vault.searchVault(rootPath, String(args.query))
      if (data.hits.length === 0) {
        return `vault 中没有包含「${String(args.query)}」的笔记`
      }
      const lines = data.hits.map((hit) => `${hit.path}:${hit.line}  ${hit.snippet}`)
      if (data.truncated) lines.push('…（命中数超出上限，结果已截断）')
      return `共 ${data.hits.length} 条命中：\n${lines.join('\n')}`
    },
  },

  fs_list: {
    description:
      '列出当前工作区关联文件夹中的全部文件（不限扩展名，扁平清单：相对路径/大小/修改时间，跳过隐藏目录；可用 subPath 限定子目录、ext 按扩展名过滤）。需要浏览工作区有哪些文件、决定读哪个时先调用本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        subPath: { type: 'string', description: '可选，限定列出的子目录（工作区内相对路径）' },
        ext: { type: 'string', description: '可选，按扩展名过滤，如 "docx" 或 ".docx"（大小写不敏感）' },
      },
      required: [],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await fsTools.listWorkspaceFiles(rootPath, args.subPath, args.ext)
      if (data.files.length === 0) {
        return '工作区文件夹中没有找到符合条件的文件'
      }
      const lines = data.files.map((item) => {
        const kb = item.size < 1024 ? `${item.size} B` : `${(item.size / 1024).toFixed(1)} KB`
        const date = new Date(item.mtime)
        const pad = (v) => String(v).padStart(2, '0')
        const time = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
        return `${item.path}（${kb}，${time}）`
      })
      if (data.truncated) lines.push('…（文件数超出上限，清单已截断）')
      return `共 ${data.files.length} 个文件：\n${lines.join('\n')}`
    },
  },

  fs_read: {
    description:
      '读取当前工作区关联文件夹中文本类文件的完整内容（utf-8，GBK 自动兜底；支持 .md .txt .json .csv .xml .html .yml .js .ts .py .css 等文本扩展名，单文件上限 2MB，超长截断）。.docx/.pdf 请改用 fs_read_document。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文件在工作区内的相对路径（以 / 分隔，如「docs/说明.md」）' },
      },
      required: ['path'],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await fsTools.readWorkspaceTextFile(rootPath, String(args.path))
      return `文件：${String(args.path)}\n\n${truncateOutput(data.content)}`
    },
  },

  fs_read_document: {
    description:
      '读取当前工作区关联文件夹中的 .docx 或 .pdf 文档并转为纯文本返回（上限 20MB，超长截断）。需要读取 Word 文档或 PDF 的正文内容时使用；.doc/.xls/.ppt 等旧格式不支持，请先另存为新格式。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文档在工作区内的相对路径（以 / 分隔，如「合同/协议.docx」）' },
      },
      required: ['path'],
    },
    requiresConfirm: false,
    timeoutMs: 60_000,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await fsTools.readWorkspaceDocumentFile(rootPath, String(args.path))
      return `文档：${String(args.path)}（${data.kind.toUpperCase()}）\n\n${truncateOutput(data.content)}`
    },
  },

  fs_write: {
    description:
      '在工作区关联文件夹内写入文本文件（utf-8，自动创建父目录；仅支持 .md .txt .json .csv .xml .html .yml .js .ts .py .css 等文本扩展名，单文件上限 2MB）。默认目标已存在时拒绝，需要覆盖时显式传 overwrite=true；仅允许工作区内相对路径，禁止路径穿越。新建或覆盖文件时使用；修改已有文件的局部内容优先用 fs_edit。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文件在工作区内的相对路径（以 / 分隔，如「docs/说明.md」）' },
        content: { type: 'string', description: '要写入的完整文本内容（utf-8）' },
        overwrite: { type: 'boolean', description: '目标文件已存在时是否覆盖，默认 false（不覆盖则报错）' },
      },
      required: ['path', 'content'],
    },
    requiresConfirm: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await fsTools.writeWorkspaceTextFile(
        rootPath,
        String(args.path),
        String(args.content),
        args.overwrite === true,
      )
      return `已写入文件：${data.path}（${formatBytes(data.size)}，${data.existed ? '覆盖已有文件' : '新建文件'}）`
    },
  },

  fs_edit: {
    description:
      '对工作区内已有的文本文件做精准替换编辑：old_string 必须在文件中恰好出现一次（replace_all=true 时替换全部出现），否则报错并需调整后重试。替换后原子写回（utf-8，GBK 兜底读取）。仅支持文本类扩展名、单文件 2MB 上限、仅允许工作区内相对路径。修改已有文件的局部内容时优先使用本工具，而不是用 fs_write 整文件重写。',
    inputSchema: {
      type: 'object',
      properties: {
        rootPath: { type: 'string', description: '根目录绝对路径；不传则自动使用当前工作区关联的文件夹' },
        path: { type: 'string', description: '文件在工作区内的相对路径（以 / 分隔，如「docs/说明.md」）' },
        old_string: { type: 'string', description: '要被替换的原文片段（必须与文件内容精确匹配，含缩进与换行）' },
        new_string: { type: 'string', description: '替换后的新文本（删除内容时传空字符串）' },
        replace_all: { type: 'boolean', description: '是否替换全部出现（默认 false，仅允许恰好出现一次）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    requiresConfirm: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot(args, context)
      const data = await fsTools.editWorkspaceTextFile(
        rootPath,
        String(args.path),
        String(args.old_string),
        String(args.new_string),
        args.replace_all === true,
      )
      return `已编辑文件：${data.path}（替换 ${data.replaced} 处，现 ${formatBytes(data.size)}）`
    },
  },

  shell_exec: {
    description:
      '在工作区文件夹内执行一条 shell 命令（Windows cmd）并返回 stdout/stderr/退出码。适合运行构建、测试、脚本、git 等命令。每次只执行一条命令，不支持交互式输入；谨慎使用删除、格式化等破坏性命令，破坏性操作需先征得用户同意。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令（单条，不支持交互式输入）' },
        cwd: {
          type: 'string',
          description: '可选，工作目录（工作区内相对路径，缺省为工作区根；禁止 ../ 或绝对路径逃逸）',
        },
        timeout_ms: {
          type: 'number',
          description: '可选，超时毫秒（1000–300000，默认 60000），超时将终止整个进程树',
        },
      },
      required: ['command'],
    },
    requiresConfirm: true,
    timeoutMs: 310_000,
    async handler(args, context) {
      const rootPath = resolveVaultRoot({}, context)
      return shellTools.runShellCommand(String(args.command), args.cwd, args.timeout_ms, rootPath)
    },
  },

  git_status: {
    description:
      '查看工作区 git 仓库状态（只读）：当前分支、与上游的领先/落后、已暂存/未暂存/未跟踪文件清单（结构化）。建议在 git_diff / git_commit 之前先调用本工具了解全貌。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(_args, context) {
      const rootPath = resolveVaultRoot({}, context)
      return gitTools.getGitStatus(rootPath)
    },
  },

  git_diff: {
    description:
      '查看工作区 git 仓库的变更内容（只读，逐文件 unified diff）：默认比较工作区 vs 暂存区；staged=true 比较暂存区 vs HEAD；可用 path 限定单个文件（工作区内相对路径）。输出按「=== 文件：路径 ===」分块。提交前建议先用本工具核对要提交的内容。',
    inputSchema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: '可选，true 时查看暂存区相对 HEAD 的 diff（默认 false：工作区相对暂存区）' },
        path: { type: 'string', description: '可选，限定单个文件（工作区内相对路径，如「src/lib/llm.ts」）' },
      },
      required: [],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot({}, context)
      return gitTools.getGitDiff(rootPath, args.staged === true, args.path)
    },
  },

  git_commit: {
    description:
      '提交当前 git 仓库的暂存区内容（写操作，需确认）：只提交已暂存的变更，不做自动 add。暂存区为空时报错——此时先用 git_status / git_diff 查看变更，确认要把全部变更纳入时再传 stage_all=true（等价 git add -A 后提交），否则让用户手动暂存。建议流程：git_status → git_diff 核对 →（需要时用 fs_edit 微调）→ git_commit；提交说明（message）由你根据变更内容撰写，首行为简短主题，正文另起行补充细节。',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '提交说明：首行为主题（简洁概括本次变更），可另起行写正文细节（将作为第二条 -m 传入）',
        },
        stage_all: {
          type: 'boolean',
          description: '可选，true 时先执行 git add -A 把工作区全部变更纳入暂存区再提交（默认 false：只提交已暂存内容）',
        },
      },
      required: ['message'],
    },
    requiresConfirm: true,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const rootPath = resolveVaultRoot({}, context)
      return gitTools.commitStaged(rootPath, args.stage_all === true, String(args.message))
    },
  },

  memory_read: {
    description:
      '读取当前工作区的长期记忆全文（Markdown：用户偏好、项目约定、经验教训等跨会话沉淀）。回答前需要回顾既有记忆，或写入记忆后核对结果时使用。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(_args, context) {
      const workspaceId = requireWorkspaceId(context)
      const content = memoryStore.readMemory(workspaceId)
      if (!content.trim()) {
        return '（当前工作区暂无记忆。当用户表达持久偏好或得出可复用经验时，可用 memory_append 沉淀。）'
      }
      return content
    },
  },

  memory_write: {
    description:
      '整篇覆盖当前工作区的长期记忆（用户偏好、项目约定、经验教训等跨会话沉淀）。仅在需要大幅重组/清理记忆时使用；日常沉淀优先用 memory_append。计划模式下会被拦截。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '记忆全文（Markdown），将整篇替换现有记忆；单文件上限 64KB' },
      },
      required: ['content'],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const workspaceId = requireWorkspaceId(context)
      const bytes = memoryStore.writeMemory(workspaceId, String(args.content))
      return `已覆盖写入工作区记忆（${formatBytes(bytes)}）。可用 memory_read 核对。`
    },
  },

  memory_append: {
    description:
      '维护当前工作区的长期记忆（用户偏好、项目约定、经验教训）；涉及「记住/以后都/我的习惯是」等表述，或任务结束得出可复用经验时写入。向记忆末尾追加一节，自动加当天日期标题（## YYYY-MM-DD），无需手动拼接时间戳。',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要追加的记忆正文（Markdown，一节内容；不要自己写日期标题）' },
      },
      required: ['content'],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler(args, context) {
      const workspaceId = requireWorkspaceId(context)
      const bytes = memoryStore.appendMemory(workspaceId, String(args.content))
      return `已追加到工作区记忆（现共 ${formatBytes(bytes)}）。可用 memory_read 核对。`
    },
  },

  // 纯信息性工具：渲染进程在 executeToolWithPrefs 中拦截并返回技能正文（本 handler 仅兜底，
  // 正常不会被触达）。schema 与 src/lib/agent-tools.ts 的 use_skill 保持同步。
  use_skill: {
    description:
      '加载一个技能的完整指令（信息性内容，不执行外部操作）。当「可用技能」清单中的某技能与当前任务相关时调用：参数传技能名称或 id，返回该技能的完整指令与脚本清单。',
    inputSchema: {
      type: 'object',
      properties: {
        skill_id: { type: 'string', description: '技能名称或技能 id（以「可用技能」清单中列出的名称为准）' },
      },
      required: ['skill_id'],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler() {
      return '（技能内容由对话界面注入，主进程无操作。）'
    },
  },

  // 渲染进程拦截直答的工具：实际安装（GitHub 拉取 + 写入技能中心 store）发生在
  // 渲染层 executeToolWithPrefs（本 handler 仅兜底，正常不会被触达）。
  // schema 与 src/lib/agent-tools.ts 的 skill_install 保持同步。
  skill_install: {
    description:
      '把 GitHub 上的 Agent Skill 技能安装进技能中心（等同用户在界面的技能市场点「安装」）。安装成功后技能立即可在技能中心看到，并可用 use_skill 按技能名调用。重复安装会明确提示，不会重复写入。',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'GitHub 仓库简写（如 "anthropics/skills"）或完整 URL（github.com 技能目录 / SKILL.md 文件、raw.githubusercontent.com 链接均可）',
        },
        skillDir: {
          type: 'string',
          description:
            '可选：仓库内技能目录名（如 "pdf"）。仓库含多个技能时用于定位；缺省时自动探测（仓库根直接含 SKILL.md 的单技能仓库）',
        },
        notes: { type: 'string', description: '可选：安装备注，会附在技能正文末尾' },
      },
      required: ['source'],
    },
    requiresConfirm: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    async handler() {
      return '（技能安装由对话界面执行，主进程无操作。）'
    },
  },
}

/**
 * 动态注册运行时工具（MCP 接入用）：
 * - 注册进同一张 TOOL_REGISTRY，callTool 的校验/超时/截断链路对动态工具完全一致；
 * - 与内置工具名冲突时让位（返回 false），保持内置工具与现有权限/确认逻辑不变；
 * - 断开时由调用方 removeDynamicTool 移除。
 */
function registerDynamicTool(name, definition) {
  if (!name || typeof name !== 'string') return false
  if (Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, name)) return false
  TOOL_REGISTRY[name] = definition
  return true
}

/** 移除动态注册的工具（不存在时静默） */
function removeDynamicTool(name) {
  delete TOOL_REGISTRY[name]
}

/** 按简化 JSON Schema 校验参数：required 缺失 / 基础类型不符 / 未知顶层字段忽略 */
function validateArgs(schema, args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return '参数必须是 JSON 对象'
  }
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return `缺少必填参数：${key}`
    }
  }
  const properties = schema.properties || {}
  for (const [key, spec] of Object.entries(properties)) {
    if (args[key] === undefined) continue
    if (spec.type === 'string' && typeof args[key] !== 'string') {
      return `参数 ${key} 必须是字符串`
    }
    if (spec.type === 'number' && typeof args[key] !== 'number') {
      return `参数 ${key} 必须是数字`
    }
    if (spec.type === 'boolean' && typeof args[key] !== 'boolean') {
      return `参数 ${key} 必须是布尔值`
    }
  }
  return null
}

/** requiresConfirm 工具的原生确认框；detail 为弹窗正文（写类文件工具传入 diff 预览）；返回 true=允许执行 */
async function confirmToolCall(toolName, args, detail) {
  const win = BrowserWindow.getAllWindows()[0]
  const preview = (detail || JSON.stringify(args, null, 2)).slice(0, 1500)
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: '工具调用确认',
    message: `智能体请求执行工具「${toolName}」，是否允许？`,
    detail: preview,
    buttons: ['允许执行', '拒绝'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  return response === 0
}

/* —— shell_exec 快捷确认（同一命令 + 同一 cwd 第二次起免确认） —— */

/** shell 免确认记忆文件名（位于 Electron userData 目录；纯 Node 环境回退环境变量目录） */
const SHELL_APPROVE_FILE_NAME = 'shell-approved.json'
/** shell 免确认记忆条目上限：超出后不再新增（防无限膨胀） */
const SHELL_APPROVE_MAX = 500

/** 免确认记忆：`command\u0000cwd` → { command, cwd, addedAt }（内存缓存，懒加载自文件） */
const shellApprovals = new Map()
/** 记忆是否已从文件加载（首次访问时加载一次） */
let shellApprovalsLoaded = false

/** shell 免确认记忆文件路径 */
function shellApproveFilePath() {
  let dir = process.cwd()
  try {
    const electron = require('electron')
    if (electron?.app && typeof electron.app.getPath === 'function') {
      dir = electron.app.getPath('userData')
    }
  } catch {
    // 纯 Node 测试环境：保持 process.cwd()
  }
  if (process.env.MRHUANG_MCP_CONFIG_DIR) dir = process.env.MRHUANG_MCP_CONFIG_DIR
  return path.join(dir, SHELL_APPROVE_FILE_NAME)
}

/** 免确认记忆条目的 key（命令 + 解析后的 cwd 绝对路径） */
function shellApproveKey(command, cwd) {
  return `${command}\u0000${cwd}`
}

/** 从 userData 文件懒加载免确认记忆（文件缺失/损坏时视为空） */
async function ensureShellApprovalsLoaded() {
  if (shellApprovalsLoaded) return
  shellApprovalsLoaded = true
  try {
    const raw = await fsp.readFile(shellApproveFilePath(), 'utf-8')
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return
    for (const item of data) {
      if (!item || typeof item.command !== 'string' || typeof item.cwd !== 'string') continue
      if (!item.command.trim() || !item.cwd.trim()) continue
      shellApprovals.set(shellApproveKey(item.command, item.cwd), {
        command: item.command,
        cwd: item.cwd,
        addedAt: typeof item.addedAt === 'number' ? item.addedAt : 0,
      })
    }
  } catch {
    // 文件不存在或损坏：空记忆
  }
}

/** 免确认记忆持久化到 userData 文件（临时文件 + rename 原子写；失败静默，仅丢本次新增） */
async function persistShellApprovals() {
  try {
    const file = shellApproveFilePath()
    const tmp = `${file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify([...shellApprovals.values()], null, 2), 'utf-8')
    await fsp.rename(tmp, file)
  } catch {
    // 持久化失败不阻断工具执行
  }
}

/** 该命令 + cwd 是否已记忆免确认（首次调用会懒加载文件） */
async function isShellApproved(command, cwd) {
  await ensureShellApprovalsLoaded()
  return shellApprovals.has(shellApproveKey(command, cwd))
}

/** 用户确认通过后记忆该命令 + cwd（超过上限时丢弃新增，先到先得） */
async function rememberShellApproval(command, cwd) {
  await ensureShellApprovalsLoaded()
  const key = shellApproveKey(command, cwd)
  if (shellApprovals.has(key)) return
  if (shellApprovals.size >= SHELL_APPROVE_MAX) return
  shellApprovals.set(key, { command, cwd, addedAt: Date.now() })
  await persistShellApprovals()
}

/** shell_exec 的 cwd 决策键：优先 context.vaultRoot + args.cwd 解析结果，异常时回退 args.cwd 原文 */
function shellApproveCwd(args, context) {
  const cwdArg = typeof args?.cwd === 'string' ? args.cwd : ''
  try {
    return shellTools.resolveShellCwd(context?.vaultRoot, cwdArg)
  } catch {
    return cwdArg
  }
}

/** 列出全部免确认记忆（按加入时间倒序，供设置页展示） */
async function listShellApprovals() {
  await ensureShellApprovalsLoaded()
  return [...shellApprovals.values()].sort((a, b) => b.addedAt - a.addedAt)
}

/** 删除单条免确认记忆（命令 + cwd 精确匹配） */
async function removeShellApproval(command, cwd) {
  await ensureShellApprovalsLoaded()
  const deleted = shellApprovals.delete(shellApproveKey(command, cwd))
  if (deleted) await persistShellApprovals()
  return deleted
}

/** 清空全部免确认记忆 */
async function clearShellApprovals() {
  await ensureShellApprovalsLoaded()
  shellApprovals.clear()
  await persistShellApprovals()
}

/** 权限模式下的写类工具名单（与渲染层 src/lib/tool-executor.ts 的 WRITE_TOOLS 保持一致） */
const WRITE_TOOLS = ['vault_write', 'http_post_json', 'fs_write', 'fs_edit', 'shell_exec', 'memory_write', 'memory_append', 'git_commit']

/** auto-edit 档自动放行的文件编辑类工具（与 vault_write 同语义：改动仅限工作区文件；git_commit 仅影响工作区仓库的提交历史） */
const AUTO_EDIT_TOOLS = ['vault_write', 'fs_write', 'fs_edit', 'git_commit']

/**
 * 按权限模式决策写类工具是否需要确认：
 * - 'full'：一律不确认；'auto-edit'：文件编辑类（vault_write / fs_write / fs_edit）放行，其余仍需确认；
 * - 'confirm'/缺省：需要确认；
 * - 'plan' 由调用方（callTool）在上游直接拒绝，不进入本函数。
 * 返回 true = 需要弹原生确认框。
 */
function writeToolNeedsConfirm(toolName, permissionMode) {
  if (permissionMode === 'full') return false
  if (permissionMode === 'auto-edit') return !AUTO_EDIT_TOOLS.includes(toolName)
  return true
}

/**
 * fs_write / fs_edit 执行前自动创建检查点（尽力而为）：
 * - 需要 context.conversationId（渲染层透传）与 context.vaultRoot（工作区根目录）；
 * - 快照失败（如无会话/无工作区/磁盘异常）时静默跳过，绝不阻塞工具执行；
 * - shell_exec 无法预知涉及文件、git_commit 影响的是提交历史而非工作区文件内容，
 *   均不纳入文件快照（shell_exec 仅由确认弹窗展示命令，git_commit 可用 git_diff 回溯）。
 */
async function createPreWriteCheckpoint(toolName, args, context) {
  const conversationId = typeof context?.conversationId === 'string' ? context.conversationId.trim() : ''
  const vaultRoot = typeof context?.vaultRoot === 'string' ? context.vaultRoot.trim() : ''
  const relPath = typeof args?.path === 'string' ? args.path.trim() : ''
  if (!conversationId || !vaultRoot || !relPath) return null
  try {
    return await checkpoints.createCheckpoint({
      conversationId,
      rootPath: vaultRoot,
      files: [{ relPath }],
      meta: { tool: toolName, operation: toolName, description: relPath },
    })
  } catch {
    return null
  }
}

/**
 * 统一工具调用入口：校验 → 确认 → 执行（超时兜底）→ 截断。
 * 永不抛异常，返回 { ok, result?, error?, canceled? }。
 */
async function callTool(name, args, context) {
  const tool = TOOL_REGISTRY[name]
  if (!tool) {
    return { ok: false, error: `未注册的工具：${name}` }
  }
  const invalid = validateArgs(tool.inputSchema, args)
  if (invalid) {
    return { ok: false, error: invalid }
  }
  const permissionMode =
    context && typeof context === 'object' ? context.permissionMode : undefined
  const isWrite = WRITE_TOOLS.includes(name)
  if (permissionMode === 'plan' && isWrite) {
    // 计划模式兜底：渲染层已拦截，正常不会到达这里
    return { ok: false, error: '计划模式下禁止写入操作' }
  }
  const needConfirm = tool.requiresConfirm && (!isWrite || writeToolNeedsConfirm(name, permissionMode))
  // shell_exec 快捷确认：设置开关开启（context.shellQuickApprove 缺省视为开启）且
  // 同一命令 + 同一 cwd 已记忆时跳过确认（记忆在用户首次允许执行时写入）
  let shellApproved = false
  if (needConfirm && name === 'shell_exec' && context?.shellQuickApprove !== false) {
    try {
      shellApproved = await isShellApproved(String(args.command ?? ''), shellApproveCwd(args, context))
    } catch {
      shellApproved = false
    }
  }
  if (needConfirm && !shellApproved) {
    // 写类文件工具优先展示行级 diff 预览；预检失败（参数不合法/不匹配）时降级为 JSON 预览
    let detail
    const builder = CONFIRM_DETAIL_BUILDERS[name]
    if (builder) {
      try {
        detail = await builder(args, context)
      } catch {
        detail = undefined
      }
    }
    if (!detail && name.startsWith('mcp__')) {
      // MCP 动态工具：确认框展示服务器命名空间内的完整工具名 + 入参 JSON
      detail = `MCP 服务器工具调用\n工具：${name}\n参数：\n${JSON.stringify(args, null, 2)}`
    }
    if (name === 'fs_write' || name === 'fs_edit') {
      // 检查点提示：执行前自动快照原文件，可随时在任务卡片中回滚
      detail = `${detail ? `${detail}\n\n` : ''}已自动创建检查点：执行前会快照文件原内容，可在任务卡片「检查点」中回滚本次修改。`
    }
    const allowed = await confirmToolCall(name, args, detail)
    if (!allowed) {
      return { ok: false, error: '用户拒绝了本次工具调用', canceled: true }
    }
    // shell_exec 首次允许执行：记忆该命令 + cwd，第二次起免确认（快捷确认关闭时不记忆）
    if (name === 'shell_exec' && context?.shellQuickApprove !== false) {
      try {
        await rememberShellApproval(String(args.command ?? ''), shellApproveCwd(args, context))
      } catch {
        // 记忆失败不阻断本次执行
      }
    }
  }
  // 写文件工具执行前自动快照（放在确认之后：用户拒绝时无需产生检查点；失败不阻塞执行）
  if (name === 'fs_write' || name === 'fs_edit') {
    await createPreWriteCheckpoint(name, args, context)
  }
  const timeoutMs = tool.timeoutMs || DEFAULT_TIMEOUT_MS
  let result
  try {
    result = await Promise.race([
      tool.handler(args, context),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`工具执行超时（${timeoutMs}ms）`)), timeoutMs)),
    ])
  } catch (err) {
    const message = err instanceof Error
      ? (err.name === 'AbortError' ? `请求超时（${timeoutMs}ms）或被中止` : err.message)
      : String(err)
    return { ok: false, error: message }
  }
  return { ok: true, result: truncateOutput(result) }
}

/** 注册 tool:call IPC 入口（由 main.cjs 在启动时调用一次）。
 * context 由渲染层透传（如 { apiKey, baseUrl } 当前模型配置），供个别工具（web_search）使用。 */
function registerToolIpc(ipcMain) {
  ipcMain.handle('tool:call', async (_event, name, argsJson, context) => {
    let args = {}
    try {
      args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : argsJson ?? {}
    } catch {
      return { ok: false, error: '参数不是合法的 JSON 字符串' }
    }
    const safeContext = context && typeof context === 'object' && !Array.isArray(context) ? context : undefined
    return callTool(name, args, safeContext)
  })
  // shell_exec 快捷确认记忆管理（设置页「工具中心 → 终端命令快捷确认」）
  ipcMain.handle('shell-approve:list', async () => ({ items: await listShellApprovals() }))
  ipcMain.handle('shell-approve:remove', async (_event, command, cwd) => {
    if (typeof command !== 'string' || typeof cwd !== 'string') {
      return { ok: false, error: '参数必须是字符串' }
    }
    const deleted = await removeShellApproval(command, cwd)
    return { ok: true, deleted }
  })
  ipcMain.handle('shell-approve:clear', async () => {
    await clearShellApprovals()
    return { ok: true }
  })
}

module.exports = {
  TOOL_REGISTRY,
  callTool,
  registerToolIpc,
  registerDynamicTool,
  removeDynamicTool,
  truncateOutput,
  buildLineDiff,
  formatBytes,
  // shell 快捷确认记忆（测试钩子）
  isShellApproved,
  rememberShellApproval,
  listShellApprovals,
  removeShellApproval,
  clearShellApprovals,
}
