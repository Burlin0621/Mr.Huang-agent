<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'

import AgentAvatar from '@/components/AgentAvatar.vue'
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
import GroupAvatar from '@/components/GroupAvatar.vue'
import RichText from '@/components/RichText.vue'
import ToolStepCard from '@/components/ToolStepCard.vue'
import { formatSessionTime } from '@/stores/conversations'
import { useAgentsStore } from '@/stores/agents'
import { useGroupChatsStore } from '@/stores/group-chats'
import { useLlmStore, type LlmConfig } from '@/stores/llm'
import { useSkillsStore } from '@/stores/skills'
import { describeLlmError, isAbortError, type LlmEndpoint } from '@/lib/llm'
import { executeToolWithPrefs } from '@/lib/tool-executor'
import type { AgentAvatar as AgentAvatarData } from '@/lib/agents'
import {
  GROUP_CHAT_MAX_ROUNDS,
  USER_SENDER_ID,
  type GroupChat,
  type TranscriptEntry,
  type TranscriptMention,
} from '@/lib/group-chat'
import {
  runGroupChat,
  type ModeratorVerdict,
  type OrchestratorMember,
} from '@/lib/orchestrator'

const agentsStore = useAgentsStore()
const groupChatsStore = useGroupChatsStore()
const llmStore = useLlmStore()
const skillsStore = useSkillsStore()

/* —— 左侧：发起群聊面板 + 会话列表 —— */

/** 建群面板展开状态 */
const showCreatePanel = ref(false)

/** 新建表单：勾选的成员（按勾选顺序即发言顺序）与任务 */
const selectedAgentIds = ref<string[]>([])
const taskDraft = ref('')

/** 成员级模型绑定：agentId → llm 配置 id（勾选成员时默认 = 当前激活配置） */
const memberConfigIds = reactive<Record<string, string>>({})
/** 主持人模型配置 id（默认 = 当前激活配置） */
const moderatorConfigId = ref<string>(llmStore.activeConfigId)

/** 模型配置下拉项：配置名 + 厂商标签 */
const configOptions = computed(() =>
  llmStore.configs.map((config) => ({
    id: config.id,
    label: `${config.name}（${config.providerKey === 'custom' ? '自定义' : config.providerKey}）`,
  })),
)

/** 成员/主持人未显式指定配置时的回退项：当前激活配置 */
const fallbackConfig = computed<LlmConfig | null>(() => llmStore.activeConfig)

/** 解析某配置 id 对应的端点；id 为空或失效时回退激活配置 */
function resolveEndpoint(configId: string, fallback: LlmEndpoint | null): LlmEndpoint | null {
  const config = llmStore.configs.find((item) => item.id === configId) ?? fallbackConfig.value
  if (!config) return fallback
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelId: config.modelId,
    temperature: config.temperature,
    timeoutSeconds: config.timeoutSeconds,
    maxRetries: config.maxRetries,
  }
}

function toggleAgent(agentId: string): void {
  if (selectedAgentIds.value.includes(agentId)) {
    selectedAgentIds.value = selectedAgentIds.value.filter((id) => id !== agentId)
    delete memberConfigIds[agentId]
  } else {
    selectedAgentIds.value = [...selectedAgentIds.value, agentId]
    // 新勾选的成员默认跟随当前激活配置（这里直接存 id 便于下拉回显）
    memberConfigIds[agentId] = llmStore.activeConfigId
  }
}

const selectedAgents = computed(() =>
  selectedAgentIds.value
    .map((id) => agentsStore.findAgent(id))
    .filter((agent): agent is NonNullable<typeof agent> => Boolean(agent)),
)

const createError = ref('')

/* —— @ 补全（@ 成员 / @ 技能）—— */

/** @ 候选项（成员来自当前群的成员，首聊时来自勾选成员；技能来自技能中心启用清单） */
interface MentionCandidate {
  kind: 'member' | 'skill'
  id: string
  name: string
  description: string
  avatar?: AgentAvatarData
  icon: string
}

const mentionOpen = ref(false)
/** 当前补全触发字符：'@' 只补成员，'/' 只补技能 */
const mentionTrigger = ref<'@' | '/' | null>(null)
const mentionQuery = ref('')
const mentionIndex = ref(0)
/** 本次输入已确认的 @ 引用（发送时写入插话条目并生效；kind 语义不变，仅 UI 触发字符区分） */
const pendingMentions = ref<TranscriptMention[]>([])
const composerEl = ref<HTMLTextAreaElement | null>(null)

/** 当前可 @ 的成员 id 列表：已有群聊用其成员，首聊用勾选成员 */
const mentionMemberIds = computed<string[]>(() => currentGroupChat.value?.members ?? selectedAgentIds.value)

const mentionCandidates = computed<MentionCandidate[]>(() => {
  const query = mentionQuery.value.trim().toLowerCase()
  const matched = (text: string): boolean => !query || text.toLowerCase().includes(query)
  // 按触发字符拆开：@ → 成员；/ → 技能
  if (mentionTrigger.value === '@') {
    const members: MentionCandidate[] = []
    for (const id of mentionMemberIds.value) {
      const agent = agentsStore.findAgent(id)
      if (!agent || !matched(agent.name)) continue
      members.push({
        kind: 'member',
        id: agent.id,
        name: agent.name,
        description: agent.description,
        avatar: agent.avatar,
        icon: agent.icon,
      })
    }
    return members
  }
  if (mentionTrigger.value === '/') {
    return skillsStore.enabledSkills
      .filter((skill) => matched(skill.name))
      .map((skill) => ({
        kind: 'skill' as const,
        id: skill.id,
        name: skill.name,
        description: skill.description,
        icon: skill.icon,
      }))
  }
  return []
})

/** 输入时检测光标前是否有未完成的 @/ / token，触发/关闭对应补全面板 */
function onComposerInput(): void {
  const el = composerEl.value
  if (!el) return
  const caret = el.selectionStart ?? taskDraft.value.length
  const match = /(^|\s)([@/])([^\s@/]*)$/.exec(taskDraft.value.slice(0, caret))
  if (match) {
    mentionTrigger.value = match[2] === '@' ? '@' : '/'
    mentionQuery.value = match[3]
    mentionIndex.value = 0
    mentionOpen.value = mentionCandidates.value.length > 0
  } else {
    mentionOpen.value = false
    mentionTrigger.value = null
  }
}

