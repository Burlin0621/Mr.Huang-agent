<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'

import { useLlmStore, type LlmConfig } from '@/stores/llm'
import {
  formatSessionTime,
  useConversationsStore,
  type ChatMessage,
  type Conversation,
  type ToolStepRecord,
} from '@/stores/conversations'
import {
  DEFAULT_WORKSPACE_ICON,
  useWorkspacesStore,
  WORKSPACE_ICON_PRESETS,
  type Workspace,
} from '@/stores/workspaces'
import { getProviderPreset } from '@/lib/model-presets'
import {
  chatCompletion,
  describeLlmError,
  isAbortError,
  runAgentLoop,
  streamChatCompletion,
  type LlmChatMessage,
  type LlmEndpoint,
} from '@/lib/llm'
import { AGENT_TOOLS, type AgentToolSchema } from '@/lib/agent-tools'
import { hasDesktopBridge, hasLlmForward, hasVaultBridge, pickFolderViaBridge, readWorkspaceMemory, writeVaultFile } from '@/lib/desktop-bridge'
import {
  buildMcpSystemHint,
  clearActivatedSkillIds,
  consumeActivatedSkillIds,
  executeToolWithPrefs,
  refreshMcpToolSchemas,
  setActiveToolConversationId,
} from '@/lib/tool-executor'
import { DEFAULT_AGENT_ID } from '@/lib/agents'
import { useAgentsStore, type AgentView } from '@/stores/agents'
import { useSkillsStore, type SkillView } from '@/stores/skills'
import {
  buildActivatedSkillBlock,
  buildSkillCatalogBlock,
  matchTriggeredSkillIds,
} from '@/lib/skill-package'
import { usePermissionStore, PERMISSION_MODES, getPermissionModeMeta } from '@/stores/permission'
import { useChatStreamStore } from '@/stores/chat-stream'
import {
  ATTACHMENT_MAX_BYTES,
  buildConversationMarkdown,
  buildConversationHtml,
  buildConversationPlainText,
  buildMemorySystemBlock,
  buildSystemMessage,
  composeUserContent,
  composeUserMultipartContent,
  formatDateTime,
  validateImageSize,
  type ComposeAttachment,
  type ExportMessage,
  type ExportTask,
  type ImageAttachment,
} from '@/lib/chat-compose'
import AgentAvatar from '@/components/AgentAvatar.vue'
import BearMascot from '@/components/BearMascot.vue'
import { useAccountStore } from '@/stores/account'
import {
  buildSummaryPrompt,
  isSummaryUsable,
  KEEP_RECENT,
  mergeCompactedMessages,
  needsCompaction,
  splitForCompaction,
  truncateSummary,
  type ConversationSummary,
} from '@/lib/context-compaction'
import AppIcon from '@/components/AppIcon.vue'
import RichText from '@/components/RichText.vue'
import ToolStepCard from '@/components/ToolStepCard.vue'
import TaskRunCard from '@/components/TaskRunCard.vue'
import CheckpointPanel from '@/components/CheckpointPanel.vue'
import VaultPanel from '@/components/VaultPanel.vue'
import {
  buildParallelGroups,
  buildSubAgentMessages,
  buildTaskSummaryMessage,
  clampStepResultChars,
  clampTaskMaxRounds,
  createTaskRun,
  extractPlanBlock,
  isTaskActive,
  loadTaskDefaults,
  truncateStepResult,
  type TaskRun,
} from '@/lib/task-runner'

const llmStore = useLlmStore()
const { configs, activeConfigId, activeConfig } = storeToRefs(llmStore)

const route = useRoute()
const router = useRouter()
const agentsStore = useAgentsStore()
const skillsStore = useSkillsStore()
const conversationsStore = useConversationsStore()
const workspacesStore = useWorkspacesStore()
const permissionStore = usePermissionStore()
const { activeWorkspaceId, activeWorkspace } = storeToRefs(workspacesStore)

/* —— 工作区记忆（跨会话长期记忆，组件内缓存，切换工作区时刷新） —— */

/** 当前工作区的记忆全文（随请求注入 system；非桌面端为 ''） */
const workspaceMemory = ref('')

/** 拉取当前工作区记忆并更新缓存（过期结果丢弃，避免切换工作区后串台） */
async function refreshWorkspaceMemory(): Promise<void> {
  const workspaceId = activeWorkspaceId.value
  if (!workspaceId) {
    workspaceMemory.value = ''
    return
  }
  const content = await readWorkspaceMemory(workspaceId)
  if (activeWorkspaceId.value === workspaceId) {
    workspaceMemory.value = content
  }
}

watch(activeWorkspaceId, () => void refreshWorkspaceMemory(), { immediate: true })

/* —— 当前使用的模型（配置 × 模型 二维选择） —— */

/** 用户显式选择的模型 ID（'' 表示未显式选择，默认用主模型） */
const activeModelId = ref('')

/** 实际使用的模型：未显式选择、或所选模型不在当前配置中时，回退主模型 */
const currentModelId = computed<string>(() => {
  const config = activeConfig.value
  if (!config) return ''
  return config.modelIds.includes(activeModelId.value)
    ? activeModelId.value
    : (config.modelIds[0] ?? '')
})

/** 在工具栏模型菜单中选择：跨配置切换 + 指定模型，作用于下一条消息 */
function pickModel(configId: string, modelId: string): void {
  if (configId !== activeConfigId.value) {
    activeConfigId.value = configId
  }
  activeModelId.value = modelId
  closePopover()
}

/**
 * 应用智能体的默认模型绑定：
 * - 绑定存在（modelConfigId 非空）且该配置仍在 configs 中时，切换配置与模型；
 *   绑定的 modelId 不在该配置 modelIds 中时回退 ''（主模型）；
 * - 未绑定或配置已被删除时不改动当前选择（用户仍可随时在模型菜单手动改）。
 */
function applyAgentModelBinding(agent: AgentView | undefined): void {
  if (!agent?.modelConfigId) return
  const config = configs.value.find((item) => item.id === agent.modelConfigId)
  if (!config) return
  activeConfigId.value = config.id
  activeModelId.value = config.modelIds.includes(agent.modelId) ? agent.modelId : ''
}

/* —— 会话消息（持久化到会话工作区 store） —— */

function createMessage(role: 'user' | 'assistant'): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content: '',
    createdAt: Date.now(),
    reasoning: '',
    status: role === 'user' ? 'done' : 'streaming',
    errorText: '',
    toolSteps: [],
  }
}

/** 草稿态（无 id）下的临时消息（如未配置模型的错误提示；不持久化，切换路由时清空） */
const draftMessages = ref<ChatMessage[]>([])

/** 路由中的对话 id（'' 表示草稿态） */
const currentConversationId = computed<string>(() => {
  const param = route.params.conversationId
  return typeof param === 'string' ? param : ''
})

/** 当前打开的对话（按路由参数解析；不存在返回 null） */
const currentConversation = computed<Conversation | null>(() => {
  const id = currentConversationId.value
  return id ? conversationsStore.findConversation(id) : null
})

/* —— 检查点与回滚：会话 id 随工具 context 透传给主进程；侧栏入口打开检查点面板 —— */

/** 检查点面板开关（侧栏「检查点」按钮 / 任务卡片内按钮） */
const showCheckpointPanel = ref(false)

// 切换/新建对话时同步激活会话 id（fs_write/fs_edit 执行前自动快照归属到该会话）
watch(
  currentConversationId,
  (id) => {
    setActiveToolConversationId(id)
    // 切换对话后若面板还开着，指向的会话已变，直接关闭避免误操作
    showCheckpointPanel.value = false
  },
  { immediate: true },
)

/** 消息数据源：当前对话的消息；草稿态回落到临时消息 */
const messages = computed<ChatMessage[]>(() =>
  currentConversation.value ? currentConversation.value.messages : draftMessages.value,
)

/* —— IM 混合式聊天布局辅助（仅展示层：头像/昵称数据源 + 连续消息折叠判断） —— */

/** 用户侧头像/昵称数据源：账号资料（avatar 为 null 时由 AgentAvatar 回退昵称首字） */
const accountStore = useAccountStore()

/**
 * 助手头像/昵称数据源：优先取会话绑定的智能体（当前会话级），
 * 未绑定或已停用时回落当前选中的智能体，仍无则由模板兜底为品牌 H 标。
 * 说明：消息本体未持久化 agentId，无法按消息粒度回溯当时的智能体，故采用会话级绑定。
 */
const chatAgent = computed<AgentView | undefined>(() => {
  const conversationAgentId = currentConversation.value?.agentId
  const fromConversation = conversationAgentId
    ? agentsStore.findAgent(conversationAgentId)
    : undefined
  if (fromConversation && !fromConversation.disabled) return fromConversation
  return activeAgent.value
})

/** 助手昵称：会话绑定智能体名；清单为空时兜底品牌名 */
const chatAgentName = computed(() => chatAgent.value?.name ?? '不懒小熊')

/** 消息行视图模型：标记是否为一组连续同 role 消息的首条（决定头像与昵称是否展示） */
const messageRows = computed(() =>
  messages.value.map((message, index) => ({
    message,
    isFirstOfGroup: index === 0 || messages.value[index - 1].role !== message.role,
  })),
)

/** 追加一条消息到指定对话并返回 store 内的响应式引用（供流式回写）；无对话时落到草稿临时列表 */
function pushMessage(conversationId: string, role: 'user' | 'assistant'): ChatMessage {
  const message = createMessage(role)
  if (conversationId) {
    const appended = conversationsStore.appendMessage(conversationId, message)
    if (appended) return appended
  }
  draftMessages.value.push(message)
  return draftMessages.value[draftMessages.value.length - 1]
}

/** 页面内呈现一条错误提示（不弹 alert） */
function pushErrorNote(text: string): void {
  const note = pushMessage(currentConversation.value?.id ?? '', 'assistant')
  note.status = 'error'
  note.errorText = text
}

/* —— 会话工作区面板（工作区 × 对话两级） —— */

type SessionTab = 'active' | 'archived'
type PanelPopover = 'workspace-menu' | 'workspace-form' | null

const sessionTab = ref<SessionTab>('active')
/** 窄屏（<900px）抽屉开关 */
const sessionDrawerOpen = ref(false)
/** 面板内浮层：工作区下拉 / 新建·编辑工作区表单（同一时间只开一个） */
const panelPopover = ref<PanelPopover>(null)
/** 面板根节点（用于点外部关闭面板浮层） */
const sessionsRoot = ref<HTMLElement | null>(null)
const workspaceNameInputEl = ref<HTMLInputElement | null>(null)

/** 新建/编辑工作区表单状态（create 时 id 为 ''） */
const workspaceForm = ref<{ mode: 'create' | 'rename'; id: string } | null>(null)
const workspaceFormName = ref('')
const workspaceFormIcon = ref(DEFAULT_WORKSPACE_ICON)
/** 表单中的关联文件夹路径（'' 表示未关联） */
const workspaceFormFolderPath = ref('')

const workspaceList = computed(() => workspacesStore.sortedWorkspaces)

/** 当前工作区的对话（面板列表只显示本工作区的对话） */
const workspaceConversations = computed(() =>
  conversationsStore.sortedConversations.filter(
    (conversation) => conversation.workspaceId === activeWorkspaceId.value,
  ),
)

const activeSessions = computed(() => workspaceConversations.value.filter((c) => !c.archived))
const archivedSessions = computed(() => workspaceConversations.value.filter((c) => c.archived))

/** 草稿态引导文案：本工作区有历史对话时提示可从会话工作区切换 */
const draftGuideText = computed(() =>
  activeSessions.value.length > 0
    ? '直接输入并发送即可自动创建对话，也可在会话工作区中切换历史对话。'
    : '直接输入并发送即可自动创建对话。',
)

/** 由首条用户消息截取对话标题：压缩空白取前 20 字，超长加省略号 */
function deriveConversationTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 20 ? `${normalized.slice(0, 20)}…` : normalized
}

/** 恢复对话携带的上下文：任务目标 / 智能体 / @ 选用技能 / 模型配置与模型 */
function restoreConversationContext(conversation: Conversation): void {
  goal.value = conversation.goal
  goalDraft.value = conversation.goal
  // @ 选用的技能随对话恢复；旧数据无该字段时兜底为空数组
  selectedSkillIds.value = Array.isArray(conversation.skillIds) ? [...conversation.skillIds] : []
  // 已激活技能（触发词命中 / use_skill）随对话元数据恢复
  activatedSkillIds.value = Array.isArray(conversation.activatedSkillIds)
    ? [...conversation.activatedSkillIds]
    : []
  // 清掉工具执行层的跨会话激活残留，防止切换对话后误并入
  clearActivatedSkillIds(conversation.id)

  // ?agent= 显式指定的智能体优先于对话恢复（带参跳转发生在进入时）
  const agentParam = route.query.agent
  const queryAgentId = Array.isArray(agentParam) ? agentParam[0] : agentParam
  const queryAgent =
    typeof queryAgentId === 'string'
      ? agentsStore.enabledAgents.find((agent) => agent.id === queryAgentId)
      : undefined
  let restoredAgent: AgentView | undefined = queryAgent
  if (!restoredAgent) {
    const stored = agentsStore.findAgent(conversation.agentId)
    restoredAgent = stored && !stored.disabled ? stored : agentsStore.findAgent(DEFAULT_AGENT_ID)
  }
  activeAgentId.value = restoredAgent?.id ?? DEFAULT_AGENT_ID

  // 模型恢复优先级：对话已保存的模型配置优先；仅当对话未保存过模型（modelConfigId 为 ''）
  // 且恢复出的智能体绑定了默认模型时，才应用智能体绑定。配置被删除则不动当前选择。
  const savedConfig = conversation.modelConfigId
    ? (configs.value.find((item) => item.id === conversation.modelConfigId) ?? null)
    : null
  if (savedConfig) {
    activeConfigId.value = savedConfig.id
    activeModelId.value = savedConfig.modelIds.includes(conversation.modelId)
      ? conversation.modelId
      : ''
  } else if (!conversation.modelConfigId) {
    applyAgentModelBinding(restoredAgent)
  }
}

/* —— 工作区：浮层 / 切换 / 新建 / 重命名 / 删除 —— */

function closePanelPopover(): void {
  panelPopover.value = null
  workspaceForm.value = null
}

function closeSessionDrawer(): void {
  sessionDrawerOpen.value = false
  closePanelPopover()
}

function toggleWorkspaceMenu(): void {
  if (panelPopover.value === 'workspace-menu') {
    closePanelPopover()
    return
  }
  workspaceForm.value = null
  panelPopover.value = 'workspace-menu'
}

function openWorkspaceCreateForm(): void {
  workspaceForm.value = { mode: 'create', id: '' }
  workspaceFormName.value = ''
  workspaceFormIcon.value = DEFAULT_WORKSPACE_ICON
  workspaceFormFolderPath.value = ''
  panelPopover.value = 'workspace-form'
  void nextTick(() => workspaceNameInputEl.value?.focus())
}

function openWorkspaceRenameForm(workspace: Workspace): void {
  workspaceForm.value = { mode: 'rename', id: workspace.id }
  workspaceFormName.value = workspace.name
  workspaceFormIcon.value = workspace.icon
  workspaceFormFolderPath.value = workspace.folderPath
  panelPopover.value = 'workspace-form'
  void nextTick(() => workspaceNameInputEl.value?.focus())
}

