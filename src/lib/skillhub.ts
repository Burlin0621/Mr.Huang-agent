import { storageGet, storageRemove, storageSet } from '@/lib/storage'
import {
  parseSkillPackageMarkdown,
  type SkillScript,
} from '@/lib/skill-package'
/**
 * SkillHub 技能目录：可一键「添加」生成自定义智能体的技能目录。
 * 纯数据模块（零依赖），风格与 src/lib/agents.ts 保持一致。
 *
 * 注：目录数据已清空，程序以空目录启动；本模块的 GitHub 链接导入与 Zip
 * 合集包导入等工具函数全部保留，用户可通过它们自行添加技能。
 * 后续若需恢复目录数据，直接在此数组中补充条目即可。
 */

export interface SkillhubAgentDefinition {
  id: string
  /** 展示名称 */
  name: string
  /** 一句话描述（SkillHub 弹窗列表中展示） */
  description: string
  /** 添加为智能体时注入的系统提示词 */
  systemPrompt: string
  /** 展示用 emoji 图标 */
  icon: string
  /** 展示用标签 chips */
  tags: string[]
}

export const SKILLHUB_AGENTS: SkillhubAgentDefinition[] = []

/* ==========================================================================
   GitHub 技能链接安装：粘贴 GitHub 链接把仓库中的技能（SKILL.md）装成智能体
   --------------------------------------------------------------------------
   - 纯函数 + async fetch，无 Vue 依赖；统一走 api.github.com（响应带 CORS 头，
     浏览器可直连；携带 Bearer Token 可访问私有仓库）
   - GitHub Token 仅保存在本机 localStorage，用于访问私有仓库
   ========================================================================== */

/** GitHub 技能链接解析结果 */
export interface ParsedGithubSkillUrl {
  owner: string
  repo: string
  /** 分支名；仓库根链接未携带分支时为空串（走仓库默认分支） */
  branch: string
  /** 仓库内路径（无首尾斜杠）；仓库根链接为空串 */
  path: string
  /** 链接形态：file = 直接指向 SKILL.md；dir = 技能目录；root = 仓库根 */
  kind: 'file' | 'dir' | 'root'
}

/** 从技能包（GitHub 链接 / ZIP 文件）解析出的技能定义（可直接作为自定义智能体入参） */
export interface InstalledSkillLike {
  name: string
  description: string
  systemPrompt: string
  /** 技能目录名（SKILL.md 所在目录；仓库根 / 压缩包根级时回退来源名） */
  skillDir: string
}

/** 从 GitHub 拉取并解析后的技能定义 */
export interface GithubSkill extends InstalledSkillLike {
  owner: string
  repo: string
}

/** GitHub Token 在 localStorage 中的持久化 key */
const GITHUB_TOKEN_KEY = 'mr-huang-agent:github-token'
/** GitHub REST API 地址 */
const GITHUB_API_ORIGIN = 'https://api.github.com'
/** SKILL.md 大小上限（100KB），超限拒绝安装 */
const MAX_SKILL_MD_BYTES = 100 * 1024
/** 描述超长时的截断长度 */
const MAX_DESCRIPTION_LENGTH = 60

/** 读取本机保存的 GitHub Token；localStorage 不可用时返回空串 */
export function getGithubToken(): string {
  try {
    return storageGet(GITHUB_TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

/** 保存 / 清除（传空串）本机 GitHub Token；持久化失败时静默降级 */
export function setGithubToken(token: string): void {
  const value = token.trim()
  try {
    if (value) storageSet(GITHUB_TOKEN_KEY, value)
    else storageRemove(GITHUB_TOKEN_KEY)
  } catch {
    // 忽略持久化失败（如隐私模式下存储不可用）
  }
}

/** URL 路径逐段解码（技能目录可能是中文名；单段解码失败时保留原文） */
function decodePathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment)
      } catch {
        return segment
      }
    })
}

/**
 * 解析 GitHub 技能链接并规范化（容忍首尾空格、末尾斜杠、?query、#hash、
 * 缺协议头自动补 https://、repo 段的 .git 后缀），支持：
 * 1. https://github.com/{owner}/{repo}/blob/{branch}/{path…}/SKILL.md
 * 2. https://github.com/{owner}/{repo}/tree/{branch}/{path…}（技能目录，拉取时列目录找 SKILL.md）
 * 3. https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path…}/SKILL.md
 * 4. 裸 github.com/... 无协议
 * 其余格式返回 null（由调用方给出中文提示）。
 */
