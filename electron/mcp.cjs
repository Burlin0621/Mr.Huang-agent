/**
 * 主进程 MCP（Model Context Protocol）客户端接入：
 * - 用官方 @modelcontextprotocol/sdk 的 Client + StdioClientTransport 连接 stdio 类型
 *   MCP 服务器（command + args + env）；
 * - 服务器配置持久化在 userData/mcp-servers.json（name/command/args/env/enabled）；
 * - 连接成功后把每个 MCP 工具以 `mcp__<server>__<tool>` 名字动态注册进 tools.cjs 的
 *   TOOL_REGISTRY（requiresConfirm 一律 false，工具级确认后续再做）；
 *   与内置工具名冲突时 MCP 工具让位（跳过注册并记录警告）；断开时从注册表移除；
 * - IPC：mcp:list-configs / mcp:save-configs（保存后自动重连）/ mcp:list-tools /
 *   mcp:call-tool；callMcpTool 超时 60 秒，输出截断 20KB；
 * - 连接失败不崩溃：状态记为 failed 并保留错误信息，供设置页展示。
 */
const path = require('node:path')
const fs = require('node:fs/promises')

// electron 仅在主进程可用；纯 Node 冒烟测试环境下静默降级（配置路径改由环境变量指定）
let electron = null
try {
  electron = require('electron')
} catch {
  electron = null
}

const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

const { registerDynamicTool, removeDynamicTool } = require('./tools.cjs')

/** MCP 工具调用超时（毫秒） */
const MCP_CALL_TIMEOUT_MS = 60_000
/** MCP 连接超时（毫秒）：listTools 未在时限内返回视为连接失败 */
const MCP_CONNECT_TIMEOUT_MS = 15_000
/** MCP 工具输出文本上限（约 20KB，与 tools.cjs 的 OUTPUT_MAX_CHARS 对齐） */
const MCP_OUTPUT_MAX_CHARS = 20_000
/** 配置文件名（位于 Electron userData 目录） */
const CONFIG_FILE_NAME = 'mcp-servers.json'

/** 合法服务器名片段：不满足的字符替换为 _，避免破坏 mcp__<server>__<tool> 命名空间 */
function sanitizeNamespace(name) {
  return String(name ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
}

/** 生成合格工具名：mcp__<server>__<tool> */
function qualifiedToolName(serverName, toolName) {
  return `mcp__${sanitizeNamespace(serverName)}__${sanitizeNamespace(toolName)}`
}

/** 配置文件路径：桌面端用 userData，纯 Node 环境回退环境变量目录 */
function configFilePath() {
  const dir =
    (electron && electron.app && typeof electron.app.getPath === 'function'
      ? electron.app.getPath('userData')
      : process.env.MRHUANG_MCP_CONFIG_DIR) || process.cwd()
  return path.join(dir, CONFIG_FILE_NAME)
}

/** 规范化单条服务器配置：缺失字段补默认值（防御外部手改配置文件） */
function normalizeConfig(raw) {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    name: typeof record.name === 'string' ? record.name.trim() : '',
    command: typeof record.command === 'string' ? record.command.trim() : '',
    args: Array.isArray(record.args) ? record.args.filter((item) => typeof item === 'string') : [],
    env:
      record.env && typeof record.env === 'object' && !Array.isArray(record.env)
        ? Object.fromEntries(
            Object.entries(record.env).filter(([, v]) => typeof v === 'string'),
          )
        : {},
    enabled: record.enabled !== false,
    // 工具级确认：该服务器内执行前需弹确认框的工具裸名列表；缺失 = 不确认（兼容旧配置）
    confirmTools: Array.isArray(record.confirmTools)
      ? record.confirmTools
          .filter((item) => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  }
}

/** 读取服务器配置（文件缺失/损坏时返回空数组并按需重建） */
async function loadConfigs() {
  try {
    const raw = await fs.readFile(configFilePath(), 'utf-8')
    const data = JSON.parse(raw)
    if (!Array.isArray(data)) return []
    return data.map(normalizeConfig).filter((item) => item.name && item.command)
  } catch {
    return []
  }
}

/** 原子写入服务器配置（先写临时文件再 rename，避免写一半损坏） */
async function persistConfigs(configs) {
  const file = configFilePath()
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(configs, null, 2), 'utf-8')
  await fs.rename(tmp, file)
}

