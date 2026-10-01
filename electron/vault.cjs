/**
 * Obsidian vault 文件操作（electron/main.cjs 的 vault IPC 与 electron/tools.cjs 共用）。
 *
 * - vault 即普通文件夹中的 .md 文件；.obsidian 为配置目录，连同 .git 及所有点开头
 *   的隐藏目录/文件一律跳过；
 * - 所有路径先经 resolveWithin(rootPath, relPath) 校验：解析结果必须仍位于 rootPath
 *   内（防目录穿越），否则抛中文错误；
 * - 统一限制：.md 白名单、单文件 2MB、树深度 8、文件数 5000、搜索命中 100 条。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')

/** 单个笔记文件大小上限（2MB） */
const MAX_FILE_BYTES = 2 * 1024 * 1024
/** 目录遍历深度上限 */
const MAX_DEPTH = 8
/** 文件清单条数上限（超出截断） */
const MAX_FILES = 5000
/** 全文搜索命中条数上限 */
const SEARCH_MAX_HITS = 100

/** 校验 relPath 解析后仍在 rootPath 内，返回绝对路径；越界/参数非法时抛错 */
function resolveWithin(rootPath, relPath) {
  if (typeof rootPath !== 'string' || !rootPath.trim()) {
    throw new Error('未提供笔记目录路径')
  }
  const root = path.resolve(rootPath)
  const rel = typeof relPath === 'string' ? relPath.trim() : ''
  const resolved = path.resolve(root, rel)
  const check = path.relative(root, resolved)
  if (check.startsWith('..') || path.isAbsolute(check)) {
    throw new Error('路径越界：目标不在笔记目录内')
  }
  return resolved
}

/** 确认 rootPath 存在且是目录，返回其绝对路径 */
async function assertRoot(rootPath) {
  const root = resolveWithin(rootPath, '')
  let stat
  try {
    stat = await fsp.stat(root)
  } catch {
    throw new Error(`笔记目录不存在或不可访问：${root}`)
  }
  if (!stat.isDirectory()) {
    throw new Error(`路径不是文件夹：${root}`)
  }
  return root
}

/** 是否为允许操作的 .md 笔记（大小写不敏感） */
function isMarkdownFile(name) {
  return typeof name === 'string' && name.toLowerCase().endsWith('.md')
}

/** 把绝对路径转成以 / 分隔的 vault 内相对路径 */
function toVaultPath(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/')
}

/** 递归收集 vault 内全部 .md 文件（跳过点开头目录/文件）；返回 { files, truncated } */
async function collectMarkdownFiles(root) {
  const files = []
  let truncated = false

  async function walk(dir, relDir, depth) {
    if (truncated || depth > MAX_DEPTH) {
      if (depth > MAX_DEPTH) truncated = true
      return
    }
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      if (entry.name.startsWith('.')) continue
      const absolute = path.join(dir, entry.name)
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(absolute, rel, depth + 1)
      } else if (entry.isFile() && isMarkdownFile(entry.name)) {
        if (files.length >= MAX_FILES) {
          truncated = true
          return
        }
        files.push({ absolute, rel })
      }
    }
  }

  await walk(root, '', 0)
  return { files, truncated }
}

/** 列出 vault 的笔记清单（扁平结构，相对路径以 / 分隔） */
async function listVaultTree(rootPath) {
  const root = await assertRoot(rootPath)
  const { files, truncated } = await collectMarkdownFiles(root)
  const items = []
  for (const file of files) {
    let stat
    try {
      stat = await fsp.stat(file.absolute)
    } catch {
      continue
    }
    items.push({
      path: file.rel,
      name: path.basename(file.rel),
      size: stat.size,
      mtime: stat.mtimeMs,
    })
  }
  return { files: items, truncated }
}

