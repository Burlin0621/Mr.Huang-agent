/**
 * 今日选题流水线 store：
 * - 把运行状态与编排逻辑从视图组件抽出到 Pinia（store 常驻内存），切换左侧菜单后
 *   运行中的任务继续执行、流式增量照常写入 store；回到页面时原样展示（含流式中途进度）；
 * - 偏好输入（账号定位/目标读者）沿用 localStorage 持久化，持久化逻辑一并移入 store；
 * - store 不 import vue-router：跳转公众号写作等路由行为留在视图层。
 *
 * 阶段编排：热点扫描（桌面端带工具）→ 选题评估（严格 JSON）→ 选题卡片（视图解析渲染）。
 */
import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

import { findAgentById } from '@/lib/agents'
import { hasLlmForward } from '@/lib/desktop-bridge'
import type { ToolStepRecord } from '@/lib/group-chat'
import { describeLlmError, isAbortError, runAgentLoop, streamChatCompletion } from '@/lib/llm'
import type { LlmChatMessage, LlmEndpoint } from '@/lib/llm'
import { executeToolWithPrefs, resolveToolSchemas } from '@/lib/tool-executor'
import { TOPIC_PLATFORMS, TOPIC_STAGES, buildStageSystemMessage, buildStageUserMessage, parsePicks } from '@/lib/today-topics'
import type { TopicPick, TopicPreference, TopicStageId } from '@/lib/today-topics'
import { useLlmStore } from '@/stores/llm'
import { storageGet, storageSet } from '@/lib/storage'

/** 单个阶段卡片的状态与产出 */
export interface TopicStageState {
  status: 'idle' | 'running' | 'done' | 'error' | 'aborted'
  content: string
  errorText: string
  toolSteps: ToolStepRecord[]
}

/** 阶段状态徽标文案（选题卡片块「解析失败」单独提示，在视图层覆盖） */
export const TOPIC_STATUS_LABEL: Record<TopicStageState['status'], string> = {
  idle: '待运行',
  running: '运行中',
  done: '已完成',
  error: '失败',
  aborted: '已中止',
}

/** 偏好输入（账号定位/目标读者）在 localStorage 中的持久化 key */
const LS_KEY_PREFIX = 'mr-huang-agent:today-topics:'
const LS_KEY_POSITIONING = `${LS_KEY_PREFIX}positioning`
const LS_KEY_AUDIENCE = `${LS_KEY_PREFIX}audience`
/** 流水线持久化 key：单 key 存恢复所需的全部状态（stages/expanded/selectedPickIndex/platform） */
const LS_KEY_PIPELINE = `${LS_KEY_PREFIX}pipeline`

/** 合法阶段状态集合（恢复时用于校验） */
const STAGE_STATUS_VALUES: TopicStageState['status'][] = ['idle', 'running', 'done', 'error', 'aborted']

function loadStoredValue(key: string): string {
  try {
    return storageGet(key) ?? ''
  } catch {
    return ''
  }
}

function persistValues(entries: Array<[string, string]>): void {
  try {
    for (const [key, value] of entries) {
      storageSet(key, value)
    }
  } catch {
    // 持久化失败不影响使用
  }
}

/** 校验恢复数据中的工具步骤记录形状，脏数据整条丢弃 */
function sanitizeToolSteps(value: unknown): ToolStepRecord[] {
  if (!Array.isArray(value)) return []
  const steps: ToolStepRecord[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.toolName !== 'string') continue
    steps.push({
      toolName: rec.toolName,
      argsText: typeof rec.argsText === 'string' ? rec.argsText : '',
      resultText: typeof rec.resultText === 'string' ? rec.resultText : '',
      durationMs: typeof rec.durationMs === 'number' ? rec.durationMs : 0,
      ...(typeof rec.error === 'string' ? { error: rec.error } : {}),
    })
  }
  return steps
}

/** 社媒运营专家智能体定义（含联网工具声明） */
const agent = findAgentById('social-media-agent')