/* —— 连接状态 —— */

/** 连接表：serverName → { client, transport, tools, status, error, errorKind, reconnect, config } */
const connections = new Map()

/**
 * 失败原因分类：
 * - 'bad-config'：坏配置（命令不存在 / 配置非法），重试也不会成功，需用户改配置；
 * - 'runtime'：运行时故障（超时 / 网络等），可等待退避重连恢复。
 */
function classifyFailure(err) {
  const text = err instanceof Error ? err.message : String(err ?? '')
  if (/ENOENT|EACCES|不是内部或外部命令|无法将.*识别|no such file|command not found/i.test(text)) {
    return 'bad-config'
  }
  return 'runtime'
}

/* —— 断线自动重连 —— */

/** 重连退避参数（可通过 setReconnectBackoff 注入，便于测试） */
let reconnectBackoff = { initialMs: 5_000, maxMs: 60_000 }

/** 待执行的重连定时器：serverName → timeout 句柄 */
const reconnectTimers = new Map()
/** 连续重连失败次数：serverName → 次数（指数退避基数，成功后清零） */
const reconnectAttempts = new Map()
/** 应用退出中：置位后不再安排新的重连 */
let shuttingDown = false

/** 注入重连退避参数（冒烟测试用；不传字段则保留原值） */
function setReconnectBackoff(options) {
  if (!options || typeof options !== 'object') return
  if (Number.isFinite(options.initialMs) && options.initialMs >= 0) {
    reconnectBackoff.initialMs = options.initialMs
  }
  if (Number.isFinite(options.maxMs) && options.maxMs >= reconnectBackoff.initialMs) {
    reconnectBackoff.maxMs = options.maxMs
  }
}

/** 清掉某服务器待执行的重连定时器（手动重连/停用/退出前调用，避免双连接） */
function clearReconnectTimer(serverName) {
  const timer = reconnectTimers.get(serverName)
  if (timer !== undefined) {
    clearTimeout(timer)
    reconnectTimers.delete(serverName)
  }
}

/**
 * 安排一次指数退避重连：延迟 = initialMs × 2^attempt，封顶 maxMs；
 * 重连成功（connectServer 后状态 connected）清零计数，失败继续翻倍。
 * 定时器 unref：纯 Node 测试环境下不阻止进程退出。
 */
function scheduleReconnect(serverName, attempt) {
  if (shuttingDown) return
  const conn = connections.get(serverName)
  if (!conn || conn.config && conn.config.enabled === false) return
  clearReconnectTimer(serverName)
  conn.status = 'reconnecting'
  conn.error = ''
  conn.errorKind = ''
  const delay = Math.min(reconnectBackoff.initialMs * 2 ** Math.max(0, attempt), reconnectBackoff.maxMs)
  // 重连计划快照：供设置页展示「第 N 次重连 · 约 X 秒后重试」
  conn.reconnect = { attempt: Math.max(0, attempt) + 1, delayMs: delay }
  const timer = setTimeout(() => {
    reconnectTimers.delete(serverName)
    void (async () => {
      const config = connections.get(serverName)?.config
      if (!config || !config.enabled || shuttingDown) return
      await connectServer(config)
      if (connections.get(serverName)?.status === 'connected') {
        reconnectAttempts.delete(serverName)
      } else {
        const next = (reconnectAttempts.get(serverName) ?? attempt) + 1
        reconnectAttempts.set(serverName, next)
        scheduleReconnect(serverName, next)
      }
    })()
  }, delay)
  timer.unref?.()
  reconnectTimers.set(serverName, timer)
}

/**
 * transport onclose 处理：已连接的连接意外断开时撤下其动态工具、
 * 标记 reconnecting 并安排首次退避重连（手动断开/disconnectServer 已先删连接表，不会进入此分支）。
 */
