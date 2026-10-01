/**
 * 执行任务（计划闭环 + 子智能体逐步执行）的纯逻辑集合（零 Vue 依赖，可在 Node 中直接单测）：
 * - extractPlanBlock：从助手回复中识别「## 执行计划」区块
 * - parsePlanSteps：按 markdown 有序列表行切分计划步骤（失败回退整体单步）
 * - buildSubAgentMessages：组装单步子智能体请求（system + user）
 * - truncateStepResult：步骤结果摘要截断
 * - TaskRun / TaskStep 状态模型 + normalizeTaskRun 防御式归一化（持久化读写共用）
 *
 * 编排（循环/回调/错误处理）在 ChatView 中装配；本模块只提供可测的纯函数与类型。
 */

import type { ToolStepRecord } from '@/lib/group-chat'
import { storageGet, storageSet } from '@/lib/storage'

/* —— 状态模型 —— */

/** 单个计划步骤的执行状态 */
export type TaskStepStatus = 'pending' | 'running' | 'done' | 'failed'

/** 执行任务整体状态：interrupted = 刷新前仍在执行、加载后被标记中断（不自动恢复） */
export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

/** 执行任务中的一个步骤（随会话持久化） */
export interface TaskStep {
  /** 步骤内容（来自计划中的编号列表行） */
  content: string
  status: TaskStepStatus
  /** 完成后的结果摘要（已截断） */
  result: string
  /** 失败时的错误说明 */
  error?: string
  /** 本步子智能体执行过程中的工具调用记录（复用 ToolStepCard 展示） */
  toolSteps: ToolStepRecord[]
  /** 计划标注：本步可与其他标注步骤并行执行（用户开关关闭时仍串行） */
  parallel?: boolean
  /** 计划标注：步骤行内 @模型名 的原始引用（未解析成功时仅展示用） */
  modelRef?: string
  /** 本步绑定的模型配置 id（llm store 的 config.id；空表示用当前会话模型） */
  modelConfigId?: string
  /** 本步绑定的具体模型 id（空表示用绑定配置的主模型） */
  modelId?: string
}

/** 会话级执行任务（conversation.taskRun 字段，旧数据缺失时视为无任务） */
export interface TaskRun {
  id: string
  title: string
  /** 整体目标（批准计划时的任务目标，随步骤请求注入） */
  goal: string
  /** 计划所在的助手消息 id（追溯来源） */
  planMessageId: string
  status: TaskRunStatus
  steps: TaskStep[]
  createdAt: number
  /** 用户批准时选择的并行执行开关（关闭时即使步骤标注了并行也按串行执行） */
  parallelEnabled: boolean
  /** 每步 agent loop 最大回合数（批准任务时快照，续跑沿用） */
  maxRounds: number
  /** 单步结果摘要字符数上限（批准任务时快照，续跑沿用） */
  resultMaxChars: number
  /** 任务失败时的整体错误说明（通常为首个失败步的错误） */
  errorText?: string
}

/** 计划区块标题（模型在计划模式下的输出约定，与 chat-compose 的约束提示保持一致） */
export const PLAN_HEADING = '## 执行计划'

/** 步骤结果摘要的字符数上限（旧默认值，保留导出兼容；实际值随任务持久化在 TaskRun.resultMaxChars） */
export const STEP_RESULT_MAX_CHARS = 500

/* —— 任务执行参数（默认值 / 范围 / 全局默认持久化） —— */

/** 每步 agent loop 最大回合数：默认值与取值范围 */
export const DEFAULT_TASK_MAX_ROUNDS = 8
export const TASK_MAX_ROUNDS_MIN = 1
export const TASK_MAX_ROUNDS_MAX = 30

/** 单步结果摘要字符数上限：默认值与取值范围 */
export const DEFAULT_STEP_RESULT_CHARS = 500
export const STEP_RESULT_CHARS_MIN = 200
export const STEP_RESULT_CHARS_MAX = 4000

/** 夹取每步最大回合数到合法范围（非法输入回退默认值） */
export function clampTaskMaxRounds(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return DEFAULT_TASK_MAX_ROUNDS
  return Math.min(TASK_MAX_ROUNDS_MAX, Math.max(TASK_MAX_ROUNDS_MIN, Math.round(num)))
}

/** 夹取单步结果上限字符数到合法范围（非法输入回退默认值） */
export function clampStepResultChars(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return DEFAULT_STEP_RESULT_CHARS
  return Math.min(STEP_RESULT_CHARS_MAX, Math.max(STEP_RESULT_CHARS_MIN, Math.round(num)))
}

