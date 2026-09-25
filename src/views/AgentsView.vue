<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { DEFAULT_AGENT_ID } from '@/lib/agents'
import { useAgentsStore, type AgentView } from '@/stores/agents'
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const agentsStore = useAgentsStore()

/* —— 搜索与过滤 —— */

const keyword = ref('')

/** 按名称 / 描述 / 标签模糊过滤合并清单 */
const filteredAgents = computed<AgentView[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return agentsStore.agents
  return agentsStore.agents.filter((agent) =>
    `${agent.name} ${agent.description} ${agent.tags.join(' ')}`.toLowerCase().includes(kw),
  )
})

/* —— 卡片「更多」菜单（同屏只开一个；点外部 / Esc 关闭） —— */

/** 当前打开菜单的卡片 id */
const openMenuId = ref<string | null>(null)

function toggleMenu(id: string): void {
  openMenuId.value = openMenuId.value === id ? null : id
}

function closeMenu(): void {
  openMenuId.value = null
}

/** 点击菜单外部时关闭 */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!openMenuId.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.agent-more')) return
  closeMenu()
}

/** Esc 关闭：优先关模态，其次关菜单 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (modalOpen.value) {
    closeModal()
  } else if (openMenuId.value) {
    closeMenu()
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
})

/* —— 卡片操作 —— */

/** 跳转 AI 对话并携带 agent 查询参数预选 */
function startChat(agent: AgentView): void {
  void router.push({ path: '/chat', query: { agent: agent.id } })
}

/** 停用 / 启用（通用助手为默认兜底，store 内部会忽略） */
function toggleAgentDisabled(agent: AgentView): void {
  closeMenu()
  agentsStore.toggleDisabled(agent.id)
}

/** 复制为自定义副本 */
function duplicateAgent(agent: AgentView): void {
  closeMenu()
  agentsStore.duplicateAgent(agent.id)
}

/** 删除自定义智能体（二次确认） */
function removeAgent(agent: AgentView): void {
  closeMenu()
  if (!window.confirm(`确定删除智能体「${agent.name}」吗？删除后不可恢复。`)) return
  agentsStore.removeCustomAgent(agent.id)
}

/* —— 新建 / 编辑模态表单 —— */

interface AgentFormState {
  name: string
  description: string
  systemPrompt: string
  icon: string
  /** 标签以逗号分隔的原文，提交时再解析 */
  tags: string
}

/** 空表单（图标留空，展示时回退默认 emoji） */
function createEmptyForm(): AgentFormState {
  return { name: '', description: '', systemPrompt: '', icon: '', tags: '' }
}

const modalOpen = ref(false)
/** 正在编辑的智能体 id；null 表示新建 */
const editingId = ref<string | null>(null)
const form = ref<AgentFormState>(createEmptyForm())
const formErrors = ref({ name: '', description: '', systemPrompt: '' })

/** 图标实时预览：优先图标字段，回退名称首字，再回退默认 emoji */
const iconPreview = computed(
  () => form.value.icon.trim() || form.value.name.trim().slice(0, 1) || '🤖',
)

/** 标签占位回显用分隔符 */
const TAGS_SEPARATOR = '，'

function openCreateModal(): void {
  editingId.value = null
  form.value = createEmptyForm()
  formErrors.value = { name: '', description: '', systemPrompt: '' }
  modalOpen.value = true
}

/** 打开编辑（仅自定义智能体可编辑） */
function openEditModal(agent: AgentView): void {
  if (agent.builtin) return
  editingId.value = agent.id
  form.value = {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    icon: agent.icon,
    tags: agent.tags.join(TAGS_SEPARATOR),
  }
  formErrors.value = { name: '', description: '', systemPrompt: '' }
  modalOpen.value = true
}

function closeModal(): void {
  modalOpen.value = false
}

/** 解析标签输入：按中英文逗号拆分，trim 后去空去重 */
function parseTags(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  )
}

function submitForm(): void {
  const name = form.value.name.trim()
  const description = form.value.description.trim()
  const systemPrompt = form.value.systemPrompt.trim()
  formErrors.value = {
    name: name ? '' : '请输入名称',
    description: description ? '' : '请输入描述',
    systemPrompt: systemPrompt ? '' : '请输入系统提示词',
  }
  if (!name || !description || !systemPrompt) return

  const payload = {
    name,
    description,
    systemPrompt,
    icon: form.value.icon.trim(),
    tags: parseTags(form.value.tags),
  }
  if (editingId.value) {
    agentsStore.updateCustomAgent(editingId.value, payload)
  } else {
    agentsStore.addCustomAgent(payload)
  }
  modalOpen.value = false
}
</script>