function handleTransportClose(serverName) {
  const conn = connections.get(serverName)
  if (!conn || conn.status !== 'connected') return
  for (const tool of conn.tools) {
    removeDynamicTool(qualifiedToolName(serverName, tool.name))
  }
  conn.tools = []
  conn.client = null
  conn.transport = null
  conn.error = ''
  conn.errorKind = ''
  conn.reconnect = null
  console.warn(`[mcp] MCP 服务器「${serverName}」连接断开，将自动重连`)
  const attempt = reconnectAttempts.get(serverName) ?? 0
  scheduleReconnect(serverName, attempt)
}

/** 服务器状态快照（供设置页展示；不含 client 等运行时对象） */
function statusSnapshot() {
  const snapshot = {}
  for (const [name, conn] of connections) {
    snapshot[name] = {
      status: conn.status,
      error: conn.error ?? '',
      errorKind: conn.errorKind ?? '',
      toolCount: conn.tools.length,
      reconnectAttempt: conn.reconnect?.attempt ?? 0,
      reconnectDelayMs: conn.reconnect?.delayMs ?? 0,
    }
  }
  return snapshot
}

/** 摘取 MCP 工具结果文本：content 块中的 text 依次拼接（其余类型以占位说明） */
function extractResultText(result) {
  if (!result || !Array.isArray(result.content)) return ''
  const parts = []
  for (const block of result.content) {
    if (block && typeof block === 'object') {
      if (typeof block.text === 'string') parts.push(block.text)
      else if (block.type) parts.push(`[不支持的内容类型：${block.type}]`)
    }
  }
  let text = parts.join('\n')
  if (result.isError === true) {
    text = `MCP 工具返回错误：${text || '未知错误'}`
  }
  if (text.length > MCP_OUTPUT_MAX_CHARS) {
    text = `${text.slice(0, MCP_OUTPUT_MAX_CHARS)}\n\n[输出超过上限，已截断：原始长度 ${text.length} 字符]`
  }
  return text
}

/** 断开单个服务器：从注册表移除其全部动态工具并关闭子进程 */
async function disconnectServer(serverName) {
  const conn = connections.get(serverName)
  if (!conn) return
  connections.delete(serverName)
  for (const tool of conn.tools) {
    removeDynamicTool(qualifiedToolName(serverName, tool.name))
  }
  try {
    await conn.client.close()
  } catch {
    // 关闭失败不阻断流程（子进程可能已退出）
  }
}

/**
 * 连接单个 stdio MCP 服务器并注册其工具：
 * - 任意一步失败都把状态记为 failed（不抛出、不崩溃），并清理半成品连接；
 * - 工具注册时与内置工具冲突则让位（registerDynamicTool 返回 false，记警告）。
 */