export function parseGithubSkillUrl(input: string): ParsedGithubSkillUrl | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  let url: URL
  try {
    url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const segments = decodePathSegments(url.pathname)

  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    const owner = segments[0] ?? ''
    let repo = segments[1] ?? ''
    if (repo.endsWith('.git')) repo = repo.slice(0, -4)
    if (!owner || !repo) return null
    const kindSegment = segments[2] ?? ''
    const rest = segments.slice(3)
    if (kindSegment === 'blob') {
      const branch = rest[0] ?? ''
      const path = rest.slice(1).join('/')
      // blob 链接必须指向 SKILL.md 文件
      if (!branch || path.split('/').pop() !== 'SKILL.md') return null
      return { owner, repo, branch, path, kind: 'file' }
    }
    if (kindSegment === 'tree') {
      const branch = rest[0] ?? ''
      if (!branch) return null
      const path = rest.slice(1).join('/')
      // tree 到仓库根（如 /tree/main）按仓库根处理
      return { owner, repo, branch, path, kind: path ? 'dir' : 'root' }
    }
    if (!kindSegment) return { owner, repo, branch: '', path: '', kind: 'root' }
    // releases / issues / commit 等其他页面链接不支持
    return null
  }

  if (url.hostname === 'raw.githubusercontent.com') {
    const owner = segments[0] ?? ''
    const repo = segments[1] ?? ''
    const branch = segments[2] ?? ''
    const path = segments.slice(3).join('/')
    if (!owner || !repo || !branch || path.split('/').pop() !== 'SKILL.md') return null
    return { owner, repo, branch, path, kind: 'file' }
  }

  return null
}

/** GitHub Contents API 目录条目（目录列举返回数组中的单项） */
interface GithubContentsEntry {
  name?: unknown
  type?: unknown
}

/** GitHub Contents API 的文件响应 */
interface GithubContentsFile {
  size?: unknown
  content?: unknown
  encoding?: unknown
}

/** 调 GitHub API 取 JSON；网络异常与常见状态码统一抛中文错误 */
async function requestGithubJson(apiPath: string, token: string | undefined): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) headers.Authorization = `Bearer ${token}`
  let response: Response
  try {
    response = await fetch(`${GITHUB_API_ORIGIN}${apiPath}`, { headers })
  } catch {
    throw new Error('网络请求失败，请检查网络后重试')
  }
  if (response.status === 404) {
    throw new Error('未找到该技能：仓库不存在、链接有误，或为私有仓库且未配置 GitHub Token')
  }
  if (response.status === 403) {
    throw new Error('GitHub 访问受限（可能触发限流），请稍后再试')
  }
  if (!response.ok) {
    throw new Error(`GitHub 请求失败（HTTP ${response.status}），请稍后再试`)
  }
  try {
    return await response.json()
  } catch {
    throw new Error('GitHub 返回了无法解析的内容，请稍后再试')
  }
}

