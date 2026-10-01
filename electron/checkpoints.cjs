/**
 * 检查点与回滚（主进程）。
 *
 * 存储布局：userData/checkpoints/<conversationId>/<checkpointId>/
 * - files/<原始相对路径>  ：快照时已存在文件的内容（保留相对路径结构）；
 * - manifest.json         ：元数据（id、时间、工具名、操作类型、工作区根目录、文件清单及 existed 标记）。
 *
 * 快照时机：fs_write / fs_edit 执行前（由 tools.cjs 调用 createCheckpoint），
 * 失败或中断也能回滚到写入前状态；shell_exec 无法预知涉及文件、git_commit
 * 影响的是提交历史而非工作区文件内容，均不纳入文件快照。
 *
 * 还原语义：
 * - 快照时存在、现已不存在 → 还原内容；
 * - 快照时不存在（fs_write 新建）、现已存在 → 还原时删除该文件；
 * - 还原前对涉及的文件当前状态再做一次快照（防误恢复，可二次回滚）。
 *
 * 安全：所有还原目标路径必须经 resolveWithin 限制在 manifest 记录的工作区根目录内，防路径穿越。
 */
const { app } = require('electron')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { resolveWithin } = require('./vault.cjs')

/** 检查点根目录：userData/checkpoints */
function checkpointsRoot() {
  return path.join(app.getPath('userData'), 'checkpoints')
}

/**
 * 会话/检查点 id 清洗：仅保留安全字符（阻断路径穿越）；空 id 抛错。
 * 注意：快照目录名是清洗后的形式，原 id 记录在 manifest 里往返一致。
 */
function safeIdSegment(value, label) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) throw new Error(`缺少${label}`)
  const safe = raw.replace(/[^a-zA-Z0-9._-]/g, '-')
  return safe
}

/** 会话检查点目录 */
function conversationDir(conversationId) {
  return path.join(checkpointsRoot(), safeIdSegment(conversationId, '会话 id'))
}

/** 单个检查点目录 */
function checkpointDir(conversationId, checkpointId) {
  return path.join(conversationDir(conversationId), safeIdSegment(checkpointId, '检查点 id'))
}

/**
 * 创建检查点：把 files 中各文件当前内容快照到检查点目录。
 * 入参 payload: { conversationId, rootPath, files: [{ relPath }], meta?: { tool, operation, description } }
 * 返回 { id, createdAt, fileCount }；全部文件无效时抛错（调用方应尽力而为不阻塞）。
 */
async function createCheckpoint(payload) {
  const { conversationId, rootPath, files, meta } = payload ?? {}
  const root = resolveWithin(typeof rootPath === 'string' ? rootPath : '', '')
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('检查点未包含任何文件')
  }
  const id = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const dir = checkpointDir(conversationId, id)
  const filesDir = path.join(dir, 'files')

  const manifest = {
    id,
    /** 原始会话 id（目录名是清洗后的形式） */
    conversationId: String(conversationId ?? ''),
    createdAt: Date.now(),
    rootPath: root,
    tool: typeof meta?.tool === 'string' ? meta.tool : '',
    operation: typeof meta?.operation === 'string' ? meta.operation : '',
    description: typeof meta?.description === 'string' ? meta.description : '',
    files: [],
  }

  const seen = new Set()
  for (const entry of files) {
    const relPath = typeof entry?.relPath === 'string' ? entry.relPath.trim() : ''
    if (!relPath || seen.has(relPath)) continue
    seen.add(relPath)
    // 防穿越：相对路径必须解析到工作区内
    const absolute = resolveWithin(root, relPath)
    const record = { relPath, existed: false, size: 0 }
    let stat = null
    try {
      stat = await fsp.stat(absolute)
    } catch {
      // 文件不存在（如 fs_write 将新建）：记录 existed=false，无需快照内容
    }
    if (stat && stat.isFile()) {
      const content = await fsp.readFile(absolute)
      const dest = path.join(filesDir, ...toSafeSegments(root, absolute))
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.writeFile(dest, content)
      record.existed = true
      record.size = stat.size
    } else if (stat) {
      // 目录等非普通文件：跳过，不纳入快照
      continue
    }
    manifest.files.push(record)
  }
  if (manifest.files.length === 0) {
    throw new Error('检查点未包含任何有效文件')
  }

  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  return { id, createdAt: manifest.createdAt, fileCount: manifest.files.length }
}

