import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import type { ToolStepRecord } from '@/lib/group-chat'
import {
  clampStepResultChars,
  clampTaskMaxRounds,
  normalizeTaskRun,
  type TaskRun,
} from '@/lib/task-runner'
import { storageGet, storageRemove, storageSet } from '@/lib/storage'

/** 工具执行记录类型与群聊 transcript 共用（定义见 src/lib/group-chat.ts） */
export type { ToolStepRecord }

/** 持久化的消息终态（'streaming' 为运行时暂态，持久化/读取时归一化为 'aborted'） */
export type StoredMessageStatus = 'done' | 'aborted' | 'error'

/** 随消息持久化的图片附件（data URL 随会话存文件存储；旧数据缺失时归一化为 []） */
export interface ChatImageAttachment {
  name: string
  dataUrl: string
  dimensions: string
}

/** 随用户消息持久化的引用回复（引用历史某条消息；text 为截断前的原文，上限 500 字符） */
export interface MessageQuote {
  author: string
  text: string
}

/** 持久化的单条消息（不持久化 streaming 状态，读取时归一化） */
export interface StoredChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: StoredMessageStatus
  /** status 为 error 时的用户可读错误信息 */
  errorText: string
  /** 工具执行步骤（旧数据缺失时归一化为 []） */
  toolSteps: ToolStepRecord[]
  /** 图片附件（含 data URL；随消息持久化，旧数据缺失时归一化为 []） */
  images?: ChatImageAttachment[]
  /** 引用回复（仅 user 消息携带；旧数据无该字段，防御式归一化） */
  quote?: MessageQuote
}

/** 运行时消息：流式期间 status 为 'streaming'，终止后与 StoredChatMessage 同构 */
export interface ChatMessage extends Omit<StoredChatMessage, 'status'> {
  status: StoredMessageStatus | 'streaming'
  /** 仅展示层的发送时间（hover 显示）；旧数据 / 持久化消息无此字段 */
  createdAt?: number
}

/** 会话摘要（长会话压缩；upToIndex 为摘要覆盖的前缀消息条数，缺省/非法时视为无摘要） */
export interface StoredConversationSummary {
  content: string
  upToIndex: number
  createdAt: number
}

/** 会话工作区中的一条对话 */
export interface Conversation {
  id: string
  /** 显示标题；由首条用户消息自动截取，可手动重命名 */
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  /** 所属工作区 id（'' 为旧版数据，读取后由工作区 store 迁移归入默认工作区） */
  workspaceId: string
  /** 随对话保存的上下文：任务目标、智能体、模型选择（切换对话时恢复） */
  goal: string
  agentId: string
  /** 对应 llm store 的 config.id，'' 表示未指定 */
  modelConfigId: string
  /** 具体模型 id，'' 表示用主模型 */
  modelId: string
  /** 对话中通过 @ 选用、随每轮注入 system 的技能 id 列表（切换对话时恢复） */
  skillIds: string[]
  /** 已激活技能 id 列表（触发词命中 / use_skill 激活，正文随每轮注入 system；旧数据无该字段） */
  activatedSkillIds: string[]
  messages: ChatMessage[]
  /** 长会话压缩摘要（可选；旧数据无该字段，防御式归一化） */
  summary?: StoredConversationSummary
  /** 执行任务（计划闭环；旧数据无该字段，防御式归一化；刷新后 running 归一化为 interrupted） */
  taskRun?: TaskRun
  /** 本会话执行任务的每步最大回合数（旧数据无该字段时回退全局默认） */
  taskMaxRounds?: number
  /** 本会话执行任务的单步结果摘要字符数上限（旧数据无该字段时回退全局默认） */
  taskResultMaxChars?: number
}

/** 对话上下文字段（创建/更新时可部分携带；创建时 workspaceId 由调用方传入） */
export type ConversationContextInput = Partial<
  Pick<
    Conversation,
    'workspaceId' | 'goal' | 'agentId' | 'modelConfigId' | 'modelId' | 'skillIds' | 'activatedSkillIds'
  >