function onComposerKeydown(event: KeyboardEvent): void {
  if (!mentionOpen.value) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    mentionIndex.value = (mentionIndex.value + 1) % mentionCandidates.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    mentionIndex.value =
      (mentionIndex.value - 1 + mentionCandidates.value.length) % mentionCandidates.value.length
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    event.preventDefault()
    const candidate = mentionCandidates.value[mentionIndex.value]
    if (candidate) pickMention(candidate)
  } else if (event.key === 'Escape') {
    mentionOpen.value = false
    mentionTrigger.value = null
  }
}

/** 选中候选项：把光标前的 @/ / token 替换为「@名称 」/「/名称 」，并记录引用 */
function pickMention(candidate: MentionCandidate): void {
  const el = composerEl.value
  const caret = el?.selectionStart ?? taskDraft.value.length
  const before = taskDraft.value.slice(0, caret)
  const match = /(^|\s)([@/])([^\s@/]*)$/.exec(before)
  if (match) {
    const tokenStart = caret - match[3].length - 1
    const token = candidate.kind === 'member' ? `@${candidate.name}` : `/${candidate.name}`
    taskDraft.value = `${taskDraft.value.slice(0, tokenStart)}${token} ${taskDraft.value.slice(caret)}`
  }
  if (!pendingMentions.value.some((m) => m.kind === candidate.kind && m.id === candidate.id)) {
    pendingMentions.value = [
      ...pendingMentions.value,
      { kind: candidate.kind, id: candidate.id, name: candidate.name },
    ]
  }
  mentionOpen.value = false
  mentionTrigger.value = null
  el?.focus()
}

/** 从 mentions 收集续聊编排参数：@ 成员 → 首位发言者；@ 技能 → 注入内容（被删成员/空技能忽略） */
function collectMentionEffects(): {
  firstSpeakerAgentId?: string
  skillInjections: Array<{ name: string; content: string }>
} {
  const firstSpeakerAgentId = pendingMentions.value.find(
    (mention) => mention.kind === 'member' && Boolean(agentsStore.findAgent(mention.id)),
  )?.id
  const skillInjections = pendingMentions.value
    .filter((mention) => mention.kind === 'skill')
    .map((mention) => ({
      name: mention.name,
      content: skillsStore.findSkill(mention.id)?.template ?? '',
    }))
    .filter((injection) => injection.content.trim().length > 0)
  return { firstSpeakerAgentId, skillInjections }
}

/** 用户插话内容按引用 token 切分（气泡内高亮用）：成员 → @名称；技能 → /名称（旧数据按新规则回放） */
function splitUserContent(
  content: string,
  mentions: TranscriptMention[],
): Array<{ text: string; name?: string; kind?: 'member' | 'skill' }> {
  if (!content) return []
  const tokens = [
    ...new Set(mentions.map((mention) => `${mention.kind === 'skill' ? '/' : '@'}${mention.name}`)),
  ].sort((a, b) => b.length - a.length)
  let segments: Array<{ text: string; name?: string; kind?: 'member' | 'skill' }> = [{ text: content }]
  for (const token of tokens) {
    const kind: 'member' | 'skill' = token.startsWith('/') ? 'skill' : 'member'
    const next: Array<{ text: string; name?: string; kind?: 'member' | 'skill' }> = []
    for (const segment of segments) {
      if (segment.name) {
        next.push(segment)
        continue
      }
      const pieces = segment.text.split(token)
      pieces.forEach((piece, index) => {
        if (index > 0) next.push({ text: token, name: token, kind })
        if (piece) next.push({ text: piece })
      })
    }
    segments = next
  }
  return segments
}

const currentGroupChat = computed<GroupChat | null>(() =>
  activeId.value ? groupChatsStore.findGroupChat(activeId.value) : null,
)

/* —— 会话列表展示辅助 —— */

/** 群头像九宫格成员（被删除的成员回退占位） */
function resolvedMembers(
  groupChat: GroupChat,
): Array<{ avatar?: AgentAvatarData; icon: string; name: string }> {
  return groupChat.members.map((id) => {
    const agent = agentsStore.findAgent(id)
    if (!agent) return { icon: '', name: '?' }
    return { avatar: agent.avatar, icon: agent.icon, name: agent.name }
  })
}

/** 最近一条消息预览（灰字，CSS 截断） */
function lastPreview(groupChat: GroupChat): string {
  if (groupChat.status === 'delivered') {
    return `【交付物】${groupChat.deliverable || '（生成中）'}`
  }
  const last = groupChat.transcript[groupChat.transcript.length - 1]
  if (!last) return groupChat.task
  const name = memberInfo(last.agentId).name
  const content = last.content || (last.errorText ? '（发言失败）' : '…')
  return `${name}：${content}`
}

/* —— 主区：运行时状态 —— */

const activeId = ref('')
const running = ref(false)
const abortController = ref<AbortController | null>(null)
const runError = ref('')
/** 流式期间的成员发言（store 内的响应式对象引用）与交付文本增量 */
const streamingEntryAgentId = ref('')
const deliverableDraft = ref('')
/** 主持人判定提示（运行时时间线用） */
interface TimelineRound {
  kind: 'round'
  round: number
}
interface TimelineVerdict {
  kind: 'verdict'
  round: number
  verdict: ModeratorVerdict
  forced: boolean
}
interface TimelineSpeech {
  kind: 'speech'
  entry: TranscriptEntry
}
type TimelineItem = TimelineRound | TimelineVerdict | TimelineSpeech

const timeline = reactive<TimelineItem[]>([])

const messagesScrollRef = ref<HTMLElement | null>(null)