/** 工作区内绝对路径 → 快照目录内的相对段数组（逐段拼接，避免分隔符歧义） */
function toSafeSegments(root, absolute) {
  const rel = path.relative(root, absolute)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('路径越界：目标不在工作区内')
  }
  return rel.split(path.sep).map((segment, index) => (index === 0 && segment === '' ? '_' : segment))
}

/** 读取单个检查点的 manifest；不存在/损坏返回 null */
async function readManifest(dir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.id !== 'string') return null
    if (!Array.isArray(parsed.files) || typeof parsed.rootPath !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 列出某会话的全部检查点概要（按创建时间倒序）：
 * [{ id, conversationId, createdAt, tool, operation, description, fileCount, files: [relPath] }]
 */
async function listCheckpoints(conversationId) {
  const dir = conversationDir(conversationId)
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return []
  }
  const items = []
  for (const name of names) {
    const manifest = await readManifest(path.join(dir, name))
    if (!manifest) continue
    items.push({
      id: manifest.id,
      conversationId: typeof manifest.conversationId === 'string' ? manifest.conversationId : '',
      createdAt: typeof manifest.createdAt === 'number' ? manifest.createdAt : 0,
      tool: typeof manifest.tool === 'string' ? manifest.tool : '',
      operation: typeof manifest.operation === 'string' ? manifest.operation : '',
      description: typeof manifest.description === 'string' ? manifest.description : '',
      fileCount: manifest.files.length,
      files: manifest.files.map((file) => String(file?.relPath ?? '')).filter(Boolean),
    })
  }
  items.sort((a, b) => b.createdAt - a.createdAt)
  return items
}

/**
 * 还原检查点：把快照文件写回原路径。
 * - 还原前把涉及文件的当前状态再做一次快照（防误恢复；失败不阻断还原）；
 * - 快照时不存在（fs_write 新建）的文件，还原时若已存在则删除。
 * 返回 { restored, deleted, preRestoreCheckpointId }。
 */
async function restoreCheckpoint(conversationId, checkpointId) {
  const dir = checkpointDir(conversationId, checkpointId)
  const manifest = await readManifest(dir)
  if (!manifest) {
    throw new Error(`检查点不存在或已损坏：${checkpointId}`)
  }
  const root = manifest.rootPath

  // 还原前二次快照（尽力而为：失败仅少一道保险，不阻断还原）
  let preRestoreCheckpointId = null
  try {
    const result = await createCheckpoint({
      conversationId,
      rootPath: root,
      files: manifest.files.map((file) => ({ relPath: file.relPath })),
      meta: {
        tool: 'checkpoint',
        operation: 'restore',
        description: `还原检查点 ${manifest.id} 前的自动快照`,
      },
    })
    preRestoreCheckpointId = result.id
  } catch {
    // 忽略：还原流程继续
  }

  let restored = 0
  let deleted = 0
  for (const file of manifest.files) {
    const relPath = String(file?.relPath ?? '')
    if (!relPath) continue
    // 防穿越：还原目标必须位于 manifest 记录的工作区根目录内
    const absolute = resolveWithin(root, relPath)
    if (file.existed === true) {
      const segments = toSafeSegments(root, absolute)
      const src = path.join(dir, 'files', ...segments)
      await fsp.mkdir(path.dirname(absolute), { recursive: true })
      await fsp.copyFile(src, absolute)
      restored += 1
    } else {
      // 快照时不存在的文件（fs_write 新建）：还原时删除
      await fsp.rm(absolute, { force: true })
      deleted += 1
    }
  }
  return { restored, deleted, preRestoreCheckpointId }
}

/** 删除单个检查点（不存在时静默成功） */
async function deleteCheckpoint(conversationId, checkpointId) {
  await fsp.rm(checkpointDir(conversationId, checkpointId), { recursive: true, force: true })
  return true
}

/** 注册检查点 IPC（由 main.cjs 启动时调用一次） */
function registerCheckpointIpc(ipcMain) {
  ipcMain.handle('checkpoint:create', (_event, payload) => createCheckpoint(payload))
  ipcMain.handle('checkpoint:list', (_event, conversationId) => listCheckpoints(conversationId))
  ipcMain.handle('checkpoint:restore', (_event, conversationId, checkpointId) =>
    restoreCheckpoint(conversationId, checkpointId),
  )
  ipcMain.handle('checkpoint:delete', (_event, conversationId, checkpointId) =>
    deleteCheckpoint(conversationId, checkpointId),
  )
}

module.exports = {
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  deleteCheckpoint,
  registerCheckpointIpc,
}