/** 取路径最后一段作为文件夹名（兼容 Windows 与 POSIX 分隔符，去除尾部斜杠） */
function folderBasename(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/**
 * 表单「选择…」按钮：桌面桥接可用时选目录回填（名称为空时用文件夹名预填）；
 * 纯浏览器环境拿不到系统路径，轻提示改用手动粘贴。
 */
async function chooseWorkspaceFolder(): Promise<void> {
  if (!hasDesktopBridge()) {
    showNotice('浏览器环境无法直接选择系统文件夹，可手动粘贴路径；封装桌面程序后可直接选择')
    return
  }
  const path = await pickFolderViaBridge()
  if (!path) return
  workspaceFormFolderPath.value = path
  if (!workspaceFormName.value.trim()) {
    const base = folderBasename(path)
    if (base) workspaceFormName.value = base
  }
}

/** 提交新建/编辑工作区表单：名称必填（去空白非空）；新建后进入该工作区草稿态 */
function submitWorkspaceForm(): void {
  const form = workspaceForm.value
  const name = workspaceFormName.value.trim()
  if (!form || !name) return
  const folderPath = workspaceFormFolderPath.value.trim()
  if (form.mode === 'create') {
    workspacesStore.createWorkspace(name, workspaceFormIcon.value, folderPath)
    void router.push({ name: 'chat' })
  } else {
    workspacesStore.renameWorkspace(form.id, name, workspaceFormIcon.value, folderPath)
  }
  closePanelPopover()
}

/** 删除工作区：confirm 提示连带删除的对话条数（含归档） */
function confirmRemoveWorkspace(id: string): void {
  const workspace = workspacesStore.findWorkspace(id)
  if (!workspace) return
  const count = conversationsStore.sortedConversations.filter(
    (conversation) => conversation.workspaceId === id,
  ).length
  const consequence =
    count > 0 ? `将连带删除其中的 ${count} 条对话（含归档），` : '该工作区暂无对话，'
  if (!window.confirm(`确定删除工作区「${workspace.name}」吗？${consequence}此操作不可撤销。`)) {
    return
  }
  const wasActive = id === activeWorkspaceId.value
  // 删除工作区会连带删除其对话：先中止其中所有仍在进行的流式
  for (const conversation of conversationsStore.sortedConversations) {
    if (conversation.workspaceId === id) stopStreaming(conversation.id)
  }
  workspacesStore.removeWorkspace(id)
  closePanelPopover()
  if (wasActive) {
    // 删的是当前工作区：store 已切到剩余的第一个，视图进入草稿态
    void router.push({ name: 'chat' })
  }
}

/** 切换工作区：切换 → 打开该工作区上次的对话（未归档）或进入草稿态（不中断进行中的流式） */
function switchWorkspace(id: string): void {
  if (id === activeWorkspaceId.value) {
    closePanelPopover()
    return
  }
  workspacesStore.setActiveWorkspace(id)
  closePanelPopover()
  const workspace = workspacesStore.findWorkspace(id)
  const lastId = workspace?.lastConversationId ?? ''
  const conversation = lastId ? conversationsStore.findConversation(lastId) : null
  if (conversation && !conversation.archived) {
    void router.push({ name: 'chat', params: { conversationId: conversation.id } })
  } else {
    void router.push({ name: 'chat' })
  }
}

/* —— 对话：新增 / 打开 / 重命名 / 归档 / 恢复 / 删除 —— */

/** 新增对话：跳草稿态（不预创建空对话）并聚焦输入框；进行中的流式继续 */
function startNewConversation(): void {
  closeSessionDrawer()
  if (currentConversationId.value) {
    void router.push({ name: 'chat' })
  }
  void nextTick(() => inputEl.value?.focus())
}

/** 打开一个进行中的对话：跳转（不中断任何流式） */
function openConversation(id: string): void {
  closeSessionDrawer()
  if (id === currentConversationId.value) return
  void router.push({ name: 'chat', params: { conversationId: id } })
}

/** 打开已归档对话（点击归档项或恢复按钮）：先恢复为进行中再跳转 */
function restoreArchivedSession(id: string): void {
  conversationsStore.unarchiveConversation(id)
  openConversation(id)
}

function renameSession(id: string): void {
  const conversation = conversationsStore.findConversation(id)
  if (!conversation) return
  const input = window.prompt('重命名对话', conversation.title)
  if (input === null) return
  const title = input.trim()
  if (!title) return
  conversationsStore.renameConversation(id, title)
}

function archiveSession(id: string): void {
  conversationsStore.archiveConversation(id)
  // 归档的是当前打开的对话 → 视图切到草稿态（流式不中断，后台继续写回）
  if (currentConversationId.value === id) {
    void router.push({ name: 'chat' })
  }
}

function removeSession(id: string): void {
  const conversation = conversationsStore.findConversation(id)
  if (!conversation) return
  if (!window.confirm(`确定删除对话「${conversation.title}」吗？删除后不可撤销。`)) return
  // 删除对话连带删消息：中止该对话仍在进行的流式，避免写回已删除的消息
  stopStreaming(id)
  conversationsStore.removeConversation(id)
  // 清理所属工作区「最近对话」的残留
  if (conversation.workspaceId) {
    const workspace = workspacesStore.findWorkspace(conversation.workspaceId)
    if (workspace?.lastConversationId === id) {
      workspacesStore.setLastConversation(workspace.id, '')
    }
  }
  if (currentConversationId.value === id) {
    void router.push({ name: 'chat' })
  }
}

/* —— 浮层（模型 / 目标 / 智能体 / 技能 / 更多；同一时间只开一个） —— */

  type PopoverKind = 'model' | 'goal' | 'agent' | 'skill' | 'permission' | 'more'

  /* —— 权限模式（plan / confirm / auto-edit / full，与设置页联动） —— */

  /** 当前模式的元信息（图标 + 中文名，供工具栏按钮展示） */
  const currentPermissionMeta = computed(() => getPermissionModeMeta(permissionStore.mode))

  /** 在权限模式菜单中选择：立即生效并持久化（作用于下一次工具调用 / system 消息） */
  function pickPermissionMode(mode: (typeof PERMISSION_MODES)[number]['value']): void {
    permissionStore.setMode(mode)
    closePopover()
  }

const activePopover = ref<PopoverKind | null>(null)
const composerRoot = ref<HTMLElement | null>(null)

function togglePopover(kind: PopoverKind): void {
  if (activePopover.value === kind) {
    activePopover.value = null
    return
  }
  if (kind === 'goal') {
    goalDraft.value = goal.value
  }
  activePopover.value = kind
  if (kind === 'goal') {
    void nextTick(() => goalInputEl.value?.focus())
  }
}

function closePopover(): void {
  activePopover.value = null
}

/** 点击输入区 / 会话面板外部关闭浮层 */
function onDocumentPointerDown(event: PointerEvent): void {
  const target = event.target as Node
  if (activePopover.value && composerRoot.value && !composerRoot.value.contains(target)) {
    closePopover()
  }
  if (panelPopover.value && sessionsRoot.value && !sessionsRoot.value.contains(target)) {
    closePanelPopover()
  }
}

/** Esc 关闭浮层 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (activePopover.value) closePopover()
    if (panelPopover.value) closePanelPopover()
  }
}

/* —— 任务目标（system 指令，随每条消息发送） —— */

const goal = ref('')
const goalDraft = ref('')
const goalInputEl = ref<HTMLTextAreaElement | null>(null)

function confirmGoal(): void {
  goal.value = goalDraft.value.trim()
  closePopover()
}

function clearGoal(): void {
  goal.value = ''
  goalDraft.value = ''
  closePopover()
}

/* —— 智能体（内置 + 自定义合并清单，来自智能体中心 store） —— */

const activeAgentId = ref<string>(DEFAULT_AGENT_ID)

/** 当前选中智能体：在合并清单中查找，找不到时回退默认智能体；清单为空时为 undefined（各消费处已兜底） */
const activeAgent = computed<AgentView | undefined>(
  () => agentsStore.findAgent(activeAgentId.value) ?? agentsStore.defaultAgent,
)

// 默认位由主智能体大B占据，按钮显示当前人设名；清单为空时兜底展示「智能体」
const activeAgentLabel = computed(() => activeAgent.value?.name ?? '智能体')

/** 激活智能体声明的工具 schema（仅桌面端生效：工具在主进程执行；未声明或纯浏览器时为空） */
const activeAgentTools = computed<AgentToolSchema[]>(() => {
  if (!hasLlmForward()) return []
  const names = activeAgent.value?.tools ?? []
  return names
    .map((name) => AGENT_TOOLS.find((tool) => tool.name === name))
    .filter((tool): tool is AgentToolSchema => tool !== undefined)
})

/**
 * 当前智能体实际生效的 system 提示词：
 * - 基础值为智能体自身的 systemPrompt；
 * - 合集智能体携带关联技能（linkedSkillIds）时逐个解析，跳过已删除或已停用的技能，
 *   把剩余技能的方法论文档以纯文本块拼接在基础值之后，模型可直接运用而无须用户手动插入模板；
 * - 一个技能都没解析到时不拼接，行为与普通智能体一致。
 */
const activeSystemPrompt = computed<string>(() => {
  // 清单为空时 activeAgent 为 undefined：不注入 system，仅按任务目标组装
  const base = activeAgent.value?.systemPrompt ?? ''
  const linkedSkills = (activeAgent.value?.linkedSkillIds ?? [])
    .map((skillId) => skillsStore.findSkill(skillId))
    .filter((skill): skill is SkillView => Boolean(skill && !skill.disabled))
  if (linkedSkills.length === 0) return base
  const skillBlocks = linkedSkills
    .map((skill) => `【技能：${skill.name}】\n${skill.template}`)
    .join('\n\n')
  return `${base}\n\n<已装载技能方法论：执行任务时可参考以下技能文档>\n\n${skillBlocks}\n</已装载技能方法论>`
})

function selectAgent(agentId: string): void {
  activeAgentId.value = agentId
  // 切换智能体即应用其默认模型绑定（作用于下一条消息；发送时随上下文写入对话）
  applyAgentModelBinding(agentsStore.findAgent(agentId))
  closePopover()
}

// 选中项被停用或删除（跨页操作）后，自动回退默认智能体（清单为空时保持无选中，展示兜底文案）
watch(
  () => agentsStore.enabledAgents,
  (enabled) => {
    if (!enabled.some((agent) => agent.id === activeAgentId.value)) {
      activeAgentId.value = DEFAULT_AGENT_ID
    }
  },
)

/* —— 技能（@ 引用模式：模板正文不进输入框，随每轮作为 system 注入；清单来自技能中心 store） —— */

const inputEl = ref<HTMLTextAreaElement | null>(null)

/** 当前对话 @ 选用的技能 id 列表（随对话持久化；发送后保留，直到用户手动移除标记） */
const selectedSkillIds = ref<string[]>([])

/**
 * 已选技能的展示清单：按 id 解析并过滤已删除的技能；
 * 已停用的技能保留展示（标记置灰提示），但注入 system 时跳过。
 */
const selectedSkills = computed<SkillView[]>(() =>
  selectedSkillIds.value
    .map((id) => skillsStore.findSkill(id))
    .filter((skill): skill is SkillView => Boolean(skill)),
)

/**
 * 本对话已激活的技能 id 列表：触发词自动命中 / 模型 use_skill 激活的技能，
 * 正文随每轮注入 system；随对话元数据持久化，切换对话时恢复。
 */
const activatedSkillIds = ref<string[]>([])

/** 已激活技能解析视图：@ 选用 ∪ 自动激活，去重后查找；已删除或已停用的跳过 */
const activatedSkills = computed<SkillView[]>(() => {
  const ids = new Set<string>([...selectedSkillIds.value, ...activatedSkillIds.value])
  return [...ids]
    .map((id) => skillsStore.findSkill(id))
    .filter((skill): skill is SkillView => Boolean(skill && !skill.disabled))
})

/**
 * 最终随请求注入的 system 提示词（按需注入，省 token）：
 * - 技能清单：全部启用技能的名称 + 描述 + 触发词（不含正文），提示模型命中时调用 use_skill；
 * - 已激活技能：@ 选用 / 触发词命中 / use_skill 激活的技能正文随每轮注入；
 * - 智能体关联技能（activeSystemPrompt 内）维持整体注入不变。
 */
const effectiveSystemPrompt = computed<string>(() => {
  const sections: string[] = []
  const catalog = buildSkillCatalogBlock(
    skillsStore.enabledSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      triggers: skill.triggers,
      tags: skill.tags,
    })),
  )
  if (catalog) sections.push(catalog)
  for (const skill of activatedSkills.value) {
    sections.push(buildActivatedSkillBlock(skill))
  }
  const extra = sections.join('\n\n')
  const base = activeSystemPrompt.value
  if (!extra) return base
  return base ? `${base}\n\n${extra}` : extra
})

/** 点击浮层项：已选则移除、未选则添加；不关闭浮层，便于连续多选 */
function toggleSkill(skill: SkillView): void {
  const index = selectedSkillIds.value.indexOf(skill.id)
  if (index >= 0) {
    selectedSkillIds.value = selectedSkillIds.value.filter((id) => id !== skill.id)
  } else {
    selectedSkillIds.value = [...selectedSkillIds.value, skill.id]
  }
}

/** 移除单个 @ 标记（输入框行首的 × 按钮） */
function removeSkill(skillId: string): void {
  selectedSkillIds.value = selectedSkillIds.value.filter((id) => id !== skillId)
}

// 技能被删除后其 id 会残留在 selectedSkillIds 中（展示与注入虽已过滤，但会让工具栏
// 徽标计数偏大），因此监听技能清单变化剪除失效 id。仅在实际剪掉了内容时才一次性
// 重赋值为新数组，避免无谓的响应式写入；本 watch 只依赖 skills 清单，重赋值不会使其再触发。
watch(
  () => skillsStore.skills,
  () => {
    if (selectedSkillIds.value.length === 0) return
    const valid = selectedSkillIds.value.filter((id) => skillsStore.findSkill(id) !== undefined)
    if (valid.length !== selectedSkillIds.value.length) {
      selectedSkillIds.value = valid
    }
  },
)

/* —— 附件（仅文本类；点击选择 / 拖拽 / 粘贴） —— */

interface PendingAttachment {
  id: string
  name: string
  size: number
  content: string
  truncated: boolean
  /** 附件类型：缺省视为 'text'（向后兼容旧结构） */
  kind?: 'text' | 'image'
  /** 图片附件的 base64 data URL（仅随当轮请求发送，不持久化） */
  dataUrl?: string
  /** 图片尺寸提示文本，如 1920×1080 */
  dimensions?: string
}

/** 允许读取的文本类扩展名（不含点，全部小写） */
const TEXT_FILE_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'xml',
  'yml',
  'yaml',
  'js',
  'jsx',
  'ts',
  'tsx',
  'vue',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'go',
  'rs',
  'rb',
  'php',
  'sql',
  'sh',
  'bat',
  'ps1',
  'ini',
  'toml',
  'env',
  'html',
  'css',
  'scss',
  'less',
]

/** 文件选择框的 accept 列表：文本类扩展名 + 图片 */
const TEXT_FILE_ACCEPT = TEXT_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(',')
const FILE_ACCEPT = `${TEXT_FILE_ACCEPT},image/*`

/** 是否为可读取的文本类文件：扩展名白名单 或 文本类 MIME */
function isTextLikeFile(file: File): boolean {
  const dotIndex = file.name.lastIndexOf('.')
  const ext = dotIndex >= 0 ? file.name.slice(dotIndex + 1).toLowerCase() : ''
  if (ext && TEXT_FILE_EXTENSIONS.includes(ext)) return true
  const mime = file.type
  if (!mime) return false
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml' ||
    mime === 'application/yaml' ||
    mime === 'application/javascript'
  )
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const attachments = ref<PendingAttachment[]>([])
const fileInputEl = ref<HTMLInputElement | null>(null)
const dragDepth = ref(0)

/** 会话附件容量提示阈值（含历史图片；data URL 约 1.37 倍原文体积，粗略按字符数估） */
const ATTACHMENT_CAPACITY_HINT_BYTES = 8 * 1024 * 1024

/** 当前会话附件总占用（待发附件 + 会话内已持久化的图片附件），供容量提示展示 */
const conversationAttachmentBytes = computed<number>(() => {
  let bytes = 0
  for (const item of attachments.value) {
    bytes += item.dataUrl ? Math.round(item.dataUrl.length * 0.75) : item.content.length
  }
  for (const message of messages.value) {
    for (const image of message.images ?? []) {
      bytes += Math.round(image.dataUrl.length * 0.75)
    }
  }
  return bytes
})

/** 是否超出容量提示阈值（true 时在输入区提示） */
const showCapacityHint = computed(() => conversationAttachmentBytes.value > ATTACHMENT_CAPACITY_HINT_BYTES)

/** 输入区内的轻提示（自动消失，不弹窗） */
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 3200)
}

