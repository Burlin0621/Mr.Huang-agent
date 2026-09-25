<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'

import { useLlmStore, type LlmConfig } from '@/stores/llm'
import { getProviderPreset } from '@/lib/model-presets'
import {
  describeLlmError,
  isAbortError,
  streamChatCompletion,
  type LlmChatMessage,
} from '@/lib/llm'
import { DEFAULT_AGENT_ID } from '@/lib/agents'
import { useAgentsStore, type AgentView } from '@/stores/agents'
import { useSkillsStore, type SkillView } from '@/stores/skills'
import {
  ATTACHMENT_MAX_BYTES,
  buildConversationMarkdown,
  buildConversationPlainText,
  buildSystemMessage,
  composeUserContent,
  formatDateTime,
  type ComposeAttachment,
} from '@/lib/chat-compose'
import AppIcon from '@/components/AppIcon.vue'

const llmStore = useLlmStore()
const { configs, activeConfigId, activeConfig } = storeToRefs(llmStore)

const route = useRoute()
const agentsStore = useAgentsStore()
const skillsStore = useSkillsStore()

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

/* —— 会话消息 —— */

type MessageStatus = 'streaming' | 'done' | 'aborted' | 'error'

interface ChatDisplayMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  reasoning: string
  status: MessageStatus
  /** status 为 error 时的用户可读错误信息 */
  errorText: string
}

function createMessage(role: 'user' | 'assistant'): ChatDisplayMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content: '',
    reasoning: '',
    status: role === 'user' ? 'done' : 'streaming',
    errorText: '',
  }
}

const messages = ref<ChatDisplayMessage[]>([])

/** 追加一条消息并返回其响应式引用 */
function pushMessage(role: 'user' | 'assistant'): ChatDisplayMessage {
  const message = createMessage(role)
  messages.value.push(message)
  return messages.value[messages.value.length - 1]
}

/** 页面内呈现一条错误提示（不弹 alert） */
function pushErrorNote(text: string): void {
  const note = pushMessage('assistant')
  note.status = 'error'
  note.errorText = text
}

/* —— 浮层（模型 / 目标 / 智能体 / 技能 / 更多；同一时间只开一个） —— */

type PopoverKind = 'model' | 'goal' | 'agent' | 'skill' | 'more'

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

/** 点击输入区外部关闭浮层 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (
    activePopover.value &&
    composerRoot.value &&
    !composerRoot.value.contains(event.target as Node)
  ) {
    closePopover()
  }
}

/** Esc 关闭浮层 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && activePopover.value) {
    closePopover()
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

/** 图片头像加载失败的智能体 id 集合（@error 时记入，浮层回退 emoji 显示） */
const failedAvatarIds = reactive(new Set<string>())

/** 当前选中智能体：在合并清单中查找，找不到时回退通用助手 */
const activeAgent = computed<AgentView>(
  () => agentsStore.findAgent(activeAgentId.value) ?? agentsStore.defaultAgent,
)

const activeAgentLabel = computed(() =>
  activeAgent.value.id === DEFAULT_AGENT_ID ? '智能体' : activeAgent.value.name,
)

function selectAgent(agentId: string): void {
  activeAgentId.value = agentId
  closePopover()
}

// 选中项被停用或删除（跨页操作）后，自动回退通用助手
watch(
  () => agentsStore.enabledAgents,
  (enabled) => {
    if (!enabled.some((agent) => agent.id === activeAgentId.value)) {
      activeAgentId.value = DEFAULT_AGENT_ID
    }
  },
)

/* —— 技能（提示词模板填入输入框；清单来自技能中心 store） —— */

const inputEl = ref<HTMLTextAreaElement | null>(null)

/** 把模板追加进输入框：已有内容时以空行分隔，随后聚焦输入框 */
function appendSkillTemplate(template: string): void {
  const base = userInput.value.replace(/\s+$/, '')
  userInput.value = base ? `${base}\n\n${template}` : template
  void nextTick(() => inputEl.value?.focus())
}

