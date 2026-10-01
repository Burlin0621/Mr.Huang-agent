/**
 * 桌面桥接契约（Electron preload 暴露到 window 的桥接对象）：
 * - selectFolder：系统目录选择；
 * - llmForward/llmAbort：LLM 请求经主进程转发（解决生产 CORS，SSE 流式回传）；
 * - callTool：主进程工具注册表统一调用入口（electron/tools.cjs）。
 *
 * 纯浏览器环境不存在这些能力（hasDesktopBridge()/hasLlmForward() 为 false），
 * LLM 请求回退为渲染进程直连（开发模式走 Vite 同源代理）。
 */

/** LLM 转发请求载荷：主进程按原样发起 fetch（SSE 响应逐块回传） */
export interface LlmForwardPayload {
  /** 厂商 API 完整地址（如 https://xxx/v1/chat/completions） */
  url: string
  method?: 'GET' | 'POST'
  headers: Record<string, string>
  /** 请求体字符串（GET 请求不携带请求体） */
  body?: string
  /** 超时秒数（主进程侧兜底，含连接与流式全程） */
  timeoutSeconds: number
}

/** 转发结束包：done 时回传；ok=false 时按 errorKind/status 分类 */
export interface LlmForwardDone {
  ok: boolean
  /** HTTP 状态码（拿到响应头时存在） */
  status?: number
  /** 非 2xx 时的响应体片段（供错误分类） */
  body?: string
  errorKind?: 'network' | 'timeout' | 'aborted' | 'parse' | 'invalid'
  message?: string
}

export interface LlmForwardCallbacks {
  /** SSE/响应体原始文本块（未解析，由渲染进程统一缓冲处理） */
  onChunk?(text: string): void
  /** 结束回调（成功、失败与用户中止都会触发恰好一次） */
  onDone?(result: LlmForwardDone): void
}

/** 工具调用结果（永不 reject；失败/拒绝通过 ok/error 表达） */
export interface ToolCallResult {
  ok: boolean
  /** ok=true 时的工具输出文本（已截断到约 20KB） */
  result?: string
  /** 失败原因 */
  error?: string
  /** requiresConfirm 工具被用户拒绝时为 true */
  canceled?: boolean
}

/** vault 笔记清单条目（path 为 vault 内相对路径，以 / 分隔） */
export interface VaultFileEntry {
  path: string
  name: string
  size: number
  mtime: number
}

/** vault 笔记清单结果（truncated 表示文件数超出上限被截断） */
export interface VaultTreeResult {
  files: VaultFileEntry[]
  truncated: boolean
}

/** vault 读取结果 */
export interface VaultReadResult {
  content: string
  size: number
  mtime: number
}

/** vault 写入结果 */
export interface VaultWriteResult {
  path: string
  size: number
  mtime: number
}

/** vault 全文检索命中 */
export interface VaultSearchHit {
  path: string
  line: number
  snippet: string
}

/** vault 全文检索结果 */
export interface VaultSearchResult {
  hits: VaultSearchHit[]
  truncated: boolean
}

/* —— MCP（Model Context Protocol）桥接契约 —— */

/** 单条 MCP 服务器配置（持久化在主进程 userData/mcp-servers.json） */
export interface McpServerConfig {
  name: string
  command: string
  args: string[]
  env: Record<string, string>
  enabled: boolean
  /** 工具级确认：该服务器内执行前需弹确认框的工具裸名列表（缺省 = 不确认，兼容旧配置） */
  confirmTools?: string[]
}

/** 单个 MCP 服务器的连接状态（设置页展示用） */
export interface McpServerStatus {
  status: 'connected' | 'failed' | 'disabled' | 'connecting' | 'reconnecting'
  error: string
  /** 失败原因分类：'bad-config'（坏配置，需人工修改）| 'runtime'（运行时故障，可重连恢复）；空串表示非失败态 */
  errorKind?: 'bad-config' | 'runtime' | ''
  toolCount: number
  /** 当前处于第几次重连（非重连状态为 0） */
  reconnectAttempt?: number
  /** 下一次重连的退避延迟（毫秒；非重连状态为 0） */
  reconnectDelayMs?: number
}

/** mcp:list-configs 返回：配置 + 各服务器连接状态 */
export interface McpConfigsResult {
  configs: McpServerConfig[]
  statuses: Record<string, McpServerStatus>
}

/** 按服务器分组的 MCP 工具条目（qualifiedName 已含 mcp__<server>__<tool> 命名空间） */
export interface McpServerTools {
  name: string
  status: McpServerStatus['status']
  error: string
  tools: Array<{ name: string; description: string; requiresConfirm?: boolean }>
}