/** 任务执行全局默认参数（SettingsView 配置，会话未单独指定时使用） */
export interface TaskDefaults {
  maxRounds: number
  resultMaxChars: number
}

const TASK_DEFAULTS_STORAGE_KEY = 'mr-huang-agent:task-defaults'

/** 读取全局默认参数；localStorage 不可用 / 数据损坏时回退默认值 */
export function loadTaskDefaults(): TaskDefaults {
  try {
    const raw = storageGet(TASK_DEFAULTS_STORAGE_KEY)
    if (!raw) return { maxRounds: DEFAULT_TASK_MAX_ROUNDS, resultMaxChars: DEFAULT_STEP_RESULT_CHARS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { maxRounds: DEFAULT_TASK_MAX_ROUNDS, resultMaxChars: DEFAULT_STEP_RESULT_CHARS }
    }
    const record = parsed as Record<string, unknown>
    return { maxRounds: clampTaskMaxRounds(record.maxRounds), resultMaxChars: clampStepResultChars(record.resultMaxChars) }
  } catch {
    return { maxRounds: DEFAULT_TASK_MAX_ROUNDS, resultMaxChars: DEFAULT_STEP_RESULT_CHARS }
  }
}

/** 持久化全局默认参数（localStorage 不可用时静默降级，仅当前会话生效） */
export function persistTaskDefaults(defaults: TaskDefaults): void {
  try {
    storageSet(TASK_DEFAULTS_STORAGE_KEY, JSON.stringify(defaults))
  } catch {
    // 忽略持久化失败
  }
}

/** 任务是否仍在执行（批准按钮禁用 / 防并发判断用） */
export function isTaskActive(status: TaskRunStatus): boolean {
  return status === 'running'
}

/* —— 计划区块识别与步骤切分 —— */

/**
 * 从助手回复正文中提取「## 执行计划」区块正文：
 * 以 PLAN_HEADING 开头（允许标题后带补充说明文字）的行起，到下一个 `##` 标题行或正文结束止。
 * 无该区块时返回 null。
 */
export function extractPlanBlock(content: string): string | null {
  if (!content) return null
  const lines = content.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s*执行计划/.test(lines[i].trim())) {
      start = i
      break
    }
  }
  if (start < 0) return null
  const body: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i].trim())) break
    body.push(lines[i])
  }
  const text = body.join('\n').trim()
  return text || null
}

/**
 * 步骤行解析结果：content 为去掉行尾标注后的正文；
 * parallel 表示行尾带「[并行]」标记；modelRef 为行尾「@模型名」的原始引用（空串表示未标注）。
 * 标注可按任意顺序混用（如「… [并行] @gpt-4o」或「… @gpt-4o [并行]」）。
 */
export interface ParsedPlanStep {
  content: string
  parallel: boolean
  modelRef: string
}

/** 行尾「[并行]」标记（允许任意大小写与前后空格） */
const PARALLEL_MARKER_PATTERN = /\s*\[并行\]\s*$/i

/** 行尾「@模型名」标注（模型名不含空白与 @） */
const MODEL_REF_PATTERN = /\s*@([^\s@]+)\s*$/

/**
 * 解析单个步骤行尾的标注（[并行] / @模型名），返回去掉标注后的正文与标注信息。
 * 纯函数：循环剥离子串，两种标注顺序任意。
 */
export function parsePlanStepAnnotations(rawStep: string): ParsedPlanStep {
  let text = (rawStep ?? '').trim()
  let parallel = false
  let modelRef = ''
  let changed = true
  while (changed) {
    changed = false
    const parallelMatch = PARALLEL_MARKER_PATTERN.exec(text)
    if (parallelMatch) {
      text = text.slice(0, parallelMatch.index).trim()
      parallel = true
      changed = true
      continue
    }
    const modelMatch = MODEL_REF_PATTERN.exec(text)
    if (modelMatch) {
      text = text.slice(0, modelMatch.index).trim()
      modelRef = modelMatch[1]
      changed = true
    }
  }
  return { content: text, parallel, modelRef }
}

/**
 * 把计划正文切分为步骤列表：按 markdown 有序列表行（`1. ` / `1、` / `1)`）切分；
 * 行尾标注（[并行] / @模型名）会从正文内容中剥离（用 parsePlanStepAnnotations 可取回标注）；
 * 无法识别出任何编号步骤时，把整段计划作为一个单步（保证任务总是可执行）。
 */