>

const CONVERSATIONS_STORAGE_KEY = 'mr-huang-agent:conversations'
/** 旧版「全局最近对话」key（迁移到工作区 lastConversationId 后不再写入，读取后清理） */
const LEGACY_ACTIVE_STORAGE_KEY = 'mr-huang-agent:active-conversation'

/** 持久化防抖（流式期间 token 级更新会频繁触发 deep watch） */
const PERSIST_DEBOUNCE_MS = 500

const TERMINAL_STATUSES: readonly StoredMessageStatus[] = ['done', 'aborted', 'error']

/** 防御性归一化工具步骤列表：非法条目丢弃，缺失时为空数组 */
function normalizeToolSteps(value: unknown): ToolStepRecord[] {
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
        typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0
          ? Math.round(record.durationMs)
          : 0,
      ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
    })
  }
  return steps
}

/** 引用文本持久化上限：超出截断（与视图层 QUOTE_TEXT_LIMIT 保持一致） */
const QUOTE_TEXT_LIMIT = 500

/** 防御性归一化引用回复：author/text 缺失时返回 undefined（视为无引用） */
function normalizeQuote(value: unknown): MessageQuote | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const author = typeof record.author === 'string' ? record.author.trim() : ''
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (!author || !text) return undefined
  return { author, text: text.length > QUOTE_TEXT_LIMIT ? text.slice(0, QUOTE_TEXT_LIMIT) : text }
}

/** 防御性归一化单条消息：字段非法返回 null；'streaming' 残留与非法 status 归一化为 'aborted' */
function normalizeMessage(value: unknown): ChatMessage | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id : ''
  const role = record.role === 'user' || record.role === 'assistant' ? record.role : null
  if (!id || !role) return null
  const status =
    typeof record.status === 'string' &&
    (TERMINAL_STATUSES as readonly string[]).includes(record.status)
      ? (record.status as StoredMessageStatus)
      : 'aborted'
  return {
    id,
    role,
    content: typeof record.content === 'string' ? record.content : '',
    reasoning: typeof record.reasoning === 'string' ? record.reasoning : '',
    status,
    errorText: typeof record.errorText === 'string' ? record.errorText : '',
    toolSteps: normalizeToolSteps(record.toolSteps),
    ...(normalizeImages(record.images) ? { images: normalizeImages(record.images) } : {}),
    ...(normalizeQuote(record.quote) ? { quote: normalizeQuote(record.quote) } : {}),
  }
}

/** 防御性归一化图片附件列表：非法条目丢弃，缺失时为空数组（返回 [] 表示无附件） */
function normalizeImages(value: unknown): ChatImageAttachment[] {
  if (!Array.isArray(value)) return []
  const images: ChatImageAttachment[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : ''
    if (!dataUrl.startsWith('data:')) continue
    images.push({
      name: typeof record.name === 'string' ? record.name : '图片',
      dataUrl,
      dimensions: typeof record.dimensions === 'string' ? record.dimensions : '',
    })
  }
  return images
}

/** 时间戳非法（缺失/非有限数）时回退当前时间 */
function normalizeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Date.now()
}

/** 防御性归一化会话摘要：字段非法或缺内容时返回 undefined（视为无摘要） */
function normalizeSummary(value: unknown): StoredConversationSummary | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  const upToIndex = record.upToIndex
  if (!content || typeof upToIndex !== 'number' || !Number.isInteger(upToIndex) || upToIndex <= 0) {
    return undefined
  }
  return { content, upToIndex, createdAt: normalizeTimestamp(record.createdAt) }
}

