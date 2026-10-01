/**
 * Electron preload 脚本。
 * 通过 contextBridge 把目录选择、LLM 转发与工具调用能力暴露给渲染进程，
 * 契约与 src/lib/desktop-bridge.ts 保持一致：
 * - window.mrHuangDesktop.selectFolder()
 * - window.mrHuangDesktop.openHtmlPreview(fileName, content) -> { ok, error? }
 *   （HTML 网页预览：主进程写临时文件并 shell.openPath 用系统默认浏览器打开；
 *    渲染进程 window.open 在本应用 Electron 环境不可用，故走主进程）
 * - window.mrHuangDesktop.llmForward(payload, callbacks) -> requestId
 * - window.mrHuangDesktop.llmAbort(requestId)
 * - window.mrHuangDesktop.callTool(name, argsJson, context?)
 *   （context 为可选的透传对象，如当前模型配置 { apiKey, baseUrl }，供 web_search 等工具使用；
 *    契约与 src/lib/desktop-bridge.ts 保持一致）
 * - window.mrHuangDesktop.vaultReadTree / vaultReadFile / vaultWriteFile / vaultSearch
 *   （Obsidian vault 文件操作，rootPath 为 vault 根目录绝对路径）
 * - window.mrHuangDesktop.memoryRead / memoryWrite / memoryReadBulk
 *   （工作区记忆持久化，electron/memory-store.cjs，userData/memory/<workspaceId>.md）
 */
const { contextBridge, ipcRenderer } = require('electron')

/** 进行中的转发监听：requestId → 'llm:chunk' 监听器（abort 后仍保留等待 done 包） */
const chunkListeners = new Map()

/**
 * invoke 失败时 Electron 会把错误包装成
 * "Error invoking remote method 'xxx': Error: <原始信息>"，
 * 这里剥掉包装只保留主进程给出的原始中文信息，供渲染层直接展示。
 */
async function invokeWithCleanError(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const marker = 'Error: '
    const index = raw.lastIndexOf(marker)
    throw new Error(index >= 0 ? raw.slice(index + marker.length) : raw)
  }
}

