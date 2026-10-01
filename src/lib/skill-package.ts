/**
 * 技能包（SKILL.md 风格）纯函数集合（零依赖，可在 Node 中直接单测）：
 * - parseSkillPackageMarkdown：YAML frontmatter（name/description/triggers，
 *   可选 version/author/icon/tags）+ `---` 分隔的正文指令
 * - serializeSkillPackageMarkdown：技能包 → SKILL.md 文本（导出用）
 * - buildSkillCatalogBlock：启用技能的「可用技能清单」system 注入块（省 token 核心）
 * - matchTriggeredSkillIds：用户消息文本 → 命中触发词的技能 id（自动激活）
 * - buildActivatedSkillBlock：已激活技能正文注入块（含脚本落盘执行约定）
 * - createSkillZip：技能包 → ZIP（SKILL.md + scripts/…，纯手写 store 打包，无依赖）
 */

/** 技能脚本文件（存于技能包 scripts/ 目录，经 shell_exec 执行） */
export interface SkillScript {
  /** 文件名（含扩展名，如 run.py；打包时位于 scripts/ 下） */
  filename: string
  /** 文件文本内容 */
  content: string
}

/** SKILL.md 解析结果（不含 id / enabled 等运行时字段） */
export interface ParsedSkillPackage {
  name: string
  description: string
  triggers: string[]
  body: string
  version: string
  author: string
  icon: string
  tags: string[]
  scripts: SkillScript[]
}

/** 技能清单条目（注入「可用技能」列表所需的最小字段） */
export interface SkillCatalogEntry {
  id: string
  name: string
  description: string
  triggers: string[]
  tags: string[]
}

/** 单字段上限（防注入体积失控） */
const MAX_BODY_LENGTH = 100 * 1024

/** 去掉 YAML 值两侧的成对引号 */
function stripQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

/** frontmatter 单值字段读取：`key: value` 或多行块标量（取缩进行拼单行）；缺失返回空串 */
function readFrontmatterString(lines: string[], key: string): string {
  const index = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line))
  if (index === -1) return ''
  let inline = lines[index].replace(new RegExp(`^${key}\\s*:`), '').trim()
  if (/^[>|][+-]?$/.test(inline)) inline = '' // 块标量标记，真实内容在后续缩进行
  const parts = inline ? [stripQuotes(inline)] : []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    // 空行或下一个顶格 key / 列表项即块结束
    if (!line.trim() || !/^\s/.test(line) || /^\s*-\s/.test(line)) break
    parts.push(line.trim())
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * frontmatter triggers 读取，兼容三种写法：
 * 1. 单行逗号/顿号分隔：triggers: 写作, 润色
 * 2. 单行 YAML 流式数组：triggers: [写作, 润色]
 * 3. 多行列表项：triggers:\n  - 写作\n  - 润色
 */
function readFrontmatterTriggers(lines: string[]): string[] {
  const index = lines.findIndex((line) => /^triggers\s*:/.test(line))
  if (index === -1) return []
  const inline = lines[index].replace(/^triggers\s*:/, '').trim()
  const items: string[] = []
  if (inline && !/^[>|][+-]?$/.test(inline)) {
    const unwrapped = inline.replace(/^\[/, '').replace(/\]$/, '')
    for (const item of unwrapped.split(/[,，、]/)) {
      const cleaned = stripQuotes(item)
      if (cleaned) items.push(cleaned)
    }
    return dedupe(items)
  }
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (!line.trim()) continue
    const match = /^-\s+(.+)$/.exec(line.trim())
    if (!match) break // 非列表项即块结束
    items.push(stripQuotes(match[1]))
  }
  return dedupe(items)
}

/** frontmatter tags 读取（与 triggers 相同的三种写法） */
function readFrontmatterTags(lines: string[]): string[] {
  const index = lines.findIndex((line) => /^tags\s*:/.test(line))
  if (index === -1) return []
  const inline = lines[index].replace(/^tags\s*:/, '').trim()
  if (inline && !/^[>|][+-]?$/.test(inline)) {
    const unwrapped = inline.replace(/^\[/, '').replace(/\]$/, '')
    return dedupe(
      unwrapped
        .split(/[,，、]/)
        .map((item) => stripQuotes(item))
        .filter(Boolean),
    )
  }
  const items: string[] = []
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (!line.trim()) continue
    const match = /^-\s+(.+)$/.exec(line.trim())
    if (!match) break
    items.push(stripQuotes(match[1]))
  }
  return dedupe(items)
}

