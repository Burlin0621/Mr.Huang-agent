<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
import PromptEditModal, { type PromptEditForm } from '@/components/PromptEditModal.vue'
import { extractTemplateVars, fillTemplateVars } from '@/lib/builtin-prompts'
import { usePromptsStore, type PromptView } from '@/stores/prompts'

const router = useRouter()
const promptsStore = usePromptsStore()

/* —— 搜索与标签筛选 —— */

const keyword = ref('')
/** 当前选中的标签；null 表示不筛选 */
const activeTag = ref<string | null>(null)

/** 按名称 / 描述 / 标签 / 正文关键字 + 标签筛选合并清单 */
const filteredPrompts = computed<PromptView[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  return promptsStore.prompts.filter((prompt) => {
    if (activeTag.value && !prompt.tags.includes(activeTag.value)) return false
    if (!kw) return true
    const haystack =
      `${prompt.name} ${prompt.description} ${prompt.content} ${prompt.tags.join(' ')}`.toLowerCase()
    return haystack.includes(kw)
  })
})

function toggleTag(tag: string): void {
  activeTag.value = activeTag.value === tag ? null : tag
}

/* —— 提示条（复制/使用结果反馈，3 秒自动消失） —— */

const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 3000)
}

onBeforeUnmount(() => {
  if (noticeTimer) clearTimeout(noticeTimer)
})

/* —— 复制正文到剪贴板 —— */

async function copyToClipboard(text: string, successMessage: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    showNotice(successMessage)
    return true
  } catch {
    showNotice('复制失败：当前环境不支持剪贴板访问')
    return false
  }
}

/** 卡片「复制」按钮：直接复制当前正文 */
function copyPrompt(prompt: PromptView): void {
  void copyToClipboard(prompt.content, `已复制「${prompt.name}」正文到剪贴板`)
}

/* —— 使用提示词（含 {{变量}} 填充流程） —— */

/** 变量填充弹窗状态：null 表示关闭 */
const usingPrompt = ref<PromptView | null>(null)
/** 变量名 → 用户填写值 */
const varValues = ref<Record<string, string>>({})
/** 当前待填充的变量名列表 */
const usingVars = ref<string[]>([])

/**
 * 「使用」入口：正文含 {{变量}} 时先弹变量填充表单；
 * 否则直接复制正文并跳转 AI 对话（新对话草稿态，粘贴即用）
 */
function usePrompt(prompt: PromptView): void {
  const vars = extractTemplateVars(prompt.content)
  if (vars.length > 0) {
    usingPrompt.value = prompt
    usingVars.value = vars
    varValues.value = {}
    return
  }
  void usePromptDirect(prompt)
}

/** 无变量路径：复制 → 跳转 /chat 新对话 */
async function usePromptDirect(prompt: PromptView): Promise<void> {
  const ok = await copyToClipboard(prompt.content, `已复制「${prompt.name}」并跳转到 AI 对话`)
  if (!ok) return
  void router.push('/chat')
}

/** 提交变量填充：替换占位符后复制并跳转 */
function submitVarValues(): void {
  const prompt = usingPrompt.value
  if (!prompt) return
  const filled = fillTemplateVars(prompt.content, varValues.value)
  usingPrompt.value = null
  void copyToClipboard(filled, `已按变量填充并复制「${prompt.name}」，跳转到 AI 对话`).then(
    (ok) => {
      if (ok) void router.push('/chat')
    },
  )
}

/* —— 新建 / 编辑 / 删除 —— */

/** 空表单（图标/标签留空，展示时兜底） */
function createEmptyForm(): PromptEditForm {
  return { name: '', description: '', content: '', icon: '', tags: '' }
}

const modalOpen = ref(false)
/** 正在编辑的提示词 id；null 表示新建（内置条目不提供编辑入口） */
const editingId = ref<string | null>(null)
const form = ref<PromptEditForm>(createEmptyForm())

function openCreateModal(): void {
  editingId.value = null
  form.value = createEmptyForm()
  modalOpen.value = true
}