/** 读取图片文件为 data URL 并取尺寸：超 5MB 拒绝；成功返回附件对象，失败返回 null */
async function readImageFile(file: File): Promise<PendingAttachment | null> {
  const oversizeReason = validateImageSize(file.size)
  if (oversizeReason) {
    showNotice(`${file.name}：${oversizeReason}`)
    return null
  }
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('read failed'))
    reader.readAsDataURL(file)
  })
  const dimensions = await new Promise<string>((resolve) => {
    const img = new Image()
    img.onload = () => resolve(`${img.naturalWidth}×${img.naturalHeight}`)
    img.onerror = () => resolve('')
    img.src = dataUrl
  })
  return {
    id: crypto.randomUUID(),
    name: file.name || '图片',
    size: file.size,
    content: '',
    truncated: false,
    kind: 'image',
    dataUrl,
    dimensions,
  }
}

/** 逐个读取文本文件为附件：非文本拒绝、超 100KB 截断并标注；图片直读为 data URL */
async function addFiles(files: File[]): Promise<void> {
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const imageAttachment = await readImageFile(file)
      if (imageAttachment) attachments.value.push(imageAttachment)
      continue
    }
    if (!isTextLikeFile(file)) {
      showNotice(`暂仅支持文本类文件，已跳过：${file.name}`)
      continue
    }
    const truncated = file.size > ATTACHMENT_MAX_BYTES
    try {
      const blob = truncated ? file.slice(0, ATTACHMENT_MAX_BYTES) : file
      const content = await blob.text()
      attachments.value.push({
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        content,
        truncated,
      })
      if (truncated) {
        showNotice(`${file.name} 超过 100KB，内容已截断`)
      }
    } catch {
      showNotice(`读取文件失败：${file.name}`)
    }
  }
}

function removeAttachment(id: string): void {
  attachments.value = attachments.value.filter((item) => item.id !== id)
}

function onFileInputChange(event: Event): void {
  const input = event.target as HTMLInputElement
  void addFiles(Array.from(input.files ?? []))
  input.value = '' // 允许再次选择同名文件
}

function onDragEnter(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  dragDepth.value += 1
}

function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('Files')) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(event: DragEvent): void {
  event.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
}

function onDrop(event: DragEvent): void {
  event.preventDefault()
  dragDepth.value = 0
  void addFiles(Array.from(event.dataTransfer?.files ?? []))
}

/** 粘贴文件（如截图旁复制的代码片段文件）直接转为附件；粘贴纯文本保持默认行为 */
function onComposerPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files ?? [])
  if (files.length === 0) return
  event.preventDefault()
  void addFiles(files)
}

/* —— Vault 笔记（Obsidian vault，仅桌面端；面板见侧栏） —— */

const vaultPanelRef = ref<InstanceType<typeof VaultPanel> | null>(null)

/** 当前工作区是否已关联文件夹（folderPath 即 vault 根目录） */
const vaultLinked = computed(() => !!activeWorkspace.value?.folderPath)

/** vault 面板可用：已关联文件夹且桌面桥接可用 */
const vaultAvailable = computed(() => vaultLinked.value && hasVaultBridge())

/** 「插入到对话」：以「【笔记：path】\n内容」追加到输入框（保留用户已输入内容） */
function insertVaultNote(note: { path: string; content: string }): void {
  const block = `【笔记：${note.path}】\n${note.content}`
  userInput.value = userInput.value.trim() ? `${userInput.value}\n\n${block}` : block
  void nextTick(() => inputEl.value?.focus())
}

/** 「作为上下文发送」：加入附件列表（随当轮 user 消息注入，沿用 100KB 截断） */
function attachVaultNote(note: { path: string; content: string }): void {
  const truncated = note.content.length > ATTACHMENT_MAX_BYTES
  attachments.value.push({
    id: crypto.randomUUID(),
    name: note.path,
    size: note.content.length,
    content: truncated ? note.content.slice(0, ATTACHMENT_MAX_BYTES) : note.content,
    truncated,
  })
  if (truncated) showNotice(`${note.path} 超过 100KB，内容已截断`)
}

/** 侧栏提示点击：打开当前工作区编辑表单去关联文件夹 */
function openVaultLinkForm(): void {
  const workspace = activeWorkspace.value
  if (workspace) openWorkspaceRenameForm(workspace)
}

/** 「存为笔记」：AI 回复写入 vault 的「AI 笔记/」目录（重名自动追加序号） */
async function saveMessageAsNote(message: ChatMessage): Promise<void> {
  const rootPath = activeWorkspace.value?.folderPath ?? ''
  if (!rootPath || !hasVaultBridge()) return
  const content = message.content.trim()
  if (!content) {
    showNotice('该消息没有正文，无法存为笔记')
    return
  }
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const relPath = attempt === 0 ? `AI 笔记/${stamp}.md` : `AI 笔记/${stamp}-${attempt + 1}.md`
    try {
      await writeVaultFile(rootPath, relPath, content)
      showNotice(`已存为笔记：${relPath}`)
      vaultPanelRef.value?.refresh()
      return
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (!text.includes('笔记已存在')) {
        showNotice(`存为笔记失败：${text}`)
        return
      }
    }
  }
  showNotice('存为笔记失败：重名笔记过多，请清理「AI 笔记」目录后重试')
}

/* —— 发送与流式接收 —— */

const userInput = ref('')

/* —— 引用回复（微信式：引用某条消息的一段内容随下一条消息一起发送） —— */

/** 引用文本上限：超出截断（存入消息的 quote.text 与请求前缀均为截断后的文本） */
const QUOTE_TEXT_LIMIT = 500

/** 未发送的引用草稿（author 为「我」或智能体名；发送 / 取消 / 切换对话时清空） */
const quoteDraft = ref<{ author: string; text: string } | null>(null)

/** 进入引用态：取消息正文为引用文本（无正文时忽略；流式生成中同样可用，不影响生成） */
function startQuote(message: ChatMessage): void {
  const text = message.content.trim()
  if (!text) return
  quoteDraft.value = {
    author: message.role === 'user' ? '我' : chatAgentName.value,
    text: text.length > QUOTE_TEXT_LIMIT ? text.slice(0, QUOTE_TEXT_LIMIT) : text,
  }
  inputEl.value?.focus()
}

/** 取消引用（清空引用态，不影响输入框正文） */
function clearQuote(): void {
  quoteDraft.value = null
}

/** 发给 API 的 user 内容前缀：引用信息只拼进请求，不改动持久化的消息 content */
function buildQuotePrefix(quote: { author: string; text: string }): string {
  return `引用 ${quote.author} 的内容：\n${quote.text}\n----\n`
}

/** 按对话隔离的流式状态（Pinia 单例，不持久化）：路由切换组件卸载不中断生成，回来可恢复展示 */
const chatStreamStore = useChatStreamStore()
const { streamingMap, streamStartMap } = storeToRefs(chatStreamStore)
const streaming = computed(
  () => !!currentConversationId.value && streamingMap.value.has(currentConversationId.value),
)

/* —— 生成中实时计时（参考 ZCode CLI「已工作 X 分 X 秒」）—— */

/** 每秒刷新的当前时间戳，仅用于驱动计时文本更新 */
const nowTick = ref(Date.now())
let elapsedTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => streamingMap.value.size,
  (size) => {
    if (size > 0 && elapsedTimer === null) {
      elapsedTimer = setInterval(() => {
        nowTick.value = Date.now()
      }, 1000)
    } else if (size === 0 && elapsedTimer !== null) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  },
  // immediate：重新进入页面时若流式已在进行（全局 store 恢复），立即启动计时
  { immediate: true },
)

