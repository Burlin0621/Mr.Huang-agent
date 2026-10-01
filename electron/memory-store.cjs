/**
 * 工作区记忆持久化（跨会话记忆，独立 IPC 通道）：
 * - 存储位置：app.getPath('userData')/memory/<workspaceId>.md（UTF-8 Markdown）；
 *   与 conversations/workspaces 等现有 localStorage 存储完全隔离；
 * - IPC 通道（由 main.cjs 调用 registerMemoryIpc 注册）：
 *   · memory:read       读取单个工作区记忆（不存在返回 ''）；
 *   · memory:write      整篇覆盖写（临时文件 + rename 原子写，单文件上限 64KB）；
 *   · memory:read-bulk  一次读取多个工作区记忆（供 system 注入用）。
 * - workspaceId 仅允许字母数字、下划线与短横线（防路径逃逸），不合法抛中文错误；
 * - 主进程抛出的中文错误经 preload 的 invokeWithCleanError 剥壳后可直接展示。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 单个记忆文件上限（UTF-8 字节数）：64KB */
const MEMORY_MAX_BYTES = 64 * 1024

/** workspaceId 合法性校验（纯函数）：仅允许字母、数字、下划线与短横线 */
function isValidWorkspaceId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id)
}

/** 校验 workspaceId，不合法抛中文错误 */
function assertWorkspaceId(id) {
  if (!isValidWorkspaceId(id)) {
    throw new Error(`无效的工作区标识：${String(id).slice(0, 50)}（仅允许字母、数字、下划线与短横线）`)
  }
}

/** 记忆目录（惰性初始化，避免模块加载期依赖 app 就绪状态） */
let memoryDir = null
function getMemoryDir() {
  if (!memoryDir) {
    const { app } = require('electron')
    memoryDir = path.join(app.getPath('userData'), 'memory')
  }
  return memoryDir
}

/** workspaceId → 记忆文件绝对路径（内含合法性校验） */
function memoryFilePath(workspaceId) {
  assertWorkspaceId(workspaceId)
  return path.join(getMemoryDir(), `${workspaceId}.md`)
}

/** 读取单个工作区记忆全文；文件不存在或读取失败返回 '' */
function readMemory(workspaceId) {
  try {
    return fs.readFileSync(memoryFilePath(workspaceId), 'utf-8')
  } catch {
    return ''
  }
}

/**
 * 整篇覆盖写单个工作区记忆（临时文件 + rename 原子写）。
 * 返回写入字节数；内容非字符串或超 64KB 抛中文错误。
 */
function writeMemory(workspaceId, content) {
  if (typeof content !== 'string') {
    throw new Error('记忆内容必须是字符串')
  }
  const bytes = Buffer.byteLength(content, 'utf-8')
  if (bytes > MEMORY_MAX_BYTES) {
    throw new Error(
      `记忆内容超过 64KB 上限（当前 ${(bytes / 1024).toFixed(1)} KB），请精简记忆后再保存`,
    )
  }
  const target = memoryFilePath(workspaceId)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, target)
  return bytes
}

/** 本地日期文本「YYYY-MM-DD」（追加节的标题用） */
function localDateText(now = new Date()) {
  const pad = (v) => String(v).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 纯函数：构造追加后的记忆全文。
 * - 追加节格式：`## YYYY-MM-DD` 标题 + 正文；
 * - 已有内容末尾空白归一为一个空行分隔；
 * - 追加正文为空白时原样返回现有内容。
 */
function buildMemoryAppendContent(existing, content, dateText) {
  const body = String(content ?? '').trim()
  if (!body) return String(existing ?? '')
  const base = String(existing ?? '').replace(/\s+$/, '')
  const prefix = base ? `${base}\n\n` : ''
  return `${prefix}## ${dateText}\n${body}\n`
}

/** 读取现有记忆 → 拼接当天日期的追加节 → 原子写回（同样受 64KB 上限约束）。返回写入字节数。 */
function appendMemory(workspaceId, content) {
  const existing = readMemory(workspaceId)
  const next = buildMemoryAppendContent(existing, content, localDateText())
  return writeMemory(workspaceId, next)
}

/** 批量读取多个工作区记忆：workspaceId 数组 → Record<id, 全文>（非法 id 跳过） */
function readMemoryBulk(workspaceIds) {
  const result = {}
  for (const id of Array.isArray(workspaceIds) ? workspaceIds : []) {
    if (isValidWorkspaceId(id)) {
      result[id] = readMemory(id)
    }
  }
  return result
}

/** 注册 memory:* IPC 通道（由 main.cjs 在启动时调用一次） */
function registerMemoryIpc(ipcMain) {
  ipcMain.handle('memory:read', (_event, workspaceId) => readMemory(workspaceId))

  ipcMain.handle('memory:write', (_event, workspaceId, content) => {
    const bytes = writeMemory(workspaceId, content)
    return { size: bytes }
  })

  ipcMain.handle('memory:read-bulk', (_event, workspaceIds) => readMemoryBulk(workspaceIds))
}

module.exports = {
  MEMORY_MAX_BYTES,
  isValidWorkspaceId,
  buildMemoryAppendContent,
  readMemory,
  writeMemory,
  appendMemory,
  readMemoryBulk,
  registerMemoryIpc,
}