export function parsePlanSteps(planText: string): string[] {
  const steps: string[] = []
  for (const rawLine of (planText ?? '').split('\n')) {
    const match = /^\s*\d+[.、)．)]\s*(.+)$/.exec(rawLine)
    if (match) {
      const content = match[1].trim()
      if (content) steps.push(parsePlanStepAnnotations(content).content)
    }
  }
  if (steps.length > 0) return steps
  const fallback = parsePlanStepAnnotations((planText ?? '').trim()).content
  return fallback ? [fallback] : []
}

/**
 * 按计划正文切分出带标注的步骤列表（createTaskRun 用）；
 * 无法识别编号步骤时整段作为单步（与 parsePlanSteps 的回退行为一致）。
 */
export function parsePlanStepsDetailed(planText: string): ParsedPlanStep[] {
  const steps: ParsedPlanStep[] = []
  for (const rawLine of (planText ?? '').split('\n')) {
    const match = /^\s*\d+[.、)．)]\s*(.+)$/.exec(rawLine)
    if (match) {
      const parsed = parsePlanStepAnnotations(match[1].trim())
      if (parsed.content) steps.push(parsed)
    }
  }
  if (steps.length > 0) return steps
  const fallback = parsePlanStepAnnotations((planText ?? '').trim())
  return fallback.content ? [fallback] : []
}

/**
 * 把未完成步骤按并行标注分组（纯函数，供执行编排用）：
 * - parallelEnabled=false 时全部单步串行；
 * - 开启时，相邻且标注 parallel 的步骤合并为一组并发执行；已 done 的步骤跳过；
 * - 组与组之间保持先后顺序（后一组可依赖前一组的完成结果）。
 */
export function buildParallelGroups(steps: readonly TaskStep[], parallelEnabled: boolean): number[][] {
  const groups: number[][] = []
  let index = 0
  while (index < steps.length) {
    if (steps[index].status === 'done') {
      index += 1
      continue
    }
    if (parallelEnabled && steps[index].parallel === true) {
      const group = [index]
      let next = index + 1
      while (next < steps.length && steps[next].parallel === true && steps[next].status !== 'done') {
        group.push(next)
        next += 1
      }
      groups.push(group)
      index = next
    } else {
      groups.push([index])
      index += 1
    }
  }
  return groups
}

/* —— 子智能体请求组装 —— */

/** 截断步骤结果摘要到上限（maxChars 缺省时用默认值 500） */
export function truncateStepResult(result: string, maxChars: number = DEFAULT_STEP_RESULT_CHARS): string {
  const limit = clampStepResultChars(maxChars)
  return (result ?? '').trim().slice(0, limit)
}

/** 已完成步骤的摘要条目（供子智能体请求注入上下文） */
export interface CompletedStepSummary {
  content: string
  result: string
}

/**
 * 组装单步子智能体请求的 messages：
 * - system：执行子智能体角色约束（只做当前步骤、可用工具、完成后输出简短总结）；
 * - user：整体目标 + 已完成步骤的结果摘要 + 当前步骤内容。
 */
export function buildSubAgentMessages(
  goal: string,
  completed: readonly CompletedStepSummary[],
  currentStep: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = [
    '你是执行子智能体，负责完成一个多步骤执行计划中的当前步骤。',
    '- 只聚焦完成「当前步骤」描述的任务，可以调用可用工具；不要执行计划中的其他步骤。',
    '- 完成后直接输出简短的结果总结（做了什么、关键产出/结论），不要输出与当前步骤无关的内容。',
  ].join('\n')

  const userLines: string[] = []
  const target = goal.trim()
  userLines.push(target ? `【整体目标】${target}` : '【整体目标】（未指定）')
  if (completed.length > 0) {
    userLines.push('', '【已完成步骤的结果摘要】')
    completed.forEach((item, index) => {
      userLines.push(`${index + 1}. ${item.content}`)
      if (item.result) userLines.push(`   结果：${item.result}`)
    })
  }
  userLines.push('', `【当前步骤】${currentStep}`, '', '请执行上述当前步骤，完成后输出结果总结。')

  return [
    { role: 'system', content: system },
    { role: 'user', content: userLines.join('\n') },
  ]
}

/** 任务完成后追加到主对话的汇总消息（直接拼接各步摘要，不做二次模型总结） */
export function buildTaskSummaryMessage(task: TaskRun): string {
  const doneSteps = task.steps.filter((step) => step.status === 'done')
  const lines = [`## 任务执行完成：${task.title}`, '']
  for (let i = 0; i < task.steps.length; i++) {
    const step = task.steps[i]
    const head = `${i + 1}. ${step.content}`
    if (step.status === 'done') {
      lines.push(head, '', step.result ? `> ${step.result.replace(/\n/g, '\n> ')}` : '> （无输出）', '')
    } else {
      lines.push(head, '', `> （${step.status === 'failed' ? `失败：${step.error ?? '未知错误'}` : '未执行'}）`, '')
    }
  }
  if (doneSteps.length === 0) lines.push('本次执行未产生已完成的步骤。')
  return lines.join('\n').trim()
}