/** 当前对话生成中的累计耗时文案（非生成中返回空串，不渲染） */
const streamElapsedText = computed(() => {
  const conversationId = currentConversationId.value
  if (!conversationId || !streaming.value) return ''
  const start = streamStartMap.value.get(conversationId)
  if (start === undefined) return ''
  const totalSeconds = Math.max(0, Math.floor((nowTick.value - start) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes > 0 ? `已工作 ${minutes} 分 ${seconds} 秒` : `已工作 ${totalSeconds} 秒`
})

/** 组装随请求全量携带的对话历史（排除错误消息与空回复；不含附件内容） */
/** 汇总对话历史为可读消息列表（role 仅 user/assistant；工具调用过程由 toolSteps 另行展示） */
function buildHistory(source: ChatMessage[] = messages.value): ExportMessage[] {
  const history: ExportMessage[] = []
  for (const message of source) {
    if (message.status === 'error') continue
    if (message.role === 'assistant' && !message.content) continue
    history.push({
      role: message.role,
      // 历史轮次：带引用的 user 消息在发给 API 的内容前拼引用前缀（持久化 content 不变）
      content:
        message.role === 'user' && message.quote
          ? buildQuotePrefix(message.quote) + message.content
          : message.content,
      ...(message.toolSteps?.length ? { toolSteps: message.toolSteps } : {}),
    })
  }
  return history
}

/** 当前会话任务 → 导出任务卡片（无任务返回 null） */
function buildExportTask(current: Conversation | null): ExportTask | null {
  const task = current?.taskRun
  if (!task || task.steps.length === 0) return null
  return {
    title: task.title,
    goal: task.goal,
    status: task.status,
    parallelEnabled: task.parallelEnabled,
    ...(task.errorText ? { errorText: task.errorText } : {}),
    steps: task.steps.map((step) => ({
      content: step.content,
      status: step.status,
      result: step.result,
      ...(step.error ? { error: step.error } : {}),
      ...(step.parallel ? { parallel: true } : {}),
    })),
  }
}

/**
 * 组装最终请求的 messages：
 * - 存在智能体 systemPrompt 或任务目标时，在最前插入一条 system 消息；
 * - 传入 summary 时改用「历史摘要 + 最近消息」的压缩结构（摘要注入 system 附加块），
 *   未传但历史超阈值时降级为截断：仅发送最近 KEEP_RECENT 条；
 * - 当轮 user 消息替换为「正文 + 附件内容」的组合（附件只随当轮携带）；
 * - 传入 quote 时在当轮 user 内容前拼引用前缀（仅影响请求，不落回持久化消息）。
 * source 显式指定消息来源（新建对话后路由尚未切换完成时，取目标对话的消息）。
 */
function buildRequestMessages(
  outgoingUserContent: LlmChatMessage['content'],
  source: ChatMessage[],
  summary?: ConversationSummary | null,
  memoryBlock?: string,
  quote?: { author: string; text: string } | null,
): LlmChatMessage[] {
  let historySource = source
  if (summary && summary.upToIndex > 0 && summary.upToIndex <= source.length) {
    // 摘要覆盖前段：请求只携带摘要覆盖之后的最近消息
    historySource = source.slice(summary.upToIndex)
  } else if (needsCompaction(source.length)) {
    // 无可用摘要（如摘要生成失败/中止）：降级截断，不阻塞对话
    historySource = source.slice(-KEEP_RECENT)
  }
  const history = buildHistory(historySource)
  const last = history[history.length - 1]
  if (last && last.role === 'user') {
    // 当轮 user 消息含图片附件时为视觉 multipart 数组：仅随请求发给模型，不落回导出结构
    // 引用前缀只拼进请求内容（纯文本直接拼接；multipart 时作为首个 text 分片）
    if (quote) {
      const prefix = buildQuotePrefix(quote)
      last.content =
        typeof outgoingUserContent === 'string'
          ? prefix + outgoingUserContent
          : ([{ type: 'text', text: prefix }, ...outgoingUserContent] as unknown as string)
    } else {
      last.content = outgoingUserContent as string
    }
  }
  const baseSystem = buildSystemMessage(
    effectiveSystemPrompt.value,
    goal.value,
    permissionStore.mode,
    memoryBlock ?? null,
  )
  if (summary && summary.upToIndex > 0 && summary.upToIndex <= source.length) {
    // mergeCompactedMessages：system 消息在前（baseSystem + 摘要块），最近消息其后
    return mergeCompactedMessages(summary.content, history, baseSystem)
  }
  return baseSystem ? [{ role: 'system', content: baseSystem }, ...history] : history
}

/**
 * 解析本次请求可用的压缩摘要：
 * - 历史不超阈值 → null（全量发送）；
 * - 已有缓存摘要且仍覆盖前段（其后消息不超过 KEEP_RECENT 条）→ 复用缓存；
 * - 否则用当前模型做一次非流式补全生成新摘要（由调用方展示提示并处理降级），
 *   成功后写入会话的 summary 字段随防抖持久化；失败/中止返回 null（调用方走截断降级）。
 */
async function resolveCompactionSummary(
  conversationId: string,
  source: ChatMessage[],
  onGeneratingChange: (generating: boolean) => void,
  signal?: AbortSignal,
): Promise<ConversationSummary | null> {
  if (!needsCompaction(source.length)) return null
  const conversation = conversationsStore.findConversation(conversationId)
  const existing = conversation?.summary
  if (existing && isSummaryUsable(existing, source.length)) return existing

  const split = splitForCompaction(source)
  const prompt = buildSummaryPrompt(split.oldMessages)
  if (!prompt || !activeConfig.value) return null
  const config = activeConfig.value
  onGeneratingChange(true)
  try {
    const content = await chatCompletion(
      {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelId: currentModelId.value,
        temperature: config.temperature,
        timeoutSeconds: config.timeoutSeconds,
        maxRetries: config.maxRetries,
      },
      [{ role: 'user', content: prompt }],
      signal,
    )
    const trimmed = truncateSummary(content)
    if (!trimmed) return null
    const summary: ConversationSummary = {
      content: trimmed,
      upToIndex: split.oldMessages.length,
      createdAt: Date.now(),
    }
    const target = conversationsStore.findConversation(conversationId)
    if (target) target.summary = summary
    return summary
  } catch {
    // 摘要失败/中止：不阻塞对话，降级为截断策略
    return null
  } finally {
    onGeneratingChange(false)
  }
}

function validateBeforeSend(config: LlmConfig, modelId: string): string | null {
  if (!modelId) {
    return `当前模型配置「${config.name}」缺少模型 ID，请到设置页补全后再试。`
  }
  if (!config.apiKey.trim() && !getProviderPreset(config.providerKey)?.apiKeyOptional) {
    return `当前模型配置「${config.name}」未填写 API Key，请到设置页补全后再试。`
  }
  return null
}

async function sendMessage(): Promise<void> {
  const text = userInput.value.trim()
  if ((!text && attachments.value.length === 0) || streaming.value || !activeConfig.value) return

  const config = activeConfig.value
  // 发送瞬间读取当前选中模型：切换模型立即生效（作用于下一条消息）
  const modelId = currentModelId.value
  const invalidReason = validateBeforeSend(config, modelId)
  if (invalidReason) {
    pushErrorNote(invalidReason)
    return
  }

  // 附件内容只拼进当轮 user 消息：先组装请求，再清空附件 chips。
  // 图片附件（data URL）随消息持久化到文件存储（消息里同时保留「[图片附件：…]」占位文本），
  // 刷新后图片仍随会话恢复；旧 localStorage 时代不持久化，现由统一存储层落盘
  const outgoingTextAttachments: ComposeAttachment[] = attachments.value
    .filter((item) => item.kind !== 'image')
    .map((item) => ({ name: item.name, content: item.content, truncated: item.truncated }))
  const outgoingImages: ImageAttachment[] = attachments.value
    .filter((item) => item.kind === 'image' && item.dataUrl)
    .map((item) => ({
      name: item.name,
      dataUrl: item.dataUrl as string,
      dimensions: item.dimensions ?? '',
    }))
  /** 图片附件在持久化消息里的占位文本（与 images 字段并存，供文本视图降级展示） */
  const imagePlaceholder = outgoingImages
    .map((img) => `[图片附件：${img.name}${img.dimensions ? `（${img.dimensions}）` : ''}]`)
    .join('\n')

  // 视觉能力提示：当前模型未勾选「支持视觉」时仅提示不阻止（图片可能被模型忽略或请求失败），
  // 是否发送由用户决定；勾选入口在设置页「模型接入 → 模型能力」
  if (outgoingImages.length > 0 && !config.supportsVision) {
    showNotice(`当前模型「${config.name} / ${modelId}」未勾选「支持视觉」，图片附件可能无法识别或导致请求失败；可到设置页勾选后再试。本次仍将发送。`)
  }

  // 已有对话：随发送同步上下文；草稿态首次发送：真正创建对话（标题取首条用户消息，
  // 携带当时的目标/智能体/模型选择）并跳转路由
  // 触发词命中：用户消息命中启用技能的触发词/名称/标签时自动激活（正文随本轮注入并保持后续生效）
  const hitSkillIds = matchTriggeredSkillIds(
    text,
    skillsStore.enabledSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      triggers: skill.triggers,
      tags: skill.tags,
    })),
  )
  if (hitSkillIds.length > 0) {
    activatedSkillIds.value = [...new Set([...activatedSkillIds.value, ...hitSkillIds])]
  }

  let conversationId = currentConversation.value?.id ?? ''
  if (conversationId) {
    conversationsStore.updateConversationContext(conversationId, {
      goal: goal.value,
      agentId: activeAgentId.value,
      skillIds: [...selectedSkillIds.value],
      activatedSkillIds: [...activatedSkillIds.value],
      modelConfigId: activeConfigId.value,
      modelId: activeModelId.value,
    })
  } else {
    conversationId = conversationsStore.createConversation({
      workspaceId: activeWorkspaceId.value,
      goal: goal.value,
      agentId: activeAgentId.value,
      skillIds: [...selectedSkillIds.value],
      activatedSkillIds: [...activatedSkillIds.value],
      modelConfigId: activeConfigId.value,
      modelId: activeModelId.value,
    })
    conversationsStore.renameConversation(conversationId, deriveConversationTitle(text || '图片附件'))
    void router.push({ name: 'chat', params: { conversationId } })
  }

  const userMessage = pushMessage(conversationId, 'user')
  userMessage.content = imagePlaceholder
    ? [composeUserContent(text, outgoingTextAttachments), imagePlaceholder]
        .filter((part) => part.trim())
        .join('\n\n')
    : text
  // 图片附件 data URL 随消息存入文件存储（重启后随会话恢复）
  if (outgoingImages.length > 0) userMessage.images = outgoingImages
  // 引用回复：引用信息随用户消息持久化（刷新后气泡上方仍展示）；请求层前缀见 buildRequestMessages
  const outgoingQuote = quoteDraft.value
  if (outgoingQuote) {
    userMessage.quote = { author: outgoingQuote.author, text: outgoingQuote.text }
    quoteDraft.value = null
  }
  userInput.value = ''
  // 快照当前全部消息（含刚发出的 user 消息；不含随后追加的助手占位）
  const sourceMessages = [
    ...(conversationsStore.findConversation(conversationId)?.messages ?? messages.value),
  ]

  // 长会话压缩：优先复用缓存摘要；需要新摘要时先用当前模型生成一次（助手气泡轻提示），
  // 失败/中止时 resolveCompactionSummary 返回 null，buildRequestMessages 自动降级为截断
  const assistant = pushMessage(conversationId, 'assistant')
  const summary = await resolveCompactionSummary(conversationId, sourceMessages, (generating) => {
    assistant.content = generating ? '正在压缩历史上下文…' : ''
  })
  // 工作区记忆：发送前刷新缓存（上一轮智能体可能已用 memory_* 工具更新），组装 system 附加块
  await refreshWorkspaceMemory()
  const memoryBlock = buildMemorySystemBlock(workspaceMemory.value)
  const requestMessages = buildRequestMessages(
    composeUserMultipartContent(text, outgoingTextAttachments, outgoingImages),
    sourceMessages,
    summary,
    memoryBlock,
    outgoingQuote,
  )
  attachments.value = []

  // 登记到全局流式 store：组件卸载（路由离开）不中止，仅记录在案供恢复展示
  const controller = chatStreamStore.start(conversationId)
  const sentConversationId = conversationId

  // MCP 动态工具：发送前刷新清单（带 5 分钟缓存），存在时并入 function calling 工具列表，
  // 并在 system 消息末尾注入可用清单提示；mcp__ 工具绕过智能体静态白名单，全局可用
  const mcpTools = await refreshMcpToolSchemas()
  // use_skill：启用技能非空时始终可用（不依赖智能体静态工具白名单），清单见 system 技能列表
  const useSkillTool = AGENT_TOOLS.find((tool) => tool.name === 'use_skill')
  const loopTools = [
    ...activeAgentTools.value,
    ...(useSkillTool && skillsStore.enabledSkills.length > 0 ? [useSkillTool] : []),
    ...mcpTools,
  ]
  const mcpHint = buildMcpSystemHint(mcpTools)
  if (mcpHint) {
    const firstMessage = requestMessages[0]
    if (firstMessage && firstMessage.role === 'system') {
      firstMessage.content += `\n\n${mcpHint}`
    } else {
      requestMessages.unshift({ role: 'system', content: mcpHint })
    }
  }

  try {
    if (loopTools.length > 0) {
      // function calling：智能体声明了工具 → 走 agent loop（tool_calls → 主进程执行 → 回传 → 继续）
      await runAgentLoop({
        endpoint: {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          modelId,
          temperature: config.temperature,
          timeoutSeconds: config.timeoutSeconds,
          maxRetries: config.maxRetries,
        },
        messages: requestMessages,
        tools: loopTools,
        executeTool: executeToolWithPrefs,
        signal: controller.signal,
        handlers: {
          onContent: (piece) => {
            assistant.content += piece
          },
          onReasoning: (piece) => {
            assistant.reasoning += piece
          },
        },
        onStep: (info) => {
          assistant.toolSteps.push({
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
        endpoint: {
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          modelId,
          temperature: config.temperature,
          timeoutSeconds: config.timeoutSeconds,
          maxRetries: config.maxRetries,
        },
        messages: requestMessages,
        signal: controller.signal,
        handlers: {
          onContent: (piece) => {
            assistant.content += piece
          },
          onReasoning: (piece) => {
            assistant.reasoning += piece
          },
        },
      })
    }
    assistant.status = assistant.content || assistant.reasoning ? 'done' : 'error'
    if (assistant.status === 'error') {
      assistant.errorText = assistant.toolSteps.length
        ? '工具阶段未产出正文，请重试。'
        : '模型未返回任何内容，请检查模型 ID 是否正确后重试。'
    }
  } catch (err) {
    if (isAbortError(err)) {
      assistant.status = 'aborted'
    } else {
      assistant.status = 'error'
      assistant.errorText = describeLlmError(err, config.baseUrl)
    }
  } finally {
    // 只清理发起本次流式的那个对话条目（闭包记录发起时的 conversationId，切换对话不影响写回）
    chatStreamStore.finish(sentConversationId)
    // 本轮模型经 use_skill 激活的技能：并入会话激活清单并持久化，后续对话持续注入正文
    const usedSkillIds = consumeActivatedSkillIds(sentConversationId)
    if (usedSkillIds.length > 0) {
      activatedSkillIds.value = [...new Set([...activatedSkillIds.value, ...usedSkillIds])]
      conversationsStore.updateConversationContext(sentConversationId, {
        activatedSkillIds: [...activatedSkillIds.value],
      })
    }
  }
}

/** 停止指定对话（缺省为当前对话）的流式生成；不存在时静默 */
function stopStreaming(conversationId?: string): void {
  const id = conversationId ?? currentConversationId.value
  if (!id) return
  chatStreamStore.abort(id)
}

/* —— 计划闭环：批准计划 → 执行子智能体逐步执行 —— */

/** 用户选择「忽略」的计划消息 id（仅当前页面会话内生效，不持久化） */
const ignoredPlanMessageIds = ref(new Set<string>())

/** 执行任务运行时控制（不持久化）：停止标记在当前步自然结束后生效 */
const taskControl = ref<{ stopRequested: boolean } | null>(null)

/** 当前对话的执行任务（随会话持久化；旧数据无字段时为 null） */
const activeTaskRun = computed<TaskRun | null>(() => currentConversation.value?.taskRun ?? null)

const activeTaskRunning = computed(
  () => activeTaskRun.value !== null && isTaskActive(activeTaskRun.value.status),
)

/** 消息正文中的「## 执行计划」区块（非完成态助手消息返回 null，供模板判断） */
function getPlanBlock(message: ChatMessage): string | null {
  if (message.role !== 'assistant' || message.status !== 'done') return null
  return extractPlanBlock(message.content)
}

function isPlanIgnored(message: ChatMessage): boolean {
  return ignoredPlanMessageIds.value.has(message.id)
}

function ignorePlan(message: ChatMessage): void {
  ignoredPlanMessageIds.value.add(message.id)
  ignoredPlanMessageIds.value = new Set(ignoredPlanMessageIds.value)
}

/** 批准按钮的禁用提示文案（空串表示可用） */
function planApproveHint(): string {
  if (activeTaskRunning.value) return '已有进行中的执行任务，请等待其完成或停止后再批准新计划'
  if (permissionStore.mode === 'plan') return '计划模式下不可执行，请切换权限模式后再批准'
  return ''
}

/** 并行执行开关（批准计划 UI 上选择，随任务持久化；默认关闭） */
const taskParallelEnabled = ref(false)

/** 解析步骤行内的 @模型名 标注：按配置名称精确匹配，或按配置内模型 id 匹配；未命中返回 null（用会话模型） */
function resolveModelRef(ref: string): { modelConfigId: string; modelId: string } | null {
  const name = ref.trim()
  if (!name) return null
  const byName = configs.value.find((config) => config.name === name)
  if (byName) return { modelConfigId: byName.id, modelId: '' }
  const byModel = configs.value.find((config) => config.modelIds.includes(name))
  if (byModel) return { modelConfigId: byModel.id, modelId: name }
  return null
}

/** 批准后把各步骤的 @模型名 标注解析为具体配置绑定（未命中的保留 modelRef 供展示） */
function resolveStepModelBindings(task: TaskRun): void {
  for (const step of task.steps) {
    if (!step.modelRef) continue
    const resolved = resolveModelRef(step.modelRef)
    if (resolved) {
      step.modelConfigId = resolved.modelConfigId
      step.modelId = resolved.modelId
    }
  }
}

/** 批准计划：解析步骤并创建执行任务，逐步派发子智能体请求 */
async function approvePlan(message: ChatMessage): Promise<void> {
  const conversationId = currentConversation.value?.id ?? ''
  const conversation = conversationsStore.findConversation(conversationId)
  const config = activeConfig.value
  if (!conversation || !config) return
  const hint = planApproveHint()
  if (hint) {
    showNotice(hint)
    return
  }
  if (streaming.value) {
    showNotice('请等待当前回复完成后再批准计划')
    return
  }
  const planText = extractPlanBlock(message.content)
  if (!planText) return
  // 参数优先级：会话级设置 > 全局默认（SettingsView 配置）
  const defaults = loadTaskDefaults()
  const task = createTaskRun({
    title: conversation.title,
    goal: goal.value || conversation.goal,
    planMessageId: message.id,
    planText,
    parallelEnabled: taskParallelEnabled.value,
    maxRounds: clampTaskMaxRounds(conversation.taskMaxRounds ?? defaults.maxRounds),
    resultMaxChars: clampStepResultChars(conversation.taskResultMaxChars ?? defaults.resultMaxChars),
  })
  if (!task) {
    showNotice('未能从计划中解析出可执行的步骤')
    return
  }
  resolveStepModelBindings(task)
  // 同一会话同时最多一个执行任务：直接覆盖已结束的旧任务
  conversation.taskRun = task
  await runTaskSteps(conversationId, task, config)
}

/** 一键切换到「自动编辑」权限档：执行子智能体写文件时无需逐步确认，整体更快 */
function switchToAutoEdit(): void {
  permissionStore.setMode('auto-edit')
  showNotice('已切换到自动编辑模式：执行子智能体修改文件时无需逐步确认')
}

/** 任务卡模型下拉选项：全部配置 × 其模型列表组合 */
const taskModelOptions = computed(() =>
  configs.value.flatMap((config) =>
    config.modelIds.map((modelId) => ({
      configId: config.id,
      modelId,
      label: config.modelIds.length > 1 ? `${config.name} / ${modelId}` : config.name,
    })),
  ),
)

/** 任务卡中手动改绑某步的执行模型（仅待执行步骤；清空 = 跟随会话模型） */
function bindStepModel(stepIndex: number, modelConfigId: string, modelId: string): void {
  const task = activeTaskRun.value
  const step = task?.steps[stepIndex]
  if (!task || !step || step.status !== 'pending') return
  if (modelConfigId) {
    step.modelConfigId = modelConfigId
    step.modelId = modelId
  } else {
    step.modelConfigId = undefined
    step.modelId = undefined
  }
}

/** 从失败/中断处续跑：已完成步骤的结果复用，仅执行剩余步骤 */
async function resumeTaskRun(): Promise<void> {
  const conversation = currentConversation.value
  const task = activeTaskRun.value
  const config = activeConfig.value
  if (!conversation || !task || !config || isTaskActive(task.status)) return
  if (permissionStore.mode === 'plan') {
    showNotice('计划模式下不可执行，请切换权限模式后再执行')
    return
  }
  await runTaskSteps(conversation.id, task, config)
}

/** 请求停止：当前步骤等待其自然结束，之后不再执行后续步骤 */
function stopTaskRun(): void {
  if (taskControl.value) taskControl.value.stopRequested = true
}

/**
 * 执行任务主循环：按并行分组派发子智能体请求（runAgentLoop，全部静态工具 + MCP 动态工具，
 * 权限模式照常生效）；组内步骤并发执行（互不阻塞、错误互不影响），组间保持先后顺序；
 * 任一步失败即停止后续分组（不自动重试）。
 * 每个步骤只写自己的状态对象，避免并发写 conversation.taskRun 的竞态；
 * 任务的响应式状态随会话防抖持久化。
 */
async function runTaskSteps(conversationId: string, task: TaskRun, config: LlmConfig): Promise<void> {
  taskControl.value = { stopRequested: false }
  const mcpTools = await refreshMcpToolSchemas()
  const loopTools = [...AGENT_TOOLS, ...mcpTools]
  task.status = 'running'
  task.errorText = undefined
  let outcome: 'completed' | 'stopped' | 'failed' = 'completed'

  /** 单步绑定的模型端点：优先步骤绑定配置，否则用当前会话配置/模型 */
  function stepEndpoint(step: (typeof task.steps)[number], fallback: LlmConfig): LlmEndpoint {
    const bound = step.modelConfigId
      ? (configs.value.find((item) => item.id === step.modelConfigId) ?? null)
      : null
    const use = bound ?? fallback
    const modelId =
      bound && step.modelId && use.modelIds.includes(step.modelId) ? step.modelId : (use.modelIds[0] ?? currentModelId.value)
    return {
      baseUrl: use.baseUrl,
      apiKey: use.apiKey,
      modelId,
      temperature: use.temperature,
      timeoutSeconds: use.timeoutSeconds,
      maxRetries: use.maxRetries,
    }
  }

  /** 执行单个步骤：成功/失败都写回自身状态并返回，不向外抛错（并行组内错误互不影响） */
  async function runOneStep(index: number): Promise<'done' | 'failed'> {
    const step = task.steps[index]
    step.status = 'running'
    step.error = undefined
    step.toolSteps = []
    const endpoint = stepEndpoint(step, config)
    const completed = task.steps
      .filter((item) => item.status === 'done')
      .map((item) => ({ content: item.content, result: item.result }))
    try {
      const result = await runAgentLoop({
        endpoint,
        messages: buildSubAgentMessages(task.goal, completed, step.content),
        tools: loopTools,
        executeTool: executeToolWithPrefs,
        maxSteps: task.maxRounds,
        onStep: (info) => {
          step.toolSteps.push({
            toolName: info.toolName,
            argsText: info.argsText,
            resultText: info.resultText,
            durationMs: info.durationMs,
            ...(info.error ? { error: info.error } : {}),
          } satisfies ToolStepRecord)
        },
      })
      step.status = 'done'
      step.result =
        truncateStepResult(
          result.content || result.steps.map((item) => item.resultText).join('\n'),
          task.resultMaxChars,
        ) || '（子智能体未返回文本结果）'
      return 'done'
    } catch (err) {
      step.status = 'failed'
      step.error = isAbortError(err) ? '已中止' : describeLlmError(err, endpoint.baseUrl)
      task.errorText = `步骤 ${index + 1} 执行失败：${step.error}`
      return 'failed'
    }
  }

  try {
    // 并行分组：相邻且标注 [并行] 的步骤合为一组（开关关闭时全部单步串行）
    const groups = buildParallelGroups(task.steps, task.parallelEnabled)
    for (const group of groups) {
      if (taskControl.value?.stopRequested) {
        outcome = 'stopped'
        break
      }
      const statuses = await Promise.all(group.map((index) => runOneStep(index)))
      if (statuses.includes('failed')) {
        // 组内任一步失败：其余步骤继续等自然结束，之后不再执行后续分组
        outcome = 'failed'
        break
      }
    }
  } finally {
    taskControl.value = null
    const allDone = task.steps.every((step) => step.status === 'done')
    if (outcome === 'stopped' && allDone) outcome = 'completed'
    task.status = outcome
    if (outcome === 'completed') {
      // 全部步骤完成后追加汇总消息（直接拼接各步摘要，简单可靠）
      const summary = pushMessage(conversationId, 'assistant')
      summary.content = buildTaskSummaryMessage(task)
      summary.status = 'done'
    }
  }
}

function clearConversation(): void {
  const conversationId = currentConversation.value?.id ?? ''
  if (!conversationId) return
  if (activeTaskRunning.value) {
    showNotice('请先停止执行中的任务，再清空对话')
    return
  }
  if (streaming.value) {
    stopStreaming()
  }
  conversationsStore.clearConversationMessages(conversationId)
}

/* —— 更多菜单：清空 / 导出 Markdown / 复制全部 —— */

function confirmClearConversation(): void {
  closePopover()
  if (!currentConversation.value || messages.value.length === 0) return
  if (!window.confirm('确定清空当前对话的全部消息吗？此操作不可撤销。')) return
  clearConversation()
}

function exportMarkdown(): void {
  closePopover()
  const history = buildHistory()
  if (history.length === 0) {
    showNotice('暂无消息可导出')
    return
  }
  const modelName = activeConfig.value
    ? `${activeConfig.value.name} / ${currentModelId.value}`
    : '未设置'
  const markdown = buildConversationMarkdown({
    modelName,
    messages: history,
    task: buildExportTask(currentConversation.value ?? null),
  })
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `对话记录-${formatDateTime(new Date()).replace(/[-: ]/g, '')}.md`
  link.click()
  URL.revokeObjectURL(url)
}

/** 导出为 HTML：与 Markdown 导出同构（任务卡片 + 工具调用记录），内联样式可直接双击打开 */
function exportHtml(): void {
  closePopover()
  const history = buildHistory()
  if (history.length === 0) {
    showNotice('暂无消息可导出')
    return
  }
  const modelName = activeConfig.value
    ? `${activeConfig.value.name} / ${currentModelId.value}`
    : '未设置'
  const html = buildConversationHtml({
    modelName,
    messages: history,
    task: buildExportTask(currentConversation.value ?? null),
  })
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `对话记录-${formatDateTime(new Date()).replace(/[-: ]/g, '')}.html`
  link.click()
  URL.revokeObjectURL(url)
}

async function copyConversation(): Promise<void> {
  closePopover()
  const text = buildConversationPlainText(buildHistory())
  if (!text) {
    showNotice('暂无消息可复制')
    return
  }
  try {
    await navigator.clipboard.writeText(text)
    showNotice('全部对话已复制到剪贴板')
  } catch {
    showNotice('复制失败：浏览器未授权剪贴板，可改用「导出 Markdown」')
  }
}

/** 「沉淀经验」固定指令：作为一条轻量标记的用户消息走正常发送/流式管线，由模型自行调用 memory_append */
const DISTILL_EXPERIENCE_INSTRUCTION =
  '【沉淀经验】请回顾以上对话，提炼值得长期沉淀的经验、偏好与约定（2-4 条，简洁），逐条调用 memory_append 写入工作区记忆，每条前简述一句。若本段对话没有值得沉淀的内容，直接说明。'

/** 更多菜单：沉淀经验 —— 让当前智能体回顾本段对话并调用 memory_append 写入工作区记忆 */
function distillExperience(): void {
  closePopover()
  if (streaming.value) return
  if (!currentConversation.value || messages.value.length === 0) {
    showNotice('请先开始对话')
    return
  }
  if (userInput.value.trim()) {
    showNotice('输入框还有未发送内容，请先发送或清空后再沉淀经验')
    return
  }
  userInput.value = DISTILL_EXPERIENCE_INSTRUCTION
  void sendMessage()
}

/* —— 输入框按键 —— */

function onComposerKeydown(event: KeyboardEvent): void {
  // Enter 发送；Shift+Enter 换行（保留默认行为）
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendMessage()
  }
}

/* —— 自动滚动 —— */

const scrollContainer = ref<HTMLElement | null>(null)
/** 用户未主动上翻时，新内容到达后自动贴底 */
const autoFollow = ref(true)

function isNearBottom(): boolean {
  const el = scrollContainer.value
  if (!el) return true
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

function scrollToBottom(): void {
  const el = scrollContainer.value
  if (el) el.scrollTop = el.scrollHeight
}

/** 距底部超过阈值（用户正在翻阅历史）时显示悬浮按钮 */
const showJumpToBottom = computed(() => !autoFollow.value)

function jumpToBottom(): void {
  autoFollow.value = true
  const el = scrollContainer.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
}

function onScroll(): void {
  autoFollow.value = isNearBottom()
}

watch(
  messages,
  async () => {
    if (autoFollow.value) {
      await nextTick()
      scrollToBottom()
    }
  },
  { deep: true },
)

/* —— 会话路由联动（置于全部状态定义之后：immediate 首跑即恢复上下文） —— */

watch(
  () => route.params.conversationId,
  () => {
    draftMessages.value = []
    // 切换对话 / 回草稿态：未发送的引用态一并清空
    quoteDraft.value = null
    autoFollow.value = true
    const id = currentConversationId.value
    if (!id) {
      // 回草稿态：激活技能是会话级状态，一并清空
      activatedSkillIds.value = []
      clearActivatedSkillIds()
      return
    }
    const conversation = conversationsStore.findConversation(id)
    if (!conversation) {
      // 无效 id（对话已被删除等）→ 回草稿态
      void router.replace({ name: 'chat' })
      return
    }
    // 跨工作区打开（如通过链接）：自动切到对话所属的工作区
    if (conversation.workspaceId && conversation.workspaceId !== activeWorkspaceId.value) {
      workspacesStore.setActiveWorkspace(conversation.workspaceId)
    }
    // 直接打开已归档对话（如通过链接）时自动恢复为进行中
    if (conversation.archived) {
      conversationsStore.unarchiveConversation(id)
    }
    workspacesStore.setLastConversation(conversation.workspaceId || activeWorkspaceId.value, id)
    restoreConversationContext(conversation)
  },
  { immediate: true },
)

// 切换路由后自动关闭窄屏会话抽屉与面板浮层
watch(
  () => route.fullPath,
  () => {
    closeSessionDrawer()
  },
)

/* —— 生命周期 —— */

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)

  // 支持从智能体中心跳转携带 ?agent=<id> 预选（需存在且未停用）
  const agentParam = route.query.agent
  const agentId = Array.isArray(agentParam) ? agentParam[0] : agentParam
  const hasAgentParam =
    typeof agentId === 'string' && agentsStore.enabledAgents.some((agent) => agent.id === agentId)
  if (hasAgentParam) {
    activeAgentId.value = agentId
    // 草稿态入口同样应用智能体的默认模型绑定
    applyAgentModelBinding(agentsStore.findAgent(agentId))
  }

  // 支持从技能中心跳转携带 ?skill=<id>：以 @ 引用方式选用该技能（需存在且未停用），
  // 模板正文不进输入框，改为行首 @ 标记并随每轮注入 system；已在列表中则不重复添加
  const skillParam = route.query.skill
  const skillId = Array.isArray(skillParam) ? skillParam[0] : skillParam
  const skill =
    typeof skillId === 'string'
      ? skillsStore.enabledSkills.find((item) => item.id === skillId)
      : undefined
  if (skill && !selectedSkillIds.value.includes(skill.id)) {
    selectedSkillIds.value = [...selectedSkillIds.value, skill.id]
  }

  // 刷新恢复：草稿态进入且无带参跳转（?agent= / ?skill= 表示显式开启新草稿）时，
  // 恢复当前工作区上次打开的对话（未归档）
  if (!currentConversationId.value && !hasAgentParam && !skill) {
    const lastId = activeWorkspace.value?.lastConversationId ?? ''
    const conversation = lastId ? conversationsStore.findConversation(lastId) : null
    if (conversation && !conversation.archived) {
      void router.replace({ name: 'chat', params: { conversationId: conversation.id } })
    }
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  if (noticeTimer) clearTimeout(noticeTimer)
  if (elapsedTimer) {
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }
  // 注意：不中止进行中的流式。流式状态在全局 chat-stream store 中，
  // 离开页面后台继续生成并写回 conversations store，返回时可恢复展示。
})
</script>

