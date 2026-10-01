/**
 * 多智能体群聊（V1）的数据类型与防御性归一化
 *
 * - 群聊会话与普通对话并列持久化（独立 storage key，见 stores/group-chats.ts）；
 * - 编排策略：固定轮询（成员按加入顺序轮流发言）+ 主持人收敛判断 + 最多 5 轮硬性熔断；
 * - 本模块保持零依赖（不 import 其他 src 模块），便于直接单测。
 */

/** 群聊会话状态：讨论中 / 已交付 */
export type GroupChatStatus = 'discussing' | 'delivered'

/** 用户插话在 transcript 中的发送者占位 id（成员发言用智能体 id，用户固定用该哨兵值） */
export const USER_SENDER_ID = '__user__'

/** 用户插话里的 @ 引用（成员或技能） */
export interface TranscriptMention {
  kind: 'member' | 'skill'
  /** 成员/技能的 id（成员被删除时运行时忽略并按原顺序轮询） */
  id: string
  /** 选择时的展示名（回放高亮用，不依赖实时查询） */
  name: string
}

/** 成员发言过程中的单次工具执行记录（与 stores/conversations.ts 的消息 toolSteps 结构对齐；
 * 定义在本纯数据模块，conversations.ts 引用同一类型保持两处 UI 结构一致） */
export interface ToolStepRecord {
  toolName: string
  /** 模型给出的原始参数 JSON 文本 */
  argsText: string
  /** 工具输出文本（已截断） */
  resultText: string
  /** 执行耗时（毫秒） */
  durationMs: number
  /** 执行失败时的错误说明 */
  error?: string
}

/** 群聊记录中的一条发言（成员发言或用户插话） */
export interface TranscriptEntry {
  /** 发言成员的智能体 id；用户插话固定为 USER_SENDER_ID */
  agentId: string
  /** 发言内容（流式期间由编排器增量回写） */
  content: string
  /** 所属轮次（从 1 开始） */
  round: number
  /** 发言时间戳（毫秒） */
  ts: number
  /** 本次发言调用失败的中文提示（失败成员发言为空时展示；正常发言无此字段） */
  errorText?: string
  /** 成员发言过程中的工具执行记录（function calling；纯文本发言/旧数据缺省为 []） */
  toolSteps?: ToolStepRecord[]
  /**
   * 发言来源：'agent'（成员发言，旧数据缺省按此处理）| 'user'（用户插话）。
   * 用户插话不进入成员轮询，仅作为上下文与 @ 指令载体。
   */
  role?: 'agent' | 'user'
  /** 用户插话携带的 @ 引用列表（成员/技能），成员发言无此字段 */
  mentions?: TranscriptMention[]
}

/** 群聊会话（持久化结构） */
export interface GroupChat {
  id: string
  /** 显示标题：由任务自动截取 */
  title: string
  createdAt: number
  updatedAt: number
  /** 群成员的智能体 id 列表（按加入顺序，即发言顺序） */
  members: string[]
  /** 用户下发的任务 */
  task: string
  /** 群聊记录（发言按时间顺序追加） */
  transcript: TranscriptEntry[]
  status: GroupChatStatus
  /** 主持人最终汇总的交付文本（status 为 delivered 时非空） */
  deliverable: string
  /** 硬性熔断轮数上限（V1 固定 5） */
  maxRounds: number
  /** 成员级模型绑定：agentId → llm 配置 id（''/缺失 = 回退当时激活配置；旧数据无此字段按 {} 处理） */
  memberConfigIds: Record<string, string>
  /** 主持人模型配置 id（'' = 回退当时激活配置） */
  moderatorConfigId: string
}

/** 硬性熔断：最多讨论轮数 */
export const GROUP_CHAT_MAX_ROUNDS = 5

/** 由任务文本生成群聊标题（与对话标题风格一致） */
export function makeGroupChatTitle(task: string): string {
  const trimmed = task.trim().replace(/\s+/g, ' ')
  if (!trimmed) return '未命名群聊'
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed
}

