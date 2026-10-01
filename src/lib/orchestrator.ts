/**
 * 多智能体群聊编排器（V1：固定轮询 + 主持人收敛判断 + 硬性熔断）
 *
 * 调用流程：
 * 1. 第 1..maxRounds 轮，成员按加入顺序轮流发言：system = 成员自身 system prompt + 群规，
 *    user = 任务 + 迄今为止的群聊记录；发言经 streamChatCompletion 流式输出（onDelta 回调）；
 * 2. 每轮结束后由当前激活的 LLM 配置扮演「主持人」，要求返回结构化 JSON
 *    { can_deliver, next_round_topic, reason }；解析失败视为 can_deliver = false 并继续；
 * 3. 主持人判定可交付或达到 maxRounds 轮后，再调一次主持人生成最终交付文本（普通文本流式），
 *    作为 deliverable 返回。
 *
 * - 成员与主持人可分别绑定不同的模型端点（memberEndpoints / moderatorEndpoint）；
 *   某成员调用失败时不中断群聊：该次发言标记 errorText 后流程继续。
 *
 * 本模块只依赖 llm.ts 与 group-chat.ts 的类型，不接触 Pinia store，便于直接单测。
 */

import {
  chatCompletion,
  describeLlmError,
  isAbortError,
  runAgentLoop,
  streamChatCompletion,
  type LlmEndpoint,
  type LlmChatMessage,
  type LlmToolDefinition,
} from '@/lib/llm'
import { hasLlmForward } from '@/lib/desktop-bridge'
import { buildMcpSystemHint, refreshMcpToolSchemas, resolveToolSchemas } from '@/lib/tool-executor'
import { GROUP_CHAT_MAX_ROUNDS, type TranscriptEntry } from '@/lib/group-chat'

/** 编排器视角的群成员（调用方从 agents store 解析后传入） */
export interface OrchestratorMember {
  agentId: string
  name: string
  systemPrompt: string
  /** 声明可用的工具名列表（非空且桌面端时，发言走 function calling；浏览器端自动退回纯文本） */
  tools?: string[]
}

/** 主持人每轮结束后的结构化判定 */
export interface ModeratorVerdict {
  canDeliver: boolean
  /** 下一轮建议聚焦的话题（canDeliver 为 false 时给主持人给出的引导） */
  nextRoundTopic: string
  /** 判定理由（供界面提示条展示） */
  reason: string
}

/** 从模型返回文本中提取 JSON 判定对象；无法解析时返回 null（调用方按继续讨论兜底） */
export function parseVerdict(raw: string): ModeratorVerdict | null {
  // 兼容模型把 JSON 包在 ```json 代码块或前后闲聊中的情况：截取首个 { 到最后一个 }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    if (typeof data.can_deliver !== 'boolean') return null
    return {
      canDeliver: data.can_deliver,
      nextRoundTopic:
        typeof data.next_round_topic === 'string' ? data.next_round_topic.trim() : '',
      reason: typeof data.reason === 'string' ? data.reason.trim() : '',
    }
  } catch {
    return null
  }
}

/** 群规说明：附加在每个成员自身 system prompt 之后 */
function memberGroupRules(memberName: string, memberNames: string[]): string {
  return [
    '',
    '—— 群聊规则 ——',
    `你正在一个多智能体群聊中与其他智能体协作完成任务。你现在的名字是「${memberName}」，群内成员有：${memberNames.join('、')}。`,
    '请严格围绕群任务，从你的职责视角发言；不要重复别人已经说过的内容，可以在他人观点基础上补充、质疑或推进。',
    '单次发言请精炼（建议 300 字以内），直接给出你的观点、理由或建议，不要客套寒暄。请使用中文发言。',
  ].join('\n')
}

/** 成员发言的 user 内容：任务 + 迄今为止的群聊记录（用户插话以「用户（我）」标注）+ 技能注入附注 */
function buildTranscriptContext(
  task: string,
  transcript: TranscriptEntry[],
  skillInjections: Array<{ name: string; content: string }>,
): string {
  const lines: string[] = [`【群任务】\n${task.trim() || '（任务待补充）'}`]
  if (transcript.length > 0) {
    lines.push('', '【目前的群聊记录】')
    for (const entry of transcript) {
      const speaker = entry.role === 'user' ? '用户（我）' : entry.agentId
      const content =
        entry.content.trim() || (entry.role === 'user' ? '（点名/插话，见 @ 引用）' : '（未发言）')
      lines.push(`${speaker}（第 ${entry.round} 轮）：${content}`)
    }
  } else {
    lines.push('', '你是第一位发言的成员，请开个头，给出你对任务的整体思路。')
  }
  if (skillInjections.length > 0) {
    lines.push('')
    for (const injection of skillInjections) {
      lines.push(`[技能注入：${injection.name}]\n${injection.content.trim()}`)
    }
    lines.push('', '请结合以上注入的技能方法论，从你的职责视角发言。')
  }
  lines.push('', '请以你的身份发表这一轮的发言。')
  return lines.join('\n')
}