<template>
  <div class="chat-page">
    <!-- 左侧：会话工作区面板（工作区 × 对话两级；<900px 收为抽屉） -->
    <aside ref="sessionsRoot" class="chat-sessions" :class="{ 'is-open': sessionDrawerOpen }">
      <!-- 工作区选择器（通栏）+ 下拉/表单浮层 -->
      <div class="workspace-switch-root">
        <button
          class="workspace-switch"
          :class="{ 'is-open': panelPopover === 'workspace-menu' }"
          type="button"
          title="切换工作区"
          @click="toggleWorkspaceMenu"
        >
          <span class="workspace-switch-icon">{{ activeWorkspace?.icon ?? '📁' }}</span>
          <span class="workspace-switch-text">
            <span class="workspace-switch-name">{{ activeWorkspace?.name ?? '默认工作区' }}</span>
            <span v-if="activeWorkspace?.folderPath" class="workspace-folder-path">
              {{ activeWorkspace.folderPath }}
            </span>
          </span>
          <AppIcon name="chevron-down" class="workspace-switch-caret" />
        </button>

        <!-- 工作区下拉浮层 -->
        <div v-if="panelPopover === 'workspace-menu'" class="workspace-menu">
          <div
            v-for="ws in workspaceList"
            :key="ws.id"
            class="workspace-menu-item"
            :class="{ 'is-active': ws.id === activeWorkspaceId }"
            role="button"
            tabindex="0"
            @click="switchWorkspace(ws.id)"
            @keydown.enter="switchWorkspace(ws.id)"
          >
            <span class="workspace-menu-icon">{{ ws.icon }}</span>
            <span class="workspace-menu-text">
              <span class="workspace-menu-name">{{ ws.name }}</span>
              <span v-if="ws.folderPath" class="workspace-folder-path">{{ ws.folderPath }}</span>
            </span>
            <button
              class="workspace-menu-edit"
              type="button"
              title="编辑工作区（重命名 / 删除）"
              @click.stop="openWorkspaceRenameForm(ws)"
            >
              <AppIcon name="edit" />
            </button>
            <AppIcon v-if="ws.id === activeWorkspaceId" name="check" class="workspace-menu-check" />
          </div>
          <button class="workspace-menu-create" type="button" @click="openWorkspaceCreateForm">
            <AppIcon name="plus" />
            <span>新建工作区</span>
          </button>
        </div>

        <!-- 新建 / 编辑工作区表单浮层 -->
        <div v-else-if="panelPopover === 'workspace-form'" class="workspace-form">
          <p class="workspace-form-title">
            {{ workspaceForm?.mode === 'rename' ? '编辑工作区' : '新建工作区' }}
          </p>
          <label class="popover-label" for="workspace-name-input">名称</label>
          <input
            id="workspace-name-input"
            ref="workspaceNameInputEl"
            v-model="workspaceFormName"
            class="workspace-form-input"
            type="text"
            maxlength="20"
            placeholder="例如：产品研发、日常琐事…"
            @keydown.enter.prevent="submitWorkspaceForm"
          />
          <p class="popover-label">图标</p>
          <div class="workspace-icon-row">
            <button
              v-for="emoji in WORKSPACE_ICON_PRESETS"
              :key="emoji"
              class="workspace-icon-option"
              :class="{ 'is-selected': workspaceFormIcon === emoji }"
              type="button"
              :title="emoji"
              @click="workspaceFormIcon = emoji"
            >
              {{ emoji }}
            </button>
          </div>
          <label class="popover-label" for="workspace-folder-input">关联文件夹（可选）</label>
          <div class="workspace-folder-row">
            <input
              id="workspace-folder-input"
              v-model="workspaceFormFolderPath"
              class="workspace-folder-input"
              type="text"
              placeholder="例如：D:\projects\my-app"
              @keydown.enter.prevent="submitWorkspaceForm"
            />
            <button
              v-if="workspaceFormFolderPath"
              class="workspace-folder-clear"
              type="button"
              title="清除关联文件夹"
              @click="workspaceFormFolderPath = ''"
            >
              <AppIcon name="close" />
            </button>
            <button class="workspace-folder-pick" type="button" @click="chooseWorkspaceFolder">
              选择…
            </button>
          </div>
          <div class="workspace-form-actions">
            <button
              v-if="workspaceForm?.mode === 'rename'"
              class="workspace-form-delete"
              type="button"
              title="删除工作区（连带删除其中全部对话）"
              @click="workspaceForm && confirmRemoveWorkspace(workspaceForm.id)"
            >
              <AppIcon name="trash" />
              <span>删除</span>
            </button>
            <span class="workspace-form-spacer" aria-hidden="true"></span>
            <button class="btn btn-ghost" type="button" @click="closePanelPopover">取消</button>
            <button
              class="btn btn-primary"
              type="button"
              :disabled="!workspaceFormName.trim()"
              @click="submitWorkspaceForm"
            >
              确定
            </button>
          </div>
        </div>
      </div>

      <!-- 新增对话（通栏） -->
      <button class="sessions-new" type="button" @click="startNewConversation">
        <AppIcon name="plus" />
        <span>新增对话</span>
      </button>

      <!-- 检查点回滚（当前会话）：列出 fs_write / fs_edit 自动快照，可回滚 -->
      <button
        v-if="currentConversationId"
        class="sessions-new sessions-checkpoint"
        type="button"
        title="查看当前会话的检查点并回滚工作区文件"
        @click="showCheckpointPanel = true"
      >
        <AppIcon name="refresh" />
        <span>检查点回滚</span>
      </button>

      <div class="sessions-tabs">
        <button
          class="sessions-tab"
          :class="{ 'is-active': sessionTab === 'active' }"
          type="button"
          @click="sessionTab = 'active'"
        >
          <span>进行中</span>
          <span class="sessions-count">{{ activeSessions.length }}</span>
        </button>
        <button
          class="sessions-tab"
          :class="{ 'is-active': sessionTab === 'archived' }"
          type="button"
          @click="sessionTab = 'archived'"
        >
          <span>已归档</span>
          <span class="sessions-count">{{ archivedSessions.length }}</span>
        </button>
      </div>

      <div class="sessions-list">
        <!-- 进行中列表 -->
        <template v-if="sessionTab === 'active'">
          <div
            v-for="item in activeSessions"
            :key="item.id"
            class="session-item"
            :class="{ 'is-current': item.id === currentConversationId }"
            role="button"
            tabindex="0"
            @click="openConversation(item.id)"
            @keydown.enter="openConversation(item.id)"
          >
            <span class="session-main">
              <span class="session-title">{{ item.title }}</span>
              <span class="session-time">{{ formatSessionTime(item.updatedAt) }}</span>
            </span>
            <span class="session-actions">
              <button
                class="session-action"
                type="button"
                title="重命名对话"
                @click.stop="renameSession(item.id)"
              >
                <AppIcon name="edit" />
              </button>
              <button
                class="session-action"
                type="button"
                title="归档对话"
                @click.stop="archiveSession(item.id)"
              >
                <AppIcon name="archive" />
              </button>
            </span>
          </div>
          <p v-if="activeSessions.length === 0" class="sessions-empty">
            该工作区还没有对话，点击上方新增开始
          </p>
        </template>

        <!-- 已归档列表 -->
        <template v-else>
          <div
            v-for="item in archivedSessions"
            :key="item.id"
            class="session-item"
            role="button"
            tabindex="0"
            @click="restoreArchivedSession(item.id)"
            @keydown.enter="restoreArchivedSession(item.id)"
          >
            <span class="session-main">
              <span class="session-title">{{ item.title }}</span>
              <span class="session-time">{{ formatSessionTime(item.updatedAt) }}</span>
            </span>
            <span class="session-actions">
              <button
                class="session-action"
                type="button"
                title="恢复对话"
                @click.stop="restoreArchivedSession(item.id)"
              >
                <AppIcon name="upload" />
              </button>
              <button
                class="session-action is-danger"
                type="button"
                title="删除对话（不可撤销）"
                @click.stop="removeSession(item.id)"
              >
                <AppIcon name="trash" />
              </button>
            </span>
          </div>
          <p v-if="archivedSessions.length === 0" class="sessions-empty">暂无归档对话</p>
        </template>
      </div>

      <!-- Vault 笔记面板（Obsidian vault，仅桌面端可用） -->
      <VaultPanel
        v-if="vaultAvailable"
        ref="vaultPanelRef"
        :folder-path="activeWorkspace?.folderPath ?? ''"
        @insert="insertVaultNote"
        @attach="attachVaultNote"
        @notice="showNotice"
      />
      <p
        v-else-if="!vaultLinked"
        class="sessions-empty vault-link-hint"
        role="button"
        tabindex="0"
        title="去工作区设置关联文件夹"
        @click="openVaultLinkForm"
        @keydown.enter="openVaultLinkForm"
      >
        关联笔记文件夹后，可在这里浏览 Vault 笔记（点击去关联）
      </p>
      <p v-else class="sessions-empty vault-link-hint">Vault 笔记功能需在桌面端使用</p>
    </aside>

    <!-- 窄屏抽屉遮罩 -->
    <div
      class="sessions-backdrop"
      :class="{ 'is-visible': sessionDrawerOpen }"
      aria-hidden="true"
      @click="closeSessionDrawer"
    ></div>

    <!-- 右侧：消息区 + 输入区 -->
    <section class="chat-main">
      <!-- 窄屏会话面板开关（≥900px 隐藏） -->
      <button
        class="icon-button chat-mobile-toggle"
        type="button"
        aria-label="打开会话面板"
        @click="sessionDrawerOpen = true"
      >
        <AppIcon name="menu" />
      </button>

      <!-- 消息区 -->
      <div class="chat-messages-wrap">
      <div ref="scrollContainer" class="chat-messages" @scroll.passive="onScroll">
        <div class="chat-messages-inner">
          <!-- 未配置引导 -->
          <div v-if="configs.length === 0" class="chat-guide">
            <h2>还没有可用的模型</h2>
            <p>
              先到「设置 · 模型接入」添加一套 OpenAI 兼容模型配置（智谱 GLM、DeepSeek
              等），再来这里对话。
            </p>
            <RouterLink
              class="btn btn-primary"
              :to="{ path: '/settings', query: { tab: 'models' } }"
            >
              前往设置
            </RouterLink>
          </div>

          <!-- 已有配置但未选择 -->
          <div v-else-if="!activeConfig" class="chat-guide">
            <h2>请选择要使用的模型</h2>
            <p>
              在下方输入区工具栏的「模型」菜单中选择模型（按配置分组，主模型标「主」），即可开始对话。
            </p>
          </div>

          <template v-else>
            <div v-if="messages.length === 0" class="chat-guide">
              <div class="guide-hero" aria-hidden="true">
                <span class="guide-dot guide-dot-a"></span>
                <BearMascot :size="88" />
                <span class="guide-ring guide-ring-b"></span>
                <span class="guide-dot guide-dot-c"></span>
              </div>
              <template v-if="currentConversation">
                <h2>继续和熊聊聊这个任务</h2>
                <p>描述你的任务直接发送，回复将以流式逐字呈现；Enter 发送，Shift+Enter 换行。</p>
              </template>
              <template v-else>
                <h2>今天想和熊聊点什么？</h2>
                <p>{{ draftGuideText }}</p>
              </template>
            </div>

            <div
              v-for="row in messageRows"
              :key="row.message.id"
              class="chat-row"
              :class="[
                row.message.role === 'user' ? 'is-user' : 'is-assistant',
                { 'is-continued': !row.isFirstOfGroup },
              ]"
            >
              <!-- 头像列：助手在左 / 用户在右；连续消息折叠为等宽透明占位保持缩进 -->
              <div class="chat-avatar-col" aria-hidden="true">
                <template v-if="row.isFirstOfGroup">
                  <AgentAvatar
                    v-if="row.message.role === 'user'"
                    class="chat-user-avatar"
                    :avatar="accountStore.avatar ?? undefined"
                    :name="accountStore.displayName()"
                  />
                  <AgentAvatar
                    v-else-if="chatAgent"
                    class="chat-agent-avatar"
                    :avatar="chatAgent.avatar"
                    :icon="chatAgent.icon"
                    :name="chatAgent.name"
                  />
                  <span v-else class="chat-brand-avatar">H</span>
                </template>
              </div>
              <div class="chat-content-col">
                <!-- 昵称行：仅助手侧、组首条展示，与头像顶端对齐 -->
                <div
                  v-if="row.message.role === 'assistant' && row.isFirstOfGroup"
                  class="chat-agent-name"
                >
                  {{ chatAgentName }}
                  <span
                    v-if="row.message.status === 'streaming'"
                    class="chat-live-dot"
                    aria-hidden="true"
                  ></span>
                </div>
                <span
                  v-if="row.message.createdAt"
                  class="chat-timestamp"
                  aria-hidden="true"
                >
                  {{ formatDateTime(new Date(row.message.createdAt)) }}
                </span>
                <!-- 引用回复块：随用户消息持久化，刷新后仍可见（两行截断） -->
                <div
                  v-if="row.message.quote"
                  class="chat-quote"
                  :title="`${row.message.quote.author}：${row.message.quote.text}`"
                >
                  <span class="chat-quote-author">{{ row.message.quote.author }}</span>
                  <span class="chat-quote-text">{{ row.message.quote.text }}</span>
                </div>
                <div
                  class="chat-bubble"
                  :class="[`role-${row.message.role}`, { 'is-error': row.message.status === 'error' }]"
                >
                <!-- 思考过程（可折叠） -->
                <details
                  v-if="row.message.reasoning"
                  class="chat-reasoning"
                  :open="row.message.status === 'streaming'"
                >
                  <summary>思考过程</summary>
                  <div class="chat-reasoning-body">{{ row.message.reasoning }}</div>
                </details>

                <!-- 工具调用卡片（function calling，按执行顺序可折叠） -->
                <div v-if="row.message.toolSteps?.length" class="chat-tools">
                  <ToolStepCard
                    v-for="(step, stepIndex) in row.message.toolSteps"
                    :key="stepIndex"
                    :step="step"
                  />
                </div>

                <!-- 正文 -->
                <p v-if="row.message.status === 'error'" class="chat-error-text">
                  {{ row.message.errorText }}
                </p>
                <!-- 正文：assistant 走 Markdown 渲染（已消毒）；user 保持纯文本 -->
                <template v-else-if="row.message.content || row.message.status !== 'streaming'">
                  <RichText
                    v-if="row.message.role === 'assistant'"
                    class="chat-text is-rich"
                    :content="row.message.content || '（模型未返回文本内容）'"
                  />
                  <p v-else class="chat-text">{{ row.message.content }}</p>
                </template>
                <p
                  v-if="row.message.status === 'streaming' && !row.message.content && !row.message.reasoning"
                  class="chat-pending"
                >
                  正在思考…
                </p>
                <span
                  v-if="row.message.status === 'streaming' && row.message.content"
                  class="chat-cursor"
                  aria-hidden="true"
                ></span>

                <span v-if="row.message.status === 'aborted'" class="chat-stopped">已停止生成</span>

                <!-- 消息操作：引用回复（用户与助手消息均支持，hover 显示；有正文即可引用） -->
                <div v-if="row.message.content.trim()" class="chat-msg-actions">
                  <button
                    class="msg-action"
                    type="button"
                    title="引用该消息内容，随下一条消息一起发送"
                    @click="startQuote(row.message)"
                  >
                    <AppIcon name="quote" />
                    <span>引用</span>
                  </button>
                </div>

                <!-- 消息操作：AI 回复可存为 vault 笔记（未关联文件夹时置灰） -->
                <div
                  v-if="row.message.role === 'assistant' && row.message.status === 'done' && row.message.content"
                  class="chat-msg-actions"
                >
                  <button
                    class="msg-action"
                    type="button"
                    title="存为笔记（写入工作区关联文件夹的「AI 笔记」目录）"
                    :disabled="!vaultAvailable"
                    @click="saveMessageAsNote(row.message)"
                  >
                    <AppIcon name="note" />
                    <span>存为笔记</span>
                  </button>
                </div>
                <!-- 计划闭环：识别「## 执行计划」区块，批准后由执行子智能体逐步执行 -->
                <div
                  v-if="getPlanBlock(row.message) && !isPlanIgnored(row.message)"
                  class="chat-msg-actions plan-actions"
                >
                  <button
                    class="msg-action plan-approve"
                    type="button"
                    :disabled="planApproveHint() !== ''"
                    :title="planApproveHint() || '按计划逐步派发执行子智能体执行'"
                    @click="approvePlan(row.message)"
                  >
                    <AppIcon name="check" />
                    <span>批准执行</span>
                  </button>
                  <label class="msg-action plan-parallel-toggle" title="标注了「[并行]」的相邻步骤将并发执行">
                    <input v-model="taskParallelEnabled" type="checkbox" />
                    <span>并行执行</span>
                  </label>
                  <button
                    v-if="permissionStore.mode === 'confirm'"
                    class="msg-action"
                    type="button"
                    title="执行子智能体修改文件时无需逐步确认，整体执行更快"
                    @click="switchToAutoEdit"
                  >
                    <AppIcon name="pen" />
                    <span>切换到自动编辑</span>
                  </button>
                  <button class="msg-action" type="button" @click="ignorePlan(row.message)">
                    <AppIcon name="close" />
                    <span>忽略</span>
                  </button>
                </div>
                </div>
              </div>
            </div>

            <!-- 执行任务卡片（批准计划后逐步执行，状态随会话持久化） -->
            <TaskRunCard
              v-if="activeTaskRun"
              :task-run="activeTaskRun"
              :conversation-id="currentConversationId"
              :model-options="taskModelOptions"
              @bind-model="bindStepModel"
              @stop="stopTaskRun"
              @resume="resumeTaskRun"
            />

            <!-- 生成中实时计时（本轮任务累计耗时，生成结束即隐藏） -->
            <p v-if="streamElapsedText" class="chat-elapsed">{{ streamElapsedText }} ›</p>
          </template>
        </div>
      </div>

      <!-- 跳转到底部：仅当用户上翻离底部超过阈值时出现 -->
      <Transition name="jump-fade">
        <button
          v-if="showJumpToBottom"
          class="jump-to-bottom"
          type="button"
          aria-label="跳转到底部"
          title="跳转到底部"
          @click="jumpToBottom"
        >
          <AppIcon name="chevron-down" />
        </button>
      </Transition>
      </div>

      <!-- 检查点面板（侧栏入口打开；全屏浮层） -->
      <CheckpointPanel
        v-if="showCheckpointPanel && currentConversationId"
        :conversation-id="currentConversationId"
        @close="showCheckpointPanel = false"
      />

      <!-- 任务式输入区 -->
      <footer class="chat-composer">
        <div
          ref="composerRoot"
          class="composer-shell"
          :class="{ 'is-dragover': dragDepth > 0 }"
          @dragenter="onDragEnter"
          @dragover="onDragOver"
          @dragleave="onDragLeave"
          @drop="onDrop"
        >
          <!-- 目标 / 附件 chips（输入框上沿） -->
          <div v-if="goal || attachments.length" class="composer-chips">
            <span
              v-if="goal"
              class="attach-chip chip-goal"
              title="任务目标：作为系统指令随每条消息发送"
            >
              <span class="chip-label">目标</span>
              <span class="chip-text">{{ goal }}</span>
              <button class="chip-x" type="button" title="清除目标" @click="clearGoal">
                <AppIcon name="close" />
              </button>
            </span>
            <span
              v-for="item in attachments"
              :key="item.id"
              class="attach-chip chip-file"
              :title="
                item.kind === 'image'
                  ? `${item.name}（${item.dimensions || '尺寸未知'}）· 图片附件随会话持久化，需要支持视觉的模型`
                  : item.truncated
                    ? `${item.name}（超过 100KB，已截断）`
                    : item.name
              "
            >
              <img
                v-if="item.kind === 'image' && item.dataUrl"
                class="chip-thumb"
                :src="item.dataUrl"
                alt=""
              />
              <AppIcon v-else name="paperclip" />
              <span class="chip-text">{{ item.name }}</span>
              <span v-if="item.kind === 'image'" class="chip-size">
                {{ item.dimensions || '图片' }} · 需要支持视觉的模型
              </span>
              <span v-else class="chip-size">{{ formatFileSize(item.size) }}</span>
              <button
                class="chip-x"
                type="button"
                title="移除附件"
                @click="removeAttachment(item.id)"
              >
                <AppIcon name="close" />
              </button>
            </span>
          </div>

          <!-- 轻提示 -->
          <p v-if="notice" class="composer-notice">{{ notice }}</p>

          <!-- 容量提示：会话附件（含已持久化图片）总量超阈值时提醒 -->
          <p v-if="showCapacityHint" class="composer-notice">
            当前会话附件已占用约 {{ formatFileSize(conversationAttachmentBytes) }}（图片附件会随会话持久化），过大可能拖慢会话加载，建议清理历史图片或新建会话。
          </p>

          <!-- 引用回复条：引用草稿挂在输入框上方（发送 / 取消 / 切换对话时清空） -->
          <div v-if="quoteDraft" class="composer-quote">
            <span class="composer-quote-author">{{ quoteDraft.author }}</span>
            <span class="composer-quote-text" :title="quoteDraft.text">{{ quoteDraft.text }}</span>
            <button
              class="composer-quote-x"
              type="button"
              title="取消引用"
              @click="clearQuote"
            >
              <AppIcon name="close" />
            </button>
          </div>

          <!-- @ 引用行：已选技能以内联标记挂在输入框行首，模板正文不进 textarea；
               无标记时 textarea 独占整行，布局与旧版一致 -->
          <div class="composer-input-row">
            <span
              v-for="skill in selectedSkills"
              :key="skill.id"
              class="composer-mention"
              :class="{ 'is-disabled': skill.disabled }"
              :title="
                skill.disabled
                  ? `${skill.name}（已停用，发送时不注入）`
                  : `技能 @ 引用：${skill.name}（模板随每轮请求注入 system）`
              "
            >
              <span class="mention-text">@{{ skill.name }}</span>
              <button
                class="mention-x"
                type="button"
                title="移除该技能"
                @click="removeSkill(skill.id)"
              >
                ×
              </button>
            </span>
            <textarea
              ref="inputEl"
              v-model="userInput"
              class="chat-input"
              rows="3"
              :placeholder="
                activeConfig
                  ? '描述你的任务，或拖入文件 / 粘贴路径与链接…'
                  : '请先在下方「模型」菜单中选择模型'
              "
              :disabled="!activeConfig"
              @keydown="onComposerKeydown"
              @paste="onComposerPaste"
            ></textarea>
          </div>

          <!-- 工具栏：模型 / 目标 / 附件 / 智能体 / 技能 / 更多 + 发送 -->
          <div class="composer-toolbar">
            <div class="composer-tools">
              <button
                class="tool-btn tool-model"
                :class="{ 'is-open': activePopover === 'model' }"
                type="button"
                title="选择模型"
                @click="togglePopover('model')"
              >
                <span class="tool-model-text">{{ currentModelId || '选择模型' }}</span>
                <AppIcon name="chevron-down" class="tool-caret" />
              </button>
              <button
                class="tool-btn"
                :class="{ 'is-active': !!goal }"
                type="button"
                title="设置任务目标（随每条消息作为系统指令发送）"
                @click="togglePopover('goal')"
              >
                <AppIcon name="target" />
                <span>目标</span>
                <span v-if="goal" class="tool-dot" aria-hidden="true"></span>
              </button>
              <button
                class="tool-btn"
                :class="{ 'is-active': attachments.length > 0 }"
                type="button"
                title="添加文本附件（也可拖拽或粘贴文件）"
                @click="fileInputEl?.click()"
              >
                <AppIcon name="paperclip" />
                <span>附件</span>
                <span v-if="attachments.length" class="tool-badge">{{ attachments.length }}</span>
              </button>
              <button
                class="tool-btn"
                :class="{ 'is-active': activeAgentId !== DEFAULT_AGENT_ID }"
                type="button"
                title="选择智能体人设"
                @click="togglePopover('agent')"
              >
                <AppIcon name="bot" />
                <span class="tool-agent-text">{{ activeAgentLabel }}</span>
                <span
                  v-if="activeAgentId !== DEFAULT_AGENT_ID"
                  class="tool-dot"
                  aria-hidden="true"
                ></span>
              </button>
              <button
                class="tool-btn"
                :class="{ 'is-active': selectedSkillIds.length > 0 }"
                type="button"
                title="选择技能（@ 引用，正文随系统消息注入）"
                @click="togglePopover('skill')"
              >
                <AppIcon name="sparkles" />
                <span>技能</span>
                <span v-if="selectedSkillIds.length" class="tool-badge">{{
                  selectedSkillIds.length
                }}</span>
              </button>
              <button
                class="tool-btn"
                :class="{ 'is-active': permissionStore.mode !== 'confirm' }"
                type="button"
                title="权限模式：控制智能体执行写类工具的确认策略"
                @click="togglePopover('permission')"
              >
                <AppIcon :name="currentPermissionMeta.icon" />
                <span>{{ currentPermissionMeta.label }}</span>
                <AppIcon name="chevron-down" class="tool-caret" />
              </button>
              <button
                class="tool-btn"
                :class="{ 'is-open': activePopover === 'more' }"
                type="button"
                title="更多操作"
                @click="togglePopover('more')"
              >
                <AppIcon name="more" />
                <span>更多</span>
              </button>
            </div>

            <button
              v-if="streaming"
              class="btn btn-stop composer-stop"
              type="button"
              @click="stopStreaming()"
            >
              停止
            </button>
            <button
              v-else
              class="composer-send"
              type="button"
              aria-label="发送"
              title="发送"
              :disabled="!activeConfig || !userInput.trim()"
              @click="sendMessage"
            >
              <AppIcon name="send" />
            </button>
          </div>

          <!-- 模型菜单 -->
          <div v-if="activePopover === 'model'" class="composer-popover popover-model">
            <template v-for="config in configs" :key="config.id">
              <p class="popover-group">{{ config.name }}</p>
              <button
                v-for="(model, index) in config.modelIds"
                :key="`${config.id}:${model}`"
                class="popover-item"
                :class="{
                  'is-selected': config.id === activeConfigId && model === currentModelId,
                }"
                type="button"
                @click="pickModel(config.id, model)"
              >
                <span class="popover-item-text">{{ model }}</span>
                <span v-if="index === 0" class="popover-tag">主</span>
                <AppIcon
                  v-if="config.id === activeConfigId && model === currentModelId"
                  name="check"
                />
              </button>
            </template>
            <p v-if="configs.length === 0" class="popover-empty">
              还没有模型配置，请先到设置页添加
            </p>
          </div>

          <!-- 目标浮层 -->
          <div v-else-if="activePopover === 'goal'" class="composer-popover popover-goal">
            <label class="popover-label" for="chat-goal-input"
              >任务目标（会作为系统指令随每条消息发送）</label
            >
            <textarea
              id="chat-goal-input"
              ref="goalInputEl"
              v-model="goalDraft"
              class="goal-input"
              rows="4"
              placeholder="例如：只回答与本项目相关的问题，回答保持简洁…"
            ></textarea>
            <div class="popover-actions">
              <button v-if="goal" class="btn btn-ghost" type="button" @click="clearGoal">
                清除
              </button>
              <button class="btn btn-primary" type="button" @click="confirmGoal">确定</button>
            </div>
          </div>

          <!-- 智能体浮层（内置 + 自定义合并清单，过滤停用） -->
          <div v-else-if="activePopover === 'agent'" class="composer-popover popover-list">
            <button
              v-for="agent in agentsStore.enabledAgents"
              :key="agent.id"
              class="popover-item"
              :class="{ 'is-selected': agent.id === activeAgentId }"
              type="button"
              @click="selectAgent(agent.id)"
            >
              <span class="popover-agent-avatar" aria-hidden="true">
                <AgentAvatar :avatar="agent.avatar" :icon="agent.icon" :name="agent.name" />
              </span>
              <span class="popover-item-main">
                <span class="popover-item-title">{{ agent.name }}</span>
                <span class="popover-item-desc">{{ agent.description }}</span>
              </span>
              <AppIcon v-if="agent.id === activeAgentId" name="check" />
            </button>
            <p class="popover-tip">在「智能体中心」可管理内置与自定义智能体</p>
          </div>

          <!-- 技能浮层（内置 + 自定义合并清单，过滤停用；点击切换 @ 选用，不关闭便于多选） -->
          <div v-else-if="activePopover === 'skill'" class="composer-popover popover-list">
            <button
              v-for="skill in skillsStore.enabledSkills"
              :key="skill.id"
              class="popover-item"
              :class="{ 'is-selected': selectedSkillIds.includes(skill.id) }"
              type="button"
              @click="toggleSkill(skill)"
            >
              <span class="popover-skill-avatar" aria-hidden="true">{{ skill.icon }}</span>
              <span class="popover-item-main">
                <span class="popover-item-title">{{ skill.name }}</span>
                <span class="popover-item-desc">{{ skill.description }}</span>
              </span>
              <AppIcon v-if="selectedSkillIds.includes(skill.id)" name="check" />
            </button>
            <p class="popover-tip">
              点击技能以 @ 引用，正文随每轮发送注入 system；可在「技能中心」管理技能
            </p>
          </div>

          <!-- 权限模式菜单（与设置页共用 permission store，切换即时生效） -->
          <div v-else-if="activePopover === 'permission'" class="composer-popover popover-list">
            <button
              v-for="meta in PERMISSION_MODES"
              :key="meta.value"
              class="popover-item"
              :class="{ 'is-selected': permissionStore.mode === meta.value }"
              type="button"
              @click="pickPermissionMode(meta.value)"
            >
              <AppIcon :name="meta.icon" />
              <span class="popover-item-main">
                <span class="popover-item-title">{{ meta.label }}</span>
                <span class="popover-item-desc">{{ meta.description }}</span>
              </span>
              <AppIcon v-if="permissionStore.mode === meta.value" name="check" />
            </button>
          </div>

          <!-- 更多菜单 -->
          <div v-else-if="activePopover === 'more'" class="composer-popover popover-more">
            <button
              class="popover-item"
              type="button"
              :disabled="!currentConversation || messages.length === 0"
              @click="confirmClearConversation"
            >
              <AppIcon name="trash" />
              <span>清空对话</span>
            </button>
            <button
              class="popover-item"
              type="button"
              :disabled="messages.length === 0"
              @click="exportMarkdown"
            >
              <AppIcon name="download" />
              <span>导出对话为 Markdown</span>
            </button>
            <button
              class="popover-item"
              type="button"
              :disabled="messages.length === 0"
              @click="exportHtml"
            >
              <AppIcon name="download" />
              <span>导出对话为 HTML</span>
            </button>
            <button
              class="popover-item"
              type="button"
              :disabled="!currentConversation || messages.length === 0 || streaming"
              @click="distillExperience"
            >
              <AppIcon name="note" />
              <span>沉淀经验</span>
            </button>
            <button
              class="popover-item"
              type="button"
              :disabled="messages.length === 0"
              @click="copyConversation"
            >
              <AppIcon name="copy" />
              <span>复制全部对话</span>
            </button>
          </div>

          <!-- 隐藏文件选择框 -->
          <input
            ref="fileInputEl"
            class="file-input"
            type="file"
            :accept="FILE_ACCEPT"
            multiple
            @change="onFileInputChange"
          />
        </div>
        <p class="chat-composer-hint">
          Enter 发送 · Shift + Enter 换行 · 附件仅随当轮发送；目标、智能体与 @
          选用技能会作为系统消息注入每轮请求
        </p>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.chat-page {
  height: 100%;
  display: flex;
  min-height: 0;
  min-width: 0;
}