/** 去重（保持首次出现顺序） */
function dedupe(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * 解析 SKILL.md 文本为技能包定义：
 * - frontmatter 缺失 / 字段缺失时用 fallbackName 兜底，不抛错（旧格式兼容）；
 * - 正文为空时抛中文错误（无指令的技能没有意义）。
 */
export function parseSkillPackageMarkdown(
  text: string,
  fallbackName: string,
): ParsedSkillPackage {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  let frontmatterLines: string[] = []
  let body = normalized.trim()
  if (lines[0]?.trim() === '---') {
    const endLine = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
    if (endLine !== -1) {
      frontmatterLines = lines.slice(1, endLine)
      body = lines.slice(endLine + 1).join('\n').trim()
    }
  }

  if (!body) throw new Error('SKILL.md 没有正文内容')
  if (body.length > MAX_BODY_LENGTH) throw new Error('SKILL.md 正文过大（超过 100KB），暂不支持')

  const name = readFrontmatterString(frontmatterLines, 'name') || fallbackName
  const description =
    readFrontmatterString(frontmatterLines, 'description') || '从 SKILL.md 导入的技能'
  const triggers = readFrontmatterTriggers(frontmatterLines)
  return {
    name: name.slice(0, 60),
    description: description.slice(0, 120),
    triggers: triggers.length > 0 ? triggers : dedupe([name]),
    body,
    version: readFrontmatterString(frontmatterLines, 'version'),
    author: readFrontmatterString(frontmatterLines, 'author'),
    icon: readFrontmatterString(frontmatterLines, 'icon').slice(0, 8),
    tags: readFrontmatterTags(frontmatterLines),
    scripts: [],
  }
}

/**
 * 技能包 → SKILL.md 文本（frontmatter + 正文）。scripts 不写入 SKILL.md
 * （导出 ZIP 时作为 scripts/ 下的独立文件随包携带）。
 */
export function serializeSkillPackageMarkdown(pkg: {
  name: string
  description: string
  triggers: string[]
  body: string
  version?: string
  author?: string
  icon?: string
  tags?: string[]
}): string {
  const lines: string[] = ['---']
  lines.push(`name: ${pkg.name}`)
  lines.push(`description: ${pkg.description.replace(/\s*\n\s*/g, ' ')}`)
  if (pkg.triggers.length > 0) {
    lines.push('triggers:')
    for (const trigger of pkg.triggers) lines.push(`  - ${trigger}`)
  }
  if (pkg.version) lines.push(`version: ${pkg.version}`)
  if (pkg.author) lines.push(`author: ${pkg.author}`)
  if (pkg.icon) lines.push(`icon: ${pkg.icon}`)
  if (pkg.tags && pkg.tags.length > 0) {
    lines.push(`tags: [${pkg.tags.map((tag) => tag.replace(/[,，[\]]/g, '')).join(', ')}]`)
  }
  lines.push('---', '', pkg.body.trim())
  return `${lines.join('\n')}\n`
}

/**
 * 构造「可用技能」清单 system 注入块：只列 name + description + 触发词，
 * 不携带正文（省 token）。清单为空时返回 null（不注入）。
 */
export function buildSkillCatalogBlock(entries: SkillCatalogEntry[]): string | null {
  const usable = entries.filter((entry) => entry.name.trim() || entry.description.trim())
  if (usable.length === 0) return null
  const lines = usable.map((entry) => {
    const words = [...entry.triggers, ...entry.tags].filter(Boolean).join('、')
    const triggerNote = words ? `（触发词：${words}）` : ''
    return `- ${entry.name}：${entry.description}${triggerNote}`
  })
  return [
    '<可用技能>',
    '以下是本工作台已启用的技能清单（仅名称与用途，正文未加载）。当用户请求与某技能的用途或触发词明显相关时，',
    '请调用 use_skill 工具（参数 skill_id 传技能名称或 id）加载该技能的完整指令后，严格按其正文执行任务；',
    '命中技能后先向用户简要声明正在使用该技能。',
    ...lines,
    '</可用技能>',
  ].join('\n')
}

/**
 * 关键词命中：用户消息文本命中任一触发词 / 技能名 / 标签（不区分大小写的字面包含）时返回该技能 id。
 * 触发词少于 2 个字符的忽略（避免单字误命中）。
 */
export function matchTriggeredSkillIds(text: string, entries: SkillCatalogEntry[]): string[] {
  const haystack = (text ?? '').toLowerCase()
  if (!haystack.trim()) return []
  const hits: string[] = []
  for (const entry of entries) {
    const words = [...entry.triggers, entry.name, ...entry.tags]
      .map((word) => word.trim().toLowerCase())
      .filter((word) => word.length >= 2)
    if (words.some((word) => haystack.includes(word))) {
      hits.push(entry.id)
    }
  }
  return hits
}

/** 脚本执行约定说明（写入激活技能注入块，模型据此自行落盘 + 执行） */
const SCRIPT_CONVENTION =
  '脚本执行约定：本技能附带的脚本文件尚未落盘。需要执行时，先用 fs_write 把脚本内容写入当前工作区' +
  '（如 scripts/<文件名>），再用 shell_exec 运行（shell_exec 的工作目录锁定在当前工作区内）。'

/**
 * 构造已激活技能的注入块：正文指令 + 脚本清单（含脚本落盘执行约定）。
 * 用于命中后注入 system / 返回给模型。
 */
export function buildActivatedSkillBlock(skill: {
  id: string
  name: string
  /** 正文（SkillView.template 的别名，兼容两种字段名） */
  body?: string
  template: string
  scripts: SkillScript[]
}): string {
  const body = (skill.body || skill.template || '').trim()
  const scripts = skill.scripts ?? []
  const scriptLines = scripts.map((script) => `- scripts/${script.filename}（${script.content.length} 字符）`)
  const parts = [`【技能指令：${skill.name}】`, '以下为该技能的完整指令，请严格遵循执行：', '', body]
  if (scripts.length > 0) {
    parts.push('', '本技能附带脚本文件：', ...scriptLines, SCRIPT_CONVENTION)
  }
  return parts.join('\n')
}

/* ==========================================================================
   ZIP 打包（导出技能包）：纯手写 store（不压缩）ZIP writer，零依赖
   --------------------------------------------------------------------------
   - 格式：每个条目 local file header + 原始字节 → central directory → EOCD；
   - UTF-8 文件名（flag bit 11 置位）；Windows 资源管理器与主流解压工具均可读。
   ========================================================================== */

/** 预生成 CRC-32 查表（多项式 0xEDB88320） */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** 计算字节序列的 CRC-32（无符号） */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** ZIP 条目（导出打包入参） */
export interface ZipOutputEntry {
  name: string
  content: string
}

/**
 * 把文本条目打包为 ZIP（store 不压缩）二进制，可直接作为 Blob 下载。
 * 全部条目为 UTF-8 文本；文件名以 / 结尾的目录条目请勿传入。
 */
export function createZip(entries: ZipOutputEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  const pushChunk = (target: Uint8Array[], bytes: Uint8Array): void => {
    target.push(bytes)
    offset += bytes.length
  }
  const u16 = (value: number): Uint8Array => new Uint8Array([value & 0xff, (value >>> 8) & 0xff])
  const u32 = (value: number): Uint8Array =>
    new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff])

  // DOS 时间戳：以当前时间的 2 秒粒度编码（时区无关，仅供解压工具展示）
  const now = new Date()
  const dosTime =
    ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() / 2) & 0x1f)
  const dosDate =
    (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0xf) << 5) | (now.getDate() & 0x1f)

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const dataBytes = encoder.encode(entry.content)
    const crc = crc32(dataBytes)
    const localOffset = offset

    // local file header：签名 + 版本 + UTF-8 flag + store + 时间 + CRC + 尺寸 + 文件名
    const local = new Uint8Array(30 + nameBytes.length)
    local.set(u32(0x04034b50), 0)
    local.set(u16(20), 4) // version needed
    local.set(u16(0x0800), 6) // flags: UTF-8 文件名
    local.set(u16(0), 8) // method: store
    local.set(u16(dosTime), 10)
    local.set(u16(dosDate), 12)
    local.set(u32(crc), 14)
    local.set(u32(dataBytes.length), 18) // compressed
    local.set(u32(dataBytes.length), 22) // uncompressed
    local.set(u16(nameBytes.length), 26)
    local.set(nameBytes, 30)
    pushChunk(chunks, local)
    pushChunk(chunks, dataBytes)

    // central directory entry
    const centralBytes = new Uint8Array(46 + nameBytes.length)
    centralBytes.set(u32(0x02014b50), 0)
    centralBytes.set(u16(20), 4) // version made by
    centralBytes.set(u16(20), 6) // version needed
    centralBytes.set(u16(0x0800), 8)
    centralBytes.set(u16(0), 10)
    centralBytes.set(u16(dosTime), 12)
    centralBytes.set(u16(dosDate), 14)
    centralBytes.set(u32(crc), 16)
    centralBytes.set(u32(dataBytes.length), 20)
    centralBytes.set(u32(dataBytes.length), 24)
    centralBytes.set(u16(nameBytes.length), 28)
    centralBytes.set(u32(localOffset), 42)
    centralBytes.set(nameBytes, 46)
    central.push(centralBytes)
  }

  const centralSize = central.reduce((sum, bytes) => sum + bytes.length, 0)
  const eocd = new Uint8Array(22)
  eocd.set(u32(0x06054b50), 0)
  eocd.set(u16(entries.length), 8)
  eocd.set(u16(entries.length), 10)
  eocd.set(u32(centralSize), 12)
  eocd.set(u32(offset), 16)

  const total = offset + centralSize + 22
  const output = new Uint8Array(total)
  let cursor = 0
  for (const bytes of [...chunks, ...central, eocd]) {
    output.set(bytes, cursor)
    cursor += bytes.length
  }
  return output
}

/** 脚本文件名合法性：仅允许字母数字中文连字符下划线点与一层子目录斜杠，禁止穿越 */
export function isValidScriptFilename(filename: string): boolean {
  if (!filename.trim()) return false
  if (filename.includes('..') || filename.startsWith('/') || filename.includes('\\')) return false
  return /^(scripts\/)?[\p{L}\p{N}_][\p{L}\p{N}._/-]*$/u.test(filename.trim())
}

/** 脚本文件名 → 包内路径（统一归一到 scripts/ 下） */
export function toZipScriptPath(filename: string): string {
  const clean = filename.trim().replace(/^scripts\//, '')
  return `scripts/${clean}`
}