/** 主持人判定轮次的 system prompt */
function moderatorJudgeSystemPrompt(task: string, maxRounds: number, currentRound: number): string {
  return [
    '你是多智能体群聊的主持人，负责任务进度判断。你自己不参与讨论，只做判断。',
    `群任务：${task.trim() || '（任务待补充）'}`,
    `当前已进行到第 ${currentRound} 轮（共最多 ${maxRounds} 轮）。`,
    '请根据群聊记录判断：任务是否已经讨论充分、可以由你汇总各成员观点形成最终交付物？',
    '判定标准：成员观点已覆盖任务要点、分歧已收敛或已足够支撑产出，即可交付；否则给出下一轮应聚焦的话题。',
    '严格只返回一个 JSON 对象，格式如下，不要包含其他文字：',
    '{ "can_deliver": true 或 false, "next_round_topic": "下一轮建议聚焦的话题（不可交付时填写）", "reason": "一句话判定理由" }',
  ].join('\n')
}

/** 主持人最终汇总的 system prompt */
function moderatorSummarySystemPrompt(task: string): string {
  return [
    '你是多智能体群聊的主持人。讨论已结束，请你汇总各成员的观点，产出任务的最终交付物。',
    `群任务：${task.trim() || '（任务待补充）'}`,
    '要求：',
    '1. 结构化呈现：给出结论/方案要点/分工或后续建议等清晰的小节（可用 Markdown 标题与列表）；',
    '2. 忠实整合各成员的有效观点，标注关键结论来自哪位成员；分歧点如未收敛，给出主持人裁决或取舍理由；',
    '3. 直接输出交付内容本身，不要寒暄，不要复述讨论过程。请使用中文。',
  ].join('\n')
}

function buildTranscriptText(transcript: TranscriptEntry[]): string {
  return transcript
    .map((entry) => {
      const speaker = entry.role === 'user' ? '用户（我）' : entry.agentId
      const content =
        entry.content.trim() || (entry.role === 'user' ? '（点名/插话，见 @ 引用）' : '（未发言）')
      return `${speaker}（第 ${entry.round} 轮）：\n${content}`
    })
    .join('\n\n')
}

/** 编排器的事件回调（均为可选，供 UI 实时渲染与状态更新） */
export interface OrchestratorHandlers {
  /** 一轮开始（round 从 1 开始） */
  onRoundStart?: (round: number) => void
  /** 某成员开始发言：entry 已包含 agentId/round/ts，content 从空串开始增量增长 */
  onSpeakerStart?: (entry: TranscriptEntry) => void
  /** 某成员发言的流式增量 */
  onDelta?: (entry: TranscriptEntry, text: string) => void
  /** 某成员发言结束（含被中止的残句） */
  onSpeakerEnd?: (entry: TranscriptEntry) => void
  /** 主持人轮末判定（解析成功时回调；解析失败不回调，按继续讨论处理） */
  onVerdict?: (verdict: ModeratorVerdict, round: number) => void
  /** 最终交付文本开始生成 */
  onDeliverableStart?: () => void
  /** 最终交付文本的流式增量 */
  onDeliverableDelta?: (text: string) => void
  /** 最终交付文本生成结束（含被中止的残文） */
  onDeliverableEnd?: (text: string) => void
}