async function connectServer(config) {
  const name = config.name
  clearReconnectTimer(name)
  await disconnectServer(name)
  const conn = { client: null, transport: null, tools: [], status: 'connecting', error: '', errorKind: '', reconnect: null, config }
  connections.set(name, conn)
  try {
    const client = new Client({ name: 'mr-huang-agent', version: '0.1.0' })
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...process.env, ...config.env },
    })
    conn.client = client
    conn.transport = transport
    // 服务器进程退出/传输错误：撤下工具并安排退避重连（手动断开时连接已被删，不会触发）
    transport.onclose = () => handleTransportClose(name)
    transport.onerror = (err) => {
      console.warn(`[mcp] MCP 服务器「${name}」传输错误:`, err instanceof Error ? err.message : err)
    }
    await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS })
    const listed = await client.listTools({ timeout: MCP_CONNECT_TIMEOUT_MS })
    const tools = Array.isArray(listed?.tools) ? listed.tools : []
    const confirmTools = Array.isArray(config.confirmTools) ? config.confirmTools : []
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) continue
      const qualified = qualifiedToolName(name, tool.name)
      const registered = registerDynamicTool(qualified, {
        description:
          typeof tool.description === 'string' && tool.description.trim()
            ? `[MCP:${name}] ${tool.description}`
            : `[MCP:${name}] ${tool.name}`,
        inputSchema: normalizeMcpInputSchema(tool.inputSchema),
        requiresConfirm: confirmTools.includes(tool.name),
        timeoutMs: MCP_CALL_TIMEOUT_MS,
        async handler(args) {
          return callMcpTool(qualified, args)
        },
      })
      if (!registered) {
        console.warn(`[mcp] MCP 工具 ${qualified} 与内置工具重名，已跳过注册`)
        continue
      }
      const normalizedSchema = normalizeMcpInputSchema(tool.inputSchema)
      conn.tools.push({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: normalizedSchema,
        requiresConfirm: confirmTools.includes(tool.name),
      })
    }
    conn.status = 'connected'
    conn.error = ''
    conn.errorKind = ''
    conn.reconnect = null
    reconnectAttempts.delete(name)
    console.log(`[mcp] 已连接 MCP 服务器「${name}」，注册 ${conn.tools.length} 个工具`)
  } catch (err) {
    conn.status = 'failed'
    conn.error = err instanceof Error ? err.message : String(err)
    conn.errorKind = classifyFailure(err)
    conn.reconnect = null
    // 注册了一半的工具全部撤下，保持注册表与连接状态一致
    for (const tool of conn.tools) {
      removeDynamicTool(qualifiedToolName(name, tool.name))
    }
    conn.tools = []
    console.error(`[mcp] 连接 MCP 服务器「${name}」失败（${conn.errorKind}）:`, conn.error)
    // 运行时故障（超时/网络等）进入退避重连；坏配置（命令不存在等）重试也不会成功，
    // 保持 failed 状态等用户修改配置（设置页红色徽标展示原因）
    if (config.enabled && !shuttingDown && conn.errorKind === 'runtime') {
      const next = (reconnectAttempts.get(name) ?? 0) + 1
      reconnectAttempts.set(name, next)
      scheduleReconnect(name, next - 1)
    }
  }
}

/** 把 MCP 的 inputSchema 规整为简化 JSON Schema（保留 type/properties/required 与描述） */
function normalizeMcpInputSchema(schema) {
  const record = schema && typeof schema === 'object' && !Array.isArray(schema) ? schema : {}
  const rawProperties = record.properties && typeof record.properties === 'object' ? record.properties : {}
  const properties = {}
  for (const [key, spec] of Object.entries(rawProperties)) {
    const item = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {}
    const type = typeof item.type === 'string' ? item.type : 'string'
    properties[key] = {
      type: ['string', 'number', 'boolean'].includes(type) ? type : 'string',
      description: typeof item.description === 'string' ? item.description : '',
    }
  }
  return {
    type: 'object',
    properties,
    required: Array.isArray(record.required) ? record.required.filter((item) => typeof item === 'string') : [],
  }
}

/** 应用启动时对 enabled 的服务器逐个连接（串行，失败不崩溃） */
async function initMcp() {
  const configs = await loadConfigs()
  for (const config of configs) {
    if (!config.enabled) {
      connections.set(config.name, { client: null, transport: null, tools: [], status: 'disabled', error: '' })
      continue
    }
    await connectServer(config)
  }
}

/** 保存配置并重连：移除消失/禁用的连接，重建其余连接（串行） */
async function saveConfigs(nextConfigs) {
  const configs = (Array.isArray(nextConfigs) ? nextConfigs : []).map(normalizeConfig).filter(
    (item) => item.name && item.command,
  )
  await persistConfigs(configs)
  const nextNames = new Set(configs.map((item) => item.name))
  // 断开已删除或被禁用的服务器（同时清掉其待执行的重连定时器与退避计数）
  for (const [name] of connections) {
    const config = configs.find((item) => item.name === name)
    if (!config || !config.enabled) {
      clearReconnectTimer(name)
      reconnectAttempts.delete(name)
      await disconnectServer(name)
      if (!nextNames.has(name)) connections.delete(name)
      else connections.set(name, { client: null, transport: null, tools: [], status: 'disabled', error: '', config: undefined })
    }
  }
  for (const config of configs) {
    if (!config.enabled) continue
    // 手动重连前清掉该服务器待执行的重连定时器，避免与新连接并行出现双连接
    clearReconnectTimer(config.name)
    reconnectAttempts.delete(config.name)
    await connectServer(config)
  }
  return { configs, statuses: statusSnapshot() }
}

