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

/** 图片附件单张上限（字节）：超过直接拒绝，避免请求体过大 */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

/** 图片附件（已读为 base64 data URL，随当轮请求直传视觉模型，不持久化） */
export interface ImageAttachment {
  name: string
  /** 形如 data:image/png;base64,... */
  dataUrl: string
  /** 图片尺寸提示文本，如 1920×1080（读取失败时为空串） */
  dimensions: string
}

/** OpenAI 视觉格式的 user 消息 content 分片 */
export interface MultipartContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

/** 校验图片大小：超限返回中文提示，合法返回 null */
export function validateImageSize(bytes: number): string | null {
  if (!Number.isFinite(bytes) || bytes < 0) return '图片大小读取失败，已跳过该附件'
  if (bytes > IMAGE_MAX_BYTES) {
    return `图片超过 5MB 上限（${formatSizeCN(bytes)}），已拒绝：建议压缩后再试`
  }
  return null
}

/** 字节数格式化为中文可读文本（KB / MB） */
function formatSizeCN(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * 组装当轮 user 消息的 multipart 内容（OpenAI 视觉格式，纯函数可单测）：
 * - 无图片附件时保持纯字符串路径（与 composeUserContent 一致）；
 * - 有图片时 content 为数组：text 分片（正文 + 文本附件）在前，每个图片一个
 *   image_url 分片（base64 data URL 直传）。
 */
export function composeUserMultipartContent(
  text: string,
  textAttachments: ComposeAttachment[],
  images: ImageAttachment[],
): string | MultipartContentPart[] {
  const textContent = composeUserContent(text, textAttachments)
  if (images.length === 0) return textContent
  const parts: MultipartContentPart[] = []
  if (textContent.trim()) parts.push({ type: 'text', text: textContent })
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  return parts
}

/** 工作区记忆注入 system 的字符上限，超长截断并提示改用 memory_read */
export const MEMORY_INJECT_MAX_CHARS = 4000

/**
 * 构造工作区记忆的 system 附加块（纯函数，可单测）：
 * - 记忆为空时仅返回维护指引（便于冷启动沉淀）；
 * - 非空时返回「【工作区记忆】…」块，超过 4000 字符截断并附提示。
 */
export function buildMemorySystemBlock(memory: string): string {
  const guideline =
    '维护指引：当用户表达持久性偏好/事实，或任务结束得出可复用经验时，' +
    '用 memory_append 沉淀到工作区记忆；避免记录一次性信息与敏感密钥。'
  const content = (memory ?? '').trim()
  if (!content) return guideline
  let body = content
  let note = ''
  if (body.length > MEMORY_INJECT_MAX_CHARS) {
    body = body.slice(0, MEMORY_INJECT_MAX_CHARS)
    note = '\n（记忆过长已截断，可调用 memory_read 读取全文）'
  }
  return `【工作区记忆】以下是本工作区的长期记忆，供回答时参考：\n${body}${note}\n${guideline}`
}

/**
 * 组装 system 消息内容：[智能体 systemPrompt] + 换行 + [「任务目标：」+ 目标]。
 * 两者皆空时返回 null（不注入 system 消息）。
 * permissionMode 为可选参数（向后兼容）：'plan' 时在末尾追加计划模式约束说明。
 * workspaceMemory 为可选参数（向后兼容）：传入时在末尾追加工作区记忆块
 * （buildMemorySystemBlock 构造，含维护指引），不传时不追加。
 */
export function buildSystemMessage(
  agentSystemPrompt: string,
  goal: string,
  permissionMode?: 'plan' | 'confirm' | 'auto-edit' | 'full',
  workspaceMemory?: string | null,
): string | null {
  const parts: string[] = []
  const prompt = agentSystemPrompt.trim()
  const target = goal.trim()
  if (prompt) parts.push(prompt)
  if (target) parts.push(`任务目标：${target}`)
  if (permissionMode === 'plan') {
    parts.push(
      '【计划模式】你当前处于计划模式：只做调研与方案设计，不要执行任何写入或提交类工具' +
        '（如 vault_write、http_post_json，这些调用会被直接拒绝）。' +
        '请基于已有信息产出一份清晰的执行计划，等待用户确认后再由用户切换权限模式执行。' +
        '最终方案必须放在以「## 执行计划」标题开头的章节中，并用 markdown 有序列表（1. 2. 3. …）' +
        '逐条列出可执行的步骤，便于用户批准后由执行子智能体逐步完成。' +
        '步骤默认按顺序串行执行；若某步骤与其他步骤无依赖、可并行执行，在该步骤行末尾追加「[并行]」标记' +
        '（如「3. 整理资料 [并行]」）。若某步骤需要绑定特定模型执行，可在行末尾追加「@模型名」标注' +
        '（如「2. 生成报告 @glm-4-plus」，写模型 id 或配置名称均可）；未标注的步骤使用当前会话模型。',
    )
  }
  if (workspaceMemory != null) {
    parts.push(buildMemorySystemBlock(workspaceMemory))
  }
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
  /** 本条消息（助手发言）过程中的工具调用记录；旧数据/用户消息缺省为空 */
  toolSteps?: ExportToolStep[]
}

/** 导出用工具调用记录（与 ToolStepRecord 结构对齐，避免导出模块反向依赖 UI 类型） */
export interface ExportToolStep {
  toolName: string
  argsText: string
  resultText: string
  durationMs: number
  error?: string
}

/** 导出用任务执行卡片（与 TaskRun 结构对齐的字段子集） */
export interface ExportTask {
  title: string
  goal: string
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'
  parallelEnabled: boolean
  errorText?: string
  steps: Array<{
    content: string
    status: 'pending' | 'running' | 'done' | 'failed'
    result: string
    error?: string
    parallel?: boolean
  }>
}

/** 任务整体状态的中文标签 */
function taskStatusLabel(status: ExportTask['status']): string {
  const map: Record<ExportTask['status'], string> = {
    running: '执行中',
    completed: '已完成',
    failed: '失败',
    stopped: '已停止',
    interrupted: '已中断',
  }
  return map[status] ?? status
}

/** 步骤状态的中文标签（含统一符号，Markdown/HTML 共用） */
export function taskStepStatusLabel(status: ExportTask['steps'][number]['status']): string {
  const map: Record<ExportTask['steps'][number]['status'], string> = {
    pending: '待执行',
    running: '执行中',
    done: '已完成',
    failed: '失败',
  }
  return map[status] ?? status
}

/** 把多行文本压成单行并截断（工具记录的参数/结果摘要用） */
function summarizeOneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars)}…（已截断）`
}

/** 单条工具调用记录的 Markdown 行（工具名 + 耗时 + 参数摘要 + 结果摘要） */
function toolStepMarkdownLine(step: ExportToolStep): string {
  const duration = step.durationMs > 0 ? `（${(step.durationMs / 1000).toFixed(1)}s）` : ''
  const head = `- \`${step.toolName}\`${duration}`
  const args = step.argsText.trim() ? `参数：${summarizeOneLine(step.argsText, 200)}` : ''
  const outcome = step.error
    ? `失败：${summarizeOneLine(step.error, 200)}`
    : step.resultText.trim()
      ? `结果：${summarizeOneLine(step.resultText, 200)}`
      : ''
  return [head, args, outcome].filter(Boolean).join('，')
}

