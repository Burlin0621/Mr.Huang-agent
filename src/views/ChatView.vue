<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { storeToRefs } from 'pinia'

import { useLlmStore, type LlmConfig } from '@/stores/llm'
import { getProviderPreset } from '@/lib/model-presets'
import {
  describeLlmError,
  isAbortError,
  streamChatCompletion,
  type LlmChatMessage,
} from '@/lib/llm'

const llmStore = useLlmStore()
const { configs, activeConfigId, activeConfig } = storeToRefs(llmStore)

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

/* —— 发送与流式接收 —— */

const userInput = ref('')
const streaming = ref(false)
const abortController = ref<AbortController | null>(null)

/** 组装随请求全量携带的对话历史（排除错误消息与空回复） */
function buildHistory(): LlmChatMessage[] {
  const history: LlmChatMessage[] = []
  for (const message of messages.value) {
    if (message.status === 'error') continue
    if (message.role === 'assistant' && !message.content) continue
    history.push({ role: message.role, content: message.content })
  }
  return history
}

function validateBeforeSend(config: LlmConfig): string | null {
  if (!config.modelId.trim()) {
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
  const invalidReason = validateBeforeSend(config)
  if (invalidReason) {
    pushErrorNote(invalidReason)
    return
  }

  pushMessage('user').content = text
  userInput.value = ''

  const assistant = pushMessage('assistant')
  streaming.value = true
  abortController.value = new AbortController()

  try {
    await streamChatCompletion({
      endpoint: {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        modelId: config.modelId,
        temperature: config.temperature,
        timeoutSeconds: config.timeoutSeconds,
        maxRetries: config.maxRetries,
      },
      messages: buildHistory(),
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

function onComposerKeydown(event: KeyboardEvent): void {
  // Enter 发送；Shift+Enter 换行（保留默认行为）
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void sendMessage()
  }
}

onBeforeUnmount(() => {
  stopStreaming()
})

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
</script>

<template>
  <div class="chat-page">
    <!-- 工具栏 -->
    <header class="chat-toolbar">
      <div class="chat-model">
        <label class="chat-model-label" for="chat-model-select">当前模型</label>
        <select
          id="chat-model-select"
          v-model="activeConfigId"
          class="chat-model-select"
          :class="{ 'is-empty': !activeConfig }"
        >
          <option value="" disabled>请选择模型配置</option>
          <option v-for="config in configs" :key="config.id" :value="config.id">
            {{ config.name }}（{{ config.modelId }}）
          </option>
        </select>
      </div>
      <button
        class="btn btn-ghost chat-clear"
        type="button"
        :disabled="messages.length === 0"
        @click="clearConversation"
      >
        清空对话
      </button>
    </header>

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
          <h2>请选择要使用的模型配置</h2>
          <p>在右上角的下拉框中选择一套模型配置，即可开始对话。</p>
        </div>

        <template v-else>
          <div v-if="messages.length === 0" class="chat-guide">
            <h2>开始与 {{ activeConfig.name }} 对话</h2>
            <p>输入任何问题，回复将以流式逐字呈现；Enter 发送，Shift+Enter 换行。</p>
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

    <!-- 输入区 -->
    <footer class="chat-composer">
      <div class="chat-composer-box" :class="{ 'is-disabled': !activeConfig }">
        <textarea
          v-model="userInput"
          class="chat-input"
          rows="3"
          :placeholder="activeConfig ? `向 ${activeConfig.name} 提问…` : '请先选择模型配置'"
          :disabled="!activeConfig"
          @keydown="onComposerKeydown"
        ></textarea>
        <button
          v-if="streaming"
          class="btn btn-stop"
          type="button"
          @click="stopStreaming"
        >
          停止
        </button>
        <button
          v-else
          class="btn btn-primary"
          type="button"
          :disabled="!activeConfig || !userInput.trim()"
          @click="sendMessage"
        >
          发送
        </button>
      </div>
      <p class="chat-composer-hint">
        Enter 发送 · Shift + Enter 换行 · 回复内容由前端流式渲染，对话历史每次请求全量携带
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

/* —— 工具栏 —— */
.chat-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-6);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}

.chat-model {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.chat-model-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.chat-model-select {
  max-width: 320px;
  height: 34px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
}

.chat-model-select.is-empty {
  color: var(--color-text-muted);
}

.chat-clear {
  height: 34px;
  flex-shrink: 0;
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

/* —— 输入区 —— */
.chat-composer {
  flex-shrink: 0;
  padding: var(--space-3) var(--space-6) var(--space-4);
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
}

.chat-composer-box {
  max-width: 860px;
  margin: 0 auto;
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
}

.chat-input {
  flex: 1;
  resize: none;
  padding: var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  line-height: 1.6;
  max-height: 160px;
  transition: border-color var(--transition-fast);
}

.chat-input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.chat-input:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.chat-composer-box .btn {
  height: 42px;
  min-width: 84px;
  flex-shrink: 0;
}

.btn-stop {
  background: var(--color-danger);
  color: #ffffff;
}

.btn-stop:not(:disabled):hover {
  filter: brightness(1.08);
}

.chat-composer-hint {
  max-width: 860px;
  margin: var(--space-2) auto 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: center;
}

@media (max-width: 640px) {
  .chat-toolbar {
    padding: var(--space-3) var(--space-4);
  }

  .chat-model-select {
    max-width: 180px;
  }

  .chat-messages {
    padding: var(--space-4);
  }

  .chat-bubble {
    max-width: 94%;
  }

  .chat-composer {
    padding: var(--space-3) var(--space-4);
  }
}
</style>
