/**
 * 公众号写作流水线 store：
 * - 把运行状态与编排逻辑从视图组件抽出到 Pinia（store 常驻内存），切换左侧菜单后
 *   运行中的任务继续执行、流式增量照常写入 store；回到页面时原样展示（含流式中途进度）；
 * - 视图只负责表单绑定与展示；路由相关（query.topic 预填）由视图挂载时调用
 *   applyQueryTopic 传入，store 不 import vue-router，与路由解耦；
 * - 流水线状态 localStorage 持久化（主 key：需求表单/阶段产出/折叠/配图 prompt 元数据）：
 *   关闭应用重开后自动恢复，running 状态归一化为 aborted、旧版含 url/status 的配图数据整体丢弃，仅「清空」时删除；
 * - 配图成图 dataUrl 体积大，单独存独立 key（LS_KEY_IMAGES），主 key 持久化时剥掉，
 *   防止配额溢出导致整条流水线状态停止持久化；恢复时按下标 + role 校验后合并，不匹配即丢弃。
 *
 * 阶段编排：热点信息提取（桌面端带工具）→ 选题与大纲 → 正文撰写 → 润色去 AI 味
 * → 封面与插图（LLM 规划配图 prompt JSON，只产出 prompt 清单不在应用内生图）。
 */
import { defineStore } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

import { findAgentById } from '@/lib/agents'
import { hasLlmForward } from '@/lib/desktop-bridge'
import type { ToolStepRecord } from '@/lib/group-chat'
import { describeLlmError, isAbortError, runAgentLoop, streamChatCompletion } from '@/lib/llm'
import type { LlmChatMessage, LlmEndpoint } from '@/lib/llm'
import { executeToolWithPrefs, resolveToolSchemas } from '@/lib/tool-executor'
import {
  WRITING_GOALS,
  WRITING_STAGES,
  buildImagePlanMessages,
  buildStageSystemMessage,
  buildStageUserMessage,
  parseImagePlan,
} from '@/lib/wechat-writing'
import type {
  ImagePlan,
  ImagePromptItem,
  WritingRequirement,
  WritingStageId,
} from '@/lib/wechat-writing'
import { useLlmStore } from '@/stores/llm'
import { storageGet, storageRemove, storageSet } from '@/lib/storage'

/** 单个阶段卡片的状态与产出（配图阶段复用结构，content 存规划阶段的模型输出） */
export interface PipelineStageState {
  status: 'idle' | 'running' | 'done' | 'error' | 'aborted'
  content: string
  errorText: string
  toolSteps: ToolStepRecord[]
}

/** 润色阶段（文章正文来源）与配图阶段在 stages 数组中的下标 */
const POLISH_INDEX = 3
const IMAGES_INDEX = 4

/** 流水线持久化 key：单 key 存恢复所需的全部状态（表单/stages/expanded/images） */
const LS_KEY_PIPELINE = 'mr-huang-agent:wechat-writing'

/**
 * 配图成图持久化 key：只存 dataUrl 槽位数组（与 images 下标对齐，空位为 null）。
 * 与主 key 分离——dataUrl 体积大，塞进主 key 会让配额溢出导致整条流水线状态停止持久化。
 */
const LS_KEY_IMAGES = 'mr-huang-agent:wechat-writing-images'

/** 独立 key 中的单个成图槽位：role 用于恢复时按下标 + role 校验匹配，不匹配即丢弃 */
interface PersistedImageSlot {
  role: ImagePromptItem['role']
  dataUrl: string
}

/** 合法阶段状态集合（恢复时用于校验） */
const STAGE_STATUS_VALUES: PipelineStageState['status'][] = ['idle', 'running', 'done', 'error', 'aborted']