async function scrollMessagesToBottom(): Promise<void> {
  await nextTick()
  const el = messagesScrollRef.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 打开历史群聊：按 transcript 重建时间线（轮次分隔），交付态直接展示交付卡 */
function openGroupChat(id: string): void {
  if (running.value) return
  activeId.value = id
  runError.value = ''
  deliverableDraft.value = ''
  streamingEntryAgentId.value = ''
  rebuildTimelineFromStore()
  void scrollMessagesToBottom()
}

function rebuildTimelineFromStore(): void {
  timeline.length = 0
  const groupChat = currentGroupChat.value
  if (!groupChat) return
  let lastRound = 0
  for (const entry of groupChat.transcript) {
    if (entry.round !== lastRound) {
      timeline.push({ kind: 'round', round: entry.round })
      lastRound = entry.round
    }
    timeline.push({ kind: 'speech', entry })
  }
}

/** 按成员 id 解析展示信息（成员被删除后回退占位，旧记录不致报错） */
function memberInfo(agentId: string): { name: string; found: boolean } {
  const agent = agentsStore.findAgent(agentId)
  if (!agent) return { name: '已移除的成员', found: false }
  return { name: agent.name, found: true }
}

/** 回放时某成员使用的模型配置名（''/缺失 = 当时跟随激活配置，不展示标签） */
function memberModelLabel(agentId: string): string {
  const groupChat = currentGroupChat.value
  const configId = groupChat?.memberConfigIds?.[agentId] ?? ''
  if (!configId) return ''
  return llmStore.configs.find((config) => config.id === configId)?.name ?? '配置已删除'
}

/** 回放时主持人使用的模型配置名 */
function moderatorModelLabel(): string {
  const groupChat = currentGroupChat.value
  const configId = groupChat?.moderatorConfigId ?? ''
  if (!configId) return ''
  return llmStore.configs.find((config) => config.id === configId)?.name ?? '配置已删除'
}

/* —— 开始 / 续聊 / 插话 —— */

const startDisabledReason = computed(() => {
  if (running.value) return '群聊进行中…'
  if (!fallbackConfig.value) return '请先在「设置」中配置并选择模型'
  if (!currentGroupChat.value && selectedAgentIds.value.length === 0) {
    return '请先在「发起群聊」中勾选成员'
  }
  if (!canSend()) return '输入任务，输入 @ 引用成员、/ 引用技能'
  return ''
})

/** 底部输入栏可发送：有群聊时 @ 点名（无正文）也可发送；首聊必须带任务正文 */
function canSend(): boolean {
  if (!fallbackConfig.value || mentionOpen.value) return false
  const hasText = taskDraft.value.trim().length > 0
  const hasMention = pendingMentions.value.length > 0
  if (!currentGroupChat.value) {
    return !running.value && hasText && selectedAgentIds.value.length > 0
  }
  return (hasText || hasMention) && currentGroupChat.value.members.length > 0
}

const sendLabel = computed(() => {
  if (running.value) return '插话'
  return currentGroupChat.value?.status === 'delivered' ? '继续讨论' : '发送'
})

/** 从群聊持久化绑定解析成员端点（被删除的成员跳过），并解析主持人端点 */
function resolveEndpointsFromGroupChat(groupChat: GroupChat): {
  members: OrchestratorMember[]
  memberEndpoints: Record<string, LlmEndpoint>
  moderatorEndpoint: LlmEndpoint | null
} {
  const members: OrchestratorMember[] = []
  const memberEndpoints: Record<string, LlmEndpoint> = {}
  for (const agentId of groupChat.members) {
    const agent = agentsStore.findAgent(agentId)
    if (!agent) continue
    const endpoint = resolveEndpoint(groupChat.memberConfigIds?.[agentId] ?? '', null)
    if (!endpoint) continue
    members.push({ agentId: agent.id, name: agent.name, systemPrompt: agent.systemPrompt, tools: agent.tools })
    memberEndpoints[agent.id] = endpoint
  }
  const moderatorEndpoint = resolveEndpoint(groupChat.moderatorConfigId ?? '', fallbackConfig.value)
  return { members, memberEndpoints, moderatorEndpoint }
}

/** 运行若干轮讨论（首轮与续聊/插话共用）；结束回写交付物或保留进度 */
async function runDiscussion(
  id: string,
  members: OrchestratorMember[],
  memberEndpoints: Record<string, LlmEndpoint>,
  moderatorEndpoint: LlmEndpoint,
  task: string,
  opts: {
    startRound?: number
    firstSpeakerAgentId?: string
    skillInjections?: Array<{ name: string; content: string }>
  } = {},
): Promise<void> {
  runError.value = ''
  const groupChat = groupChatsStore.findGroupChat(id)
  if (!groupChat) return

  running.value = true
  const controller = new AbortController()
  abortController.value = controller

  try {
    const result = await runGroupChat({
      memberEndpoints,
      moderatorEndpoint,
      members,
      task,
      // 传入 store 内的响应式数组：运行中的用户插话对后续成员立即可见
      transcript: groupChat.transcript,
      startRound: opts.startRound,
      firstSpeakerAgentId: opts.firstSpeakerAgentId,
      skillInjections: opts.skillInjections,
      maxRounds: GROUP_CHAT_MAX_ROUNDS,
      signal: controller.signal,
      executeTool: executeToolWithPrefs,
      handlers: {
        onRoundStart: (round) => {
          timeline.push({ kind: 'round', round })
          void scrollMessagesToBottom()
        },
        onSpeakerStart: (entry) => {
          streamingEntryAgentId.value = entry.agentId
          // 条目已由编排器推入 store 响应式数组：取代理对象，流式更新可触发渲染
          const stored =
            groupChat.transcript.length > 0
              ? groupChat.transcript[groupChat.transcript.length - 1]
              : entry
          timeline.push({ kind: 'speech', entry: stored.agentId === entry.agentId ? stored : entry })
          void scrollMessagesToBottom()
        },
        onDelta: () => {
          void scrollMessagesToBottom()
        },
        onSpeakerEnd: () => {
          streamingEntryAgentId.value = ''
        },
        onVerdict: (verdict, round) => {
          timeline.push({ kind: 'verdict', round, verdict, forced: false })
          void scrollMessagesToBottom()
        },
        onDeliverableStart: () => {
          deliverableDraft.value = ''
        },
        onDeliverableDelta: (text) => {
          deliverableDraft.value += text
          void scrollMessagesToBottom()
        },
        onDeliverableEnd: (text) => {
          deliverableDraft.value = ''
          groupChatsStore.finishGroupChat(id, text)
        },
      },
    })
    if (result.aborted) {
      runError.value = '已停止：群聊被手动中止，当前进度已保存'
    } else if (!result.lastVerdict?.canDeliver) {
      // 硬性熔断：轮数用尽仍不可交付时，强制收敛并补充一条判定提示
      timeline.push({
        kind: 'verdict',
        round: result.rounds,
        verdict: result.lastVerdict ?? { canDeliver: false, nextRoundTopic: '', reason: '' },
        forced: true,
      })
    }
  } catch (err) {
    runError.value = isAbortError(err)
      ? '已停止：群聊被手动中止，当前进度已保存'
      : `群聊执行失败：${describeLlmError(err)}`
  } finally {
    running.value = false
    abortController.value = null
    streamingEntryAgentId.value = ''
    rebuildTimelineFromStore()
    void scrollMessagesToBottom()
  }
}

async function startGroupChat(): Promise<void> {
  const task = taskDraft.value.trim()
  const memberAgents = selectedAgents.value
  if (!fallbackConfig.value || !task || memberAgents.length === 0) return

  const memberEndpoints: Record<string, LlmEndpoint> = {}
  for (const agent of memberAgents) {
    const endpoint = resolveEndpoint(memberConfigIds[agent.id] ?? '', null)
    if (!endpoint) return
    memberEndpoints[agent.id] = endpoint
  }
  const moderatorEndpoint = resolveEndpoint(moderatorConfigId.value, fallbackConfig.value)
  if (!moderatorEndpoint) return

  createError.value = ''
  const id = groupChatsStore.createGroupChat(
    memberAgents.map((agent) => agent.id),
    task,
    {
      memberConfigIds: { ...memberConfigIds },
      moderatorConfigId: moderatorConfigId.value,
    },
  )
  activeId.value = id
  showCreatePanel.value = false
  timeline.length = 0
  deliverableDraft.value = ''

  const members: OrchestratorMember[] = memberAgents.map((agent) => ({
    agentId: agent.id,
    name: agent.name,
    systemPrompt: agent.systemPrompt,
    tools: agent.tools,
  }))

  // 首聊也可在任务里 @ 成员 / @ 技能，效果与续聊一致
  const effects = collectMentionEffects()
  const firstSpeakerAgentId = effects.firstSpeakerAgentId
  pendingMentions.value = []
  taskDraft.value = ''

  await runDiscussion(id, members, memberEndpoints, moderatorEndpoint, task, {
    firstSpeakerAgentId,
    skillInjections: effects.skillInjections,
  })
}

/** 已有群聊下的发送：空闲→开新一轮；已交付→重开并续聊；进行中→插话（下一轮生效） */
async function continueGroupChat(): Promise<void> {
  const groupChat = currentGroupChat.value
  if (!groupChat || !fallbackConfig.value) return
  const text = taskDraft.value.trim()
  if (!text && pendingMentions.value.length === 0) return

  const { members, memberEndpoints, moderatorEndpoint } = resolveEndpointsFromGroupChat(groupChat)
  if (!moderatorEndpoint || members.length === 0) {
    runError.value = '模型配置缺失或成员已全部删除，无法继续讨论'
    return
  }

  const effects = collectMentionEffects()
  const mentions = [...pendingMentions.value]
  const nextRound = (groupChat.transcript[groupChat.transcript.length - 1]?.round ?? 0) + 1
  const wasDelivered = groupChat.status === 'delivered'

  const entry: TranscriptEntry = {
    agentId: USER_SENDER_ID,
    content: text,
    round: nextRound,
    ts: Date.now(),
    role: 'user',
    mentions,
  }
  const stored = groupChatsStore.appendTranscriptEntry(groupChat.id, entry)
  timeline.push({ kind: 'speech', entry: stored ?? entry })
  void scrollMessagesToBottom()

  taskDraft.value = ''
  pendingMentions.value = []
  if (wasDelivered) groupChatsStore.reopenGroupChat(groupChat.id)

  await runDiscussion(groupChat.id, members, memberEndpoints, moderatorEndpoint, groupChat.task, {
    startRound: nextRound,
    firstSpeakerAgentId: effects.firstSpeakerAgentId,
    skillInjections: effects.skillInjections,
  })
}

/** 底部输入栏统一发送入口：无群聊→建群开始；有群聊→续聊/插话 */
async function sendComposer(): Promise<void> {
  if (!canSend()) return
  if (!currentGroupChat.value) {
    await startGroupChat()
  } else {
    await continueGroupChat()
  }
}

function stopGroupChat(): void {
  abortController.value?.abort()
}

/* —— 交付物：复制 / 导出 —— */

const copyState = ref<'idle' | 'ok'>('idle')

const deliverableText = computed(() => {
  if (deliverableDraft.value) return deliverableDraft.value
  return currentGroupChat.value?.status === 'delivered'
    ? currentGroupChat.value.deliverable
    : ''
})

async function copyDeliverable(): Promise<void> {
  if (!deliverableText.value) return
  try {
    await navigator.clipboard.writeText(deliverableText.value)
    copyState.value = 'ok'
    setTimeout(() => {
      copyState.value = 'idle'
    }, 1600)
  } catch {
    // 剪贴板不可用时静默降级
  }
}

function exportDeliverable(): void {
  const groupChat = currentGroupChat.value
  if (!groupChat || !deliverableText.value) return
  const header = `# ${groupChat.title}\n\n> 任务：${groupChat.task}\n> 成员：${groupChat.members
    .map((id) => memberInfo(id).name)
    .join('、')}\n> 产出时间：${new Date(groupChat.updatedAt).toLocaleString('zh-CN')}\n\n---\n\n`
  const blob = new Blob([`${header}${deliverableText.value}\n`], {
    type: 'text/markdown;charset=utf-8',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `群聊交付-${groupChat.title}.md`
  anchor.click()
  URL.revokeObjectURL(url)
}

function deleteGroupChat(id: string): void {
  if (running.value && id === activeId.value) return
  groupChatsStore.removeGroupChat(id)
  if (activeId.value === id) activeId.value = ''
}

function statusLabel(groupChat: GroupChat): string {
  if (groupChat.status === 'delivered') return '已交付'
  return running.value && groupChat.id === activeId.value ? '讨论中' : '待继续'
}
</script>

<template>
  <div class="group-page">
    <!-- 最左：会话列表栏 -->
    <aside class="conv-panel">
      <button
        class="btn btn-primary new-chat-button"
        type="button"
        :disabled="running"
        @click="showCreatePanel = !showCreatePanel"
      >
        <AppIcon name="plus" />
        发起群聊
      </button>

      <section v-if="showCreatePanel" class="card create-panel" aria-labelledby="create-title">
        <h2 id="create-title" class="panel-title">
          发起群聊
          <button class="icon-button" type="button" aria-label="收起建群面板" @click="showCreatePanel = false">
            <AppIcon name="close" />
          </button>
        </h2>

        <div class="field-label">选择成员（按顺序发言）</div>
        <ul class="agent-pick-list">
          <li v-for="agent in agentsStore.enabledAgents" :key="agent.id" class="agent-pick-slot">
            <button
              type="button"
              class="agent-pick-item"
              :class="{ 'is-selected': selectedAgentIds.includes(agent.id) }"
              :disabled="running"
              @click="toggleAgent(agent.id)"
            >
              <span class="agent-pick-avatar">
                <AgentAvatar :avatar="agent.avatar" :icon="agent.icon" :name="agent.name" />
              </span>
              <span class="agent-pick-meta">
                <span class="agent-pick-name">{{ agent.name }}</span>
                <span class="agent-pick-desc">{{ agent.description }}</span>
              </span>
              <span v-if="selectedAgentIds.includes(agent.id)" class="agent-pick-order">
                {{ selectedAgentIds.indexOf(agent.id) + 1 }}
              </span>
            </button>
            <select
              v-if="selectedAgentIds.includes(agent.id)"
              v-model="memberConfigIds[agent.id]"
              class="member-model-select"
              :disabled="running"
              :aria-label="`成员 ${agent.name} 使用的模型配置`"
            >
              <option value="">跟随当前激活配置</option>
              <option v-for="opt in configOptions" :key="opt.id" :value="opt.id">
                {{ opt.label }}
              </option>
            </select>
          </li>
        </ul>

        <label class="field-label" for="moderator-config">主持人模型（收敛判定与最终汇总）</label>
        <select
          id="moderator-config"
          v-model="moderatorConfigId"
          class="member-model-select"
          :disabled="running"
        >
          <option value="">跟随当前激活配置</option>
          <option v-for="opt in configOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
        </select>

        <p class="panel-hint">任务在右侧底部输入框填写，点「发送任务」开始。</p>
        <p v-if="createError" class="panel-warn">{{ createError }}</p>
      </section>

      <ul class="conv-list" aria-label="群聊会话列表">
        <li v-for="groupChat in groupChatsStore.sortedGroupChats" :key="groupChat.id" class="conv-slot">
          <button
            type="button"
            class="conv-item"
            :class="{ 'is-active': groupChat.id === activeId }"
            :disabled="running"
            @click="openGroupChat(groupChat.id)"
          >
            <span class="conv-avatar">
              <GroupAvatar :members="resolvedMembers(groupChat)" />
            </span>
            <span class="conv-meta">
              <span class="conv-row">
                <span class="conv-title">{{ groupChat.title }}</span>
                <span class="conv-time">{{ formatSessionTime(groupChat.updatedAt) }}</span>
              </span>
              <span class="conv-row">
                <span class="conv-preview">{{ lastPreview(groupChat) }}</span>
                <span
                  class="conv-badge"
                  :class="groupChat.status === 'delivered' ? 'is-delivered' : 'is-discussing'"
                >
                  {{ statusLabel(groupChat) }}
                </span>
              </span>
            </span>
          </button>
          <button
            type="button"
            class="icon-button conv-delete"
            aria-label="删除群聊"
            :disabled="running"
            @click="deleteGroupChat(groupChat.id)"
          >
            <AppIcon name="trash" />
          </button>
        </li>
      </ul>
    </aside>

    <!-- 中+右：聊天窗口 -->
    <section class="chat-window">
      <template v-if="currentGroupChat">
        <!-- 顶栏 -->
        <header class="chat-topbar">
          <div class="chat-topbar-left">
            <span class="chat-avatar">
              <GroupAvatar :members="resolvedMembers(currentGroupChat)" />
            </span>
            <div class="chat-topbar-meta">
              <span class="chat-title">{{ currentGroupChat.title }}</span>
              <span class="chat-subtitle">
                {{ currentGroupChat.members.length }} 位成员 ·
                ⚖ 主持人 · {{ moderatorModelLabel() || '跟随激活配置' }}
              </span>
            </div>
            <div class="member-stack" tabindex="0">
              <span
                v-for="memberId in currentGroupChat.members"
                :key="memberId"
                class="member-stack-avatar"
                :title="memberInfo(memberId).name"
              >
                <AgentAvatar
                  v-if="agentsStore.findAgent(memberId)"
                  :avatar="agentsStore.findAgent(memberId)!.avatar"
                  :icon="agentsStore.findAgent(memberId)!.icon"
                  :name="memberInfo(memberId).name"
                />
                <template v-else>?</template>
              </span>
              <div class="member-popover" role="tooltip">
                <div v-for="memberId in currentGroupChat.members" :key="memberId" class="member-popover-row">
                  <span class="member-popover-avatar">
                    <AgentAvatar
                      v-if="agentsStore.findAgent(memberId)"
                      :avatar="agentsStore.findAgent(memberId)!.avatar"
                      :icon="agentsStore.findAgent(memberId)!.icon"
                      :name="memberInfo(memberId).name"
                    />
                  </span>
                  <span class="member-popover-name">{{ memberInfo(memberId).name }}</span>
                  <span class="member-popover-model">
                    {{ memberModelLabel(memberId) || '跟随激活配置' }}
                  </span>
                </div>
              </div>
            </div>
          </div>
          <div class="chat-topbar-right">
            <span
              v-if="currentGroupChat.status === 'delivered' && !running"
              class="badge badge-info"
            >
              已交付
            </span>
            <button v-if="running" class="btn btn-ghost" type="button" @click="stopGroupChat">
              <AppIcon name="close" />
              停止
            </button>
          </div>
        </header>

        <!-- 消息区 -->
        <div ref="messagesScrollRef" class="messages" aria-label="群聊消息流">
          <!-- 任务 = 自己发的右侧气泡 -->
          <div class="message is-self">
            <span class="message-avatar is-self-avatar" aria-hidden="true">我</span>
            <div class="bubble is-self-bubble">
              <p class="bubble-text">{{ currentGroupChat.task }}</p>
            </div>
          </div>

          <template v-for="(item, index) in timeline" :key="index">
            <div v-if="item.kind === 'round'" class="time-divider">
              <span>第 {{ item.round }} 轮</span>
            </div>

            <div v-else-if="item.kind === 'verdict'" class="system-notice" :class="{ 'is-forced': item.forced }">
              <span class="system-notice-icon" aria-hidden="true">⚖</span>
              第 {{ item.round }} 轮结束：主持人判定{{
                item.verdict.canDeliver ? '可以交付' : '需继续讨论'
              }}{{ item.forced ? '（已达到轮数上限，强制收敛）' : '' }}——{{
                item.verdict.reason || item.verdict.nextRoundTopic || '（无说明）'
              }}
            </div>

            <article
              v-else-if="item.entry.role === 'user'"
              class="message is-self"
            >
              <span class="message-avatar is-self-avatar" aria-hidden="true">我</span>
              <div class="message-main is-self-main">
                <header class="message-head is-self-head">
                  <span class="message-time">{{ formatSessionTime(item.entry.ts) }}</span>
                </header>
                <div class="bubble is-self-bubble">
                  <p class="bubble-text">
                    <template
                      v-for="(segment, segIndex) in splitUserContent(
                        item.entry.content,
                        item.entry.mentions ?? [],
                      )"
                      :key="segIndex"
                    ><span
                      v-if="segment.name"
                      class="mention-highlight"
                      :class="{ 'is-skill': segment.kind === 'skill' }"
                    >{{ segment.text }}</span><template v-else>{{ segment.text }}</template></template>
                  </p>
                  <p v-if="!item.entry.content" class="bubble-text is-mention-only">
                    {{ (item.entry.mentions ?? []).some((m) => m.kind === 'member') ? '（点名发言）' : '（插话）' }}
                  </p>
                </div>
              </div>
            </article>

            <article
              v-else
              class="message"
              :class="{
                'is-streaming':
                  running && streamingEntryAgentId === item.entry.agentId && index === timeline.length - 1,
              }"
            >
              <span class="message-avatar">
                <AgentAvatar
                  v-if="agentsStore.findAgent(item.entry.agentId)"
                  :avatar="agentsStore.findAgent(item.entry.agentId)!.avatar"
                  :icon="agentsStore.findAgent(item.entry.agentId)!.icon"
                  :name="memberInfo(item.entry.agentId).name"
                />
                <template v-else>?</template>
              </span>
              <div class="message-main">
                <header class="message-head">
                  <span class="message-name">{{ memberInfo(item.entry.agentId).name }}</span>
                  <span
                    v-if="memberModelLabel(item.entry.agentId)"
                    class="message-model"
                    title="该成员本次使用的模型配置"
                  >
                    {{ memberModelLabel(item.entry.agentId) }}
                  </span>
                  <span class="message-time">{{ formatSessionTime(item.entry.ts) }}</span>
                </header>
                  <div class="bubble is-agent-bubble">
                    <div v-if="item.entry.toolSteps?.length" class="entry-tools">
                      <ToolStepCard
                        v-for="(step, stepIndex) in item.entry.toolSteps"
                        :key="stepIndex"
                        :step="step"
                      />
                    </div>
                    <RichText
                      class="bubble-text is-rich"
                      :content="item.entry.content || '（本次发言失败）'"
                    />
                    <p v-if="item.entry.errorText" class="bubble-error">
                      发言失败：{{ item.entry.errorText }}
                    </p>
                  </div>
              </div>
            </article>
          </template>

          <!-- 交付物卡片 -->
          <div v-if="deliverableText" class="message is-self is-deliverable">
            <div class="deliverable card">
              <header class="deliverable-head">
                <span class="badge badge-info">交付物</span>
                <span class="deliverable-title">主持人汇总 · 最终交付</span>
                <span class="deliverable-actions">
                  <button class="btn btn-ghost" type="button" @click="copyDeliverable">
                    <AppIcon :name="copyState === 'ok' ? 'check' : 'copy'" />
                    {{ copyState === 'ok' ? '已复制' : '复制' }}
                  </button>
                  <button
                    class="btn btn-ghost"
                    type="button"
                    :disabled="!currentGroupChat || currentGroupChat.status !== 'delivered'"
                    @click="exportDeliverable"
                  >
                    <AppIcon name="download" />
                    导出 .md
                  </button>
                </span>
              </header>
              <p class="deliverable-content-label">交付内容</p>
              <RichText class="deliverable-content is-rich" :content="deliverableText" />
            </div>
          </div>

          <p v-if="runError" class="run-error">{{ runError }}</p>
        </div>
      </template>

      <EmptyState
        v-else
        class="chat-empty"
        title="还没有群聊"
        description="点击左上角「发起群聊」，选择多个智能体成员并配置模型，在下方输入任务后发送；成员轮流讨论，主持人收敛后生成交付物。"
      >
        <button class="btn btn-primary" type="button" :disabled="running" @click="showCreatePanel = true">
          <AppIcon name="plus" />
          发起群聊
        </button>
      </EmptyState>

      <!-- 底部输入栏 -->
      <footer class="composer">
        <div v-if="mentionOpen" class="mention-pop">
          <button
            v-for="(candidate, candidateIndex) in mentionCandidates"
            :key="`${candidate.kind}:${candidate.id}`"
            type="button"
            class="mention-option"
            :class="{ 'is-active': candidateIndex === mentionIndex }"
            :title="candidate.description"
            @mousedown.prevent
            @click="pickMention(candidate)"
            @mousemove="mentionIndex = candidateIndex"
          >
            <span class="mention-option-avatar">
              <AgentAvatar
                v-if="candidate.kind === 'member'"
                :avatar="candidate.avatar"
                :icon="candidate.icon"
                :name="candidate.name"
              />
              <template v-else>{{ candidate.icon || '⚡' }}</template>
            </span>
            <span class="mention-option-name">
              {{ candidate.kind === 'member' ? '@' : '/' }}{{ candidate.name }}
              <span class="mention-option-kind">
                {{ candidate.kind === 'member' ? '成员' : '技能' }}
              </span>
            </span>
            <span class="mention-option-desc">{{ candidate.description }}</span>
          </button>
          <p v-if="mentionCandidates.length === 0" class="mention-empty">
            {{ mentionTrigger === '@' ? '没有匹配的成员' : '没有匹配的技能' }}
          </p>
        </div>
        <textarea
          id="group-task"
          ref="composerEl"
          v-model="taskDraft"
          class="composer-input"
          rows="2"
          :placeholder="
            running
              ? '群聊进行中，可 @ 成员 / 技能插话，下一轮生效…'
              : '输入任务或插话：@ 引用成员，/ 引用技能…'
          "
          @input="onComposerInput"
          @keydown="onComposerKeydown"
          @blur="mentionOpen = false"
        ></textarea>
        <div class="composer-foot">
          <span class="composer-hint">
            {{ running ? '群聊进行中…插话将在下一轮生效' : startDisabledReason || `最多 ${GROUP_CHAT_MAX_ROUNDS} 轮 · 主持人自动收敛` }}
          </span>
          <button
            class="composer-send"
            type="button"
            :aria-label="sendLabel"
            :title="sendLabel"
            :disabled="!canSend()"
            @click="sendComposer"
          >
            <AppIcon name="send" />
          </button>
        </div>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.group-page {
  display: flex;
  gap: var(--space-4);
  height: 100%;
  min-height: 0;
}

/* —— 最左：会话列表栏（导航面板沉底：muted 底，建群卡片以 surface 白卡浮起） —— */
.conv-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  width: 288px;
  flex-shrink: 0;
  min-height: 0;
  background: var(--color-surface-muted);
  border-right: 1px solid var(--color-border);
  overflow-y: auto;
}