/** 防御性归一化单条对话：缺 id（核心标识）时丢弃，其余字段逐项兜底 */
function normalizeConversation(value: unknown): Conversation | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  if (!id) return null
  return {
    id,
    title:
      typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '未命名对话',
    createdAt: normalizeTimestamp(record.createdAt),
    updatedAt: normalizeTimestamp(record.updatedAt),
    archived: record.archived === true,
    workspaceId: typeof record.workspaceId === 'string' ? record.workspaceId : '',
    goal: typeof record.goal === 'string' ? record.goal : '',
    agentId: typeof record.agentId === 'string' ? record.agentId : '',
    modelConfigId: typeof record.modelConfigId === 'string' ? record.modelConfigId : '',
    modelId: typeof record.modelId === 'string' ? record.modelId : '',
    // 旧版数据无该字段时兜底为空数组；混入非字符串项时逐项过滤
    skillIds: Array.isArray(record.skillIds)
      ? record.skillIds.filter((id): id is string => typeof id === 'string')
      : [],
    // 旧数据无该字段时兜底为空数组
    activatedSkillIds: Array.isArray(record.activatedSkillIds)
      ? record.activatedSkillIds.filter((id): id is string => typeof id === 'string')
      : [],
    messages: Array.isArray(record.messages)
      ? record.messages
          .map(normalizeMessage)
          .filter((message): message is ChatMessage => message !== null)
      : [],
    ...(normalizeSummary(record.summary) ? { summary: normalizeSummary(record.summary) } : {}),
    ...(() => {
      const taskRun = normalizeTaskRun(record.taskRun)
      return taskRun ? { taskRun } : {}
    })(),
    ...(record.taskMaxRounds !== undefined ? { taskMaxRounds: clampTaskMaxRounds(record.taskMaxRounds) } : {}),
    ...(record.taskResultMaxChars !== undefined
      ? { taskResultMaxChars: clampStepResultChars(record.taskResultMaxChars) }
      : {}),
  }
}

/** 读取持久化的对话列表；localStorage 不可用或数据损坏时回退空数组 */
export function loadConversations(): Conversation[] {
  try {
    const raw = storageGet(CONVERSATIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeConversation)
      .filter((conversation): conversation is Conversation => conversation !== null)
  } catch {
    // 数据损坏（非法 JSON 等）时回退空列表
    return []
  }
}

/**
 * 读取旧版「全局最近对话」id 并清理该 key（供工作区 store 初始化迁移用，只调用一次）。
 * 最近对话记录此后统一存放在 Workspace.lastConversationId。
 */
export function readLegacyActiveConversationId(): string {
  try {
    const value = storageGet(LEGACY_ACTIVE_STORAGE_KEY) ?? ''
    if (value) storageRemove(LEGACY_ACTIVE_STORAGE_KEY)
    return value
  } catch {
    return ''
  }
}

function persistTo(key: string, value: string): void {
  try {
    storageSet(key, value)
  } catch {
    // localStorage 不可用（配额满等）时静默降级，仅当前会话生效
  }
}

/** 序列化前的归一化：'streaming' 残留（防抖窗口内刷新等）→ 'aborted' */
function toPersisted(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      status: message.status === 'streaming' ? 'aborted' : message.status,
    })),
  }
}