function openEditModal(prompt: PromptView): void {
  editingId.value = prompt.id
  form.value = {
    name: prompt.name,
    description: prompt.description,
    content: prompt.content,
    icon: prompt.icon,
    tags: prompt.tags.join('，'),
  }
  modalOpen.value = true
}

function closeModal(): void {
  modalOpen.value = false
}

/** 弹窗提交：新建或保存编辑（tags 已在弹窗内解析为数组） */
function submitForm(form: PromptEditForm): void {
  const payload = { ...form, tags: [...form.tags] }
  if (editingId.value) {
    promptsStore.updateCustomPrompt(editingId.value, payload)
  } else {
    promptsStore.addCustomPrompt(payload)
  }
  modalOpen.value = false
}

/** 删除自定义提示词（二次确认） */
function removePrompt(prompt: PromptView): void {
  if (!window.confirm(`确定删除提示词「${prompt.name}」吗？删除后不可恢复。`)) return
  promptsStore.removeCustomPrompt(prompt.id)
}

/* —— Esc 关闭弹窗（优先变量填充弹窗，其次编辑弹窗） —— */

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (usingPrompt.value) {
    usingPrompt.value = null
  } else if (modalOpen.value) {
    closeModal()
  }
}

onMounted(() => {
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<template>
  <div class="page">
    <header class="page-head prompts-head">
      <div>
        <h1>提示词库</h1>
        <p>沉淀与管理提示词模板：内置精选 + 自定义条目，一键复制到 AI 对话使用</p>
      </div>
      <div class="prompts-head-actions">
        <button class="btn btn-primary" type="button" @click="openCreateModal">
          <AppIcon name="plus" />
          新建提示词
        </button>
      </div>
    </header>

    <div class="prompts-toolbar">
      <div class="search-box">
        <AppIcon name="search" />
        <input
          v-model="keyword"
          class="search-input"
          type="text"
          placeholder="搜索名称、描述、标签或正文…"
        />
      </div>
      <div class="prompts-toolbar-meta">
        <span class="prompts-count">共 {{ filteredPrompts.length }} 条</span>
      </div>
    </div>

    <div v-if="promptsStore.allTags.length" class="prompts-tagbar">
      <button
        class="chip chip-tag tag-filter"
        :class="{ 'is-active': activeTag === null }"
        type="button"
        @click="activeTag = null"
      >
        全部
      </button>
      <button
        v-for="tag in promptsStore.allTags"
        :key="tag"
        class="chip chip-tag tag-filter"
        :class="{ 'is-active': activeTag === tag }"
        type="button"
        @click="toggleTag(tag)"
      >
        {{ tag }}
      </button>
    </div>

    <div v-if="filteredPrompts.length" class="prompts-grid">
      <article v-for="prompt in filteredPrompts" :key="prompt.id" class="card prompt-card">
        <div class="prompt-card-head">
          <span class="prompt-avatar" aria-hidden="true">{{ prompt.icon || '📝' }}</span>
          <div class="prompt-title-group">
            <h2 class="prompt-name">{{ prompt.name }}</h2>
            <div class="prompt-meta">
              <span v-if="prompt.source === 'builtin'" class="chip chip-builtin">内置</span>
              <span v-else class="chip chip-on">自定义</span>
            </div>
          </div>
        </div>

        <p class="prompt-desc">{{ prompt.description }}</p>
        <pre class="prompt-content">{{ prompt.content }}</pre>
        <div v-if="prompt.tags.length" class="prompt-tags">
          <span v-for="tag in prompt.tags" :key="tag" class="chip chip-tag">{{ tag }}</span>
        </div>

        <div class="prompt-actions">
          <button
            class="btn btn-primary btn-sm"
            type="button"
            title="复制正文并跳转到 AI 对话"
            @click="usePrompt(prompt)"
          >
            <AppIcon name="chat" />
            使用
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            title="复制正文到剪贴板"
            @click="copyPrompt(prompt)"
          >
            <AppIcon name="copy" />
            复制
          </button>
          <template v-if="prompt.source !== 'builtin'">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              title="编辑提示词"
              @click="openEditModal(prompt)"
            >
              <AppIcon name="edit" />
              编辑
            </button>
            <button
              class="btn btn-ghost btn-sm prompt-delete"
              type="button"
              title="删除提示词"
              @click="removePrompt(prompt)"
            >
              <AppIcon name="trash" />
              删除
            </button>
          </template>
        </div>
      </article>
    </div>

    <div v-else class="card">
      <EmptyState
        title="未找到匹配的提示词"
        description="换个关键词或标签试试，或新建一个自定义提示词。"
      >
        <button class="btn btn-primary" type="button" @click="openCreateModal">
          <AppIcon name="plus" />
          新建提示词
        </button>
      </EmptyState>
    </div>

    <!-- 新建 / 编辑弹窗 -->
    <PromptEditModal
      v-if="modalOpen"
      :editing-id="editingId"
      :initial="form"
      @close="closeModal"
      @submit="submitForm"
    />

    <!-- {{变量}} 填充弹窗 -->
    <div v-if="usingPrompt" class="modal-mask" @click.self="usingPrompt = null">
      <div class="modal modal-compact" role="dialog" aria-modal="true" aria-label="填写模板变量">
        <header class="modal-head">
          <h2>填写「{{ usingPrompt.name }}」的变量</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="usingPrompt = null">
            <AppIcon name="close" />
          </button>
        </header>
        <form class="modal-form" @submit.prevent="submitVarValues">
          <label v-for="varName in usingVars" :key="varName" class="field">
            <span class="field-label">{{ varName }}</span>
            <textarea
              v-model="varValues[varName]"
              class="field-input field-textarea"
              rows="4"
              :placeholder="`请输入 ${varName} 的内容`"
            ></textarea>
          </label>
          <footer class="modal-foot">
            <button class="btn btn-ghost" type="button" @click="usingPrompt = null">取消</button>
            <button class="btn btn-primary" type="submit">填充并复制</button>
          </footer>
        </form>
      </div>
    </div>

    <!-- 操作结果提示条 -->
    <Transition name="prompt-toast">
      <div v-if="notice" class="prompt-toast" role="status">{{ notice }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.prompts-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.prompts-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  margin: var(--space-4) 0;
}

.prompts-toolbar-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.prompts-count {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

/* —— 标签筛选栏 —— */
.prompts-tagbar {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}

.tag-filter {
  cursor: pointer;
  border: 1px solid transparent;
}

.tag-filter.is-active {
  background: var(--color-brand-soft);
  color: var(--color-brand);
  border-color: var(--color-brand);
}

/* —— 卡片网格 —— */
.prompts-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: var(--space-4);
}

.prompt-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
}

.prompt-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.prompt-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
  font-size: var(--font-size-lg);
}

.prompt-title-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.prompt-name {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-display);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.prompt-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.prompt-desc {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

/* 正文预览：等宽字体 + 两行截断 */
.prompt-content {
  margin: 0;
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
  font-family: var(--font-mono, Consolas, Menlo, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
}

.prompt-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}

.prompt-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: auto;
}

.prompt-delete:hover {
  color: var(--color-danger, #d92d20);
}

/* —— 结果提示条 —— */
.prompt-toast {
  position: fixed;
  left: 50%;
  bottom: 32px;
  transform: translateX(-50%);
  z-index: 60;
  padding: 10px var(--space-4);
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: var(--font-size-sm);
  box-shadow: var(--shadow-lg);
  white-space: nowrap;
}

.prompt-toast-enter-active,
.prompt-toast-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.prompt-toast-enter-from,
.prompt-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

/* 变量填充弹窗压缩宽度 */
.modal-compact {
  width: min(520px, calc(100vw - 48px));
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

@media (max-width: 640px) {
  .prompts-head,
  .prompts-toolbar {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