/* —— 防御式归一化（持久化读取用，与 conversations store 的其他 normalize 同风格） —— */

/** 归一化单个步骤；缺内容时丢弃（返回 null） */
function normalizeTaskStep(value: unknown): TaskStep | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const content = typeof record.content === 'string' ? record.content.trim() : ''
  if (!content) return null
  const rawStatus = record.status
  // running 残留（刷新前仍在执行）归一化为 pending：任务不自动恢复，由用户决定续跑
  const status: TaskStepStatus =
    rawStatus === 'done' || rawStatus === 'failed' || rawStatus === 'running' ? rawStatus : 'pending'
  return {
    content,
    status: status === 'running' ? 'pending' : status,
    result: typeof record.result === 'string' ? record.result : '',
    ...(typeof record.error === 'string' && record.error ? { error: record.error } : {}),
    toolSteps: Array.isArray(record.toolSteps)
      ? (record.toolSteps.filter(
          (item): item is ToolStepRecord =>
            typeof item === 'object' && item !== null && typeof (item as ToolStepRecord).toolName === 'string',
        ) as ToolStepRecord[])
      : [],
    ...(record.parallel === true ? { parallel: true } : {}),
    ...(typeof record.modelRef === 'string' && record.modelRef ? { modelRef: record.modelRef } : {}),
    ...(typeof record.modelConfigId === 'string' && record.modelConfigId
      ? { modelConfigId: record.modelConfigId }
      : {}),
    ...(typeof record.modelId === 'string' && record.modelId ? { modelId: record.modelId } : {}),
  }
}

/**
 * 防御式归一化执行任务：字段非法逐项兜底；running 残留归一化为 interrupted
 * （刷新后标记为已中断，不自动恢复）；无 id / 无有效步骤时返回 null（视为无任务）。
 */
export function normalizeTaskRun(value: unknown): TaskRun | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const steps = Array.isArray(record.steps)
    ? (record.steps.map(normalizeTaskStep).filter((step): step is TaskStep => step !== null))
    : []
  if (!id || steps.length === 0) return null
  const rawStatus = record.status
  const status: TaskRunStatus =
    rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped' || rawStatus === 'interrupted'
      ? rawStatus
      : 'running'
  const createdAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt > 0
      ? record.createdAt
      : Date.now()
  return {
    id,
    title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : '执行任务',
    goal: typeof record.goal === 'string' ? record.goal : '',
    planMessageId: typeof record.planMessageId === 'string' ? record.planMessageId : '',
    status: status === 'running' ? 'interrupted' : status,
    steps,
    createdAt,
    parallelEnabled: record.parallelEnabled === true,
    maxRounds: clampTaskMaxRounds(record.maxRounds),
    resultMaxChars: clampStepResultChars(record.resultMaxChars),
    ...(typeof record.errorText === 'string' && record.errorText ? { errorText: record.errorText } : {}),
  }
}

/** 创建执行任务的运行时初值（批准计划时调用；参数缺省时回退全局默认值） */
export function createTaskRun(input: {
  title: string
  goal: string
  planMessageId: string
  planText: string
  parallelEnabled?: boolean
  maxRounds?: number
  resultMaxChars?: number
}): TaskRun | null {
  const parsed = parsePlanStepsDetailed(input.planText)
  if (parsed.length === 0) return null
  return {
    id: crypto.randomUUID(),
    title: input.title.trim() || '执行任务',
    goal: input.goal,
    planMessageId: input.planMessageId,
    status: 'running',
    createdAt: Date.now(),
    parallelEnabled: input.parallelEnabled === true,
    maxRounds: clampTaskMaxRounds(input.maxRounds ?? DEFAULT_TASK_MAX_ROUNDS),
    resultMaxChars: clampStepResultChars(input.resultMaxChars ?? DEFAULT_STEP_RESULT_CHARS),
    steps: parsed.map((item) => ({
      content: item.content,
      status: 'pending' as const,
      result: '',
      toolSteps: [],
      ...(item.parallel ? { parallel: true } : {}),
      ...(item.modelRef ? { modelRef: item.modelRef } : {}),
    })),
  }
}