.new-chat-button {
  justify-content: center;
  flex-shrink: 0;
  margin: var(--space-3) var(--space-3) 0;
}

.create-panel {
  margin: 0 var(--space-3);
  padding: var(--space-3);
  flex-shrink: 0;
  max-height: 55%;
  overflow-y: auto;
}

.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: var(--font-size-md);
  font-weight: 600;
}

.panel-hint {
  margin-top: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

.panel-warn {
  margin-top: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}

.field-label {
  display: block;
  margin-top: var(--space-3);
  margin-bottom: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  font-weight: 600;
}

.agent-pick-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-height: 220px;
  overflow-y: auto;
}

.agent-pick-slot {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.agent-pick-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.agent-pick-item:hover:not(:disabled) {
  border-color: var(--color-brand);
}

.agent-pick-item.is-selected {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.agent-pick-item:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.agent-pick-avatar {
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  font-size: 16px;
}

.agent-pick-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.agent-pick-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.agent-pick-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.agent-pick-order {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: var(--font-size-xs);
  font-weight: 700;
}

.member-model-select {
  width: 100%;
  padding: 4px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-family: inherit;
}

.member-model-select:focus {
  outline: none;
  border-color: var(--color-brand);
}

.member-model-select:disabled {
  opacity: 0.6;
}

/* 会话列表 */
.conv-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  min-height: 0;
  margin-top: var(--space-1);
  padding: 0 var(--space-3) var(--space-3);
}

.conv-slot {
  position: relative;
  display: flex;
  align-items: stretch;
}

.conv-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  min-width: 0;
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border: 0;
  border-left: 3px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: var(--color-text);
  transition: background-color var(--transition-fast);
}

