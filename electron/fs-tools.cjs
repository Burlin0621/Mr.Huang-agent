/**
 * 通用文件只读工具（fs_list / fs_read / fs_read_document 的实现层）。
 *
 * - 与 vault.cjs 同一套安全约束：路径先经 resolveWithin 校验（防目录穿越），
 *   跳过点开头的隐藏目录/文件，深度上限 8、文件数上限 5000；
 * - 不 require 任何 electron API（纯 node:fs/path + 第三方解析库），
 *   可在主进程外直接 require 做冒烟测试；
 * - fs_read 仅支持文本类扩展名白名单（utf-8，GBK 兜底）；
 * - fs_read_document 支持 .docx（mammoth）与 .pdf（pdf-parse），上限 20MB；
 * - fs_write / fs_edit 写类工具同用文本扩展名白名单与 2MB 上限：
 *   写入前先 preview（校验 + 生成替换后全文，不落盘），确认后经 atomicWriteText 原子写回；
 *   编辑要求 old_string 恰好出现一次（replace_all 除外），避免误替换。
 */
const fsp = require('node:fs/promises')
const path = require('node:path')
const { resolveWithin, assertRoot, toVaultPath, MAX_DEPTH, MAX_FILES } = require('./vault.cjs')

/** 文本文件大小上限（2MB） */
const TEXT_MAX_BYTES = 2 * 1024 * 1024
/** 二进制文档（docx/pdf）大小上限（20MB） */
const DOC_MAX_BYTES = 20 * 1024 * 1024

/** fs_read 允许的文本扩展名白名单（小写，含点） */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.csv', '.tsv', '.log', '.xml', '.html', '.htm',
  '.yml', '.yaml', '.ini', '.cfg', '.conf', '.env', '.bat', '.sh', '.ps1',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.go',
  '.rs', '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.rb', '.swift', '.sql',
  '.vue', '.css', '.scss', '.less',
])

/** fs_read_document 支持的二进制文档扩展名 → 解析方式 */
const DOCUMENT_EXTENSIONS = new Set(['.docx', '.pdf'])

/** 旧版二进制 Office 格式：单独给出更友好的提示 */
const LEGACY_OFFICE_EXTENSIONS = new Set(['.doc', '.xls', '.ppt', '.wps'])

/** 取小写扩展名（含点）；无扩展名返回空串 */
function getExtension(name) {
  return typeof name === 'string' ? path.extname(name).toLowerCase() : ''
}

/** 是否为白名单内的文本文件（大小写不敏感） */
function isTextFile(name) {
  return TEXT_EXTENSIONS.has(getExtension(name))
}

/**
 * 读文本内容：先按 utf-8 解码；若出现 U+FFFD 替换符则改用 GBK 重试；
 * GBK 结果仍含 U+FFFD 时按 utf-8 结果返回。
 */
async function readTextWithFallback(absolute) {
  const buffer = await fsp.readFile(absolute)
  const utf8 = buffer.toString('utf-8')
  if (!utf8.includes('\uFFFD')) {
    return utf8
  }
  try {
    // 延迟 require，避免在未安装依赖时影响模块加载
    const iconv = require('iconv-lite')
    const gbk = iconv.decode(buffer, 'gbk')
    if (!gbk.includes('\uFFFD')) {
      return gbk
    }
  } catch {
    // iconv-lite 不可用时静默回退 utf-8 结果
  }
  return utf8
}

/** 递归收集 root 内全部文件（跳过点开头目录/文件）；返回 { files, truncated } */
async function collectAllFiles(root) {
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
      } else if (entry.isFile()) {
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

/**
 * 列出工作区关联文件夹的全部文件（不限扩展名，扁平清单）。
 * subPath 限定子目录前缀；ext 过滤扩展名（如 "docx" 或 ".docx"，大小写不敏感）。
 */
async function listWorkspaceFiles(rootPath, subPath, ext) {
  const root = await assertRoot(rootPath)
  let { files, truncated } = await collectAllFiles(root)

  if (typeof subPath === 'string' && subPath.trim()) {
    const prefix = `${subPath.trim().replace(/^\/+|\/+$/g, '')}/`
    files = files.filter((item) => item.rel.startsWith(prefix))
  }
  if (typeof ext === 'string' && ext.trim()) {
    const suffix = ext.trim().toLowerCase().replace(/^\./, '')
    files = files.filter((item) => getExtension(item.rel) === `.${suffix}`)
  }

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
  return { root: toVaultPath(root, root), files: items, truncated }
}

/** 读取文本文件（白名单扩展名，2MB 上限，utf-8 + GBK 兜底） */
async function readWorkspaceTextFile(rootPath, relPath) {
  const root = await assertRoot(rootPath)
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('缺少文件相对路径参数 path')
  }
  const ext = getExtension(relPath)
  if (!ext) {
    throw new Error(`文件没有扩展名，fs_read 仅支持文本类文件（如 .md .txt .json .csv .py 等）`)
  }
  if (!TEXT_EXTENSIONS.has(ext)) {
    const hint = DOCUMENT_EXTENSIONS.has(ext) || LEGACY_OFFICE_EXTENSIONS.has(ext)
      ? '该类型不支持以文本方式读取，.docx/.pdf 请改用 fs_read_document'
      : `「${ext}」类型不支持读取，fs_read 仅支持文本类文件`
    throw new Error(`${hint}（文件：${relPath}）`)
  }
  const absolute = resolveWithin(root, relPath)
  let stat
  try {
    stat = await fsp.stat(absolute)
  } catch {
    throw new Error(`文件不存在：${toVaultPath(root, absolute)}`)
  }
  if (!stat.isFile()) {
    throw new Error('目标不是文件')
  }
  if (stat.size > TEXT_MAX_BYTES) {
    throw new Error('文件超过 2MB，暂不支持读取')
  }
  const content = await readTextWithFallback(absolute)
  return { content, size: stat.size, mtime: stat.mtimeMs }
}