/** 持久化写入（含删除）：localStorage 不可用/配额满时静默降级，不影响页面 */
function persistValue(key: string, value: string | null): void {
  try {
    if (value === null) {
      storageRemove(key)
    } else {
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

/**
 * 校验恢复数据中的配图 prompt 条目：role/prompt/ratio/size 齐备才保留，anchor/caption 可选。
 * 旧版（应用内生图时期）条目带 url/status 字段且无 ratio，结构不符直接丢弃，恢复为空列表，
 * 用户重新规划即可——不允许脏数据把恢复流程搞崩。dataUrl 不在主 key 存储（独立 key 见
 * restoreImageData），这里显式重建条目顺带剥掉，保证主 key 恢复结果不含成图数据。
 */
function sanitizeImages(value: unknown): ImagePromptItem[] {
  if (!Array.isArray(value)) return []
  const images: ImagePromptItem[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    // 旧版数据带 url/status 字段：一律视为过期结构丢弃
    if (typeof rec.url !== 'undefined' || typeof rec.status !== 'undefined') continue
    if ((rec.role !== 'cover' && rec.role !== 'illustration') || typeof rec.prompt !== 'string' || typeof rec.ratio !== 'string' || typeof rec.size !== 'string') {
      continue
    }
    images.push({
      role: rec.role,
      prompt: rec.prompt,
      ratio: rec.ratio,
      size: rec.size,
      ...(typeof rec.anchor === 'string' ? { anchor: rec.anchor } : {}),
      ...(typeof rec.caption === 'string' ? { caption: rec.caption } : {}),
    })
  }
  return images
}

/**
 * 恢复成图 dataUrl：独立 key 的槽位数组与 images 元数据按下标对齐合并。
 * role 不匹配（期间配图被重新规划过）或槽位结构不符的条目直接丢弃；独立 key 读取失败静默跳过。
 */
function restoreImageData(target: ImagePromptItem[]): void {
  let raw: unknown
  try {
    raw = JSON.parse(storageGet(LS_KEY_IMAGES) ?? 'null')
  } catch {
    return
  }
  if (!Array.isArray(raw)) return
  for (let i = 0; i < raw.length && i < target.length; i++) {
    const slot = raw[i] as PersistedImageSlot | null
    if (typeof slot !== 'object' || slot === null) continue
    if (typeof slot.dataUrl !== 'string' || !slot.dataUrl.startsWith('data:image/')) continue
    if (slot.role !== target[i].role) continue
    target[i] = { ...target[i], dataUrl: slot.dataUrl }
  }
}

/** 社媒运营专家智能体定义（含联网工具声明） */
const agent = findAgentById('social-media-agent')

export const useWechatWritingStore = defineStore('wechat-writing', () => {
  const llmStore = useLlmStore()
  const activeConfig = computed(() => llmStore.activeConfig)

  /* —— 需求表单（随 store 常驻，切路由输入不丢） —— */

  const topic = ref('')
  const mpName = ref('')
  const mpBio = ref('')
  const authorRole = ref('')
  const positioning = ref('')
  const audience = ref('')
  const goal = ref<string>(WRITING_GOALS[0])
  const styleText = ref('')

  /* —— 阶段状态 —— */

  /** 各阶段状态（与 WRITING_STAGES 一一对应） */
  const stages = reactive<PipelineStageState[]>(
    WRITING_STAGES.map(() => ({ status: 'idle', content: '', errorText: '', toolSteps: [] })),
  )

  /** 卡片折叠状态：运行中自动展开，用户可手动折叠 */
  const expanded = reactive<boolean[]>(WRITING_STAGES.map(() => true))

  /** 配图阶段产物（封面与插图的生图 prompt 清单，用户复制去外部工具生图；dataUrl 存上传的成图） */
  const images = ref<ImagePromptItem[]>([])

  /* —— 配图成图上传（dataUrl 独立 key 持久化，见 LS_KEY_IMAGES） —— */

  /** 清空独立 key 中的成图数据：重新规划/清空配图时同步调用，避免旧图残留与配额占用 */
  function clearImageData(): void {
    persistValue(LS_KEY_IMAGES, null)
  }

  /** 记录用户上传的成图 dataUrl（index + role 双重校验：弹窗期间配图被重规划时错位丢弃） */
  function setImageDataUrl(index: number, role: ImagePromptItem['role'], dataUrl: string): void {
    const item = images.value[index]
    if (!item || item.role !== role) return
    images.value[index] = { ...item, dataUrl }
  }

  const abortController = ref<AbortController | null>(null)

  /** 流水线整体是否运行中（任一阶段 running） */
  const running = computed(() => stages.some((stage) => stage.status === 'running'))

  /** 「今日选题」跳转携带 ?topic=：由视图在挂载时调用（store 不感知路由） */
  function applyQueryTopic(value: unknown): void {
    if (typeof value === 'string' && value.trim()) {
      topic.value = value.trim()
    }
  }

  function buildRequirement(): WritingRequirement {
    return {
      topic: topic.value.trim(),
      mpName: mpName.value.trim(),
      mpBio: mpBio.value.trim(),
      authorRole: authorRole.value.trim(),
      positioning: positioning.value.trim(),
      audience: audience.value.trim(),
      goal: goal.value,
      style: styleText.value.trim(),
    }
  }

  /* —— 私有：请求组装 —— */

  function buildEndpoint(baseUrl: string, apiKey: string, modelId: string, temperature: number, timeoutSeconds: number, maxRetries: number): LlmEndpoint {
    return { baseUrl, apiKey, modelId, temperature, timeoutSeconds, maxRetries }
  }

  /** 收集此阶段之前已完成阶段的产出文本（供串联） */
  function collectPrevOutputs(stageIndex: number): Partial<Record<WritingStageId, string>> {
    const prev: Partial<Record<WritingStageId, string>> = {}
    for (let i = 0; i < stageIndex; i++) {
      if (stages[i].status === 'done' && stages[i].content.trim()) {
        prev[WRITING_STAGES[i].id] = stages[i].content
      }
    }
    return prev
  }

  /** 组装阶段请求消息（system = 智能体提示词 + 阶段指令；user = 需求 + 前序产出） */
  function buildStageMessages(stageIndex: number, req: WritingRequirement): LlmChatMessage[] {
    const stage = WRITING_STAGES[stageIndex]
    return [
      { role: 'system', content: buildStageSystemMessage(stage, agent?.systemPrompt ?? '') },
      { role: 'user', content: buildStageUserMessage(stage, req, collectPrevOutputs(stageIndex)) },
    ]
  }

  /* —— 私有：LLM 阶段运行 —— */

  /**
   * 运行单个 LLM 阶段：流式写入 content；桌面端热点阶段走 agent loop（工具步骤进 toolSteps）。
   * 中止时保留已生成内容并标记 aborted；失败写入 errorText（不抛出）。
   */
  async function runStage(stageIndex: number, req: WritingRequirement): Promise<void> {
    const config = activeConfig.value
    if (!config) return

    const state = stages[stageIndex]
    const stage = WRITING_STAGES[stageIndex]
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

  /* —— 配图阶段（LLM 规划配图 prompt，应用内不生图） —— */

  /**
   * 运行配图阶段：基于润色全文做一次 LLM 规划调用，要求严格 JSON（解析失败重试一次）。
   * 解析成功即阶段完成——产出为 prompt 条目列表（1 封面 + 3-5 插图），图片由用户
   * 复制 prompt 去外部生图工具生成，这里不再调用应用内生的生图工具（GLM-Image 太慢，已下线该路径）。
   */
  async function runImagesStage(req: WritingRequirement): Promise<void> {
    const config = activeConfig.value
    if (!config) return

    const state = stages[IMAGES_INDEX]
    state.status = 'running'
    state.content = ''
    state.errorText = ''
    state.toolSteps = []
    expanded[IMAGES_INDEX] = true
    images.value = []
    // 重新规划配图：旧上传成图一并作废，同步清空独立 key
    clearImageData()

    const controller = new AbortController()
    abortController.value = controller
    const isCurrent = () => abortController.value === controller
    const endpoint = buildEndpoint(
      config.baseUrl,
      config.apiKey,
      config.modelId,
      config.temperature,
      config.timeoutSeconds,
      config.maxRetries,
    )

    try {
      // 配图规划（流式输出便于观察，解析失败重试一次）
      let plan: ImagePlan | null = null
      for (let attempt = 0; attempt < 2 && !plan; attempt++) {
        if (attempt > 0) state.content = ''
        await streamChatCompletion({
          endpoint,
          messages: buildImagePlanMessages(agent?.systemPrompt ?? '', req, stages[POLISH_INDEX].content),
          signal: controller.signal,
          handlers: {
            onContent: (piece) => {
              if (!isCurrent()) return
              state.content += piece
            },
          },
        })
        if (!isCurrent()) return
        plan = parseImagePlan(state.content)
      }
      if (!plan) {
        state.status = 'error'
        state.errorText = '配图方案解析失败：模型未按要求返回 JSON，请重试本阶段。'
        return
      }

      // 规划成功即完成：封面 1 张 + 插图 3-5 张的 prompt 清单，交给视图渲染为可复制卡片
      images.value = [
        {
          role: 'cover',
          prompt: plan.cover.prompt,
          ratio: plan.cover.ratio,
          size: plan.cover.size,
        },
        ...plan.illustrations.map((item) => ({
          role: 'illustration' as const,
          prompt: item.prompt,
          ratio: item.ratio,
          size: item.size,
          anchor: item.anchor,
          caption: item.caption,
        })),
      ]
      state.status = 'done'
    } catch (err) {
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

  /** 重跑某阶段前，后续阶段产出基于旧产出已过时：重置为待运行 */
  function resetDownstream(stageIndex: number): void {
    for (let i = stageIndex + 1; i < stages.length; i++) {
      stages[i].status = 'idle'
      stages[i].content = ''
      stages[i].errorText = ''
      stages[i].toolSteps = []
    }
    if (stageIndex < IMAGES_INDEX) {
      images.value = []
      // 配图会重新规划：旧上传成图作废，同步清空独立 key
      clearImageData()
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

  /** 从指定阶段顺序执行到末尾：某阶段未完成（失败/中止）即停下 */
  async function runPipelineFrom(startIndex: number): Promise<void> {
    const req = buildRequirement()
    for (let i = startIndex; i < WRITING_STAGES.length; i++) {
      if (WRITING_STAGES[i].id === 'images') {
        await runImagesStage(req)
      } else {
        await runStage(i, req)
      }
      if (stages[i].status !== 'done') return
    }
  }

  /** 点击「开始写作」：清空全部阶段后从头执行 */
  async function startPipeline(): Promise<void> {
    if (!buildRequirement().topic) return
    stop()
    for (let i = 0; i < stages.length; i++) {
      stages[i].status = 'idle'
      stages[i].content = ''
      stages[i].errorText = ''
      stages[i].toolSteps = []
      expanded[i] = true
    }
    images.value = []
    await runPipelineFrom(0)
  }

  /** 从该阶段继续执行流水线，成功自动接力后续；重跑前先重置下游 */
  async function retryStage(stageIndex: number): Promise<void> {
    if (running.value) return
    const req = buildRequirement()
    if (!req.topic) return
    if (!prerequisitesDone(stageIndex)) return
    resetDownstream(stageIndex)
    await runPipelineFrom(stageIndex)
  }

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

    // 需求表单优先恢复：即使阶段/折叠数据结构不符（旧版本或脏数据），用户已填的表单也不能丢
    if (typeof saved.topic === 'string') topic.value = saved.topic
    if (typeof saved.mpName === 'string') mpName.value = saved.mpName
    if (typeof saved.mpBio === 'string') mpBio.value = saved.mpBio
    if (typeof saved.authorRole === 'string') authorRole.value = saved.authorRole
    if (typeof saved.positioning === 'string') positioning.value = saved.positioning
    if (typeof saved.audience === 'string') audience.value = saved.audience
    if (typeof saved.styleText === 'string') styleText.value = saved.styleText
    const savedGoal = saved.goal
    if (typeof savedGoal === 'string' && WRITING_GOALS.some((item) => item === savedGoal)) {
      goal.value = savedGoal
    }

    // 阶段数据结构不符时仅放弃恢复阶段部分，表单字段已在上方恢复
    if (!Array.isArray(saved.stages) || saved.stages.length !== WRITING_STAGES.length) return
    if (!Array.isArray(saved.expanded) || saved.expanded.length !== WRITING_STAGES.length) return
    if (saved.expanded.some((flag) => typeof flag !== 'boolean')) return

    const restored: PipelineStageState[] = []
    for (const item of saved.stages) {
      if (typeof item !== 'object' || item === null) return
      const rec = item as Record<string, unknown>
      // running 阶段在进程关闭后不可能仍在运行：恢复为 aborted 并保留已产出内容（可单阶段重试）
      let status: PipelineStageState['status'] = 'idle'
      if (rec.status === 'running') {
        status = 'aborted'
      } else if (STAGE_STATUS_VALUES.includes(rec.status as PipelineStageState['status'])) {
        status = rec.status as PipelineStageState['status']
      }
      restored.push({
        status,
        content: typeof rec.content === 'string' ? rec.content : '',
        errorText: typeof rec.errorText === 'string' ? rec.errorText : '',
        toolSteps: sanitizeToolSteps(rec.toolSteps),
      })
    }

    // 需求表单已在函数开头恢复，这里只负责阶段产出
    for (let i = 0; i < restored.length; i++) {
      stages[i] = restored[i]
    }
    expanded.splice(0, expanded.length, ...(saved.expanded as boolean[]))
    // 配图：结构不符（含旧版带 url/status 的数据）整体丢弃（见 sanitizeImages），恢复为空列表
    images.value = sanitizeImages(saved.images)
    // 成图 dataUrl 存在独立 key，按下标 + role 校验后合并回条目（见 restoreImageData）
    restoreImageData(images.value)
  }

  /** 防抖写入：流式追加期间高频触发，合并为最后一次写入，保证最终态一定落盘 */
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  /** 「清空」后置位：跳过下一次防抖写入（清空语义是删数据而非写回初始快照） */
  let skipNextPersist = false

  function persistPipeline(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      if (skipNextPersist) {
        skipNextPersist = false
        persistValue(LS_KEY_PIPELINE, null)
        persistValue(LS_KEY_IMAGES, null)
        return
      }
      // 成图 dataUrl 体积大：单独存独立 key（与 images 下标对齐的槽位数组），
      // 无任何成图时直接删 key；主 key 里剥掉 dataUrl，防止配额溢出拖垮整条流水线状态
      const imageSlots = images.value.map((item) =>
        item.dataUrl ? { role: item.role, dataUrl: item.dataUrl } : null,
      )
      persistValue(
        LS_KEY_IMAGES,
        imageSlots.some((slot) => slot !== null) ? JSON.stringify(imageSlots) : null,
      )
      // AbortController 与 computed（running/activeConfig）为运行期对象，不参与序列化
      persistValue(
        LS_KEY_PIPELINE,
        JSON.stringify({
          topic: topic.value,
          mpName: mpName.value,
          mpBio: mpBio.value,
          authorRole: authorRole.value,
          positioning: positioning.value,
          audience: audience.value,
          goal: goal.value,
          styleText: styleText.value,
          stages: stages.map((stage) => ({
            status: stage.status,
            content: stage.content,
            errorText: stage.errorText,
            toolSteps: stage.toolSteps,
          })),
          expanded: [...expanded],
          // 主 key 只存 prompt 元数据（dataUrl 走独立 key，见上方 imageSlots）
          images: images.value.map((item) => ({
            role: item.role,
            prompt: item.prompt,
            ratio: item.ratio,
            size: item.size,
            ...(item.anchor ? { anchor: item.anchor } : {}),
            ...(item.caption ? { caption: item.caption } : {}),
          })),
        }),
      )
    }, 500)
  }

  /** 点击「清空」：表单、全部阶段产出与配图回到初始态，并同步删除持久化数据 */
  function clearAll(): void {
    stop()
    topic.value = ''
    mpName.value = ''
    mpBio.value = ''
    authorRole.value = ''
    positioning.value = ''
    audience.value = ''
    goal.value = WRITING_GOALS[0]
    styleText.value = ''
    for (let i = 0; i < stages.length; i++) {
      stages[i].status = 'idle'
      stages[i].content = ''
      stages[i].errorText = ''
      stages[i].toolSteps = []
      expanded[i] = true
    }
    images.value = []
    // 状态重置会触发 watch，置位跳过防抖写入，直接删除 localStorage 中的持久化数据（含成图独立 key）
    skipNextPersist = true
    persistValue(LS_KEY_PIPELINE, null)
    clearImageData()
  }

  restorePipeline()
  watch(
    [topic, mpName, mpBio, authorRole, positioning, audience, goal, styleText, stages, expanded, images],
    persistPipeline,
    { deep: true },
  )

  return {
    topic,
    mpName,
    mpBio,
    authorRole,
    positioning,
    audience,
    goal,
    styleText,
    stages,
    expanded,
    images,
    running,
    activeConfig,
    applyQueryTopic,
    buildRequirement,
    startPipeline,
    stop,
    clearAll,
    retryStage,
    prerequisitesDone,
    setImageDataUrl,
  }
})