/* —— 会话工作区面板（导航面板沉底：muted 底，层级上让右侧对话区 surface 成为更亮一级） —— */
.chat-sessions {
  display: flex;
  flex-direction: column;
  width: 264px;
  flex-shrink: 0;
  background: var(--color-surface-muted);
  border-right: 1px solid var(--color-border);
}

/* —— 工作区选择器（面板顶部通栏） —— */
.workspace-switch-root {
  position: relative;
  padding: var(--space-3) var(--space-3) var(--space-2);
}

.workspace-switch {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 34px;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

/* muted 面板底上的 hover：提亮到 surface，形成「白卡浮起」层级 */
.workspace-switch:hover {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.workspace-switch.is-open {
  color: var(--color-brand);
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.workspace-switch-icon {
  font-size: var(--font-size-lg);
  line-height: 1;
  flex-shrink: 0;
}

/* 名称 + 已关联文件夹路径（可选第二行）的纵向文本列 */
.workspace-switch-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.workspace-switch-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

/* 已关联文件夹路径（选择器通栏与下拉列表项共用）：muted 小字号、单行省略 */
.workspace-folder-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.3;
}

.workspace-switch-caret {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform var(--transition-fast);
}

.workspace-switch.is-open .workspace-switch-caret {
  transform: rotate(180deg);
}

/* 工作区下拉 / 表单浮层（锚定选择器下方） */
.workspace-menu,
.workspace-form {
  position: absolute;
  top: calc(100% - var(--space-2) + 4px);
  left: var(--space-3);
  right: var(--space-3);
  z-index: 40;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
}

.workspace-menu-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--color-text);
  cursor: pointer;
}