/** mcp:list-tools 返回：分组视图 + 扁平工具清单（inputSchema 为服务器原始 schema，渲染层再简化） */
export interface McpToolsResult {
  servers: McpServerTools[]
  tools: Array<{
    name: string
    description: string
    server: string
    inputSchema?: unknown
    requiresConfirm?: boolean
  }>
}

/* —— 检查点与回滚（主进程 userData/checkpoints/<conversationId>/） —— */

/** 检查点概要（checkpoint:list 返回的单条记录，按创建时间倒序） */
export interface CheckpointSummary {
  id: string
  conversationId: string
  /** 创建时间（毫秒时间戳） */
  createdAt: number
  /** 产生快照的工具名（fs_write / fs_edit / checkpoint） */
  tool: string
  /** 操作类型（同工具名；'restore' 表示还原前的自动快照） */
  operation: string
  /** 描述（通常是涉及的文件相对路径） */
  description: string
  /** 涉及文件数 */
  fileCount: number
  /** 涉及文件相对路径列表 */
  files: string[]
}

/** checkpoint:restore 返回：还原/删除文件数 + 还原前自动二次快照的 id */
export interface CheckpointRestoreResult {
  restored: number
  deleted: number
  preRestoreCheckpointId: string | null
}

export interface DesktopBridge {
  /** 打开系统目录选择对话框，返回所选目录绝对路径；用户取消返回 null */
  selectFolder(): Promise<string | null>
  /** HTML 网页预览：主进程写临时文件并 shell.openPath 用系统默认浏览器打开（渲染进程 window.open 在 Electron 内不可用） */
  openHtmlPreview?(fileName: string, content: string): Promise<{ ok: boolean; error?: string }>
  /** KV 文件持久化：读单个 key（不存在返回 null） */
  kvGet?(key: string): Promise<string | null>
  /** KV 文件持久化：写单个 key（主进程临时文件 + rename 原子写） */
  kvSet?(key: string, value: string): Promise<boolean>
  /** KV 文件持久化：删除单个 key（不存在时静默成功） */
  kvDelete?(key: string): Promise<boolean>
  /** KV 文件持久化：列出全部原始 key */
  kvKeys?(): Promise<string[]>
  /** LLM 转发：同步返回 requestId（供 llmAbort 中止），结果经回调回传 */
  llmForward(payload: LlmForwardPayload, callbacks?: LlmForwardCallbacks): string
  /** 中止进行中的转发请求 */
  llmAbort(requestId: string): void
  /** 调用主进程工具注册表中的工具；context（可选）透传给工具 handler（如当前模型配置 { apiKey, baseUrl }） */
  callTool(name: string, argsJson: string, context?: Record<string, unknown>): Promise<ToolCallResult>
  /** vault：列出笔记目录下的全部 .md 文件（扁平清单） */
  vaultReadTree(rootPath: string): Promise<VaultTreeResult>
  /** vault：读取单个笔记内容（仅 .md，2MB 上限） */
  vaultReadFile(rootPath: string, relPath: string): Promise<VaultReadResult>
  /** vault：写入笔记（默认不覆盖已存在文件，overwrite=true 时覆盖） */
  vaultWriteFile(rootPath: string, relPath: string, content: string, overwrite?: boolean): Promise<VaultWriteResult>
  /** vault：全文检索（大小写不敏感按行匹配，最多 100 条命中） */
  vaultSearch(rootPath: string, query: string): Promise<VaultSearchResult>
  /** MCP：读取服务器配置 + 连接状态 */
  getMcpConfigs(): Promise<McpConfigsResult>
  /** MCP：保存服务器配置并触发重连，返回最新连接状态 */
  saveMcpConfigs(configs: McpServerConfig[]): Promise<McpConfigsResult>
  /** MCP：按服务器分组的工具清单 + 扁平工具列表 */
  listMcpTools(): Promise<McpToolsResult>
  /** 工作区记忆：读取单个工作区记忆全文（不存在返回 ''） */
  memoryRead?(workspaceId: string): Promise<string>
  /** 工作区记忆：整篇覆盖写（主进程原子写，64KB 上限），返回写入字节数 */
  memoryWrite?(workspaceId: string, content: string): Promise<{ size: number }>
  /** 工作区记忆：批量读取多个工作区记忆，返回 Record<workspaceId, 全文> */
  memoryReadBulk?(workspaceIds: string[]): Promise<Record<string, string>>
  /** 检查点：列出某会话的全部检查点概要（按创建时间倒序） */
  checkpointList?(conversationId: string): Promise<CheckpointSummary[]>
  /** 检查点：还原（主进程还原前自动二次快照） */
  checkpointRestore?(conversationId: string, checkpointId: string): Promise<CheckpointRestoreResult>
  /** 检查点：删除单个检查点 */
  checkpointDelete?(conversationId: string, checkpointId: string): Promise<boolean>
  /** shell 快捷确认：列出已记忆的命令 + cwd */
  shellApproveList?(): Promise<{ items: ShellApproval[] }>
  /** shell 快捷确认：删除单条记忆（命令 + cwd 精确匹配），返回是否删除 */
  shellApproveRemove?(command: string, cwd: string): Promise<{ ok: boolean; deleted: boolean }>
  /** shell 快捷确认：清空全部记忆 */
  shellApproveClear?(): Promise<{ ok: boolean }>
  /** 窗口按钮配色：主题变化时同步原生 titleBarOverlay（仅 Windows 生效，其他平台静默） */
  setWindowTitleBar?(theme: 'light' | 'dark'): void
}