export interface RunGroupChatOptions {
  /** 成员级模型端点映射：agentId → 该成员发言使用的端点（缺失项回退 moderatorEndpoint） */
  memberEndpoints: Record<string, LlmEndpoint>
  /** 主持人端点：轮末收敛判定与最终汇总共用 */
  moderatorEndpoint: LlmEndpoint
  members: OrchestratorMember[]
  task: string
  /**
   * 群聊记录数组。注意：编排器会直接向该数组追加成员发言（不拷贝），
   * 因此调用方传入 store 内的响应式数组即可让「进行中插话」被后续轮次看到。
   */
  transcript?: TranscriptEntry[]
  /** 首位发言成员的 agentId（用户 @ 成员时从其开始轮询；不存在/被删除时按原顺序） */
  firstSpeakerAgentId?: string
  /** 注入到本轮所有成员上下文的技能内容（@技能 时携带） */
  skillInjections?: Array<{ name: string; content: string }>
  /** 起始轮次（默认 1；已交付后续聊时传 lastRound+1，熔断计数从此重新计 maxRounds 轮） */
  startRound?: number
  maxRounds?: number
  signal?: AbortSignal
  handlers?: OrchestratorHandlers
  /** 工具执行回调（桌面端 + 成员声明工具时必需；未传则所有成员退回纯文本发言） */
  executeTool?: (name: string, argsJson: string) => Promise<string>
}

export interface RunGroupChatResult {
  /** 全部发言（含本轮新增） */
  transcript: TranscriptEntry[]
  /** 主持人最终交付文本（被中止时可能是空串或残文） */
  deliverable: string
  /** 是否因用户中止而提前结束 */
  aborted: boolean
  /** 实际进行的轮数 */
  rounds: number
  /** 最后一轮的主持人判定（解析成功时存在） */
  lastVerdict: ModeratorVerdict | null
}

/** 单次成员发言：用该成员绑定的端点流式回调增量，返回完整发言条目。
 * 成员声明工具且桌面端时改走 runAgentLoop（工具步骤记录到条目 toolSteps）；
 * 调用失败（网络/鉴权等）不让群聊崩掉：在发言上标记 errorText 后照常返回，流程继续。 */
async function runMemberTurn(
  endpoint: LlmEndpoint,
  member: OrchestratorMember,
  memberNames: string[],
  task: string,
  transcript: TranscriptEntry[],
  skillInjections: Array<{ name: string; content: string }>,
  round: number,
  signal: AbortSignal | undefined,
  handlers: OrchestratorHandlers | undefined,
  executeTool: ((name: string, argsJson: string) => Promise<string>) | undefined,
  /** MCP system 提示块（整个群聊只注入一次，由 mcpHintState 控制） */
  mcpHint: string | null,
  /** MCP 提示注入状态（跨成员轮次共享的可变标记） */
  mcpHintState: { injected: boolean },
): Promise<TranscriptEntry> {
  const entry: TranscriptEntry = { agentId: member.agentId, content: '', round, ts: Date.now() }
  // 先入 transcript 再取回响应式代理：后续增量写入走代理，UI 才能实时渲染
  transcript.push(entry)
  const tracked = transcript[transcript.length - 1] ?? entry
  handlers?.onSpeakerStart?.(tracked)
  let systemContent = `${member.systemPrompt.trim()}\n${memberGroupRules(member.name, memberNames)}`
  // MCP 提示只随第一位发言成员的 system 注入一次（不按智能体重复注入）
  if (mcpHint && !mcpHintState.injected) {
    systemContent += `\n\n${mcpHint}`
    mcpHintState.injected = true
  }
  const messages: LlmChatMessage[] = [
    { role: 'system', content: systemContent },
    { role: 'user', content: buildTranscriptContext(task, transcript, skillInjections) },
  ]

  // 工具能力：成员声明了工具 + 桌面端 + 调用方提供了执行器 → function calling；否则纯文本
  const tools: LlmToolDefinition[] =
    member.tools && member.tools.length > 0 && hasLlmForward() && executeTool
      ? resolveToolSchemas(member.tools)
      : []

  try {
    if (tools.length > 0 && executeTool) {
      await runAgentLoop({
        endpoint,
        messages,
        tools,
        executeTool,
        signal,
        handlers: {
          onContent: (text) => {
            tracked.content += text
            handlers?.onDelta?.(tracked, text)
          },
        },
        onStep: (info) => {
          const steps = [...(tracked.toolSteps ?? []), { ...info }]
          tracked.toolSteps = steps
        },
      })
    } else {
      await streamChatCompletion({
        endpoint,
        messages,
        signal,
        handlers: {
          onContent: (text) => {
            tracked.content += text
            handlers?.onDelta?.(tracked, text)
          },
        },
      })
    }
  } catch (err) {
    // 用户主动中止仍向上抛出，由 runGroupChat 统一收尾；其余失败标记后继续
    if (signal?.aborted || isAbortError(err)) throw err
    tracked.errorText = describeLlmError(err, endpoint.baseUrl)
  } finally {
    tracked.content = tracked.content.trim()
    handlers?.onSpeakerEnd?.(tracked)
  }
  return tracked
}

