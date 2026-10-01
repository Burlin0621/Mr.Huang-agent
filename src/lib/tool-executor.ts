/**
 * 渲染进程统一工具执行入口：
 * - executeToolWithPrefs 供 ChatView 与群聊编排器共用（runAgentLoop 的 executeTool 回调）；
 * - 禁用偏好持久化在 localStorage（mr-huang-agent:tool-prefs），每次调用实时读取——
 *   设置页切换后立即生效，无需跨视图同步；
 * - 禁用/无桥接/失败均以文本结果返回（不抛错），由模型自行决策，符合 runAgentLoop 容错语义；
 * - 主进程注册表（electron/tools.cjs）不感知禁用状态：拦截发生在渲染层；
 * - 调用桥接时自动携带 context（当前激活模型配置的 { apiKey, baseUrl }），供 web_search
 *   等需要密钥的工具使用；无 Pinia 环境或无激活配置时 context 为空对象。
 */

import { AGENT_TOOLS, type AgentToolSchema } from '@/lib/agent-tools'
import { hasMcpBridge } from '@/lib/desktop-bridge'
import { buildActivatedSkillBlock } from '@/lib/skill-package'
import { fetchSkillFromGithub, getGithubToken } from '@/lib/skillhub'
import { storageGet, storageSet } from '@/lib/storage'
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
} from '@/stores/permission'

/** 工具禁用偏好在 localStorage 中的持久化 key（存被禁用的工具名数组） */
const TOOL_PREFS_STORAGE_KEY = 'mr-huang-agent:tool-prefs'

/** shell_exec 快捷确认开关的持久化 key（存 '0'/'1'；缺省视为开启） */
export const SHELL_QUICK_APPROVE_STORAGE_KEY = 'mr-huang-agent:shell-quick-approve'

/**
 * 写类工具名单：修改外部状态、需要按权限模式管控的工具。
 * - plan 模式：渲染层直接拦截（不发 IPC）；
 * - auto-edit / full 模式：主进程按名单决定是否跳过原生确认框。
 */
const WRITE_TOOLS: readonly string[] = [
  'vault_write',
  'http_post_json',
  'fs_write',
  'fs_edit',
  'shell_exec',
  'memory_write',
  'memory_append',
  'git_commit',
]

/** 某工具是否属于写类工具（供执行拦截与 UI 提示复用） */
export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.includes(name)
}

/** 防御式解析权限模式字符串；非法值回退默认档（可单测的纯函数） */
export function parsePermissionMode(value: unknown): PermissionMode {
  return value === 'plan' || value === 'confirm' || value === 'auto-edit' || value === 'full'
    ? value
    : DEFAULT_PERMISSION_MODE
}