/** shell_exec 快捷确认记忆条目（同一命令 + 同一 cwd 第二次起免确认） */
export interface ShellApproval {
  command: string
  /** 执行时的解析绝对路径（工作区根 + 相对 cwd；解析失败时为原始 cwd 参数） */
  cwd: string
  /** 首次允许执行的时间戳（毫秒） */
  addedAt: number
}

declare global {
  interface Window {
    mrHuangDesktop?: Partial<DesktopBridge>
  }
}

/** 是否存在桌面桥接（纯浏览器环境为 false） */
export function hasDesktopBridge(): boolean {
  return typeof window.mrHuangDesktop?.selectFolder === 'function'
}

/** 是否具备 LLM 转发通道（桌面端且 preload 已暴露 llmForward） */
export function hasLlmForward(): boolean {
  return typeof window.mrHuangDesktop?.llmForward === 'function'
}

/** 是否具备 HTML 预览桥接（桌面端且 preload 已暴露 openHtmlPreview；纯浏览器为 false 走 window.open 回退） */
export function hasHtmlPreviewBridge(): boolean {
  return typeof window.mrHuangDesktop?.openHtmlPreview === 'function'
}

/** 通过桥接选择文件夹；无桥接、用户取消或桥接异常时返回 null */
export async function pickFolderViaBridge(): Promise<string | null> {
  if (!hasDesktopBridge()) return null
  try {
    const path = await window.mrHuangDesktop?.selectFolder?.()
    return typeof path === 'string' && path ? path : null
  } catch {
    // 桥接异常时按取消处理，调用方保持表单原状
    return null
  }
}

/** 桥接的 vault 方法是否可用（桌面端且 preload 已暴露） */
export function hasVaultBridge(): boolean {
  return typeof window.mrHuangDesktop?.vaultReadTree === 'function'
}

/** 桥接的 MCP 方法是否可用（桌面端且 preload 已暴露；纯浏览器模式下 MCP 功能不可用） */
export function hasMcpBridge(): boolean {
  return typeof window.mrHuangDesktop?.listMcpTools === 'function'
}

/** 桥接的 KV 文件持久化方法是否可用（桌面端且 preload 已暴露） */
export function hasKvBridge(): boolean {
  return typeof window.mrHuangDesktop?.kvGet === 'function'
}

/** 桥接的工作区记忆方法是否可用（桌面端且 preload 已暴露；纯浏览器模式下记忆功能不可用） */
export function hasMemoryBridge(): boolean {
  return typeof window.mrHuangDesktop?.memoryRead === 'function'
}

/** 桥接的 shell 快捷确认记忆方法是否可用（桌面端且 preload 已暴露） */
export function hasShellApproveBridge(): boolean {
  return typeof window.mrHuangDesktop?.shellApproveList === 'function'
}

/** 列出 shell 快捷确认记忆；非桌面环境/失败时返回 [] */
export async function listShellApprovals(): Promise<ShellApproval[]> {
  if (!hasShellApproveBridge()) return []
  try {
    const result = await window.mrHuangDesktop?.shellApproveList?.()
    return Array.isArray(result?.items) ? result.items : []
  } catch {
    return []
  }
}

/** 删除单条 shell 快捷确认记忆；非桌面环境返回 false */
export async function removeShellApproval(command: string, cwd: string): Promise<boolean> {
  if (!hasShellApproveBridge()) return false
  try {
    const result = await window.mrHuangDesktop?.shellApproveRemove?.(command, cwd)
    return result?.deleted === true
  } catch {
    return false
  }
}