function applySkill(skill: SkillView): void {
  appendSkillTemplate(skill.template)
  closePopover()
}

/* —— 附件（仅文本类；点击选择 / 拖拽 / 粘贴） —— */

interface PendingAttachment {
  id: string
  name: string
  size: number
  content: string
  truncated: boolean
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

/** 文件选择框的 accept 列表 */
const TEXT_FILE_ACCEPT = TEXT_FILE_EXTENSIONS.map((ext) => `.${ext}`).join(',')

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

/** 逐个读取文本文件为附件：非文本拒绝、超 100KB 截断并标注 */
async function addFiles(files: File[]): Promise<void> {
  for (const file of files) {
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

/* —— 发送与流式接收 —— */

const userInput = ref('')
const streaming = ref(false)
const abortController = ref<AbortController | null>(null)

/** 组装随请求全量携带的对话历史（排除错误消息与空回复；不含附件内容） */
function buildHistory(): LlmChatMessage[] {
  const history: LlmChatMessage[] = []
  for (const message of messages.value) {
    if (message.status === 'error') continue
    if (message.role === 'assistant' && !message.content) continue
    history.push({ role: message.role, content: message.content })
  }
  return history
}

/**
 * 组装最终请求的 messages：
 * - 存在智能体 systemPrompt 或任务目标时，在最前插入一条 system 消息；
 * - 当轮 user 消息替换为「正文 + 附件内容」的组合（附件只随当轮携带）。
 */
function buildRequestMessages(outgoingUserContent: string): LlmChatMessage[] {
  const history = buildHistory()
  const last = history[history.length - 1]
  if (last && last.role === 'user') {
    last.content = outgoingUserContent
  }
  const systemContent = buildSystemMessage(activeAgent.value.systemPrompt, goal.value)
  return systemContent ? [{ role: 'system', content: systemContent }, ...history] : history
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
  if (!text || streaming.value || !activeConfig.value) return

  const config = activeConfig.value
  // 发送瞬间读取当前选中模型：切换模型立即生效（作用于下一条消息）
  const modelId = currentModelId.value
  const invalidReason = validateBeforeSend(config, modelId)
  if (invalidReason) {
    pushErrorNote(invalidReason)
    return
  }

  // 附件内容只拼进当轮 user 消息：先组装请求，再清空附件 chips
  const outgoingAttachments: ComposeAttachment[] = attachments.value.map((item) => ({
    name: item.name,
    content: item.content,
    truncated: item.truncated,
  }))

  pushMessage('user').content = text
  userInput.value = ''
  const requestMessages = buildRequestMessages(composeUserContent(text, outgoingAttachments))
  attachments.value = []

  const assistant = pushMessage('assistant')
  streaming.value = true
  abortController.value = new AbortController()

  try {
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
      signal: abortController.value.signal,
      handlers: {
        onContent: (piece) => {
          assistant.content += piece
        },
        onReasoning: (piece) => {
          assistant.reasoning += piece
        },
      },
    })
    assistant.status = assistant.content || assistant.reasoning ? 'done' : 'error'
    if (assistant.status === 'error') {
      assistant.errorText = '模型未返回任何内容，请检查模型 ID 是否正确后重试。'
    }
  } catch (err) {
    if (isAbortError(err)) {
      assistant.status = 'aborted'
    } else {
      assistant.status = 'error'
      assistant.errorText = describeLlmError(err, config.baseUrl)
    }
  } finally {
    streaming.value = false
    abortController.value = null
  }
}

function stopStreaming(): void {
  abortController.value?.abort()
}

function clearConversation(): void {
  if (streaming.value) {
    stopStreaming()
  }
  messages.value = []
}

/* —— 更多菜单：清空 / 导出 Markdown / 复制全部 —— */

function confirmClearConversation(): void {
  closePopover()
  if (messages.value.length === 0) return
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
  const markdown = buildConversationMarkdown({ modelName, messages: history })
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `对话记录-${formatDateTime(new Date()).replace(/[-: ]/g, '')}.md`
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

/* —— 生命周期 —— */

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)