/** 列表用的短格式时间：今天 HH:mm；今年 MM-DD HH:mm；更早 YYYY-MM-DD */
export function formatSessionTime(timestamp: number, now: Date = new Date()): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  if (isSameDay) return hm
  if (date.getFullYear() === now.getFullYear()) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`
  }
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export const useConversationsStore = defineStore('conversations', () => {
  /** 全部对话（持久化到 localStorage；按 workspaceId 归属各工作区） */
  const conversations = ref<Conversation[]>(loadConversations())

  /** 按 updatedAt 倒序的完整列表（按工作区过滤由调用方做） */
  const sortedConversations = computed(() =>
    [...conversations.value].sort((a, b) => b.updatedAt - a.updatedAt),
  )

  // 对话数据 deep watch + 500ms 防抖后写入 localStorage（失败时静默降级）
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    conversations,
    () => {
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        persistTimer = null
        persistTo(CONVERSATIONS_STORAGE_KEY, JSON.stringify(conversations.value.map(toPersisted)))
      }, PERSIST_DEBOUNCE_MS)
    },
    { deep: true },
  )

  function findConversation(id: string): Conversation | null {
    return conversations.value.find((conversation) => conversation.id === id) ?? null
  }

  /** 新建空对话（归入调用方指定的 workspaceId），返回新 id */
  function createConversation(input?: ConversationContextInput): string {
    const id = crypto.randomUUID()
    const now = Date.now()
    conversations.value.push({
      id,
      title: '新对话',
      createdAt: now,
      updatedAt: now,
      archived: false,
      workspaceId: input?.workspaceId ?? '',
      goal: input?.goal ?? '',
      agentId: input?.agentId ?? '',
      modelConfigId: input?.modelConfigId ?? '',
      modelId: input?.modelId ?? '',
      // 拷贝数组，避免调用方后续原地修改时串改对话内的引用
      skillIds: input?.skillIds ? [...input.skillIds] : [],
      activatedSkillIds: input?.activatedSkillIds ? [...input.activatedSkillIds] : [],
      messages: [],
    })
    return id
  }

  /** 更新对话的 updatedAt（列表按其倒序） */
  function touch(id: string): void {
    const conversation = findConversation(id)
    if (conversation) conversation.updatedAt = Date.now()
  }

  /** 重命名（空标题忽略） */
  function renameConversation(id: string, title: string): void {
    const conversation = findConversation(id)
    const trimmed = title.trim()
    if (conversation && trimmed) conversation.title = trimmed
  }

  function archiveConversation(id: string): void {
    const conversation = findConversation(id)
    if (conversation) conversation.archived = true
  }

  function unarchiveConversation(id: string): void {
    const conversation = findConversation(id)
    if (conversation) conversation.archived = false
  }

  /** 删除对话 */
  function removeConversation(id: string): void {
    const index = conversations.value.findIndex((conversation) => conversation.id === id)
    if (index >= 0) conversations.value.splice(index, 1)
  }

  /** 删除某工作区下的全部对话（含归档；供工作区 store 删除工作区时连带清理），返回删除条数 */
  function removeConversationsInWorkspace(workspaceId: string): number {
    const remaining: Conversation[] = []
    let removed = 0
    for (const conversation of conversations.value) {
      if (conversation.workspaceId === workspaceId) {
        removed += 1
      } else {
        remaining.push(conversation)
      }
    }
    if (removed > 0) conversations.value = remaining
    return removed
  }

  /** 清空消息但保留对话（摘要随消息一并失效） */
  function clearConversationMessages(id: string): void {
    const conversation = findConversation(id)
    if (!conversation) return
    conversation.messages = []
    conversation.summary = undefined
    conversation.taskRun = undefined
    conversation.updatedAt = Date.now()
  }

  /** 追加一条消息并 touch；返回 store 内的响应式消息对象（供流式回写） */
  function appendMessage(conversationId: string, message: ChatMessage): ChatMessage | null {
    const conversation = findConversation(conversationId)
    if (!conversation) return null
    conversation.messages.push(message)
    conversation.updatedAt = Date.now()
    return conversation.messages[conversation.messages.length - 1]
  }

  /** 更新对话携带的上下文（目标/智能体/配置/模型/@ 选用技能） */
  function updateConversationContext(id: string, input: ConversationContextInput): void {
    const conversation = findConversation(id)
    if (!conversation) return
    if (input.goal !== undefined) conversation.goal = input.goal
    if (input.agentId !== undefined) conversation.agentId = input.agentId
    if (input.modelConfigId !== undefined) conversation.modelConfigId = input.modelConfigId
    if (input.modelId !== undefined) conversation.modelId = input.modelId
    // 拷贝数组，避免视图层的响应式数组与持久化数据共享同一引用
    if (input.skillIds !== undefined) conversation.skillIds = [...input.skillIds]
    if (input.activatedSkillIds !== undefined) conversation.activatedSkillIds = [...input.activatedSkillIds]
  }

  return {
    conversations,
    sortedConversations,
    findConversation,
    createConversation,
    touch,
    renameConversation,
    archiveConversation,
    unarchiveConversation,
    removeConversation,
    removeConversationsInWorkspace,
    clearConversationMessages,
    appendMessage,
    updateConversationContext,
  }
})