/** 清空全部 shell 快捷确认记忆；非桌面环境返回 false */
export async function clearShellApprovals(): Promise<boolean> {
  if (!hasShellApproveBridge()) return false
  try {
    const result = await window.mrHuangDesktop?.shellApproveClear?.()
    return result?.ok === true
  } catch {
    return false
  }
}

/** 读取工作区记忆全文；非桌面环境/失败时返回 ''（不抛错，调用方按空记忆降级） */
export async function readWorkspaceMemory(workspaceId: string): Promise<string> {
  if (!hasMemoryBridge()) return ''
  try {
    const content = await window.mrHuangDesktop?.memoryRead?.(workspaceId)
    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

/** 覆盖写工作区记忆；非桌面环境返回 null，主进程错误以可读 Error 抛出（供设置页提示） */
export async function writeWorkspaceMemory(
  workspaceId: string,
  content: string,
): Promise<{ size: number } | null> {
  if (!hasMemoryBridge()) return null
  try {
    return await window.mrHuangDesktop!.memoryWrite!(workspaceId, content)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/** 抛出统一格式的 vault 调用错误（保留主进程的中文信息） */
function rejectVault(message: string): never {
  throw new Error(message)
}

/* —— 检查点与回滚的渲染层封装（非桌面环境返回降级值，不抛错） —— */

/** 桥接的检查点方法是否可用（桌面端且 preload 已暴露） */
export function hasCheckpointBridge(): boolean {
  return typeof window.mrHuangDesktop?.checkpointList === 'function'
}

/** 列出某会话的全部检查点概要；非桌面环境/失败时返回 [] */
export async function listCheckpoints(conversationId: string): Promise<CheckpointSummary[]> {
  if (!hasCheckpointBridge() || !conversationId) return []
  try {
    const items = await window.mrHuangDesktop?.checkpointList?.(conversationId)
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

/** 还原检查点；非桌面环境返回 null，主进程错误以可读 Error 抛出（供 UI 提示） */
export async function restoreCheckpoint(
  conversationId: string,
  checkpointId: string,
): Promise<CheckpointRestoreResult | null> {
  if (!hasCheckpointBridge()) return null
  try {
    return await window.mrHuangDesktop!.checkpointRestore!(conversationId, checkpointId)
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : String(err))
  }
}

/** 删除单个检查点；非桌面环境返回 false */
export async function deleteCheckpoint(conversationId: string, checkpointId: string): Promise<boolean> {
  if (!hasCheckpointBridge()) return false
  try {
    return (await window.mrHuangDesktop?.checkpointDelete?.(conversationId, checkpointId)) === true
  } catch {
    return false
  }
}

/** 列出 vault 笔记清单；非桌面环境返回 null，主进程错误以可读 Error 抛出 */
export async function readVaultTree(rootPath: string): Promise<VaultTreeResult | null> {
  if (!hasVaultBridge()) return null
  try {
    return await window.mrHuangDesktop!.vaultReadTree!(rootPath)
  } catch (err) {
    rejectVault(err instanceof Error ? err.message : String(err))
  }
}

/** 读取 vault 笔记；非桌面环境返回 null，主进程错误以可读 Error 抛出 */
export async function readVaultFile(rootPath: string, relPath: string): Promise<VaultReadResult | null> {
  if (!hasVaultBridge()) return null
  try {
    return await window.mrHuangDesktop!.vaultReadFile!(rootPath, relPath)
  } catch (err) {
    rejectVault(err instanceof Error ? err.message : String(err))
  }
}

/** 写入 vault 笔记；非桌面环境返回 null，主进程错误以可读 Error 抛出 */
export async function writeVaultFile(
  rootPath: string,
  relPath: string,
  content: string,
  overwrite = false,
): Promise<VaultWriteResult | null> {
  if (!hasVaultBridge()) return null
  try {
    return await window.mrHuangDesktop!.vaultWriteFile!(rootPath, relPath, content, overwrite)
  } catch (err) {
    rejectVault(err instanceof Error ? err.message : String(err))
  }
}

/** vault 全文检索；非桌面环境返回 null，主进程错误以可读 Error 抛出 */
export async function searchVault(rootPath: string, query: string): Promise<VaultSearchResult | null> {
  if (!hasVaultBridge()) return null
  try {
    return await window.mrHuangDesktop!.vaultSearch!(rootPath, query)
  } catch (err) {
    rejectVault(err instanceof Error ? err.message : String(err))
  }
}