  // 支持从智能体中心跳转携带 ?agent=<id> 预选（需存在且未停用）
  const agentParam = route.query.agent
  const agentId = Array.isArray(agentParam) ? agentParam[0] : agentParam
  if (
    typeof agentId === 'string' &&
    agentsStore.enabledAgents.some((agent) => agent.id === agentId)
  ) {
    activeAgentId.value = agentId
  }

  // 支持从技能中心跳转携带 ?skill=<id> 把模板追加进输入框（需存在且未停用）
  const skillParam = route.query.skill
  const skillId = Array.isArray(skillParam) ? skillParam[0] : skillParam
  if (typeof skillId === 'string') {
    const skill = skillsStore.enabledSkills.find((item) => item.id === skillId)
    if (skill) {
      appendSkillTemplate(skill.template)
    }
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  if (noticeTimer) clearTimeout(noticeTimer)
  stopStreaming()
})
</script>

<template>
  <div class="chat-page">
    <!-- 消息区 -->
    <div ref="scrollContainer" class="chat-messages" @scroll.passive="onScroll">
      <div class="chat-messages-inner">
        <!-- 未配置引导 -->
        <div v-if="configs.length === 0" class="chat-guide">
          <h2>还没有可用的模型</h2>
          <p>先到「设置 · 模型接入」添加一套 OpenAI 兼容模型配置（智谱 GLM、DeepSeek 等），再来这里对话。</p>
          <RouterLink class="btn btn-primary" :to="{ path: '/settings', query: { tab: 'models' } }">
            前往设置
          </RouterLink>
        </div>

        <!-- 已有配置但未选择 -->
        <div v-else-if="!activeConfig" class="chat-guide">
          <h2>请选择要使用的模型</h2>
          <p>在下方输入区工具栏的「模型」菜单中选择模型（按配置分组，主模型标「主」），即可开始对话。</p>
        </div>

        <template v-else>
          <div v-if="messages.length === 0" class="chat-guide">
            <h2>开始与 {{ activeConfig.name }} 对话</h2>
            <p>描述你的任务直接发送，回复将以流式逐字呈现；Enter 发送，Shift+Enter 换行。</p>
          </div>

          <div
            v-for="message in messages"
            :key="message.id"
            class="chat-row"
            :class="message.role === 'user' ? 'is-user' : 'is-assistant'"
          >
            <div class="chat-bubble" :class="[`role-${message.role}`, { 'is-error': message.status === 'error' }]">
              <!-- 思考过程（可折叠） -->
              <details v-if="message.reasoning" class="chat-reasoning" :open="message.status === 'streaming'">
                <summary>思考过程</summary>
                <div class="chat-reasoning-body">{{ message.reasoning }}</div>
              </details>

              <!-- 正文 -->
              <p v-if="message.status === 'error'" class="chat-error-text">{{ message.errorText }}</p>
              <p v-else-if="message.content || message.status !== 'streaming'" class="chat-text">
                {{ message.content || (message.role === 'assistant' ? '（模型未返回文本内容）' : '') }}
              </p>
              <p
                v-if="message.status === 'streaming' && !message.content && !message.reasoning"
                class="chat-pending"
              >
                正在思考…
              </p>
              <span v-if="message.status === 'streaming' && message.content" class="chat-cursor" aria-hidden="true"></span>

              <span v-if="message.status === 'aborted'" class="chat-stopped">已停止生成</span>
            </div>
          </div>
        </template>
      </div>
    </div>

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
            class="chip chip-goal"
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
            class="chip chip-file"
            :title="item.truncated ? `${item.name}（超过 100KB，已截断）` : item.name"
          >
            <AppIcon name="paperclip" />
            <span class="chip-text">{{ item.name }}</span>
            <span class="chip-size">{{ formatFileSize(item.size) }}</span>
            <button class="chip-x" type="button" title="移除附件" @click="removeAttachment(item.id)">
              <AppIcon name="close" />
            </button>
          </span>
        </div>

        <!-- 轻提示 -->
        <p v-if="notice" class="composer-notice">{{ notice }}</p>

        <textarea
          ref="inputEl"
          v-model="userInput"
          class="chat-input"
          rows="3"
          :placeholder="activeConfig ? '描述你的任务，或拖入文件 / 粘贴路径与链接…' : '请先在下方「模型」菜单中选择模型'"
          :disabled="!activeConfig"
          @keydown="onComposerKeydown"
          @paste="onComposerPaste"
        ></textarea>

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
              <span v-if="activeAgentId !== DEFAULT_AGENT_ID" class="tool-dot" aria-hidden="true"></span>
            </button>
            <button
              class="tool-btn"
              type="button"
              title="选择提示词模板填入输入框"
              @click="togglePopover('skill')"
            >
              <AppIcon name="sparkles" />
              <span>技能</span>
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

          <button v-if="streaming" class="btn btn-stop composer-send" type="button" @click="stopStreaming">
            停止
          </button>
          <button
            v-else
            class="btn btn-primary composer-send"
            type="button"
            :disabled="!activeConfig || !userInput.trim()"
            @click="sendMessage"
          >
            发送
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
              <AppIcon v-if="config.id === activeConfigId && model === currentModelId" name="check" />
            </button>
          </template>
          <p v-if="configs.length === 0" class="popover-empty">
            还没有模型配置，请先到设置页添加
          </p>
        </div>

        <!-- 目标浮层 -->
        <div v-else-if="activePopover === 'goal'" class="composer-popover popover-goal">
          <label class="popover-label" for="chat-goal-input">任务目标（会作为系统指令随每条消息发送）</label>
          <textarea
            id="chat-goal-input"
            ref="goalInputEl"
            v-model="goalDraft"
            class="goal-input"
            rows="4"
            placeholder="例如：只回答与本项目相关的问题，回答保持简洁…"
          ></textarea>
          <div class="popover-actions">
            <button v-if="goal" class="btn btn-ghost" type="button" @click="clearGoal">清除</button>
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
              <img
                v-if="agent.avatar && !failedAvatarIds.has(agent.id)"
                :src="agent.avatar"
                :alt="agent.name"
                class="popover-agent-img"
                @error="failedAvatarIds.add(agent.id)"
              />
              <template v-else>{{ agent.icon }}</template>
            </span>
            <span class="popover-item-main">
              <span class="popover-item-title">{{ agent.name }}</span>
              <span class="popover-item-desc">{{ agent.description }}</span>
            </span>
            <AppIcon v-if="agent.id === activeAgentId" name="check" />
          </button>
          <p class="popover-tip">在「智能体中心」可管理内置与自定义智能体</p>
        </div>

        <!-- 技能浮层（内置 + 自定义合并清单，过滤停用） -->
        <div v-else-if="activePopover === 'skill'" class="composer-popover popover-list">
          <button
            v-for="skill in skillsStore.enabledSkills"
            :key="skill.id"
            class="popover-item"
            type="button"
            @click="applySkill(skill)"
          >
            <span class="popover-skill-avatar" aria-hidden="true">{{ skill.icon }}</span>
            <span class="popover-item-main">
              <span class="popover-item-title">{{ skill.name }}</span>
              <span class="popover-item-desc">{{ skill.description }}</span>
            </span>
            <AppIcon name="chevron-down" class="popover-skill-caret" />
          </button>
          <p class="popover-tip">点击后模板将追加到输入框；在「技能中心」可管理技能</p>
        </div>

        <!-- 更多菜单 -->
        <div v-else-if="activePopover === 'more'" class="composer-popover popover-more">
          <button
            class="popover-item"
            type="button"
            :disabled="messages.length === 0"
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
          :accept="TEXT_FILE_ACCEPT"
          multiple
          @change="onFileInputChange"
        />
      </div>
      <p class="chat-composer-hint">
        Enter 发送 · Shift + Enter 换行 · 附件仅随当轮发送；目标与智能体会作为系统消息注入每轮请求
      </p>
    </footer>
  </div>