/** 归一化 @ 引用列表：仅保留合法条目（旧数据缺失时为 undefined） */
export function normalizeMentions(value: unknown): TranscriptMention[] | undefined {
  if (!Array.isArray(value)) return undefined
  const mentions: TranscriptMention[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const kind = record.kind === 'member' || record.kind === 'skill' ? record.kind : null
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    if (kind && id && name) mentions.push({ kind, id, name })
  }
  return mentions
}

/** 归一化工具执行记录列表：非法条目丢弃，缺失时为空数组 */
export function normalizeToolSteps(value: unknown): ToolStepRecord[] {
  if (!Array.isArray(value)) return []
  const steps: ToolStepRecord[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const toolName = typeof record.toolName === 'string' ? record.toolName : ''
    if (!toolName) continue
    steps.push({
      toolName,
      argsText: typeof record.argsText === 'string' ? record.argsText : '',
      resultText: typeof record.resultText === 'string' ? record.resultText : '',
      durationMs:
        typeof record.durationMs === 'number' &&
        Number.isFinite(record.durationMs) &&
        record.durationMs >= 0
          ? Math.round(record.durationMs)
          : 0,
      ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
    })
  }
  return steps
}

/** 防御性归一化单条发言：缺 agentId 或非对象时丢弃，content 兜底为空串 */
export function normalizeTranscriptEntry(value: unknown): TranscriptEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const agentId = typeof record.agentId === 'string' ? record.agentId : ''
  if (!agentId) return null
  const role = record.role === 'user' ? 'user' : 'agent'
  return {
    agentId,
    content: typeof record.content === 'string' ? record.content : '',
    round:
      typeof record.round === 'number' && Number.isFinite(record.round) && record.round > 0
        ? Math.trunc(record.round)
        : 1,
    ts:
      typeof record.ts === 'number' && Number.isFinite(record.ts) && record.ts > 0
        ? record.ts
        : Date.now(),
    ...(typeof record.errorText === 'string' && record.errorText
      ? { errorText: record.errorText }
      : {}),
    role,
    // 工具执行记录：成员发言可能携带，用户插话/旧数据缺省为 []
    ...(role === 'agent' ? { toolSteps: normalizeToolSteps(record.toolSteps) } : {}),
    ...(role === 'user' ? { mentions: normalizeMentions(record.mentions) ?? [] } : {}),
  }
}

/** 归一化 agentId → 配置 id 映射：仅保留字符串键值对（旧数据缺失时为空表） */
export function normalizeConfigIdMap(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.trim() && key.trim()) {
      result[key.trim()] = entry.trim()
    }
  }
  return result
}

/** 时间戳非法（缺失/非有限数）时回退当前时间 */
function normalizeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Date.now()
}

/** 防御性归一化单条群聊：缺 id（核心标识）或 members/task 均缺失时丢弃，其余字段逐项兜底 */
export function normalizeGroupChat(value: unknown): GroupChat | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) return null
  const members = Array.isArray(record.members)
    ? record.members.filter((member): member is string => typeof member === 'string')
    : []
  const task = typeof record.task === 'string' ? record.task : ''
  if (members.length === 0 && !task) return null
  return {
    id,
    title:
      typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '未命名群聊',
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
    members,
    task,
    transcript: Array.isArray(record.transcript)
      ? record.transcript
          .map(normalizeTranscriptEntry)
          .filter((entry): entry is TranscriptEntry => entry !== null)
      : [],
    status: record.status === 'delivered' ? 'delivered' : 'discussing',
    deliverable: typeof record.deliverable === 'string' ? record.deliverable : '',
    maxRounds:
      typeof record.maxRounds === 'number' &&
      Number.isFinite(record.maxRounds) &&
      record.maxRounds > 0
        ? Math.trunc(record.maxRounds)
        : GROUP_CHAT_MAX_ROUNDS,
    // 旧数据无模型绑定字段时兜底为空表 / 空串（运行时回退当时激活配置）
    memberConfigIds: normalizeConfigIdMap(record.memberConfigIds),
    moderatorConfigId:
      typeof record.moderatorConfigId === 'string' ? record.moderatorConfigId.trim() : '',
  }
}