/** 读取 shell_exec 快捷确认开关（默认开；关闭后所有 shell_exec 都弹确认框） */
export function loadShellQuickApprove(): boolean {
  try {
    return storageGet(SHELL_QUICK_APPROVE_STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

/** 持久化 shell_exec 快捷确认开关（失败时静默降级，仅当前会话生效） */
export function saveShellQuickApprove(enabled: boolean): void {
  try {
    storageSet(SHELL_QUICK_APPROVE_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // 忽略持久化失败
  }
}

/** 读取被禁用的工具名列表；localStorage 不可用或数据损坏时回退空数组 */
export function loadDisabledTools(): string[] {
  try {
    const raw = storageGet(TOOL_PREFS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** 持久化被禁用的工具名列表（失败时静默降级，仅当前会话生效） */
export function saveDisabledTools(disabled: string[]): void {
  try {
    storageSet(TOOL_PREFS_STORAGE_KEY, JSON.stringify([...new Set(disabled)]))
  } catch {
    // localStorage 不可用时静默降级
  }
}

/** 某工具是否被禁用（每次实时读 localStorage，设置页切换后立即生效） */
export function isToolDisabled(name: string): boolean {
  return loadDisabledTools().includes(name)
}

/** 是否具备工具执行环境（桌面端且 preload 已暴露 callTool） */
export function hasToolExecutor(): boolean {
  return typeof window.mrHuangDesktop?.callTool === 'function'
}

/**
 * 当前激活会话 id（由视图层在切换/创建对话时经 setActiveToolConversationId 设置）：
 * 随工具 context 透传给主进程，供 fs_write / fs_edit 执行前把检查点快照归属到对应会话
 * （userData/checkpoints/<conversationId>/）。模块级变量，无 Pinia 依赖。
 */
let activeToolConversationId = ''

/** 视图层设置当前激活会话 id（切换对话 / 新建对话后调用；空串表示草稿态） */
export function setActiveToolConversationId(id: string): void {
  activeToolConversationId = typeof id === 'string' ? id : ''
}

/* —— use_skill（纯信息性工具，渲染端拦截直答；主进程仅注册占位 schema） —— */

/** 会话 id → 已激活技能 id 集合（use_skill 调用后记录，视图层取走即清空该会话的增量） */
const activatedSkillIdsByConversation = new Map<string, Set<string>>()

/** 记录一次技能激活（供 ChatView 在发送前后合并进会话元数据，保持后续对话持续注入） */
export function recordSkillActivation(conversationId: string, skillId: string): void {
  if (!conversationId || !skillId) return
  const set = activatedSkillIdsByConversation.get(conversationId) ?? new Set<string>()
  set.add(skillId)
  activatedSkillIdsByConversation.set(conversationId, set)
}

/**
 * 取走指定会话通过 use_skill 新激活的技能 id（取后清空该会话记录）；
 * 视图层在每轮请求后调用一次，把结果合并进会话元数据持久化。
 */
export function consumeActivatedSkillIds(conversationId: string): string[] {
  const set = activatedSkillIdsByConversation.get(conversationId)
  if (!set || set.size === 0) return []
  activatedSkillIdsByConversation.delete(conversationId)
  return [...set]
}

/** 清空指定会话（或全部，入参缺省）的激活记录（切换对话 / 删除会话时调用，防串扰） */
export function clearActivatedSkillIds(conversationId?: string): void {
  if (conversationId) activatedSkillIdsByConversation.delete(conversationId)
  else activatedSkillIdsByConversation.clear()
}

/**
 * use_skill 渲染端直答：解析参数 → 在技能中心启用清单中按 id / 名称匹配 →
 * 返回技能正文 + 脚本清单（含 fs_write 落盘 + shell_exec 执行约定），
 * 并把激活记入当前会话，保证后续对话持续注入。
 */
async function executeUseSkill(argsJson: string): Promise<string> {
  let skillId = ''
  try {
    const args: unknown = JSON.parse(argsJson || '{}')
    if (args && typeof args === 'object' && typeof (args as Record<string, unknown>).skill_id === 'string') {
      skillId = ((args as Record<string, unknown>).skill_id as string).trim()
    }
  } catch {
    // 参数非合法 JSON：按空处理，走下方未找到提示
  }
  if (!skillId) return 'use_skill 调用失败：缺少 skill_id 参数（传「可用技能」清单中的技能名称或 id）'
  try {
    const { useSkillsStore } = await import('@/stores/skills')
    const store = useSkillsStore()
    const target = store.enabledSkills.find(
      (skill) => skill.id === skillId || skill.name === skillId,
    )
    if (!target) {
      const available = store.enabledSkills.map((skill) => skill.name).join('、') || '（无）'
      return `未找到技能「${skillId}」。当前可用技能：${available}。请核对名称后重试。`
    }
    recordSkillActivation(activeToolConversationId, target.id)
    return buildActivatedSkillBlock(target)
  } catch {
    return 'use_skill 调用失败：技能清单不可用（无 Pinia 环境或数据异常）'
  }
}

/* —— skill_install（渲染端拦截直答：拉取 GitHub 技能并写入技能中心 store） —— */

/** `owner/repo` 仓库简写的形态（两段、允许字母数字与 ._- ） */
const GITHUB_SHORTHAND_RE = /^[\w.-]+\/[\w.-]+$/

/**
 * 解析 skill_install 参数中的 source（+ 可选 skillDir）为可交给 fetchSkillFromGithub
 * 的 GitHub 链接：仓库简写拼成 github.com 根/目录链接；完整 URL 原样透传
 * （仓库根形态且给了 skillDir 时补成 tree 目录链接）；其余形态返回 null。
 */
function resolveSkillInstallUrl(source: string, skillDir: string): string | null {
  const trimmedSource = source.trim()
  if (!trimmedSource) return null
  if (GITHUB_SHORTHAND_RE.test(trimmedSource)) {
    return skillDir
      ? `https://github.com/${trimmedSource}/tree/main/${skillDir}`
      : `https://github.com/${trimmedSource}`
  }
  if (/^https?:\/\//i.test(trimmedSource)) {
    if (!skillDir) return trimmedSource
    // 已带 tree/blob 路径或 raw 链接的 URL 直接使用 skillDir 无意义，原样透传；
    // 仅仓库根形态（无第三段路径）补成默认分支下的技能目录链接
    try {
      const url = new URL(trimmedSource)
      const segments = url.pathname.split('/').filter(Boolean)
      if (
        (url.hostname === 'github.com' || url.hostname === 'www.github.com') &&
        segments.length <= 2
      ) {
        const repo = segments[1] ?? ''
        return `https://github.com/${segments[0] ?? ''}/${repo}/tree/main/${skillDir}`
      }
    } catch {
      // URL 解析失败时按原样透传，交由 fetchSkillFromGithub 报中文错误
    }
    return trimmedSource
  }
  return null
}

/**
 * skill_install 渲染端直答：解析参数 → 拉取 GitHub SKILL.md → 查重 →
 * 按技能市场同一数据结构写入技能中心（自定义技能，skillhubId = gh:owner/repo/dir），
 * 返回技能名 / 描述 / 调用键。失败（网络 / 无 SKILL.md / 重复 / 纯浏览器）均返回
 * 模型可读的中文文本，不抛错。
 */
async function executeSkillInstall(argsJson: string): Promise<string> {
  let source = ''
  let skillDir = ''
  let notes = ''
  try {
    const args: unknown = JSON.parse(argsJson || '{}')
    if (args && typeof args === 'object') {
      const record = args as Record<string, unknown>
      if (typeof record.source === 'string') source = record.source.trim()
      if (typeof record.skillDir === 'string') skillDir = record.skillDir.trim().replace(/^\/+|\/+$/g, '')
      if (typeof record.notes === 'string') notes = record.notes.trim()
    }
  } catch {
    // 参数非合法 JSON：按空处理，走下方缺参提示
  }
  if (!source) return 'skill_install 调用失败：缺少 source 参数（传 GitHub 仓库简写 owner/repo 或技能目录 / SKILL.md 的完整链接）'
  if (!hasToolExecutor()) {
    return 'skill_install 调用失败：工具执行环境不可用（技能安装需要桌面端应用，纯浏览器环境暂不支持）'
  }
  const skillUrl = resolveSkillInstallUrl(source, skillDir)
  if (!skillUrl) {
    return `skill_install 调用失败：无法识别 source「${source}」。请传 GitHub 仓库简写（owner/repo）或 github.com / raw.githubusercontent.com 的技能目录 / SKILL.md 链接`
  }
  let installed: Awaited<ReturnType<typeof fetchSkillFromGithub>>
  try {
    installed = await fetchSkillFromGithub(skillUrl, getGithubToken() || undefined)
  } catch (error) {
    return `skill_install 安装失败：${error instanceof Error ? error.message : '网络请求异常，请稍后重试'}`
  }
  try {
    const { useSkillsStore } = await import('@/stores/skills')
    const skillsStore = useSkillsStore()
    const skillhubId = `gh:${installed.owner}/${installed.repo}/${installed.skillDir}`
    if (skillsStore.isSkillImported(skillhubId)) {
      return `该技能已安装，无需重复安装：「${installed.name}」（来源 ${installed.owner}/${installed.repo}，调用键可用技能名或 id）。`
    }
    const template = notes
      ? `${installed.systemPrompt}\n\n> 安装备注：${notes}`
      : installed.systemPrompt
    skillsStore.addCustomSkill({
      name: installed.name,
      description: installed.description,
      template,
      icon: '🧩',
      tags: ['技能市场'],
      triggers: [installed.name],
      skillhubId,
      source: 'import',
    })
    return [
      `已安装技能「${installed.name}」到技能中心（立即可见，来源 ${installed.owner}/${installed.repo}）。`,
      `描述：${installed.description}`,
      `调用键：技能名「${installed.name}」（可通过 use_skill 以技能名或 id 加载完整指令）。`,
      notes ? `安装备注：${notes}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  } catch {
    return 'skill_install 调用失败：技能中心不可用（无 Pinia 环境或数据异常）'
  }
}


/**
 * 组装透传给主进程的 context：当前激活模型配置的 { apiKey, baseUrl } +
 * 当前工作区关联文件夹（vaultRoot，供 vault_* 工具注入根目录，未关联时为 ''）。
 * store 依赖 Pinia（动态 import 延迟获取并用 try/catch 包住），无 Pinia 环境返回空对象。
 */
async function buildToolContext(): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {}
  // 当前激活会话 id：供主进程 fs_write/fs_edit 执行前把检查点归属到该会话（无会话时主进程跳过快照）
  context.conversationId = activeToolConversationId
  // shell_exec 快捷确认开关（默认开；主进程据此决定同命令同目录是否跳过确认框）
  context.shellQuickApprove = loadShellQuickApprove()
  try {
    const { usePermissionStore } = await import('@/stores/permission')
    context.permissionMode = usePermissionStore().mode
  } catch {
    // 无 Pinia 环境时降级为默认档（与主进程缺省行为一致）
    context.permissionMode = DEFAULT_PERMISSION_MODE
  }
  try {
    const { useLlmStore } = await import('@/stores/llm')
    const active = useLlmStore().activeConfig
    if (active) {
      context.apiKey = active.apiKey ?? ''
      context.baseUrl = active.baseUrl ?? ''
    }
  } catch {
    // 无 Pinia 环境（如纯函数单测）时静默降级
  }
  try {
    const { useWorkspacesStore } = await import('@/stores/workspaces')
    const workspaceStore = useWorkspacesStore()
    context.vaultRoot = workspaceStore.activeWorkspace?.folderPath ?? ''
    // 当前工作区 id（供 memory_* 工具定位 userData/memory/<workspaceId>.md）
    context.workspaceId = workspaceStore.activeWorkspaceId
  } catch {
    // 无 Pinia 环境时同样降级（vault 工具将以「未关联文件夹」报错，
    // memory 工具将以「无法获取当前工作区」报错）
  }
  return context
}

/**
 * 统一执行工具：禁用拦截 → 桥接调用。永不抛错，结果以文本返回
 * （作为 role:'tool' 消息回传给模型，与 runAgentLoop 的容错语义一致）。
 */
export async function executeToolWithPrefs(name: string, argsJson: string): Promise<string> {
  // use_skill：纯信息性工具，渲染端直接返回技能正文（不落权限/禁用拦截，不发 IPC）
  if (name === 'use_skill') {
    return executeUseSkill(argsJson)
  }
  // skill_install：渲染端直答（GitHub 拉取 + 写入技能中心 store，不发 IPC；
  // 纯浏览器环境在 handler 内返回友好降级提示）
  if (name === 'skill_install') {
    return executeSkillInstall(argsJson)
  }
  if (isToolDisabled(name)) {
    return `工具已被禁用：${name}。可在「设置 → 工具中心」重新启用。`
  }
  // 计划模式：写类工具在渲染层直接拦截，不发 IPC（主进程另有兜底）
  let permissionMode: PermissionMode = DEFAULT_PERMISSION_MODE
  try {
    const { usePermissionStore } = await import('@/stores/permission')
    permissionMode = parsePermissionMode(usePermissionStore().mode)
  } catch {
    // 无 Pinia 环境时按默认档处理
  }
  if (permissionMode === 'plan' && isWriteTool(name)) {
    return `当前为计划模式，已禁止写入操作（${name}）。请先输出调研结论与执行计划，待用户确认后再切换权限模式执行。`
  }
  const result = await window.mrHuangDesktop?.callTool?.(name, argsJson, await buildToolContext())
  if (!result) return '工具执行环境不可用（工具调用需要桌面端应用）'
  if (!result.ok) {
    return `工具调用失败${result.canceled ? '（用户拒绝）' : ''}：${result.error ?? '未知错误'}`
  }
  return result.result ?? ''
}

/* —— MCP 动态工具（运行时注册，schema 从主进程 listMcpTools 动态拉取） —— */

/** MCP 动态清单缓存有效期（毫秒）：过期后下次发送前重新拉取 */
const MCP_CACHE_TTL_MS = 5 * 60 * 1000

interface McpCache {
  /** 合格工具名 → schema（MCP inputSchema 已转为简化 JSON Schema） */
  schemas: Map<string, AgentToolSchema>
  fetchedAt: number
}

let mcpCache: McpCache | null = null
let mcpFetchInFlight: Promise<McpCache | null> | null = null

/**
 * 把 MCP 的 inputSchema 转为简化 JSON Schema：
 * 保留 type/properties/required，properties 项保留 type/description，
 * type 仅保留 string/number/boolean（其余一律映射为 string）。
 * 纯函数，便于直接单测。
 */
export function convertMcpInputSchema(schema: unknown): AgentToolSchema['parameters'] {
  const record: Record<string, unknown> =
    schema && typeof schema === 'object' && !Array.isArray(schema) ? (schema as Record<string, unknown>) : {}
  const rawProperties =
    record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : {}
  const properties: AgentToolSchema['parameters']['properties'] = {}
  for (const [key, spec] of Object.entries(rawProperties)) {
    const item = spec && typeof spec === 'object' && !Array.isArray(spec) ? (spec as Record<string, unknown>) : {}
    const type = typeof item.type === 'string' ? item.type : 'string'
    properties[key] = {
      type: type === 'number' || type === 'boolean' ? type : 'string',
      description: typeof item.description === 'string' ? item.description : '',
    }
  }
  const required = Array.isArray(record.required)
    ? (record.required as unknown[]).filter((item): item is string => typeof item === 'string')
    : []
  return { type: 'object', properties, required }
}

/** MCP 工具条目 → function calling schema（description 补 MCP:server 前缀便于模型区分来源） */
function toAgentToolSchema(entry: {
  name: string
  description: string
  server: string
  inputSchema?: unknown
  requiresConfirm?: boolean
}): AgentToolSchema {
  const base = entry.description
    ? `[MCP:${entry.server}] ${entry.description}`
    : `[MCP:${entry.server}] ${entry.name}`
  return {
    name: entry.name,
    description: entry.requiresConfirm ? `${base}（执行前需确认）` : base,
    parameters: convertMcpInputSchema(entry.inputSchema),
  }
}

/** 拉取并缓存 MCP 动态工具清单；无桥接/失败时清空缓存（不抛错，不阻塞对话） */
async function fetchMcpSchemas(): Promise<McpCache | null> {
  if (!hasMcpBridge()) return null
  try {
    const result = await window.mrHuangDesktop!.listMcpTools!()
    const schemas = new Map<string, AgentToolSchema>()
    for (const entry of result?.tools ?? []) {
      if (typeof entry.name !== 'string' || !entry.name.startsWith('mcp__')) continue
      schemas.set(entry.name, toAgentToolSchema(entry))
    }
    mcpCache = { schemas, fetchedAt: Date.now() }
    return mcpCache
  } catch {
    // 主进程错误（如桥接异常）时清空缓存，动态兜底退化为不可用
    mcpCache = null
    return null
  }
}

/**
 * 刷新 MCP 动态工具 schema 清单（带 5 分钟 TTL 缓存；force=true 强制重拉）。
 * 在会话发送前调用一次；纯浏览器/失败时返回空数组。
 */
export async function refreshMcpToolSchemas(force = false): Promise<AgentToolSchema[]> {
  if (!hasMcpBridge()) return []
  const fresh = mcpCache !== null && Date.now() - mcpCache.fetchedAt < MCP_CACHE_TTL_MS
  if (!fresh || force) {
    // 并发去重：同窗口多次调用共享一次拉取
    mcpFetchInFlight = mcpFetchInFlight ?? fetchMcpSchemas()
    try {
      await mcpFetchInFlight
    } finally {
      mcpFetchInFlight = null
    }
  }
  return [...(mcpCache?.schemas.values() ?? [])]
}

/**
 * 为存在 MCP 工具时构造 system 提示词附加块：
 * 告知模型动态工具的来源与调用约定（工具名以 mcp__ 开头，参数按 schema 传入）。
 * 清单为空时返回 null（不注入）。
 */
export function buildMcpSystemHint(schemas: AgentToolSchema[]): string | null {
  if (schemas.length === 0) return null
  const lines = schemas.map((tool) => `- ${tool.name}：${tool.description}`)
  return [
    '<可用 MCP 工具>',
    '除内置工具外，还可以调用以下通过 MCP 接入的外部工具（请谨慎使用）：',
    ...lines,
    '调用时按各自的参数 schema 传入 JSON 参数；工具不可用时其错误信息会作为结果回传。',
    '</可用 MCP 工具>',
  ].join('\n')
}

/**
 * 某智能体声明的工具名中实际可用的 schema 列表（过滤未注册名称；供 llm tools 参数）：
 * 静态注册表查不到时（mcp__ 前缀动态工具）回退 MCP 动态缓存（需先 refreshMcpToolSchemas）。
 */
export function resolveToolSchemas(names: string[]): Array<{
  name: string
  description: string
  parameters: Record<string, unknown>
}> {
  return names
    .map((name) => {
      const staticTool = AGENT_TOOLS.find((tool) => tool.name === name)
      if (staticTool) return staticTool
      return mcpCache?.schemas.get(name)
    })
    .filter((tool): tool is AgentToolSchema => tool !== undefined)
}