</template>

<style scoped>
.chat-page {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* —— 消息区 —— */
.chat-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6) var(--space-6) var(--space-4);
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

.chat-guide h2 {
  font-size: var(--font-size-xl);
}

.chat-guide p {
  color: var(--color-text-secondary);
  max-width: 420px;
}

.chat-row {
  display: flex;
}

.chat-row.is-user {
  justify-content: flex-end;
}

.chat-row.is-assistant {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 86%;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  font-size: var(--font-size-md);
  line-height: 1.7;
  word-break: break-word;
}

.chat-bubble.role-user {
  background: var(--color-brand);
  color: var(--color-on-brand);
  border-bottom-right-radius: var(--radius-sm);
  white-space: pre-wrap;
}

.chat-bubble.role-assistant {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-bottom-left-radius: var(--radius-sm);
}

.chat-bubble.is-error {
  background: var(--color-danger-soft);
  border-color: transparent;
}

.chat-text {
  white-space: pre-wrap;
}

.chat-error-text {
  color: var(--color-danger);
}

.chat-pending {
  color: var(--color-text-muted);
}

.chat-stopped {
  display: inline-block;
  margin-top: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-warning);
}

/* 思考过程折叠块 */
.chat-reasoning {
  margin-bottom: var(--space-3);
  border-left: 3px solid var(--color-border-strong);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
}