/* muted 面板底上的 hover：提亮到 surface，形成「白卡浮起」层级 */
.conv-item:hover:not(:disabled) {
  background: var(--color-surface);
}

.conv-item.is-active {
  background: var(--color-brand-soft);
  border-left-color: var(--color-brand);
}

.conv-item:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.conv-avatar {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--color-border);
}

.conv-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.conv-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.conv-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-time {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.conv-preview {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conv-badge {
  flex-shrink: 0;
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
}

.conv-badge.is-delivered {
  background: var(--color-brand-soft);
  color: var(--color-brand);
}

.conv-badge.is-discussing {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
}

/* hover 时浮现的删除入口 */
.conv-delete {
  position: absolute;
  right: var(--space-1);
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 28px;
  opacity: 0;
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transition: opacity var(--transition-fast);
}

.conv-slot:hover .conv-delete:not(:disabled) {
  opacity: 1;
}

/* —— 中+右：聊天窗口 —— */
.chat-window {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
}

.chat-empty {
  flex: 1;
  justify-content: center;
}

/* 顶栏 */
.chat-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
  flex-shrink: 0;
}

.chat-topbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.chat-avatar {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--color-border);
}

.chat-topbar-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.chat-title {
  font-size: var(--font-size-md);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-subtitle {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 成员头像堆叠 + hover 展开面板 */
.member-stack {
  position: relative;
  display: flex;
  align-items: center;
  cursor: default;
}

.member-stack-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-full);
  overflow: hidden;
  font-size: 13px;
  border: 2px solid var(--color-surface);
  background: var(--color-surface-muted);
  margin-left: -8px;
}