.workspace-menu-item:hover {
  background: var(--color-surface-muted);
}

.workspace-menu-item.is-active {
  color: var(--color-brand);
  background: var(--color-brand-soft);
}

.workspace-menu-icon {
  font-size: var(--font-size-lg);
  line-height: 1;
  flex-shrink: 0;
}

/* 名称 + 已关联文件夹路径（可选第二行）的纵向文本列 */
.workspace-menu-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.workspace-menu-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-menu-edit {
  display: none;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
}

.workspace-menu-item:hover .workspace-menu-edit,
.workspace-menu-item:focus-within .workspace-menu-edit {
  display: inline-flex;
}

.workspace-menu-edit:hover {
  color: var(--color-brand);
  background: var(--color-surface);
}

.workspace-menu-edit .app-icon {
  width: 13px;
  height: 13px;
}

.workspace-menu-check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.workspace-menu-create {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-1);
  padding: var(--space-2);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.workspace-menu-create:hover {
  color: var(--color-brand);
  border-color: var(--color-brand);
}

.workspace-menu-create .app-icon {
  width: 14px;
  height: 14px;
}

/* 新建 / 编辑工作区表单 */
.workspace-form-title {
  margin: var(--space-1) var(--space-2);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.workspace-form-input {
  display: block;
  width: 100%;
  margin: var(--space-1) 0 var(--space-2);
  padding: var(--space-2);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
}

.workspace-form-input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.workspace-icon-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
  margin: var(--space-1) 0 var(--space-2);
}

.workspace-icon-option {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-size: var(--font-size-lg);
  line-height: 1;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.workspace-icon-option:hover {
  border-color: var(--color-border-strong);
  background: var(--color-surface-muted);
}

.workspace-icon-option.is-selected {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

/* 表单「关联文件夹」行：路径输入 + 清除 + 选择 */
.workspace-folder-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  margin: var(--space-1) 0 var(--space-2);
}

.workspace-folder-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-xs);
}

.workspace-folder-input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.workspace-folder-clear,
.workspace-folder-pick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  flex-shrink: 0;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.workspace-folder-clear {
  width: 30px;
  padding: 0;
}

.workspace-folder-clear:hover,
.workspace-folder-pick:hover {
  color: var(--color-brand);
  border-color: var(--color-brand);
}

.workspace-folder-clear .app-icon {
  width: 13px;
  height: 13px;
}

.workspace-form-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.workspace-form-actions .btn {
  height: 30px;
}

.workspace-form-delete {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-danger);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.workspace-form-delete:hover {
  background: var(--color-danger-soft);
}

.workspace-form-delete .app-icon {
  width: 13px;
  height: 13px;
}

.workspace-form-spacer {
  flex: 1;
}

/* —— 新增对话（通栏） —— */
.sessions-new {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin: 0 var(--space-3) var(--space-2);
  height: 32px;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.sessions-new:hover {
  color: var(--color-brand);
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.sessions-new .app-icon {
  width: 14px;
  height: 14px;
}

/* 分段切换：进行中 / 已归档 */
.sessions-tabs {
  display: flex;
  gap: var(--space-1);
  padding: 0 var(--space-3) var(--space-2);
}

.sessions-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.sessions-tab:hover {
  color: var(--color-text);
  background: var(--color-surface);
}

.sessions-tab.is-active {
  color: var(--color-brand);
  background: var(--color-brand-soft);
}

.sessions-count {
  min-width: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  font-size: 11px;
  line-height: 14px;
}

.sessions-tab.is-active .sessions-count {
  background: var(--color-brand);
  color: var(--color-on-brand);
}

.sessions-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 var(--space-2) var(--space-3);
}

.session-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
  border-left: 3px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.session-item:hover {
  background: var(--color-surface);
}

.session-item:focus-visible {
  outline: 2px solid var(--color-brand);
  outline-offset: -2px;
}

.session-item.is-current {
  background: var(--color-brand-soft);
  border-left-color: var(--color-brand);
}

.session-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

.session-item.is-current .session-title {
  color: var(--color-brand);
  font-weight: 500;
}

.session-time {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* 操作按钮：hover / 聚焦时显示 */
.session-actions {
  display: none;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.session-item:hover .session-actions,
.session-item:focus-within .session-actions {
  display: inline-flex;
}

.session-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.session-action:hover {
  color: var(--color-brand);
  background: var(--color-surface);
}

.session-action.is-danger:hover {
  color: var(--color-danger);
}

.session-action .app-icon {
  width: 14px;
  height: 14px;
}

.sessions-empty {
  margin: var(--space-4) var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: center;
}

/* —— Vault 笔记面板（未关联/非桌面端提示） —— */
.vault-link-hint {
  cursor: pointer;
  transition: color var(--transition-fast);
}

.vault-link-hint[role='button']:hover {
  color: var(--color-brand);
}

/* —— 消息操作（hover / 聚焦时显示） —— */
.chat-msg-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--space-2);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.chat-row:hover .chat-msg-actions,
.chat-bubble:focus-within .chat-msg-actions {
  opacity: 1;
}

.msg-action {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.msg-action:hover:not(:disabled) {
  color: var(--color-brand);
  background: var(--color-brand-soft);
}

.msg-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.msg-action .app-icon {
  width: 13px;
  height: 13px;
}

/* —— 引用回复 —— */

/* 消息气泡上方的引用块（两行截断，随消息持久化） */
.chat-quote {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  padding: var(--space-2);
  border-left: 3px solid var(--color-brand);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  min-width: 0;
}

.chat-quote-author {
  flex-shrink: 0;
  font-weight: 600;
}

.chat-quote-text {
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
}

/* 计划闭环操作条：批准（主操作色）/ 忽略 */
.plan-approve {
  color: var(--color-brand);
}

.plan-approve:hover:not(:disabled) {
  color: var(--color-brand);
  background: var(--color-brand-soft);
}

/* 计划操作条：并行执行开关（复用 msg-action 外观，内嵌复选框） */
.plan-parallel-toggle {
  cursor: pointer;
  user-select: none;
  gap: var(--space-1);
}

.plan-parallel-toggle input {
  margin: 0;
  accent-color: var(--color-brand);
  cursor: pointer;
}

/* 窄屏抽屉遮罩（仅 sessionDrawerOpen 时可见） */
.sessions-backdrop {
  position: fixed;
  inset: 0;
  z-index: 15;
  background: var(--overlay-bg);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast);
}

/* —— 右侧：消息区 + 输入区 —— */
.chat-main {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.chat-mobile-toggle {
  display: none;
  position: absolute;
  top: var(--space-3);
  left: var(--space-3);
  z-index: 10;
}

/* —— 消息区 —— */
.chat-messages-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-6) var(--space-4);
}

/* —— 跳转到底部悬浮按钮 —— */
.jump-to-bottom {
  position: absolute;
  right: var(--space-6);
  bottom: var(--space-4);
  z-index: 5;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text);
  box-shadow: var(--shadow-md);
  cursor: pointer;
  transition:
    transform var(--transition-fast),
    box-shadow var(--transition-fast),
    background var(--transition-fast);
}