/** 格式化为「YYYY-MM-DD HH:mm:ss」（本地时区，手动补零避免环境差异） */
export function formatDateTime(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/** 生成可下载的 Markdown 文档（含模型名 / 导出时间 / 任务卡片 / 全部消息与工具调用记录） */
export function buildConversationMarkdown(options: {
  modelName: string
  messages: ExportMessage[]
  exportedAt?: Date
  task?: ExportTask | null
}): string {
  const exportedAt = options.exportedAt ?? new Date()
  const lines: string[] = ['# Mr.Huang Agent 对话记录', '']
  lines.push(`- 模型：${options.modelName.trim() || '未设置'}`)
  lines.push(`- 导出时间：${formatDateTime(exportedAt)}`)
  lines.push(`- 消息条数：${options.messages.length}`, '')

  // 任务执行卡片：计划步骤与状态（无任务时省略）
  const task = options.task
  if (task && task.steps.length > 0) {
    lines.push('---', '', '## 任务执行卡片', '')
    lines.push(`- 任务：${task.title || task.goal || '（未命名任务）'}`)
    lines.push(`- 状态：${taskStatusLabel(task.status)}`)
    lines.push(`- 并行执行：${task.parallelEnabled ? '开' : '关'}`, '')
    task.steps.forEach((step, index) => {
      const note = step.parallel ? '（[并行]）' : ''
      lines.push(`${index + 1}. 【${taskStepStatusLabel(step.status)}】${step.content}${note}`)
      if (step.error) lines.push(`   - 失败原因：${summarizeOneLine(step.error, 300)}`)
      else if (step.result.trim()) lines.push(`   - 结果摘要：${summarizeOneLine(step.result, 300)}`)
    })
    if (task.errorText) lines.push('', `> 任务错误：${summarizeOneLine(task.errorText, 300)}`)
    lines.push('')
  }

  if (options.messages.length === 0) {
    lines.push('（暂无消息）')
    return `${lines.join('\n')}\n`
  }

  lines.push('---', '')
  for (const message of options.messages) {
    const heading =
      message.role === 'user' ? '🙋 用户' : message.role === 'assistant' ? '🤖 助手' : '⚙️ 系统'
    lines.push(`## ${heading}`, '', message.content, '')
    if (message.toolSteps && message.toolSteps.length > 0) {
      lines.push('**工具调用记录**', '')
      for (const step of message.toolSteps) {
        lines.push(toolStepMarkdownLine(step))
      }
      lines.push('')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** HTML 转义（正文 / 属性通用） */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 生成独立 HTML 导出文档（与 Markdown 导出同构：模型名 / 导出时间 / 任务卡片 /
 * 全部消息与工具调用记录），版式沿用应用内的卡片式浅色风格（内联 CSS，双击即可在浏览器打开）。
 */
export function buildConversationHtml(options: {
  modelName: string
  messages: ExportMessage[]
  exportedAt?: Date
  task?: ExportTask | null
}): string {
  const exportedAt = options.exportedAt ?? new Date()
  const task = options.task
  const parts: string[] = []

  if (task && task.steps.length > 0) {
    const stepItems = task.steps
      .map((step) => {
        const extra = step.error
          ? `<div class="step-extra is-error">失败原因：${escapeHtml(summarizeOneLine(step.error, 300))}</div>`
          : step.result.trim()
            ? `<div class="step-extra">结果摘要：${escapeHtml(summarizeOneLine(step.result, 300))}</div>`
            : ''
        const note = step.parallel ? '<span class="step-parallel">并行</span>' : ''
        return `<li class="step is-${escapeHtml(step.status)}"><span class="step-status">${taskStepStatusLabel(step.status)}</span> ${escapeHtml(step.content)}${note}${extra}</li>`
      })
      .join('\n')
    parts.push(
      `<section class="task-card"><h2>任务执行卡片</h2>` +
        `<p class="task-meta">任务：${escapeHtml(task.title || task.goal || '（未命名任务）')} · 状态：${taskStatusLabel(task.status)} · 并行执行：${task.parallelEnabled ? '开' : '关'}</p>` +
        (task.errorText
          ? `<p class="task-error">任务错误：${escapeHtml(summarizeOneLine(task.errorText, 300))}</p>`
          : '') +
        `<ol class="task-steps">${stepItems}</ol></section>`,
    )
  }

  for (const message of options.messages) {
    const roleLabel = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统'
    const toolBlock =
      message.toolSteps && message.toolSteps.length > 0
        ? `<div class="tool-records"><p class="tool-records-title">工具调用记录</p><ul>${message.toolSteps
            .map((step) => {
              const duration = step.durationMs > 0 ? `（${(step.durationMs / 1000).toFixed(1)}s）` : ''
              const args = step.argsText.trim()
                ? `<span class="tool-line">参数：${escapeHtml(summarizeOneLine(step.argsText, 200))}</span>`
                : ''
              const outcome = step.error
                ? `<span class="tool-line is-error">失败：${escapeHtml(summarizeOneLine(step.error, 200))}</span>`
                : step.resultText.trim()
                  ? `<span class="tool-line">结果：${escapeHtml(summarizeOneLine(step.resultText, 200))}</span>`
                  : ''
              return `<li><code>${escapeHtml(step.toolName)}</code>${duration}${args}${outcome}</li>`
            })
            .join('')}</ul></div>`
        : ''
    parts.push(
      `<article class="msg msg-${escapeHtml(message.role)}"><p class="msg-role">${roleLabel}</p>` +
        `<div class="msg-content">${escapeHtml(message.content).replace(/\n/g, '<br>')}</div>${toolBlock}</article>`,
    )
  }

  const body = parts.length > 0 ? parts.join('\n') : '<p class="empty">（暂无消息）</p>'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mr.Huang Agent 对话记录</title>
<style>
  body { margin: 0; padding: 32px 16px; background: #f5f6f8; color: #1f2329;
    font-family: "PingFang SC", "Microsoft YaHei", -apple-system, "Segoe UI", sans-serif;
    font-size: 14px; line-height: 1.7; }
  .wrap { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 8px; }
  .meta { color: #6b7280; font-size: 13px; margin: 0 0 24px; }
  .task-card, .msg { background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
    padding: 16px 20px; margin-bottom: 12px; }
  .task-card h2, .tool-records-title { font-size: 15px; margin: 0 0 8px; }
  .task-meta { color: #6b7280; font-size: 13px; margin: 0 0 10px; }
  .task-error { color: #d92d20; font-size: 13px; margin: 0 0 10px; }
  .task-steps { margin: 0; padding-left: 20px; }
  .task-steps li { margin-bottom: 8px; }
  .step-status { display: inline-block; padding: 0 8px; margin-right: 6px; border-radius: 999px;
    font-size: 12px; background: #eef1f4; color: #4b5563; }
  .is-done .step-status { background: #e6f4ea; color: #1a7f37; }
  .is-failed .step-status { background: #fdeceb; color: #d92d20; }
  .is-running .step-status { background: #e8f0fe; color: #1a56db; }
  .step-parallel { margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 12px;
    background: #f4f0ff; color: #6d28d9; }
  .step-extra { margin-top: 4px; color: #6b7280; font-size: 13px; }
  .step-extra.is-error { color: #d92d20; }
  .msg-role { margin: 0 0 6px; font-size: 12px; color: #6b7280; font-weight: 600; }
  .msg-content { overflow-wrap: anywhere; white-space: pre-wrap; }
  .tool-records { margin-top: 12px; padding-top: 10px; border-top: 1px dashed #e5e7eb; }
  .tool-records ul { list-style: none; margin: 0; padding: 0; }
  .tool-records li { font-size: 13px; color: #4b5563; margin-bottom: 6px; }
  .tool-records code { font-family: Consolas, Menlo, monospace; background: #eef1f4;
    padding: 1px 6px; border-radius: 4px; margin-right: 6px; }
  .tool-line { display: block; margin-top: 2px; color: #6b7280; overflow-wrap: anywhere; }
  .tool-line.is-error { color: #d92d20; }
  .empty { color: #6b7280; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
<h1>Mr.Huang Agent 对话记录</h1>
<p class="meta">模型：${escapeHtml(options.modelName.trim() || '未设置')} · 导出时间：${formatDateTime(exportedAt)} · 消息条数：${options.messages.length}</p>
${body}
</div>
</body>
</html>
`
}

/** 生成复制到剪贴板的纯文本（你：/ 助手： 交替） */
export function buildConversationPlainText(messages: ExportMessage[]): string {
  return messages
    .map((message) => `${message.role === 'user' ? '你' : '助手'}：\n${message.content}`)
    .join('\n\n')
}