.member-stack-avatar:first-child {
  margin-left: 0;
}

.member-popover {
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 20;
  min-width: 240px;
  padding: var(--space-2) var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md, var(--shadow-sm));
}

.member-stack:hover .member-popover,
.member-stack:focus-within .member-popover {
  display: block;
}

.member-popover-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-1) 0;
}

.member-popover-avatar {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  overflow: hidden;
  font-size: 12px;
}

.member-popover-name {
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.member-popover-model {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.chat-topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

/* 消息区 */
.messages {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  overflow-y: auto;
  padding: var(--space-5) var(--space-6);
  background: var(--color-bg);
}

.message {
  display: flex;
  gap: var(--space-3);
  max-width: 82%;
}

.message-main {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.message-avatar {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  font-size: 18px;
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
}

.message-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding-left: var(--space-1);
}

.message-name {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-secondary);
}

.message-model {
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 160px;
}

.message-time {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* 气泡（与 ChatView 同语言：不对称圆角贴纸感——成员气泡左下小圆角、自己气泡右下小圆角） */
.bubble {
  position: relative;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-lg);
  width: fit-content;
  max-width: 100%;
}

.bubble.is-agent-bubble {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
  border-bottom-left-radius: var(--radius-sm);
}

/* 成员气泡内的工具卡片容器（卡片样式见 ToolStepCard 组件） */
.entry-tools {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}

.bubble.is-self-bubble {
  background: var(--color-brand);
  color: var(--color-on-brand);
  border-bottom-right-radius: var(--radius-sm);
}

.bubble-text {
  font-size: var(--font-size-sm);
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 成员发言为 Markdown 渲染容器：块级元素自带换行，关闭 pre-wrap 避免双重换行 */
.bubble-text.is-rich {
  white-space: normal;
}

.bubble-error {
  margin-top: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-danger);
  border-top: 1px dashed var(--color-border);
  padding-top: var(--space-2);
}

/* 自己发的消息：整行靠右、头像在右 */
.message.is-self {
  align-self: flex-end;
  flex-direction: row-reverse;
}

.message-avatar.is-self-avatar {
  border-radius: var(--radius-full);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-brand);
  background: var(--color-brand-soft);
  border: 1px solid var(--color-brand);
}