export const useTodayTopicsStore = defineStore('today-topics', () => {
  const llmStore = useLlmStore()
  const activeConfig = computed(() => llmStore.activeConfig)

  /* —— 偏好输入区（localStorage 持久化，逻辑移入 store） —— */

  const positioning = ref(loadStoredValue(LS_KEY_POSITIONING))
  const audience = ref(loadStoredValue(LS_KEY_AUDIENCE))
  const platform = ref<string>(TOPIC_PLATFORMS[0])

  /** 偏好变化时持久化 */
  watch([positioning, audience], ([nextPositioning, nextAudience]) => {
    persistValues([
      [LS_KEY_POSITIONING, nextPositioning],
      [LS_KEY_AUDIENCE, nextAudience],
    ])
  })

  /* —— 阶段状态 —— */

  /** 两个 LLM 阶段状态（与 TOPIC_STAGES 一一对应） */
  const stages = reactive<TopicStageState[]>(
    TOPIC_STAGES.map(() => ({ status: 'idle', content: '', errorText: '', toolSteps: [] })),
  )

  /** 卡片折叠状态：运行中自动展开，用户可手动折叠 */
  const expanded = reactive<boolean[]>(TOPIC_STAGES.map(() => true))

  const abortController = ref<AbortController | null>(null)

  /** 流水线整体是否运行中（任一 LLM 阶段 running） */
  const running = computed(() => stages.some((stage) => stage.status === 'running'))

  function buildPreference(): TopicPreference {
    return {
      positioning: positioning.value.trim(),
      audience: audience.value.trim(),
      platform: platform.value,
    }
  }

  /* —— 私有：请求组装 —— */

  function buildEndpoint(baseUrl: string, apiKey: string, modelId: string, temperature: number, timeoutSeconds: number, maxRetries: number): LlmEndpoint {
    return { baseUrl, apiKey, modelId, temperature, timeoutSeconds, maxRetries }
  }

  /** 收集此阶段之前已完成阶段的产出文本（供串联） */
  function collectPrevOutputs(stageIndex: number): Partial<Record<TopicStageId, string>> {
    const prev: Partial<Record<TopicStageId, string>> = {}
    for (let i = 0; i < stageIndex; i++) {
      if (stages[i].status === 'done' && stages[i].content.trim()) {
        prev[TOPIC_STAGES[i].id] = stages[i].content
      }
    }
    return prev
  }

  /** 组装阶段请求消息（system = 智能体提示词 + 阶段指令；user = 偏好 + 前序产出） */
  function buildStageMessages(stageIndex: number, req: TopicPreference): LlmChatMessage[] {
    const stage = TOPIC_STAGES[stageIndex]
    return [
      { role: 'system', content: buildStageSystemMessage(stage, agent?.systemPrompt ?? '') },
      { role: 'user', content: buildStageUserMessage(stage, req, collectPrevOutputs(stageIndex)) },
    ]
  }

  /* —— 私有：LLM 阶段运行 —— */

  /**
   * 运行单个阶段：流式写入 content；桌面端热点扫描阶段走 agent loop（工具步骤进 toolSteps）。
   * 中止时保留已生成内容并标记 aborted；失败写入 errorText（不抛出）。
   */
  async function runStage(stageIndex: number, req: TopicPreference): Promise<void> {
    const config = activeConfig.value
    if (!config) return

    const state = stages[stageIndex]
    const stage = TOPIC_STAGES[stageIndex]
    // 重跑前清空上一轮产出
    state.status = 'running'
    state.content = ''
    state.errorText = ''
    state.toolSteps = []
    expanded[stageIndex] = true

    const controller = new AbortController()
    abortController.value = controller
    // 防串写守卫：若本阶段被新一轮运行接管（旧流尚未感知 abort），旧回调不再回写状态
    const isCurrent = () => abortController.value === controller
    const endpoint = buildEndpoint(
      config.baseUrl,
      config.apiKey,
      config.modelId,
      config.temperature,
      config.timeoutSeconds,
      config.maxRetries,
    )
    const messages = buildStageMessages(stageIndex, req)
    const tools =
      stage.useTools && hasLlmForward() ? resolveToolSchemas(agent?.tools ?? []) : []

    try {
      if (tools.length > 0) {
        await runAgentLoop({
          endpoint,
          messages,
          tools,
          executeTool: executeToolWithPrefs,
          signal: controller.signal,
          handlers: {
            onContent: (piece) => {
              if (!isCurrent()) return
              state.content += piece
            },
          },
          onStep: (info) => {
            if (!isCurrent()) return
            state.toolSteps.push({
              toolName: info.toolName,
              argsText: info.argsText,
              resultText: info.resultText,
              durationMs: info.durationMs,
              ...(info.error ? { error: info.error } : {}),
            } satisfies ToolStepRecord)
          },
        })
      } else {
        await streamChatCompletion({
          endpoint,
          messages,
          signal: controller.signal,
          handlers: {
            onContent: (piece) => {
              if (!isCurrent()) return
              state.content += piece
            },
          },
        })
      }
      if (!isCurrent()) return
      if (state.content.trim()) {
        state.status = 'done'
      } else {
        state.status = 'error'
        state.errorText = state.toolSteps.length
          ? '工具阶段未产出正文，请重试本阶段。'
          : '模型未返回任何内容，请检查模型 ID 是否正确后重试。'
      }
    } catch (err) {
      // 被新一轮运行接管时丢弃旧结果，不覆盖新运行的状态
      if (!isCurrent()) return
      if (isAbortError(err)) {
        state.status = 'aborted'
      } else {
        state.status = 'error'
        state.errorText = describeLlmError(err, config.baseUrl)
      }
    } finally {
      if (abortController.value === controller) {
        abortController.value = null
      }
    }
  }

  /* —— 编排入口 —— */

  /** 单阶段重试成功后，后续阶段产出已过时：重置为待运行 */
  function resetDownstream(stageIndex: number): void {
    for (let i = stageIndex + 1; i < stages.length; i++) {
      stages[i].status = 'idle'
      stages[i].content = ''
      stages[i].errorText = ''
      stages[i].toolSteps = []
    }
  }

  /** 前序阶段是否全部完成（单阶段重试的前置条件） */
  function prerequisitesDone(stageIndex: number): boolean {
    for (let i = 0; i < stageIndex; i++) {
      if (stages[i].status !== 'done') return false
    }
    return true
  }

  function stop(): void {
    abortController.value?.abort()
  }

  /** 顺序执行整个流水线：某阶段未完成（失败/中止）即停下 */
  async function runPipeline(): Promise<void> {
    const req = buildPreference()
    for (let i = 0; i < TOPIC_STAGES.length; i++) {
      await runStage(i, req)
      if (stages[i].status !== 'done') return
    }
  }

  /** 点击「看看今天有什么可写」/「换一批」：清空全部阶段后从头执行（重新抓取） */
  async function startPipeline(): Promise<void> {
    stop()
    for (let i = 0; i < stages.length; i++) {
      stages[i].status = 'idle'
      stages[i].content = ''
      stages[i].errorText = ''
      stages[i].toolSteps = []
      expanded[i] = true
    }
    await runPipeline()
  }

  /** 单阶段重试：使用此前阶段已完成的产出重新运行本阶段 */
  async function retryStage(stageIndex: number): Promise<void> {
    if (running.value) return
    if (!prerequisitesDone(stageIndex)) return
    await runStage(stageIndex, buildPreference())
    if (stages[stageIndex].status === 'done') {
      resetDownstream(stageIndex)
    }
  }

  /* —— 选题卡片（Block 3：解析评估阶段的严格 JSON，派生状态随 store 常驻） —— */

  /** 评估阶段完成后解析出的推荐选题列表（解析失败为 null） */
  const parsedPicks = computed<TopicPick[] | null>(() => {
    const evalStage = stages[1]
    if (evalStage.status !== 'done' || !evalStage.content.trim()) return null
    return parsePicks(evalStage.content)
  })

  /** 评估阶段产出非空但解析失败 → 卡片块降级为原文展示 */
  const parseFailed = computed(() => {
    const evalStage = stages[1]
    return evalStage.status === 'done' && evalStage.content.trim().length > 0 && !parsedPicks.value
  })

  /** 卡片块状态：随评估阶段推导（评估运行中→运行中；完成→解析成功/失败；其余→待运行） */
  const cardsStatus = computed<TopicStageState['status']>(() => {
    const evalStatus = stages[1].status
    if (evalStatus === 'running') return 'running'
    if (evalStatus === 'done') return parsedPicks.value ? 'done' : 'error'
    return 'idle'
  })

  /** 卡片块状态徽标文案（解析失败单独提示） */
  const cardsStatusLabel = computed(() =>
    cardsStatus.value === 'error' ? '解析失败' : TOPIC_STATUS_LABEL[cardsStatus.value],
  )

  /** 是否已有可展示的结果（用于控制「换一批」按钮显隐） */
  const hasResult = computed(() => stages.some((stage) => stage.status === 'done'))

  /* —— 卡片选择模式：单选当前要写的话题 —— */

  /** 选中卡片下标（用下标而非 topic 做 key：topic 同轮可能重复，避免选中歧义） */
  const selectedPickIndex = ref<number | null>(null)

  /* —— 流水线持久化：单 key 存全部恢复所需状态，关闭应用后原样恢复 —— */

  /** 恢复上次会话的流水线状态；结构不符整体丢弃，静默降级为全新状态（不抛错） */
  function restorePipeline(): void {
    let raw: unknown
    try {
      raw = JSON.parse(storageGet(LS_KEY_PIPELINE) ?? 'null')
    } catch {
      return
    }
    if (typeof raw !== 'object' || raw === null) return
    const saved = raw as Record<string, unknown>
    if (!Array.isArray(saved.stages) || saved.stages.length !== TOPIC_STAGES.length) return
    if (!Array.isArray(saved.expanded) || saved.expanded.length !== TOPIC_STAGES.length) return
    if (saved.expanded.some((flag) => typeof flag !== 'boolean')) return

    const restored: TopicStageState[] = []
    for (const item of saved.stages) {
      if (typeof item !== 'object' || item === null) return
      const rec = item as Record<string, unknown>
      // running 阶段在进程关闭后不可能仍在运行：恢复为 aborted 并保留已产出内容（可单阶段重试）
      let status: TopicStageState['status'] = 'idle'
      if (rec.status === 'running') {
        status = 'aborted'
      } else if (STAGE_STATUS_VALUES.includes(rec.status as TopicStageState['status'])) {
        status = rec.status as TopicStageState['status']
      }
      restored.push({
        status,
        content: typeof rec.content === 'string' ? rec.content : '',
        errorText: typeof rec.errorText === 'string' ? rec.errorText : '',
        toolSteps: sanitizeToolSteps(rec.toolSteps),
      })
    }

    for (let i = 0; i < restored.length; i++) {
      stages[i] = restored[i]
    }
    expanded.splice(0, expanded.length, ...(saved.expanded as boolean[]))
    // platform 非法时回落默认值（保持初始值不动）
    const savedPlatform = saved.platform
    if (typeof savedPlatform === 'string' && TOPIC_PLATFORMS.some((item) => item === savedPlatform)) {
      platform.value = savedPlatform
    }
    // 选中下标需与当前解析结果匹配：parsedPicks 为 null 或越界即清掉脏值
    if (typeof saved.selectedPickIndex === 'number') {
      const picks = parsedPicks.value
      selectedPickIndex.value =
        picks !== null && picks[saved.selectedPickIndex] !== undefined
          ? saved.selectedPickIndex
          : null
    }
  }

  /** 防抖写入：流式追加期间高频触发，合并为最后一次写入，保证最终态一定落盘 */
  let persistTimer: ReturnType<typeof setTimeout> | null = null

  function persistPipeline(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistValues([
        [
          LS_KEY_PIPELINE,
          JSON.stringify({
            stages: stages.map((stage) => ({
              status: stage.status,
              content: stage.content,
              errorText: stage.errorText,
              toolSteps: stage.toolSteps,
            })),
            expanded: [...expanded],
            selectedPickIndex: selectedPickIndex.value,
            platform: platform.value,
          }),
        ],
      ])
    }, 400)
  }

  restorePipeline()
  watch([stages, expanded, platform, selectedPickIndex], persistPipeline, { deep: true })

  return {
    positioning,
    audience,
    platform,
    stages,
    expanded,
    selectedPickIndex,
    running,
    activeConfig,
    parsedPicks,
    parseFailed,
    cardsStatus,
    cardsStatusLabel,
    hasResult,
    startPipeline,
    stop,
    retryStage,
    prerequisitesDone,
  }
})