<template>
  <div class="page">
    <header class="page-head agents-head">
      <div>
        <h1>智能体中心</h1>
        <p>管理内置与自定义智能体人设，统一用于 AI 对话</p>
      </div>
      <button class="btn btn-primary" type="button" @click="openCreateModal">
        <AppIcon name="plus" />
        新建智能体
      </button>
    </header>

    <div class="agents-toolbar">
      <div class="search-box">
        <AppIcon name="search" />
        <input
          v-model="keyword"
          class="search-input"
          type="text"
          placeholder="搜索名称、描述或标签…"
        />
      </div>
      <span class="agents-count">共 {{ filteredAgents.length }} 个智能体</span>
    </div>

    <div v-if="filteredAgents.length" class="agents-grid">
      <article
        v-for="agent in filteredAgents"
        :key="agent.id"
        class="agent-card"
        :class="{ 'is-disabled': agent.disabled }"
      >
        <div class="agent-card-head">
          <span class="agent-avatar" aria-hidden="true">{{ agent.icon || agent.name.slice(0, 1) }}</span>
          <div class="agent-title-group">
            <h2 class="agent-name">{{ agent.name }}</h2>
            <div class="agent-meta">
              <span v-if="agent.builtin" class="chip chip-builtin">内置</span>
              <span class="chip" :class="agent.disabled ? 'chip-off' : 'chip-on'">
                {{ agent.disabled ? '停用' : '启用' }}
              </span>
            </div>
          </div>
        </div>

        <p class="agent-desc">{{ agent.description }}</p>
        <p class="agent-prompt">
          {{ agent.systemPrompt || '未配置系统提示词，对话时保持默认通用行为。' }}
        </p>
        <div v-if="agent.tags.length" class="agent-tags">
          <span v-for="tag in agent.tags" :key="tag" class="chip chip-tag">{{ tag }}</span>
        </div>

        <div class="agent-actions">
          <button
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="agent.disabled"
            title="跳转到 AI 对话并使用该智能体"
            @click="startChat(agent)"
          >
            <AppIcon name="chat" />
            开始对话
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="agent.builtin"
            :title="agent.builtin ? '内置智能体不支持编辑，可复制后修改' : '编辑智能体'"
            @click="openEditModal(agent)"
          >
            <AppIcon name="edit" />
            编辑
          </button>
          <div class="agent-more">
            <button
              class="icon-button"
              type="button"
              aria-label="更多操作"
              @click.stop="toggleMenu(agent.id)"
            >
              <AppIcon name="more" />
            </button>
            <div v-if="openMenuId === agent.id" class="agent-menu">
              <button
                v-if="agent.id !== DEFAULT_AGENT_ID"
                class="menu-item"
                type="button"
                @click="toggleAgentDisabled(agent)"
              >
                {{ agent.disabled ? '启用' : '停用' }}
              </button>
              <button class="menu-item" type="button" @click="duplicateAgent(agent)">复制</button>
              <button
                v-if="!agent.builtin"
                class="menu-item menu-danger"
                type="button"
                @click="removeAgent(agent)"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      </article>
    </div>

    <div v-else class="card">
      <EmptyState title="未找到匹配的智能体" description="换个关键词试试，或新建一个自定义智能体。">
        <button class="btn btn-primary" type="button" @click="openCreateModal">
          <AppIcon name="plus" />
          新建智能体
        </button>
      </EmptyState>
    </div>

    <!-- 新建 / 编辑模态 -->
    <div v-if="modalOpen" class="modal-mask" @click.self="closeModal">
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="editingId ? '编辑智能体' : '新建智能体'"
      >
        <header class="modal-head">
          <h2>{{ editingId ? '编辑智能体' : '新建智能体' }}</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeModal">
            <AppIcon name="close" />
          </button>
        </header>

        <form class="modal-form" @submit.prevent="submitForm">
          <label class="field">
            <span class="field-label">名称<span class="field-required" aria-hidden="true">*</span></span>
            <input v-model="form.name" class="field-input" type="text" placeholder="例如：代码评审官" />
            <span v-if="formErrors.name" class="field-error">{{ formErrors.name }}</span>
          </label>

          <label class="field">
            <span class="field-label">描述<span class="field-required" aria-hidden="true">*</span></span>
            <input
              v-model="form.description"
              class="field-input"
              type="text"
              placeholder="一句话说明用途，例如：审查代码改动并给出改进建议"
            />
            <span v-if="formErrors.description" class="field-error">{{ formErrors.description }}</span>
          </label>

          <label class="field">
            <span class="field-label"
              >系统提示词<span class="field-required" aria-hidden="true">*</span></span
            >
            <textarea
              v-model="form.systemPrompt"
              class="field-input field-textarea"
              rows="5"
              placeholder="例如：你是一位资深代码评审专家。评审时：先指出阻断性问题，再给建议性问题；每条附上理由与修改示例；除非用户另行要求，一律用中文回答。"
            ></textarea>
            <span v-if="formErrors.systemPrompt" class="field-error">{{ formErrors.systemPrompt }}</span>
          </label>

          <div class="field">
            <span class="field-label">图标（emoji）</span>
            <div class="icon-field">
              <span class="agent-avatar icon-preview" aria-hidden="true">{{ iconPreview }}</span>
              <input
                v-model="form.icon"
                class="field-input"
                type="text"
                placeholder="默认 🤖，可留空"
              />
            </div>
          </div>

          <label class="field">
            <span class="field-label">标签</span>
            <input
              v-model="form.tags"
              class="field-input"
              type="text"
              placeholder="多个标签用逗号分隔，例如：编程, 评审"
            />
          </label>

          <footer class="modal-foot">
            <button class="btn btn-ghost" type="button" @click="closeModal">取消</button>
            <button class="btn btn-primary" type="submit">保存</button>
          </footer>
        </form>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* —— 页面头部 —— */