contextBridge.exposeInMainWorld('mrHuangDesktop', {
  selectFolder: () => ipcRenderer.invoke('select-folder'),

  /** HTML 网页预览：主进程写临时文件 + 系统默认浏览器打开（始终 resolve { ok, error? }） */
  openHtmlPreview: (fileName, content) => invokeWithCleanError('preview:open-html', fileName, content),

  /**
   * LLM 转发：主进程 fetch 厂商 API，SSE 原始文本块经 onChunk 逐段回调，
   * 结束（成功/失败/中止）时 onDone 收到最终结果包。同步返回 requestId 供中止。
   */
  llmForward: (payload, callbacks = {}) => {
    const requestId = `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    const listener = (_event, chunk) => {
      if (!chunk || chunk.requestId !== requestId) return
      if (chunk.done) {
        ipcRenderer.removeListener('llm:chunk', listener)
        chunkListeners.delete(requestId)
        try {
          callbacks.onDone?.(chunk)
        } catch {
          // 回调异常不影响通道清理
        }
        return
      }
      try {
        callbacks.onChunk?.(chunk.text ?? '')
      } catch {
        // 忽略单次回调异常，保持流继续
      }
    }
    chunkListeners.set(requestId, listener)
    ipcRenderer.on('llm:chunk', listener)
    ipcRenderer.send('llm:forward', requestId, payload)
    return requestId
  },

  /** 中止进行中的转发请求（主进程 abort 上游连接，随后仍会推送 done 包） */
  llmAbort: (requestId) => {
    if (typeof requestId === 'string') ipcRenderer.send('llm:abort', requestId)
  },

  /** 工具调用统一入口：{ ok, result?, error?, canceled? }，永不 reject；
   * context（可选对象）透传给主进程工具 handler，非对象时忽略 */
  callTool: (name, argsJson, context) => {
    if (typeof name !== 'string') return Promise.resolve({ ok: false, error: '工具名必须是字符串' })
    const safeContext = context && typeof context === 'object' && !Array.isArray(context) ? context : undefined
    return ipcRenderer.invoke('tool:call', name, argsJson, safeContext)
  },

  /** vault：列出笔记目录下的全部 .md 文件（扁平清单，相对路径以 / 分隔） */
  vaultReadTree: (rootPath) => invokeWithCleanError('vault:list-tree', rootPath),

  /** vault：读取单个笔记内容（仅 .md，2MB 上限） */
  vaultReadFile: (rootPath, relPath) => invokeWithCleanError('vault:read-file', rootPath, relPath),

  /** vault：写入笔记（默认不覆盖已存在文件，overwrite=true 时覆盖） */
  vaultWriteFile: (rootPath, relPath, content, overwrite) =>
    invokeWithCleanError('vault:write-file', rootPath, relPath, content, overwrite === true),

  /** vault：全文检索（大小写不敏感按行匹配，最多 100 条命中） */
  vaultSearch: (rootPath, query) => invokeWithCleanError('vault:search', rootPath, query),

  /** MCP：读取服务器配置 + 连接状态（electron/mcp.cjs，userData/mcp-servers.json） */
  getMcpConfigs: () => invokeWithCleanError('mcp:list-configs'),

  /** MCP：保存服务器配置（主进程保存后自动重连，返回最新连接状态） */
  saveMcpConfigs: (configs) => invokeWithCleanError('mcp:save-configs', configs),

  /** MCP：按服务器分组的工具清单 + 连接状态（供渲染层动态 schema 与设置页展示） */
  listMcpTools: () => invokeWithCleanError('mcp:list-tools'),

  /** KV 文件持久化：读单个 key（userData/storage/<key>.json），不存在返回 null */
  kvGet: (key) => invokeWithCleanError('kv:get', key),

  /** KV 文件持久化：写单个 key（主进程临时文件 + rename 原子写） */
  kvSet: (key, value) => invokeWithCleanError('kv:set', key, value),

  /** KV 文件持久化：删除单个 key（不存在时静默成功） */
  kvDelete: (key) => invokeWithCleanError('kv:delete', key),

  /** KV 文件持久化：列出全部原始 key */
  kvKeys: () => invokeWithCleanError('kv:keys'),

  /** 工作区记忆：读取单个工作区记忆全文（userData/memory/<workspaceId>.md），不存在返回 '' */
  memoryRead: (workspaceId) => invokeWithCleanError('memory:read', workspaceId),

  /** 工作区记忆：整篇覆盖写（主进程临时文件 + rename 原子写，64KB 上限），返回 { size } */
  memoryWrite: (workspaceId, content) => invokeWithCleanError('memory:write', workspaceId, content),

  /** 工作区记忆：批量读取多个工作区记忆，返回 Record<workspaceId, 全文> */
  memoryReadBulk: (workspaceIds) => invokeWithCleanError('memory:read-bulk', workspaceIds),

  /** 检查点：列出某会话的全部检查点概要（userData/checkpoints/<conversationId>/） */
  checkpointList: (conversationId) => invokeWithCleanError('checkpoint:list', conversationId),

  /** 检查点：还原（还原前主进程自动二次快照），返回 { restored, deleted, preRestoreCheckpointId } */
  checkpointRestore: (conversationId, checkpointId) =>
    invokeWithCleanError('checkpoint:restore', conversationId, checkpointId),

  /** 检查点：删除单个检查点 */
  checkpointDelete: (conversationId, checkpointId) =>
    invokeWithCleanError('checkpoint:delete', conversationId, checkpointId),

  /** shell 快捷确认：列出已记忆的命令 + cwd（userData/shell-approved.json） */
  shellApproveList: () => invokeWithCleanError('shell-approve:list'),

  /** shell 快捷确认：删除单条记忆（命令 + cwd 精确匹配） */
  shellApproveRemove: (command, cwd) => invokeWithCleanError('shell-approve:remove', command, cwd),

  /** shell 快捷确认：清空全部记忆 */
  shellApproveClear: () => invokeWithCleanError('shell-approve:clear'),

  /** 窗口按钮配色：主题变化时同步原生 titleBarOverlay（'light' | 'dark'，仅 Windows 生效） */
  setWindowTitleBar: (theme) => {
    if (theme === 'light' || theme === 'dark') ipcRenderer.send('title-bar:overlay', theme)
  },
})