/* 流式打字光标 */
.message.is-streaming .bubble-text::after {
  content: '▍';
  color: var(--color-brand);
  animation: blink 1s steps(1) infinite;
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}

/* 轮次分隔：仿微信居中时间戳 */
.time-divider {
  display: flex;
  justify-content: center;
}

.time-divider span {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  background: var(--color-surface-muted);
  padding: 2px var(--space-3);
  border-radius: var(--radius-full);
  letter-spacing: 2px;
}

/* 主持人判定：居中系统提示条 */
.system-notice {
  align-self: center;
  max-width: 76%;
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: 1.7;
  text-align: left;
}

.system-notice.is-forced {
  border-color: var(--color-brand);
  color: var(--color-brand);
}

/* 交付物卡片：靠右醒目展示 */
.message.is-deliverable {
  align-self: flex-end;
  max-width: 92%;
}

.deliverable {
  border: 2px solid var(--color-brand);
  padding: var(--space-4);
  width: 100%;
  box-sizing: border-box;
}

.deliverable-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.deliverable-title {
  flex: 1;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.deliverable-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.deliverable-content {
  margin-top: var(--space-3);
  font-size: var(--font-size-sm);
  line-height: 1.8;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow-y: auto;
}

/* 交付卡为 Markdown 渲染容器：块级元素自带换行，关闭 pre-wrap */
.deliverable-content.is-rich {
  white-space: normal;
}

.deliverable-content-label {
  margin-top: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.run-error {
  align-self: center;
  font-size: var(--font-size-sm);
  color: var(--color-danger);
}

/* —— @ 补全面板 —— */
.mention-pop {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
  max-height: 260px;
  overflow-y: auto;
}

.mention-option {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: var(--color-text);
}

.mention-option.is-active {
  background: var(--color-brand-soft);
}

.mention-option-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  overflow: hidden;
  font-size: 14px;
  background: var(--color-surface-muted);
}

.mention-option-name {
  flex-shrink: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-brand);
}