.agents-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

/* —— 工具行：搜索 + 计数 —— */
.agents-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

.search-box {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 220px;
  max-width: 420px;
  height: 40px;
  padding: 0 var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--transition-fast);
}

.search-box:focus-within {
  border-color: var(--color-brand);
}

.search-box svg {
  width: 16px;
  height: 16px;
  color: var(--color-text-muted);
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  color: var(--color-text);
  font: inherit;
  outline: none;
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

.agents-count {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

/* —— 卡片网格 —— */
.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-5);
}

.agent-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
  transition:
    background-color var(--transition-theme),
    border-color var(--transition-theme),
    box-shadow var(--transition-fast);
}

.agent-card:hover {
  box-shadow: var(--shadow-md);
}

/* 停用的卡片整体降饱和 */
.agent-card.is-disabled {
  opacity: 0.62;
  filter: saturate(0.55);
}

.agent-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.agent-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
  font-size: var(--font-size-xl);
  line-height: 1;
}

.agent-title-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.agent-name {
  font-size: var(--font-size-lg);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.agent-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-prompt {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.agent-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* —— 徽章 chips —— */
.chip {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.chip-builtin {
  background: var(--color-brand-soft);
  color: var(--color-brand);
}

.chip-on {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.chip-off {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.chip-tag {
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
}

/* —— 卡片操作区 —— */
.agent-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: auto;
  padding-top: var(--space-2);
}

.btn-sm {
  height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-sm);
}

.agent-more {
  position: relative;
  margin-left: auto;
}

.agent-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 128px;
  padding: var(--space-1);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}

.menu-item {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 8px var(--space-3);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  text-align: left;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.menu-item:hover {
  background: var(--color-surface-muted);
  color: var(--color-text);
}

.menu-danger {
  color: var(--color-danger);
}

.menu-danger:hover {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* —— 新建 / 编辑模态 —— */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  background: rgba(8, 12, 24, 0.55);
}

.modal {
  width: 100%;
  max-width: 560px;
  max-height: calc(100vh - var(--space-8));
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--color-border);
}

.modal-head h2 {
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.modal-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-6);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.field-required {
  margin-left: 2px;
  color: var(--color-danger);
}

.field-input {
  padding: 8px var(--space-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text);
  font: inherit;
  transition: border-color var(--transition-fast);
}

.field-input::placeholder {
  color: var(--color-text-muted);
}

.field-input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.field-textarea {
  resize: vertical;
  min-height: 96px;
  line-height: 1.6;
}

.field-error {
  color: var(--color-danger);
  font-size: var(--font-size-xs);
}

.icon-field {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.icon-preview {
  width: 40px;
  height: 40px;
  font-size: var(--font-size-lg);
}

.icon-field .field-input {
  flex: 1;
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding-top: var(--space-2);
}
</style>