/** 仓库内路径逐段重新编码为 URL 路径（中文目录名等） */
function encodeRepoPath(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/** 组装 contents API 路径（branch 为空时走仓库默认分支） */
function contentsApiPath(owner: string, repo: string, path: string, branch: string): string {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : ''
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodeRepoPath(path)}${ref}`
}

/** 列举仓库目录（返回 name/type 列表）；响应不是目录数组时报错 */
async function listGithubDir(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string | undefined,
): Promise<Array<{ name: string; type: string }>> {
  const data = await requestGithubJson(contentsApiPath(owner, repo, path, branch), token)
  if (!Array.isArray(data)) {
    throw new Error('无法读取该目录：请确认链接指向技能目录（GitHub 返回的内容不是目录列表）')
  }
  return data.map((entry) => {
    const item = (entry ?? {}) as GithubContentsEntry
    return {
      name: typeof item.name === 'string' ? item.name : '',
      type: typeof item.type === 'string' ? item.type : '',
    }
  })
}

/** base64 → UTF-8 文本（GitHub 返回的 content 含换行需先去除；用 TextDecoder 保证中文不乱码） */
function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ''))
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new TextDecoder().decode(bytes)
}

/** 拉取单个 SKILL.md 文件内容；超过 100KB 或内容缺失时抛中文错误 */
async function fetchSkillMdContent(
  owner: string,
  repo: string,
  path: string,
  branch: string,
  token: string | undefined,
): Promise<string> {
  const data = await requestGithubJson(contentsApiPath(owner, repo, path, branch), token)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('未找到该技能：仓库不存在、链接有误，或为私有仓库且未配置 GitHub Token')
  }
  const file = data as GithubContentsFile
  if (typeof file.size === 'number' && file.size > MAX_SKILL_MD_BYTES) {
    throw new Error('SKILL.md 过大（超过 100KB），暂不支持')
  }
  if (typeof file.content !== 'string' || file.encoding !== 'base64') {
    // 文件超过 1MB 时 GitHub 不内联返回 content，统一按过大处理
    throw new Error('SKILL.md 过大（超过 100KB），暂不支持')
  }
  return decodeBase64Utf8(file.content)
}

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

/**
 * 解析 SKILL.md 顶部的 YAML frontmatter（--- 包围块），提取 name / description。
 * description 兼容单行（可带引号）与多行块标量（> / >- / | 等，取后续缩进行拼为单行）；
 * 拿不到的字段为空串，由调用方回退。
 */
function parseFrontmatter(text: string): { name: string; description: string; body: string } {
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') {
    return { name: '', description: '', body: normalized.trim() }
  }
  const endLine = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (endLine === -1) {
    return { name: '', description: '', body: normalized.trim() }
  }
  const frontmatterLines = lines.slice(1, endLine)
  const body = lines.slice(endLine + 1).join('\n').trim()

  const nameLine = frontmatterLines.find((line) => /^name\s*:/.test(line))
  const name = nameLine ? stripQuotes(nameLine.replace(/^name\s*:/, '')) : ''

  const descriptionIndex = frontmatterLines.findIndex((line) => /^description\s*:/.test(line))
  let description = ''
  if (descriptionIndex !== -1) {
    let inline = frontmatterLines[descriptionIndex].replace(/^description\s*:/, '').trim()
    if (/^[>|][+-]?$/.test(inline)) inline = '' // 块标量标记，真实内容在后续缩进行
    const parts = inline ? [stripQuotes(inline)] : []
    for (let index = descriptionIndex + 1; index < frontmatterLines.length; index += 1) {
      const line = frontmatterLines[index]
      // 空行或下一个顶格 key 即块结束
      if (!line || !line.trim() || !/^\s/.test(line)) break
      parts.push(line.trim())
    }
    description = parts.join(' ').replace(/\s+/g, ' ').trim()
  }
  return { name, description, body }
}

/**
 * 从 GitHub 拉取技能并解析为智能体定义：
 * - blob / raw 链接直接取 SKILL.md；tree 目录链接列目录找 SKILL.md（大小写敏感）；
 *   仓库根链接只认根下直接存在 SKILL.md 的单技能仓库，检测到 skills/ 目录时提示
 *   进入具体技能目录（不做递归猜测）
 * - token 用于访问私有仓库；错误统一抛中文信息
 */
export async function fetchSkillFromGithub(url: string, token?: string): Promise<GithubSkill> {
  const parsed = parseGithubSkillUrl(url)
  if (!parsed) {
    throw new Error('无法识别该链接：请粘贴 GitHub 技能目录（含 SKILL.md）或 SKILL.md 文件的链接')
  }
  const { owner, repo, branch, path, kind } = parsed

  let skillMdPath = ''
  if (kind === 'file') {
    skillMdPath = path
  } else if (kind === 'dir') {
    const entries = await listGithubDir(owner, repo, path, branch, token)
    if (!entries.some((entry) => entry.type === 'file' && entry.name === 'SKILL.md')) {
      throw new Error('该目录下未找到 SKILL.md：请确认链接指向技能目录（目录内需包含 SKILL.md）')
    }
    skillMdPath = `${path}/SKILL.md`
  } else {
    const entries = await listGithubDir(owner, repo, '', branch, token)
    if (entries.some((entry) => entry.type === 'file' && entry.name === 'SKILL.md')) {
      skillMdPath = 'SKILL.md'
    } else if (entries.some((entry) => entry.type === 'dir' && entry.name === 'skills')) {
      throw new Error('检测到该仓库的 skills/ 技能目录：请进入具体技能目录后复制链接，再粘贴安装')
    } else {
      throw new Error('暂不支持仓库根链接：请进入包含 SKILL.md 的技能目录后复制链接')
    }
  }

  const raw = await fetchSkillMdContent(owner, repo, skillMdPath, branch, token)
  // 技能目录名：SKILL.md 的上一级目录；仓库根时回退仓库名
  const pathSegments = skillMdPath.split('/')
  const skillDir = pathSegments.length >= 2 ? pathSegments[pathSegments.length - 2] : repo
  const { name, description, systemPrompt } = parseSkillMd(raw, skillDir)
  return { name, description, systemPrompt, skillDir, owner, repo }
}

/**
 * SKILL.md 文本 → 智能体定义（GitHub 链接与 ZIP 上传两条安装路径共享同一份解析）：
 * frontmatter 提取 name / description（描述回退文案、超长 60 字截断）、
 * 正文为空时报错、正文末尾统一追加中文回答约束。
 */
function parseSkillMd(
  text: string,
  fallbackName: string,
  fallbackDescription = '从 GitHub 安装的技能智能体',
): { name: string; description: string; systemPrompt: string } {
  const { name, description, body } = parseFrontmatter(text)
  if (!body) throw new Error('SKILL.md 没有正文内容')

  const displayDescription = description
    ? description.length > MAX_DESCRIPTION_LENGTH
      ? `${description.slice(0, MAX_DESCRIPTION_LENGTH)}…`
      : description
    : fallbackDescription

  // 正文末尾若无中文回答约束则统一追加
  const systemPrompt = /用中文回答/.test(body) ? body : `${body}\n\n除非用户另行要求，一律用中文回答。`
  return { name: name || fallbackName, description: displayDescription, systemPrompt }
}

/* ==========================================================================
   ZIP 技能包上传安装：本地解析技能目录压缩包（内含 SKILL.md），装成智能体；
   兼容 EvoFlow 合集包（manifest.json + skillsets/ 工作流 + skills/*.zip 内嵌技能）
   --------------------------------------------------------------------------
   - 不引入任何依赖，用浏览器原生能力手写 ZIP 解析：尾部回扫 EOCD → 遍历中央
     目录 → 按本地文件头切数据；deflate 用 DecompressionStream('deflate-raw')
     流式解压（Chromium 103+ 原生支持，无需 polyfill）
   - SKILL.md 解析与 GitHub 链接安装完全一致（同一 parseSkillMd）
   - 条目表 / 单条目解压抽成内部函数，外层与内层（合集包 skills/*.zip）共用
   ========================================================================== */

/** ZIP 文件大小上限（10MB），超限拒绝解析 */
const MAX_ZIP_BYTES = 10 * 1024 * 1024
/** EOCD（目录结束记录）签名，小端读出为 0x06054b50 */
const ZIP_EOCD_SIGNATURE = 0x06054b50
/** 中央目录文件头签名，小端读出为 0x02014b50 */
const ZIP_CENTRAL_SIGNATURE = 0x02014b50
/** 本地文件头签名，小端读出为 0x04034b50 */
const ZIP_LOCAL_SIGNATURE = 0x04034b50
/** 中央目录文件头的固定长度（46 字节） */
const ZIP_CENTRAL_HEADER_SIZE = 46
/** 本地文件头的固定长度（30 字节） */
const ZIP_LOCAL_HEADER_SIZE = 30

/** 中央目录中的单个条目（仅提取解析 SKILL.md 所需字段） */
interface ZipEntry {
  /** 完整路径名（目录项已过滤） */
  name: string
  /** 压缩方式：0 = store（原样存储），8 = deflate */
  method: number
  /** 压缩后字节数 */
  compressedSize: number
  /** 本地文件头在 ZIP 中的字节偏移 */
  localOffset: number
}

/** 压缩包文件名 → 安全的技能目录名（去 .zip 后缀，仅保留文字/数字/连字符/下划线） */
function sanitizeZipBaseName(fileName: string): string {
  const safe = fileName
    .replace(/\.zip$/i, '')
    .trim()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
  return safe || '未命名技能'
}

/** 单技能包导入结果（可直接作为自定义智能体入参） */
export interface ZipSkillImportResult {
  kind: 'skill'
  name: string
  description: string
  systemPrompt: string
  /** 技能目录名（SKILL.md 所在目录；根级时回退压缩包文件名） */
  skillDir: string
}

/** 合集包解出的单个技能（可直接作为自定义技能入参） */
export interface ZipExpertSkill {
  name: string
  description: string
  /** 技能模板（内层 SKILL.md 清洗后的正文） */
  template: string
  /** 技能标识（内层技能目录名 / slug，用于「zip:合集:技能」粒度查重） */
  skillKey: string
}

/** 合集包导入结果：1 个智能体（skillsets 工作流）+ N 个技能（包内 skills/*.zip） */
export interface ZipExpertImportResult {
  kind: 'expert'
  /** 工作流清洗后得到的智能体定义；skillDir = manifest.slug（查重键 zip:{skillDir}） */
  agent: { name: string; description: string; systemPrompt: string; skillDir: string }
  skills: ZipExpertSkill[]
}

/** ZIP 上传导入结果：单技能包 / 合集包，调用方按 kind 分流处理 */
export type ZipImportResult = ZipSkillImportResult | ZipExpertImportResult

/** 合集包 manifest.json 的可识别字段（拿不到或类型不符的字段按空串处理） */
interface ExpertPackageManifest {
  type?: unknown
  slug?: unknown
  displayName?: unknown
  summary?: unknown
}

/**
 * 从 ZIP 原始字节解析出中央目录条目表（外层技能包 / 合集包与内层 skills/*.zip
 * 共用同一份解析）：尾部回扫 EOCD → 遍历中央目录 → 过滤目录项与噪音条目；
 * 拒绝加密与 Zip64；错误统一抛中文信息。
 */
function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  // EOCD 固定 22 字节、尾部注释最长 65535 字节：从尾部向前扫描签名
  const eocdFloor = Math.max(0, bytes.length - 22 - 0xffff)
  let eocdOffset = -1
  for (let offset = bytes.length - 22; offset >= eocdFloor; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset === -1) {
    throw new Error('ZIP 文件无效或已损坏：未找到目录结束记录，请重新打包技能目录后重试')
  }
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralOffset = view.getUint32(eocdOffset + 16, true)
  if (entryCount === 0xffff || centralOffset === 0xffffffff) {
    throw new Error('暂不支持 Zip64 格式的 ZIP 文件，请用标准方式重新打包')
  }

  // 遍历中央目录条目（签名校验防越界错位）
  const entries: ZipEntry[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + ZIP_CENTRAL_HEADER_SIZE > bytes.length ||
      view.getUint32(cursor, true) !== ZIP_CENTRAL_SIGNATURE
    ) {
      throw new Error('ZIP 文件无效或已损坏：中央目录读取失败，请重新打包技能目录后重试')
    }
    const flags = view.getUint16(cursor + 8, true)
    if ((flags & 0x0001) !== 0) {
      throw new Error('不支持的加密 ZIP，请上传未加密的 ZIP 文件')
    }
    const method = view.getUint16(cursor + 10, true)
    const compressedSize = view.getUint32(cursor + 20, true)
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    // flag bit 11 置位时文件名为 UTF-8；未置位按单字节编码回退（ASCII 文件名两者一致）
    const name = new TextDecoder((flags & 0x0800) !== 0 ? 'utf-8' : 'iso-8859-1').decode(
      bytes.subarray(cursor + ZIP_CENTRAL_HEADER_SIZE, cursor + ZIP_CENTRAL_HEADER_SIZE + nameLength),
    )
    cursor += ZIP_CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength

    if (name.endsWith('/') || name === '__MACOSX' || name.startsWith('__MACOSX/')) continue // 目录项与 macOS 打包噪音
    if (name.split('/').some((segment) => segment.startsWith('.'))) continue // 隐藏文件（.DS_Store 等）
    entries.push({ name, method, compressedSize, localOffset })
  }
  return entries
}

/**
 * 解压单个条目：按本地文件头（30 字节 + 文件名 + 扩展字段）切出压缩数据，
 * deflate 用 DecompressionStream('deflate-raw') 流式解压，store 原样返回。
 */
async function readZipEntryBytes(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const localOffset = entry.localOffset
  if (
    localOffset + ZIP_LOCAL_HEADER_SIZE > bytes.length ||
    view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE
  ) {
    throw new Error('ZIP 文件无效或已损坏：本地文件头读取失败，请重新打包技能目录后重试')
  }
  const localNameLength = view.getUint16(localOffset + 26, true)
  const localExtraLength = view.getUint16(localOffset + 28, true)
  const dataStart = localOffset + ZIP_LOCAL_HEADER_SIZE + localNameLength + localExtraLength
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize)

  if (entry.method === 8) {
    // deflate：原生 DecompressionStream('deflate-raw') 流式解压
    const stream = new Blob([compressed])
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  }
  if (entry.method === 0) {
    // store：数据原样存储，直接使用
    return compressed
  }
  throw new Error('不支持的压缩方式（仅支持 store / deflate 的 ZIP）')
}

/** 定位 SKILL.md 条目：优先根级；否则取路径深度最浅的子目录内 SKILL.md */
function findSkillMdEntry(entries: ZipEntry[]): ZipEntry | undefined {
  const root = entries.find((entry) => entry.name === 'SKILL.md')
  if (root) return root
  return entries
    .filter((entry) => entry.name.endsWith('/SKILL.md'))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0]
}

/** manifest 字段读取：仅接受非空字符串，其余（缺失 / 类型不符）按空串处理 */
function manifestString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 读取根级 manifest.json 并解析；条目不存在或内容损坏（非法 JSON / 非对象）时
 * 返回 null，由调用方回落单技能路径；不向外抛错。
 */
async function readExpertManifest(
  bytes: Uint8Array,
  entries: ZipEntry[],
): Promise<ExpertPackageManifest | null> {
  const manifestEntry = entries.find((entry) => entry.name === 'manifest.json')
  if (!manifestEntry) return null
  try {
    const text = new TextDecoder('utf-8').decode(await readZipEntryBytes(bytes, manifestEntry))
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? (parsed as ExpertPackageManifest) : null
  } catch {
    // manifest 损坏时按不存在处理
    return null
  }
}

/**
 * 合集包工作流文档（skillsets/*.md）→ 智能体提示词的轻量清洗（纯正则）：
 * - 去 frontmatter（复用 parseFrontmatter 的正文提取）
 * - 「你已安装以下 Skill，请按步骤串联使用」安装说明 → 「按以下步骤依次推进」
 * - 删除单独成行的「使用 **技能名** 完成：」包装行（其后 bullets 保留）；
 *   与其他正文同行时仅删除该包装前缀
 * - 结尾不是完整中文句时追加中文回答约束
 */
function cleanSkillsetWorkflow(text: string): string {
  let cleaned = parseFrontmatter(text).body
  cleaned = cleaned.replace(
    /你已安装以下\s*(?:Skill|技能)\s*[，,]?\s*(?:请按步骤串联使用)?/g,
    '按以下步骤依次推进',
  )
  // 单独成行的包装词整行删除（其后 bullets 保留）
  cleaned = cleaned.replace(/^[ \t]*使用[ \t]*\*\*[^*]+\*\*[ \t]*(?:完成|来完成)?[：:]?[ \t]*$/gm, '')
  // 与其他正文同行的包装词只删前缀（含可选的「完成：」尾巴）
  cleaned = cleaned.replace(
    /(^|[-，。；：,;:>])[ \t]*使用[ \t]*\*\*[^*]+\*\*[ \t]*(?:完成|来完成)?[：:]?[ \t]*/gm,
    '$1',
  )
  // 删行后收拢连续空行，首尾去空白
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim()
  if (!/[。！？!?…”」)\]]\s*$/.test(cleaned)) {
    cleaned = `${cleaned}\n\n除非用户另行要求，一律用中文回答。`
  }
  return cleaned
}

/**
 * 解析合集包（EvoFlow skillhub-expert-package 格式）：
 * - 智能体：skillsets/ 下最浅的第一个 .md 清洗为提示词，名称 / 描述取自 manifest
 * - 技能：skills/*.zip 逐个解开内层 SKILL.md；单个失败（无 SKILL.md / 解压失败 /
 *   超限）跳过不中断，全部失败也不报错（skills 为空数组）
 */
async function parseExpertPackage(
  bytes: Uint8Array,
  entries: ZipEntry[],
  manifest: ExpertPackageManifest,
  fallbackSlug: string,
): Promise<ZipExpertImportResult> {
  const skillDir = manifestString(manifest.slug) || fallbackSlug
  const name = manifestString(manifest.displayName) || skillDir
  // summary 单行化后超长 60 字截断，缺失时用回退文案
  const summary = manifestString(manifest.summary).replace(/\s+/g, ' ')
  const description = summary
    ? summary.length > MAX_DESCRIPTION_LENGTH
      ? `${summary.slice(0, MAX_DESCRIPTION_LENGTH)}…`
      : summary
    : '从合集包导入的智能体'

  // 工作流文档：skillsets/ 下路径深度最浅的第一个 .md
  const workflowEntry = entries
    .filter((entry) => entry.name.startsWith('skillsets/') && entry.name.endsWith('.md'))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0]
  if (!workflowEntry) {
    throw new Error('合集包中未找到工作流文档：skillsets/ 目录应包含 .md 文件')
  }
  const workflowBytes = await readZipEntryBytes(bytes, workflowEntry)
  if (workflowBytes.byteLength > MAX_SKILL_MD_BYTES) {
    throw new Error('工作流文档过大（超过 100KB），暂不支持')
  }
  const systemPrompt = cleanSkillsetWorkflow(new TextDecoder('utf-8').decode(workflowBytes))

  const skills: ZipExpertSkill[] = []
  const innerZips = entries
    .filter((entry) => /^skills\/[^/]+\.zip$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of innerZips) {
    const zipBase = entry.name.replace(/^skills\//i, '').replace(/\.zip$/i, '')
    // 内层失败跳过，不影响其余技能与智能体导入
    const skill = await parseInnerSkillZip(bytes, entry, zipBase).catch(() => null)
    if (skill) skills.push(skill)
  }
  return { kind: 'expert', agent: { name, description, systemPrompt, skillDir }, skills }
}

/**
 * 解开内层技能 zip（合集包 skills/ 下的条目）为技能条目：
 * 找 SKILL.md（根级或最浅层）→ 与外层一致的 parseSkillMd；
 * skillKey = 内层 SKILL.md 所在目录名，根级时回退 zip 文件名（即技能 slug）。
 */
async function parseInnerSkillZip(
  outerBytes: Uint8Array,
  entry: ZipEntry,
  zipBase: string,
): Promise<ZipExpertSkill> {
  const innerBytes = await readZipEntryBytes(outerBytes, entry)
  const innerEntries = readZipEntries(innerBytes)
  const skillMd = findSkillMdEntry(innerEntries)
  if (!skillMd) throw new Error(`内层 ZIP（${zipBase}.zip）中未找到 SKILL.md，已跳过`)

  const plain = await readZipEntryBytes(innerBytes, skillMd)
  if (plain.byteLength > MAX_SKILL_MD_BYTES) {
    throw new Error(`内层 SKILL.md（${zipBase}）过大（超过 100KB），已跳过`)
  }
  const segments = skillMd.name.split('/')
  const innerDir = segments.length >= 2 ? segments[segments.length - 2] : ''
  const { name, description, systemPrompt } = parseSkillMd(
    new TextDecoder('utf-8').decode(plain),
    innerDir || zipBase,
    '从合集包导入的技能',
  )
  return { name, description, template: systemPrompt, skillKey: innerDir || zipBase }
}

/**
 * 解析 ZIP 上传文件为导入结果（判别联合，调用方按 kind 分流）：
 * 1. 尾部回扫 EOCD → 遍历中央目录 → 过滤噪音条目；拒绝加密与 Zip64
 * 2. 合集包检测：根级 manifest.json 有效且 type=skillhub-expert-package（或无
 *    type 但存在 skillsets/ 条目）→ 1 个智能体 + 包内全部技能；manifest 损坏回落单技能
 * 3. 单技能包：定位 SKILL.md（优先根级，否则最浅子目录）解压，UTF-8 解码后走与
 *    GitHub 安装一致的 parseSkillMd；错误统一抛中文信息
 */
export async function parseSkillZip(file: File): Promise<ZipImportResult> {
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > MAX_ZIP_BYTES) {
    throw new Error('ZIP 文件过大（超过 10MB），暂不支持')
  }
  const bytes = new Uint8Array(buffer)
  const entries = readZipEntries(bytes)

  // 合集包检测：manifest 类型匹配时走合集路径，否则回落单技能路径
  const manifest = await readExpertManifest(bytes, entries)
  const manifestType = manifestString(manifest?.type)
  if (
    manifest &&
    (manifestType === 'skillhub-expert-package' ||
      (manifestType === '' && entries.some((entry) => entry.name.startsWith('skillsets/'))))
  ) {
    return parseExpertPackage(bytes, entries, manifest, sanitizeZipBaseName(file.name))
  }

  // —— 单技能包路径（与合集包无关的普通技能目录压缩包）——
  const target = findSkillMdEntry(entries)
  if (!target) {
    throw new Error(
      'ZIP 中未找到 SKILL.md（技能包应包含 SKILL.md 文件；若是技能合集包，请确认包内含 manifest.json 与 skillsets/ 目录）',
    )
  }

  const plain = await readZipEntryBytes(bytes, target)
  if (plain.byteLength > MAX_SKILL_MD_BYTES) {
    throw new Error('SKILL.md 过大（超过 100KB），暂不支持')
  }

  // 技能目录名：SKILL.md 的上一级目录；根级时回退压缩包文件名（仅取安全字符）
  const segments = target.name.split('/')
  const skillDir = segments.length >= 2 ? segments[segments.length - 2] : sanitizeZipBaseName(file.name)
  const { name, description, systemPrompt } = parseSkillMd(
    new TextDecoder('utf-8').decode(plain),
    skillDir,
    '从 ZIP 导入的技能智能体',
  )
  return { kind: 'skill', name, description, systemPrompt, skillDir }
}

/* ==========================================================================
   技能包 ZIP 导入（SKILL.md + scripts/）：在单技能包解析基础上，
   额外解析 frontmatter 触发词并收集 scripts/ 目录脚本文件；
   旧格式（无 frontmatter triggers / 无 scripts）自然兼容：触发词回退技能名。
   ========================================================================== */

/** 单个脚本文件大小上限（200KB），超限跳过该脚本 */
const MAX_SCRIPT_BYTES = 200 * 1024
/** 单技能包脚本数量上限，超出截断 */
const MAX_SCRIPT_FILES = 20

/** 技能包 ZIP 导入结果（可直接作为技能中心自定义技能入参） */
export interface SkillPackageZipResult {
  name: string
  description: string
  triggers: string[]
  /** SKILL.md 正文指令（frontmatter 之后） */
  body: string
  /** 包内 scripts/ 目录脚本（SKILL.md 所在目录下的 scripts/；根级包为根 scripts/） */
  scripts: SkillScript[]
  /** 技能目录名（SKILL.md 所在目录；根级时回退压缩包文件名） */
  skillDir: string
}

/**
 * 解析技能包 ZIP（SKILL.md + 可选 scripts/ 目录）：
 * - SKILL.md 定位与单技能包一致（优先根级，否则最浅子目录），frontmatter 解析
 *   name/description/triggers（旧格式无 triggers 时回退技能名）；
 * - 收集 SKILL.md 同目录 scripts/ 下的文本文件为脚本清单，单个超限/超量跳过不报错。
 */
export async function parseSkillPackageZip(file: File): Promise<SkillPackageZipResult> {
  const buffer = await file.arrayBuffer()
  if (buffer.byteLength > MAX_ZIP_BYTES) {
    throw new Error('ZIP 文件过大（超过 10MB），暂不支持')
  }
  const bytes = new Uint8Array(buffer)
  const entries = readZipEntries(bytes)

  const target = findSkillMdEntry(entries)
  if (!target) {
    throw new Error('ZIP 中未找到 SKILL.md（技能包应包含 SKILL.md 文件）')
  }
  const plain = await readZipEntryBytes(bytes, target)
  if (plain.byteLength > MAX_SKILL_MD_BYTES) {
    throw new Error('SKILL.md 过大（超过 100KB），暂不支持')
  }

  // SKILL.md 在根级时脚本前缀为 scripts/；在子目录时为 <目录>/scripts/
  const segments = target.name.split('/')
  const baseDir = segments.length >= 2 ? segments.slice(0, -1).join('/') : ''
  const skillDir = baseDir || sanitizeZipBaseName(file.name)
  const parsed = parseSkillPackageMarkdown(new TextDecoder('utf-8').decode(plain), skillDir)

  // 收集脚本：SKILL.md 同目录的 scripts/ 前缀，子目录脚本保留相对路径
  const scriptPrefix = baseDir ? `${baseDir}/scripts/` : 'scripts/'
  const scripts: SkillScript[] = []
  for (const entry of entries) {
    if (!entry.name.startsWith(scriptPrefix)) continue
    const filename = entry.name.slice(scriptPrefix.length)
    // 仅收 scripts/ 下的平铺文件（子目录脚本保留相对路径，跳过空名）
    if (!filename || filename.endsWith('/')) continue
    if (scripts.length >= MAX_SCRIPT_FILES) break
    const scriptBytes = await readZipEntryBytes(bytes, entry).catch(() => null)
    if (!scriptBytes || scriptBytes.byteLength > MAX_SCRIPT_BYTES) continue
    scripts.push({ filename, content: new TextDecoder('utf-8').decode(scriptBytes) })
  }

  return {
    name: parsed.name,
    description: parsed.description,
    triggers: parsed.triggers,
    body: parsed.body,
    scripts,
    skillDir,
  }
}