.jump-to-bottom:hover {
  transform: translateY(-2px);
  background: var(--color-brand-soft);
  color: var(--color-brand-strong);
  box-shadow: var(--shadow-lg);
}

.jump-to-bottom:active {
  transform: translateY(0);
}

.jump-fade-enter-active,
.jump-fade-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.jump-fade-enter-from,
.jump-fade-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

.chat-messages-inner {
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.chat-guide {
  margin: auto;
  padding: var(--space-8) var(--space-6);
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
}

/* 品牌空状态：小熊 + 圆点/圆环几何点缀（纯装饰，aria-hidden） */
.guide-hero {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.guide-ring {
  display: inline-block;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  border: 5px solid var(--color-brand-100);
}

.guide-dot {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
}

.guide-dot-a {
  background: var(--color-brand-accent);
}

.guide-dot-c {
  width: 8px;
  height: 8px;
  background: var(--color-border-strong);
}

.chat-guide h2 {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-display);
  letter-spacing: -0.02em;
}

.chat-guide p {
  color: var(--color-text-secondary);
  max-width: 420px;
}

/* —— IM 混合式聊天布局：头像列 + 内容列 —— */
.chat-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.chat-row.is-user {
  flex-direction: row-reverse;
}

/* 头像列：等宽固定，连续消息时内容为空、仅保留缩进占位 */
.chat-avatar-col {
  width: 38px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
}

/* 用户头像（静态展示，与侧栏 UserAvatar 同语言，但不带交互） */
.chat-user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-md);
  font-weight: 700;
}

/* 智能体头像容器：AgentAvatar 铺满内部 */
.chat-agent-avatar {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-brand-soft);
  box-shadow: var(--shadow-sm);
  font-size: var(--font-size-lg);
}

/* 品牌兜底头像：橙黄渐变 H 标，与 MainLayout logo-mark 同语言 */
.chat-brand-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--color-brand), var(--color-brand-accent));
  color: var(--color-on-accent);
  font-size: var(--font-size-lg);
  font-weight: 700;
  box-shadow: var(--shadow-sm);
}

/* 内容列：助手左对齐 / 用户右对齐 */
.chat-content-col {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
}

/* 用户内容列：宽度上限相对整行解析（避免气泡内百分比循环求宽导致短句提前换行） */
.chat-row.is-user .chat-content-col {
  align-items: flex-end;
  max-width: 75%;
}

/* 助手昵称行：小号灰字、与头像顶端对齐 */
.chat-agent-name {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-1);
  padding: 0 var(--space-1);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-muted);
}

/* 生成中：助手名字旁品牌橙脉冲圆点（呼吸动画） */
.chat-live-dot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--color-brand-500);
  animation: chat-live-pulse 1.2s var(--ease-out-soft) infinite;
}

@keyframes chat-live-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.35;
    transform: scale(0.72);
  }
}

.chat-bubble {
  position: relative;
  max-width: 100%;
  padding: 0;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-md);
  line-height: 1.7;
  word-break: break-word;
}

/* 代码块与表格在消息内横向滚动，不挤压布局 */
.chat-bubble pre {
  max-width: 100%;
  overflow-x: auto;
}

.chat-bubble table {
  max-width: 100%;
  overflow-x: auto;
}

/* 用户消息：小气泡，muted 底 + 大圆角，右对齐，最宽 75% */
.chat-bubble.role-user {
  max-width: 100%;
  padding: var(--space-3) var(--space-4);
  background: var(--color-surface-muted);
  color: var(--color-text);
  white-space: pre-wrap;
  /* 中文按整字断行，长英文单词仅在必要处断词，不 break-all */
  overflow-wrap: break-word;
}

/* 助手消息：去气泡化——无底色通栏排版，左侧品牌橙短条标记 */
.chat-bubble.role-assistant {
  padding: var(--space-1) 0 0 calc(var(--space-3) + 6px);
}

.chat-bubble.role-assistant::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--space-2);
  width: 4px;
  height: 28px;
  border-radius: var(--radius-full);
  background: var(--color-brand);
}

/* 错误消息：danger-soft 底 + danger 文字的提示条，简洁不刺眼 */
.chat-bubble.is-error {
  max-width: 100%;
  padding: var(--space-3) var(--space-4);
  border-left: 2px solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
}

.chat-bubble.is-error::before {
  display: none;
}

.chat-text {
  white-space: pre-wrap;
}

/* assistant 气泡为 Markdown 渲染容器：块级元素自带换行，关闭 pre-wrap 避免双重换行 */
.chat-text.is-rich {
  white-space: normal;
}

.chat-error-text {
  margin: 0;
  color: var(--color-danger);
  font-weight: 500;
}

/* 消息时间戳：默认隐藏，hover 消息行时浮现（纯辅助信息） */
.chat-timestamp {
  margin-bottom: var(--space-1);
  padding: 0 var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  opacity: 0;
  transition: opacity var(--transition-fast);
  user-select: none;
}

.chat-row:hover .chat-timestamp {
  opacity: 1;
}

/* 流式占位：禁止换行，避免 flex 收缩后空气泡被压成一字一行竖排 */
.chat-pending {
  white-space: nowrap;
  color: var(--color-text-muted);
}

/* 生成中实时计时：低调单行灰字，居左跟随消息流 */
.chat-elapsed {
  padding: var(--space-2) var(--space-4) 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.chat-stopped {
  display: inline-block;
  margin-top: var(--space-2);
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* 思考过程折叠块：muted 浅底 + 左侧强调细线，次级字号斜体 */
.chat-reasoning {
  margin-bottom: var(--space-3);
  border-left: 2px solid var(--color-border-strong);
  border-radius: 0 var(--radius-md) var(--radius-md) 0;
  background: var(--color-surface-muted);
}

.chat-reasoning summary {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  cursor: pointer;
  user-select: none;
  transition: color var(--transition-fast);
}

.chat-reasoning summary:hover {
  color: var(--color-text-secondary);
}

.chat-reasoning-body {
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--font-size-sm);
  font-style: italic;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  max-height: 320px;
  overflow-y: auto;
  animation: chat-reasoning-reveal var(--transition-fast) both;
}

@keyframes chat-reasoning-reveal {
  from {
    opacity: 0;
    transform: translateY(-2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* —— 工具调用卡片（ToolStepCard 组件样式见组件内部，此处仅容器） —— */
.chat-tools {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0 var(--space-3) var(--space-2);
}

/* 流式光标：正文尾部 2px 闪烁竖线 */
.chat-cursor {
  display: inline-block;
  width: 2px;
  height: 1.05em;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--color-brand);
  animation: chat-cursor-blink 0.9s steps(1) infinite;
}

@keyframes chat-cursor-blink {
  50% {
    opacity: 0;
  }
}

/* —— 任务式输入区 —— */
.chat-composer {
  flex-shrink: 0;
  padding: var(--space-3) var(--space-6) var(--space-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}

/* 输入框卡片：surface 底 + border 描边 + md 阴影，聚焦时边框过渡到品牌橙 */
.composer-shell {
  position: relative;
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-md);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    background-color var(--transition-fast);
}

.composer-shell:focus-within {
  border-color: var(--color-brand);
  box-shadow:
    var(--shadow-md),
    0 0 0 3px var(--color-brand-soft);
}

.composer-shell.is-dragover {
  border-color: var(--color-brand);
  border-style: dashed;
  background: var(--color-brand-soft);
}

/* chips：目标 / 附件 */
.composer-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3) 0;
}

.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
  padding: 3px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.chip-goal {
  background: var(--color-brand-soft);
  color: var(--color-brand);
}

.chip-file {
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.chip-label {
  font-weight: 600;
  flex-shrink: 0;
}

.chip-text {
  min-width: 0;
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-size {
  flex-shrink: 0;
  color: var(--color-text-secondary);
}

.chip-thumb {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm, 4px);
  object-fit: cover;
  flex-shrink: 0;
  border: 1px solid var(--color-border);
}

.attach-chip .app-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.chip-x:hover {
  color: var(--color-danger);
}

.chip-x .app-icon {
  width: 10px;
  height: 10px;
}

.composer-notice {
  margin: 0;
  padding: var(--space-2) var(--space-3) 0;
  font-size: var(--font-size-xs);
  color: var(--color-warning);
}

/* 引用回复条：输入框上方（单行截断，可取消） */
.composer-quote {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: var(--space-2) var(--space-3) 0;
  padding: var(--space-2);
  border-left: 3px solid var(--color-brand);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  min-width: 0;
}

.composer-quote-author {
  flex-shrink: 0;
  font-weight: 600;
}

.composer-quote-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.composer-quote-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}

.composer-quote-x:hover {
  color: var(--color-danger);
}

.composer-quote-x .app-icon {
  width: 11px;
  height: 11px;
}

/* 输入框本体 */
.chat-input {
  width: 100%;
  padding: var(--space-3);
  border: none;
  resize: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  line-height: 1.6;
  max-height: 180px;
}

.chat-input:focus {
  outline: none;
}

.chat-input:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

/* @ 引用行：技能标记内联在输入框行首；无标记时 textarea 独占整行，与旧版布局一致 */
.composer-input-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: var(--space-2);
}

.composer-input-row .chat-input {
  flex: 1 1 160px;
  min-width: 0;
}

/* @ 技能标记：品牌色浅底高亮（同截图观感）；已停用置灰，仅展示不注入 */
.composer-mention {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin: var(--space-2) 0 0 var(--space-3);
  max-width: 200px;
  padding: 2px 4px 2px 8px;
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  flex-shrink: 0;
}

.composer-mention.is-disabled {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}

.mention-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* × 按钮：hover 标记或聚焦时才显示，避免视觉噪音 */
.mention-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  padding: 0;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.composer-mention:hover .mention-x,
.mention-x:focus-visible {
  opacity: 1;
}

.mention-x:hover {
  color: var(--color-danger);
}

/* 工具栏：次级工具一律 ghost 式（无边框无底色），仅激活项以品牌橙作唯一彩色焦点 */
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0 var(--space-2) var(--space-1);
}

.composer-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-1);
  min-width: 0;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.tool-btn:hover {
  color: var(--color-text);
  border-color: transparent;
  background: var(--color-surface-muted);
}

.tool-btn.is-active {
  color: var(--color-brand);
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.tool-btn.is-open {
  color: var(--color-brand);
  background: var(--color-surface-muted);
}

.tool-btn .app-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.tool-model {
  color: var(--color-text);
  border-color: var(--color-border);
  background: var(--color-surface);
  max-width: 260px;
}

.tool-model:hover {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.tool-model-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-caret {
  transition: transform var(--transition-fast);
}

.tool-btn.is-open .tool-caret {
  transform: rotate(180deg);
}

.tool-agent-text {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
  flex-shrink: 0;
}

.tool-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: 11px;
  flex-shrink: 0;
}

/* 圆形发送按钮：仅图标，橙实底；disabled 安静降级为 muted 灰 */
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
  box-shadow: 0 0 0 3px var(--color-brand-soft);
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

/* 流式生成期间：发送按钮位置切换为 danger 描边态停止按钮（仅改形态，逻辑不动） */
.composer-toolbar .composer-stop {
  height: 44px;
  min-width: 44px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-full);
  flex-shrink: 0;
  background: transparent;
  border: 1px solid var(--color-danger);
  color: var(--color-danger);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast),
    border-color var(--transition-fast);
}

.composer-toolbar .composer-stop:not(:disabled):hover {
  background: var(--color-danger-soft);
  border-color: var(--color-danger-strong);
  color: var(--color-danger-strong);
  filter: none;
}

.btn-stop {
  background: var(--color-danger-strong);
  color: var(--color-on-accent);
}

.btn-stop:not(:disabled):hover {
  filter: brightness(1.08);
}

/* 浮层（向上弹出） */
.composer-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  width: min(420px, calc(100vw - 32px));
  min-width: min(260px, calc(100vw - 32px));
  max-height: 340px;
  overflow-y: auto;
  padding: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
  z-index: 30;
}

.popover-model {
  min-width: min(300px, calc(100vw - 32px));
}

.popover-goal {
  min-width: min(340px, calc(100vw - 32px));
}

.popover-more {
  left: auto;
  right: 0;
  min-width: 232px;
}

.popover-group {
  margin: var(--space-2) var(--space-2) var(--space-1);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.popover-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.popover-item:hover {
  background: var(--color-surface-muted);
}

.popover-item.is-selected {
  color: var(--color-brand);
  background: var(--color-brand-soft);
}

.popover-item:disabled {
  color: var(--color-text-muted);
  background: transparent;
  cursor: not-allowed;
  opacity: 0.55;
}

.popover-item .app-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--color-text-muted);
}

.popover-item.is-selected .app-icon {
  color: var(--color-brand);
}

.popover-item-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popover-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 智能体浮层项的 emoji 头像 */
.popover-agent-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--color-brand-soft);
  font-size: var(--font-size-lg);
  line-height: 1;
}

/* 技能浮层项的 emoji 图标 */
.popover-skill-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--color-brand-soft);
  font-size: var(--font-size-lg);
  line-height: 1;
}

.popover-item-title {
  font-weight: 500;
}

.popover-item-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.popover-tag {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.4;
}

.popover-label {
  display: block;
  margin: 0;
  padding: 0 var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.goal-input {
  display: block;
  width: 100%;
  margin: var(--space-2) 0;
  padding: var(--space-2);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  resize: vertical;
  min-height: 96px;
}

.goal-input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.popover-actions .btn {
  height: 30px;
}

.popover-tip {
  margin: var(--space-1) var(--space-2) var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.popover-empty {
  margin: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  text-align: center;
}

.file-input {
  display: none;
}

.chat-composer-hint {
  max-width: 860px;
  margin: var(--space-1) auto 0;
  padding: 0 var(--space-1);
  font-size: 11px;
  color: var(--color-text-muted);
  opacity: 0.8;
  text-align: left;
}

@media (max-width: 640px) {
  .chat-messages {
    padding: var(--space-4);
  }

  .jump-to-bottom {
    right: var(--space-4);
  }

  .chat-avatar-col {
    width: 28px;
  }

  .chat-user-avatar,
  .chat-agent-avatar,
  .chat-brand-avatar {
    width: 28px;
    height: 28px;
    font-size: var(--font-size-sm);
  }

  .chat-agent-name {
    display: none;
  }

  .chat-row.is-user .chat-content-col {
    max-width: 86%;
  }

  .chat-composer {
    padding: var(--space-3) var(--space-4);
  }

  .tool-model {
    max-width: 160px;
  }

  .composer-send {
    width: 40px;
    height: 40px;
  }

  .composer-popover {
    right: 0;
    left: auto;
  }

  .popover-more {
    right: 0;
  }
}

/* 超窄屏：隐藏头像仅保留等宽缩进对齐 */
@media (max-width: 380px) {
  .chat-user-avatar,
  .chat-agent-avatar,
  .chat-brand-avatar {
    display: none;
  }

  .chat-row.is-user .chat-content-col {
    max-width: 92%;
  }
}

/* —— 窄屏会话抽屉（<900px，风格与 MainLayout 侧边栏抽屉一致） —— */
@media (max-width: 899px) {
  .chat-sessions {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: min(300px, 84vw);
    z-index: 50;
    transform: translateX(-102%);
    transition: transform 240ms ease;
    box-shadow: var(--shadow-lg);
  }

  .chat-sessions.is-open {
    transform: translateX(0);
  }

  .sessions-backdrop.is-visible {
    opacity: 1;
    pointer-events: auto;
  }

  .chat-mobile-toggle {
    display: inline-flex;
  }
}
</style>