/** 读取二进制文档并转为纯文本（.docx / .pdf，20MB 上限） */
async function readWorkspaceDocumentFile(rootPath, relPath) {
  const root = await assertRoot(rootPath)
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('缺少文件相对路径参数 path')
  }
  const ext = getExtension(relPath)
  if (LEGACY_OFFICE_EXTENSIONS.has(ext)) {
    throw new Error(`暂不支持读取 ${ext} 旧格式，请先在 Office/WPS 中另存为对应新格式（${ext} → .docx/.xlsx/.pptx）后重试`)
  }
  if (!DOCUMENT_EXTENSIONS.has(ext)) {
    throw new Error(`fs_read_document 仅支持 .docx 与 .pdf，收到：「${ext || '（无扩展名）'}」类型`)
  }
  const absolute = resolveWithin(root, relPath)
  let stat
  try {
    stat = await fsp.stat(absolute)
  } catch {
    throw new Error(`文件不存在：${toVaultPath(root, absolute)}`)
  }
  if (!stat.isFile()) {
    throw new Error('目标不是文件')
  }
  if (stat.size > DOC_MAX_BYTES) {
    throw new Error('文档超过 20MB，暂不支持读取')
  }

  let text
  if (ext === '.docx') {
    const mammoth = require('mammoth')
    const result = await mammoth.extractRawText({ path: absolute })
    text = result.value || ''
  } else {
    // pdf-parse v2 起入口已无旧版调试副作用，直接用 PDFParse 类读取
    const { PDFParse } = require('pdf-parse')
    const parser = new PDFParse({ data: await fsp.readFile(absolute) })
    try {
      const result = await parser.getText()
      text = result.text || ''
    } finally {
      await parser.destroy().catch(() => {})
    }
  }

  return { content: text.trim(), size: stat.size, mtime: stat.mtimeMs, kind: ext.slice(1) }
}

/**
 * 校验写入/编辑目标的路径与扩展名（与 readWorkspaceTextFile 同一套规则），返回绝对路径。
 * resolveWithin 保证解析结果仍位于 root 内（防 `..` 与绝对路径逃逸）。
 */
function resolveWritableTextFile(root, relPath) {
  if (!relPath || typeof relPath !== 'string') {
    throw new Error('缺少文件相对路径参数 path')
  }
  const ext = getExtension(relPath)
  if (!ext) {
    throw new Error('文件没有扩展名，仅支持文本类文件（如 .md .txt .json .csv .py 等）')
  }
  if (!TEXT_EXTENSIONS.has(ext)) {
    throw new Error(`「${ext}」类型不支持写入/编辑，仅允许文本类扩展名（文件：${relPath}）`)
  }
  return resolveWithin(root, relPath)
}