/** 全部已连接服务器的工具清单（合并 namespace，供渲染层动态 schema 兜底） */
function getMcpTools() {
  const tools = []
  for (const [serverName, conn] of connections) {
    if (conn.status !== 'connected') continue
    for (const tool of conn.tools) {
      tools.push({
        name: qualifiedToolName(serverName, tool.name),
        description: tool.description,
        server: serverName,
        inputSchema: tool.inputSchema,
        requiresConfirm: tool.requiresConfirm === true,
      })
    }
  }
  return tools
}

/** 按服务器分组的工具清单 + 连接状态（供设置页只读展示） */
function listToolsByServer() {
  const servers = []
  for (const [serverName, conn] of connections) {
    servers.push({
      name: serverName,
      status: conn.status,
      error: conn.error ?? '',
      errorKind: conn.errorKind ?? '',
      reconnectAttempt: conn.reconnect?.attempt ?? 0,
      reconnectDelayMs: conn.reconnect?.delayMs ?? 0,
      tools: conn.tools.map((tool) => ({
        name: qualifiedToolName(serverName, tool.name),
        description: tool.description,
        requiresConfirm: tool.requiresConfirm === true,
      })),
    })
  }
  return { servers, tools: getMcpTools() }
}

/** 路由调用：mcp__<server>__<tool> → 对应服务器的 MCP callTool；60 秒超时 */
async function callMcpTool(qualifiedName, args) {
  if (!qualifiedName.startsWith('mcp__')) {
    throw new Error(`非法的 MCP 工具名：${qualifiedName}`)
  }
  // 服务器名可含下划线（如 my_server），故按最后一个 __ 分隔：toolName 不含 __（已 sanitize）
  const rest = qualifiedName.slice('mcp__'.length)
  const separatorIndex = rest.lastIndexOf('__')
  if (separatorIndex <= 0) {
    throw new Error(`非法的 MCP 工具名：${qualifiedName}`)
  }
  const serverName = rest.slice(0, separatorIndex)
  const toolName = rest.slice(separatorIndex + 2)
  const conn = connections.get(serverName)
  if (!conn || conn.status !== 'connected' || !conn.client) {
    throw new Error(`MCP 服务器「${serverName}」未连接，请到「设置 → MCP 服务器」检查状态`)
  }
  const result = await conn.client.callTool({ name: toolName, arguments: args ?? {} }, undefined, {
    timeout: MCP_CALL_TIMEOUT_MS,
  })
  return extractResultText(result)
}

/** 注册 MCP 相关 IPC（由 main.cjs 在启动时调用一次） */
function registerMcpIpc(ipcMain) {
  ipcMain.handle('mcp:list-configs', async () => {
    return { configs: await loadConfigs(), statuses: statusSnapshot() }
  })
  ipcMain.handle('mcp:save-configs', async (_event, configs) => saveConfigs(configs))
  ipcMain.handle('mcp:list-tools', async () => listToolsByServer())
  ipcMain.handle('mcp:call-tool', async (_event, qualifiedName, argsJson) => {
    try {
      const args = typeof argsJson === 'string' ? JSON.parse(argsJson || '{}') : argsJson ?? {}
      const result = await callMcpTool(qualifiedName, args)
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** 退出前停止所有重连定时器并关闭全部 MCP 连接（由 main.cjs 在 will-quit 调用） */
async function shutdownMcp() {
  shuttingDown = true
  for (const [name] of connections) {
    clearReconnectTimer(name)
  }
  for (const [, timer] of reconnectTimers) {
    clearTimeout(timer)
  }
  reconnectTimers.clear()
  for (const [name] of connections) {
    await disconnectServer(name)
  }
}

module.exports = {
  initMcp,
  registerMcpIpc,
  saveConfigs,
  getMcpTools,
  callMcpTool,
  shutdownMcp,
  qualifiedToolName,
  normalizeMcpInputSchema,
  // 重连与测试钩子
  setReconnectBackoff,
  handleTransportClose,
}
