/**
 * 长会话上下文压缩的纯函数集合（零依赖，可在 Node 中直接单测）：
 * - needsCompaction：历史消息条数是否超过阈值（需要压缩）
 * - splitForCompaction：切分为「待摘要前段」+「保持原文的最近段」
 * - buildSummaryPrompt：让模型总结旧消息的单条 user 提示词
 * - buildCompactedSystemBlock：注入 system 的历史摘要文本块
 * - mergeCompactedMessages：摘要 + 最近消息 → 实际发送的 messages 数组
 *
 * 摘要本身作为会话字段持久化在 conversations store（summary.upToIndex 记录
 * 摘要覆盖到 messages 的第几条，按「前缀条数」语义：messages[0, upToIndex) 已被摘要）。
 */

/** 历史消息条数超过该值时触发压缩 */
export const COMPACTION_THRESHOLD = 24

/** 压缩后保持原文的最近消息条数 */
export const KEEP_RECENT = 8

/** 摘要正文的字符数上限（超出截断） */
export const SUMMARY_MAX_CHARS = 2000

/** 参与压缩的最小消息结构（与持久化消息及 LLM 消息的公共子集兼容） */
export interface CompactableMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
}

/** 会话摘要（随对话持久化；upToIndex 为摘要覆盖的前缀条数） */
export interface ConversationSummary {
  content: string
  upToIndex: number
  createdAt: number
}

/** 历史消息条数是否需要压缩（恰好等于阈值不触发，超出才触发） */
export function needsCompaction(messageCount: number): boolean {
  return Number.isFinite(messageCount) && messageCount > COMPACTION_THRESHOLD
}

/**
 * 把消息列表切分为前段（待摘要）与最近段（保持原文）。
 * 总数不超过 KEEP_RECENT 时不切分（oldMessages 为空，recentMessages 即原列表）。
 */
export function splitForCompaction<T>(messages: readonly T[]): {
  oldMessages: T[]
  recentMessages: T[]
} {
  if (!Array.isArray(messages) || messages.length <= KEEP_RECENT) {
    return { oldMessages: [], recentMessages: [...(messages ?? [])] }
  }
  const splitIndex = messages.length - KEEP_RECENT
  return {
    oldMessages: messages.slice(0, splitIndex),
    recentMessages: messages.slice(splitIndex),
  }
}

/** 单条消息的对话文本行（「用户：/助手：」前缀，空内容跳过） */
function formatMessageLine(message: CompactableMessage): string {
  const speaker = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : message.role
  return `${speaker}：${message.content.trim()}`
}

/**
 * 组装让模型总结旧消息的单条 user 提示词。
 * 内容为空时返回空串（调用方应视为不可摘要，直接降级）。
 */
export function buildSummaryPrompt(oldMessages: readonly CompactableMessage[]): string {
  const lines = (oldMessages ?? [])
    .filter((message) => message && typeof message.content === 'string' && message.content.trim())
    .map(formatMessageLine)
  if (lines.length === 0) return ''
  return [
    '请把以下对话历史浓缩成一份要点摘要，用于替代原始历史注入后续对话。摘要需保留：',
    '1. 用户的核心诉求与约束条件；',
    '2. 已做过的关键操作与得出的结论；',
    '3. 出现过的重要数据、文件路径、命令等具体信息；',
    '4. 尚未完成的事项。',
    `要求：条目化输出，总字数不超过 ${SUMMARY_MAX_CHARS} 字，直接输出摘要正文，不要任何开场白或解释。`,
    '',
    '【对话历史开始】',
    ...lines,
    '【对话历史结束】',
  ].join('\n')
}

/** 注入 system 的历史摘要文本块 */
export function buildCompactedSystemBlock(summary: string): string {
  const trimmed = summary.trim()
  if (!trimmed) return ''
  return `【历史摘要】以下是本次对话更早部分的要点摘要（原始消息已省略以控制上下文长度）：\n${trimmed}`
}

/** 截断摘要正文到上限 */
export function truncateSummary(summary: string): string {
  return summary.trim().slice(0, SUMMARY_MAX_CHARS)
}

/**
 * 组装实际发送给 LLM 的 messages：
 * - baseSystemContent 为业务 system 消息内容（可为 null/空）；
 * - 摘要统一注入 system（与 OpenAI 兼容请求最稳妥，不会破坏 user/assistant 交替结构）：
 *   有 system 时把摘要块追加到其后，无 system 时单发一条 system 消息；
 * - recentMessages 原样保留在 system 之后。
 */
export function mergeCompactedMessages(
  summary: string,
  recentMessages: readonly CompactableMessage[],
  baseSystemContent?: string | null,
): CompactableMessage[] {
  const block = buildCompactedSystemBlock(summary)
  const messages: CompactableMessage[] = []
  if (!block) {
    // 无有效摘要时退化为：system（若有）+ 最近消息
    if (baseSystemContent && baseSystemContent.trim()) {
      messages.push({ role: 'system', content: baseSystemContent })
    }
    messages.push(...recentMessages)
    return messages
  }
  const systemContent =
    baseSystemContent && baseSystemContent.trim()
      ? `${baseSystemContent.trim()}\n\n${block}`
      : block
  messages.push({ role: 'system', content: systemContent })
  messages.push(...recentMessages)
  return messages
}

/**
 * 判断已有摘要是否仍覆盖当前历史前段（可复用缓存摘要）：
 * 摘要覆盖 [0, upToIndex)，其后剩余未覆盖的消息条数不超过 KEEP_RECENT 时仍有效。
 */
export function isSummaryUsable(summary: unknown, messageCount: number): summary is ConversationSummary {
  if (typeof summary !== 'object' || summary === null) return false
  const record = summary as Record<string, unknown>
  if (typeof record.content !== 'string' || !record.content.trim()) return false
  if (typeof record.upToIndex !== 'number' || !Number.isInteger(record.upToIndex)) return false
  if (record.upToIndex <= 0 || record.upToIndex > messageCount) return false
  return messageCount - record.upToIndex <= KEEP_RECENT
}