/** 原子写文本：先写同目录临时文件再 rename 覆盖，避免写一半损坏原文件 */
async function atomicWriteText(absolute, content) {
  const tmp = `${absolute}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(tmp, content, 'utf-8')
  try {
    await fsp.rename(tmp, absolute)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}

/** 统计 sub 在 text 中的出现次数（含重叠，纯函数可单测） */
function countOccurrences(text, sub) {
  if (!sub) return 0
  let count = 0
  let index = text.indexOf(sub)
  while (index !== -1) {
    count += 1
    index = text.indexOf(sub, index + sub.length)
  }
  return count
}

/**
 * 预检 fs_write：校验路径/扩展名/大小，返回 { absolute, existed, oldText }（不写盘）。
 * 目标已存在且 overwrite=false 时抛错（与执行行为一致，供确认弹窗提前失败降级）。
 */
async function previewWorkspaceWrite(rootPath, relPath, content, overwrite) {
  const root = await assertRoot(rootPath)
  const absolute = resolveWritableTextFile(root, relPath)
  if (typeof content !== 'string') {
    throw new Error('缺少文件内容参数 content')
  }
  const size = Buffer.byteLength(content, 'utf-8')
  if (size > TEXT_MAX_BYTES) {
    throw new Error(`内容超过 2MB 上限（${(size / 1024 / 1024).toFixed(2)} MB），不支持写入`)
  }
  let existed = false
  let oldText = ''
  try {
    const stat = await fsp.stat(absolute)
    if (!stat.isFile()) throw new Error('目标路径已存在且不是文件')
    existed = true
    if (!overwrite) {
      throw new Error(`目标文件已存在：${toVaultPath(root, absolute)}。如需覆盖请显式传 overwrite=true`)
    }
    oldText = await readTextWithFallback(absolute)
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith('目标文件已存在') || err.message.startsWith('目标路径已存在'))) {
      throw err
    }
    // 其余情况按「文件不存在（将新建）」处理
  }
  return { absolute, root, relPath, existed, oldText, size }
}

/** 执行 fs_write：基于 preview 结果写入（自动创建父目录，原子写回） */
async function writeWorkspaceTextFile(rootPath, relPath, content, overwrite) {
  const preview = await previewWorkspaceWrite(rootPath, relPath, content, overwrite)
  await fsp.mkdir(path.dirname(preview.absolute), { recursive: true })
  await atomicWriteText(preview.absolute, content)
  return { path: preview.relPath.trim(), size: preview.size, existed: preview.existed }
}

/**
 * 预检 fs_edit：校验目标为可编辑文本文件，统计 old_string 出现次数并生成替换后全文（不写盘）。
 * - 文件不存在 / 扩展名不在白名单 / 超过 2MB 时抛错；
 * - replace_all=false 时出现次数必须恰好为 1，0 次或多次都抛错并提示调整。
 */
async function previewWorkspaceEdit(rootPath, relPath, oldString, newString, replaceAll) {
  const root = await assertRoot(rootPath)
  const absolute = resolveWritableTextFile(root, relPath)
  if (typeof oldString !== 'string' || oldString === '') {
    throw new Error('缺少待替换文本参数 old_string（不能为空）')
  }
  if (typeof newString !== 'string') {
    throw new Error('缺少替换文本参数 new_string')
  }
  let stat
  try {
    stat = await fsp.stat(absolute)
  } catch {
    throw new Error(`文件不存在：${toVaultPath(root, absolute)}（fs_edit 只能编辑已有文件，新建请用 fs_write）`)
  }
  if (!stat.isFile()) {
    throw new Error('目标不是文件')
  }
  if (stat.size > TEXT_MAX_BYTES) {
    throw new Error('文件超过 2MB，暂不支持编辑')
  }
  const content = await readTextWithFallback(absolute)
  const count = countOccurrences(content, oldString)
  if (!replaceAll && count === 0) {
    throw new Error('old_string 在文件中未找到（0 次），请先用 fs_read 核对原文，再调整 old_string 精确匹配（含缩进与换行）')
  }
  if (!replaceAll && count > 1) {
    throw new Error(`old_string 在文件中出现了 ${count} 次，为避免误替换请加长 old_string 使其唯一，或改用 replace_all=true`)
  }
  const newText = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString)
  return { absolute, root, relPath, oldText: content, newText, replaced: replaceAll ? count : 1 }
}

/** 执行 fs_edit：基于 preview 结果原子写回 */
async function editWorkspaceTextFile(rootPath, relPath, oldString, newString, replaceAll) {
  const preview = await previewWorkspaceEdit(rootPath, relPath, oldString, newString, replaceAll === true)
  await atomicWriteText(preview.absolute, preview.newText)
  return {
    path: preview.relPath.trim(),
    replaced: preview.replaced,
    size: Buffer.byteLength(preview.newText, 'utf-8'),
  }
}

module.exports = {
  TEXT_EXTENSIONS,
  DOCUMENT_EXTENSIONS,
  TEXT_MAX_BYTES,
  DOC_MAX_BYTES,
  getExtension,
  isTextFile,
  readTextWithFallback,
  countOccurrences,
  atomicWriteText,
  previewWorkspaceWrite,
  previewWorkspaceEdit,
  listWorkspaceFiles,
  readWorkspaceTextFile,
  readWorkspaceDocumentFile,
  writeWorkspaceTextFile,
  editWorkspaceTextFile,
}
