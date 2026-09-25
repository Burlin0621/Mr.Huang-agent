/**
 * 对话组装与导出的纯函数集合（零依赖，可在 Node 中直接单测）：
 * - buildSystemMessage：智能体提示词 + 任务目标 → system 消息内容
 * - composeUserContent：附件内容拼进当轮 user 消息
 * - buildConversationMarkdown / buildConversationPlainText：导出与复制
 */

export interface ComposeAttachment {
  name: string
  content: string
  /** 内容是否因超过大小上限被截断 */
  truncated: boolean
}

/** 单个文本附件的读取上限（字节），超出截断并标注 */
export const ATTACHMENT_MAX_BYTES = 100 * 1024

/**
 * 组装 system 消息内容：[智能体 systemPrompt] + 换行 + [「任务目标：」+ 目标]。
 * 两者皆空时返回 null（不注入 system 消息）。
 */
export function buildSystemMessage(agentSystemPrompt: string, goal: string): string | null {
  const parts: string[] = []
  const prompt = agentSystemPrompt.trim()
  const target = goal.trim()
  if (prompt) parts.push(prompt)
  if (target) parts.push(`任务目标：${target}`)
  return parts.length > 0 ? parts.join('\n') : null
}

/**
 * 把附件内容拼接进当轮 user 消息：正文在前，每个附件一个
 * 「【附件：filename】\n<内容>」块，块间空一行；截断的附件在块尾标注。
 */
export function composeUserContent(text: string, attachments: ComposeAttachment[]): string {
  if (attachments.length === 0) return text
  const blocks = attachments.map((file) => {
    const note = file.truncated ? '\n（注：文件超过 100KB，内容已截断）' : ''
    return `【附件：${file.name}】\n${file.content}${note}`
  })
  return [text.trim(), ...blocks]
    .filter((part) => part.trim().length > 0)
    .join('\n\n')
}

/* —— 导出 / 复制 —— */

export interface ExportMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

/** 格式化为「YYYY-MM-DD HH:mm:ss」（本地时区，手动补零避免环境差异） */
export function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 生成可下载的 Markdown 文档（含模型名 / 导出时间 / 全部消息） */
export function buildConversationMarkdown(options: {
  modelName: string
  messages: ExportMessage[]
  exportedAt?: Date
}): string {
  const exportedAt = options.exportedAt ?? new Date()
  const lines: string[] = ['# Mr.Huang Agent 对话记录', '']
  lines.push(`- 模型：${options.modelName.trim() || '未设置'}`)
  lines.push(`- 导出时间：${formatDateTime(exportedAt)}`)
  lines.push(`- 消息条数：${options.messages.length}`, '')

  if (options.messages.length === 0) {
    lines.push('（暂无消息）')
    return `${lines.join('\n')}\n`
  }

  lines.push('---', '')
  for (const message of options.messages) {
    const heading =
      message.role === 'user' ? '🙋 用户' : message.role === 'assistant' ? '🤖 助手' : '⚙️ 系统'
    lines.push(`## ${heading}`, '', message.content, '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** 生成复制到剪贴板的纯文本（你：/ 助手： 交替） */
export function buildConversationPlainText(messages: ExportMessage[]): string {
  return messages
    .map((message) => `${message.role === 'user' ? '你' : '助手'}：\n${message.content}`)
    .join('\n\n')
}