/** 读取单个笔记内容（仅 .md，2MB 上限） */
async function readVaultFile(rootPath, relPath) {
  const root = await assertRoot(rootPath)
  if (!relPath || !isMarkdownFile(relPath)) {
    throw new Error('仅支持读取 .md 笔记文件')
  }
  const absolute = resolveWithin(root, relPath)
  let stat
  try {
    stat = await fsp.stat(absolute)
  } catch {
    throw new Error(`笔记不存在：${toVaultPath(root, absolute)}`)
  }
  if (!stat.isFile()) {
    throw new Error('目标不是文件')
  }
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('笔记超过 2MB，暂不支持读取')
  }
  const content = await fsp.readFile(absolute, 'utf-8')
  return { content, size: stat.size, mtime: stat.mtimeMs }
}

/** 写入笔记（仅 .md；默认不覆盖已存在文件，overwrite=true 时覆盖） */
async function writeVaultFile(rootPath, relPath, content, overwrite = false) {
  const root = await assertRoot(rootPath)
  if (!relPath || !isMarkdownFile(relPath)) {
    throw new Error('仅支持写入 .md 笔记文件')
  }
  if (typeof content !== 'string') {
    throw new Error('笔记内容必须是非空文本')
  }
  const absolute = resolveWithin(root, relPath)
  if (!overwrite) {
    let exists = true
    try {
      await fsp.access(absolute)
    } catch {
      exists = false
    }
    if (exists) {
      throw new Error(`笔记已存在：${toVaultPath(root, absolute)}（如需覆盖请开启 overwrite）`)
    }
  }
  await fsp.mkdir(path.dirname(absolute), { recursive: true })
  await fsp.writeFile(absolute, content, 'utf-8')
  const stat = await fsp.stat(absolute)
  return { path: toVaultPath(root, absolute), size: stat.size, mtime: stat.mtimeMs }
}

/** 全文检索（大小写不敏感按行匹配，最多 100 条命中，跳过 2MB 以上文件） */
async function searchVault(rootPath, query) {
  const root = await assertRoot(rootPath)
  const keyword = typeof query === 'string' ? query.trim().toLowerCase() : ''
  if (!keyword) {
    throw new Error('搜索关键词不能为空')
  }
  const { files } = await collectMarkdownFiles(root)
  const hits = []
  let truncated = false
  for (const file of files) {
    if (hits.length >= SEARCH_MAX_HITS) {
      truncated = true
      break
    }
    let stat
    try {
      stat = await fsp.stat(file.absolute)
    } catch {
      continue
    }
    if (stat.size > MAX_FILE_BYTES) continue
    let content
    try {
      content = await fsp.readFile(file.absolute, 'utf-8')
    } catch {
      continue
    }
    const lines = content.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const lineIndex = lines[index].toLowerCase().indexOf(keyword)
      if (lineIndex < 0) continue
      const raw = lines[index].trim()
      const snippet = raw.length > 160 ? `${raw.slice(0, 160)}…` : raw
      hits.push({ path: file.rel, line: index + 1, snippet })
      if (hits.length >= SEARCH_MAX_HITS) {
        truncated = true
        break
      }
    }
  }
  return { hits, truncated }
}

/** 注册 vault:* IPC（由 main.cjs 启动时调用一次；错误 reject 并携带中文信息） */
function registerVaultIpc(ipcMain) {
  ipcMain.handle('vault:list-tree', (_event, rootPath) => listVaultTree(rootPath))
  ipcMain.handle('vault:read-file', (_event, rootPath, relPath) => readVaultFile(rootPath, relPath))
  ipcMain.handle('vault:write-file', (_event, rootPath, relPath, content, overwrite) =>
    writeVaultFile(rootPath, relPath, content, overwrite === true),
  )
  ipcMain.handle('vault:search', (_event, rootPath, query) => searchVault(rootPath, query))
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_DEPTH,
  MAX_FILES,
  resolveWithin,
  assertRoot,
  toVaultPath,
  listVaultTree,
  readVaultFile,
  writeVaultFile,
  searchVault,
  registerVaultIpc,
}