/**
 * 运行群聊编排（见模块顶部注释的完整流程）。
 * 抛出的异常（网络/鉴权等）交由调用方展示；用户中止不抛异常，以 aborted: true 正常返回。
 */
export async function runGroupChat(options: RunGroupChatOptions): Promise<RunGroupChatResult> {
  const {
    members,
    task,
    maxRounds = GROUP_CHAT_MAX_ROUNDS,
    signal,
    handlers,
  } = options
  const moderatorEndpoint = options.moderatorEndpoint
  const memberEndpoints = options.memberEndpoints ?? {}
  // 直接使用调用方传入的数组（不拷贝）：进行中的用户插话对后续成员立即可见
  const transcript: TranscriptEntry[] = options.transcript ?? []
  const skillInjections = options.skillInjections ?? []
  const startRound = Math.max(1, Math.trunc(options.startRound ?? 1))
  // 发言顺序：用户 @ 成员时从其开始轮询（成员不存在/被删除时忽略，按原顺序）
  const firstIndex = members.findIndex((member) => member.agentId === options.firstSpeakerAgentId)
  const orderedMembers =
    firstIndex > 0 ? [...members.slice(firstIndex), ...members.slice(0, firstIndex)] : members
  const memberNames = members.map((member) => member.name)
  let lastVerdict: ModeratorVerdict | null = null
  let rounds = startRound - 1

  // MCP 动态工具：群聊开始前刷新一次（5 分钟 TTL 缓存，多次调用不重复建连），
  // 存在 MCP 工具时生成 system 提示块，随首位发言成员的 system 注入一次。
  let mcpHint: string | null = null
  try {
    mcpHint = buildMcpSystemHint(await refreshMcpToolSchemas())
  } catch {
    mcpHint = null
  }
  const mcpHintState = { injected: false }

  const runJudge = async (round: number): Promise<ModeratorVerdict | null> => {
    try {
      const raw = await chatCompletion(moderatorEndpoint, [
        {
          role: 'system',
          content: moderatorJudgeSystemPrompt(task, maxRounds, round),
        },
        {
          role: 'user',
          content: `【群聊记录】\n${buildTranscriptText(transcript) || '（暂无发言）'}\n\n请返回 JSON 判定。`,
        },
      ], signal)
      return parseVerdict(raw)
    } catch (err) {
      if (signal?.aborted) throw err
      // 主持人判定失败（网络抖动等）不终止群聊：按「继续讨论」兜底，防止跑飞由轮数熔断兜住
      return null
    }
  }

  for (let round = startRound; round < startRound + maxRounds; round++) {
    handlers?.onRoundStart?.(round)
    rounds = round
    for (const member of orderedMembers) {
      if (signal?.aborted) {
        return { transcript, deliverable: '', aborted: true, rounds, lastVerdict }
      }
      // 发言条目已由 runMemberTurn 原位推入 transcript（含流式增量回写）
      await runMemberTurn(
        memberEndpoints[member.agentId] ?? moderatorEndpoint,
        member,
        memberNames,
        task,
        transcript,
        skillInjections,
        round,
        signal,
        handlers,
        options.executeTool,
        mcpHint,
        mcpHintState,
      )
    }

    const verdict = await runJudge(round)
    if (verdict) {
      lastVerdict = verdict
      handlers?.onVerdict?.(verdict, round)
      if (verdict.canDeliver) break
    }
    if (round === startRound + maxRounds - 1) break
  }

  if (signal?.aborted) {
    return { transcript, deliverable: '', aborted: true, rounds, lastVerdict }
  }

  // 最终汇总：主持人生成交付文本（流式）
  handlers?.onDeliverableStart?.()
  let deliverable = ''
  try {
    await streamChatCompletion({
      endpoint: moderatorEndpoint,
      messages: [
        { role: 'system', content: moderatorSummarySystemPrompt(task) },
        {
          role: 'user',
          content: `【群任务】\n${task.trim() || '（任务待补充）'}\n\n【群聊记录】\n${buildTranscriptText(transcript) || '（暂无发言）'}\n\n请汇总产出最终交付物。`,
        },
      ],
      signal,
      handlers: {
        onContent: (text) => {
          deliverable += text
          handlers?.onDeliverableDelta?.(text)
        },
      },
    })
  } finally {
    deliverable = deliverable.trim()
    handlers?.onDeliverableEnd?.(deliverable)
  }

  return { transcript, deliverable, aborted: Boolean(signal?.aborted), rounds, lastVerdict }
}