.mention-option-kind {
  margin-left: var(--space-1);
  padding: 0 var(--space-1);
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  font-size: var(--font-size-xs);
  font-weight: 400;
  color: var(--color-text-muted);
}

.mention-option-desc {
  flex: 1;
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.mention-empty {
  padding: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: center;
}

/* 用户插话：@ 引用高亮（成员主题色 / 技能成功色） */
.mention-highlight {
  color: var(--color-brand);
  font-weight: 600;
}

.mention-highlight.is-skill {
  color: var(--color-success);
}

.bubble-text.is-mention-only {
  color: var(--color-text-secondary);
}

/* 自己气泡为品牌实底时，@ 高亮 / 弱化文本改用 on-brand 语言保证对比度 */
.is-self-bubble .bubble-text.is-mention-only {
  color: var(--color-on-brand);
  opacity: 0.82;
}

.is-self-bubble .mention-highlight {
  color: var(--color-on-brand);
  text-decoration: underline;
}

.is-self-bubble .mention-highlight.is-skill {
  color: var(--color-on-brand);
}

.message-main.is-self-main {
  align-items: flex-end;
}

.message-head.is-self-head {
  padding-left: 0;
  padding-right: var(--space-1);
  justify-content: flex-end;
}

/* 底部输入栏 */
.composer {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}

.composer-input {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-family: inherit;
  line-height: 1.6;
  resize: none;
}

/* focus 态语言与 ChatView composer 一致：brand-200 描边 + 极淡橙晕 */
.composer-input:focus,
.composer:focus-within .composer-input {
  outline: none;
  border-color: var(--color-brand-200);
  box-shadow: 0 0 0 3px rgba(255, 106, 0, 0.12);
}

.composer-input:disabled {
  opacity: 0.6;
}

.composer-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.composer-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* 圆形发送按钮：与 ChatView 同一视觉语言 */
.composer-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.composer-send:hover:not(:disabled) {
  background: var(--color-brand-strong);
  box-shadow: 0 0 0 3px rgba(255, 106, 0, 0.14);
}

.composer-send:disabled {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
  cursor: default;
  box-shadow: none;
}

.composer-send .app-icon {
  width: 18px;
  height: 18px;
}

@media (max-width: 900px) {
  .group-page {
    flex-direction: column;
    height: auto;
  }

  .conv-panel {
    width: 100%;
    max-height: none;
  }

  .conv-list {
    max-height: 320px;
  }

  .chat-window {
    min-height: 480px;
  }

  .message {
    max-width: 94%;
  }
}
</style>