.chat-reasoning summary {
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
}

.chat-reasoning-body {
  padding: 0 var(--space-3) var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  max-height: 320px;
  overflow-y: auto;
}

/* 流式光标 */
.chat-cursor {
  display: inline-block;
  width: 8px;
  height: 15px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: var(--color-brand);
  border-radius: 2px;
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

.composer-shell {
  position: relative;
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.composer-shell:focus-within {
  border-color: var(--color-brand);
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

.chip {
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
  color: var(--color-text-muted);
}

.chip .app-icon {
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

/* 工具栏 */
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 0 var(--space-2) var(--space-2);
}

.composer-tools {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
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
  border-color: var(--color-border-strong);
  background: var(--color-surface-muted);
}

.tool-btn.is-active {
  color: var(--color-brand);
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.tool-btn.is-open {
  color: var(--color-brand);
  border-color: var(--color-brand);
}

.tool-btn .app-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.tool-model {
  color: var(--color-text);
  border-color: var(--color-border-strong);
  max-width: 260px;
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
  font-size: 10px;
  flex-shrink: 0;
}

.composer-send {
  height: 34px;
  min-width: 76px;
  flex-shrink: 0;
}

.btn-stop {
  background: var(--color-danger);
  color: #ffffff;
}

.btn-stop:not(:disabled):hover {
  filter: brightness(1.08);
}

/* 浮层（向上弹出） */
.composer-popover {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  min-width: 260px;
  max-width: min(420px, 100%);
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
  min-width: 300px;
}

.popover-goal {
  min-width: 340px;
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

/* 小尺寸图片头像（圆角方块，居中于色块） */
.popover-agent-img {
  width: 22px;
  height: 22px;
  border-radius: var(--radius-sm);
  object-fit: cover;
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

.popover-skill-caret {
  color: var(--color-text-muted);
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
  margin: var(--space-2) auto 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: center;
}

@media (max-width: 640px) {
  .chat-messages {
    padding: var(--space-4);
  }

  .chat-bubble {
    max-width: 94%;
  }

  .chat-composer {
    padding: var(--space-3) var(--space-4);
  }

  .tool-model {
    max-width: 160px;
  }

  .composer-send {
    min-width: 64px;
  }
}
</style>
