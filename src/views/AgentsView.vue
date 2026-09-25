<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import { DEFAULT_AGENT_ID } from '@/lib/agents'
import {
  fetchSkillFromGithub,
  getGithubToken,
  parseSkillZip,
  setGithubToken,
  SKILLHUB_AGENTS,
  type SkillhubAgentDefinition,
  type ZipExpertImportResult,
} from '@/lib/skillhub'
import { useAgentsStore, type AgentView } from '@/stores/agents'
import { useSkillsStore } from '@/stores/skills'
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const agentsStore = useAgentsStore()
const skillsStore = useSkillsStore()

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

/* —— 行头像（图片加载失败时回退 emoji / 首字） —— */

/** 图片头像加载失败的智能体 id 集合（@error 时记入，触发回退显示） */
const failedAvatarIds = reactive(new Set<string>())

/* —— 行「更多」菜单（同屏只开一个；点外部 / Esc 关闭） —— */

/** 当前打开菜单的行 id */
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

/** Esc 关闭：优先关模态（新建/编辑或 SkillHub），其次关菜单 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (modalOpen.value) {
    closeModal()
  } else if (skillhubOpen.value) {
    closeSkillhubModal()
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
  clearGhStatus()
})

/* —— 行操作 —— */

/** 跳转 AI 对话并携带 agent 查询参数预选 */
function startChat(agent: AgentView): void {
  void router.push({ path: '/chat', query: { agent: agent.id } })
}

/** 从更多菜单打开编辑弹窗 */
function editAgent(agent: AgentView): void {
  closeMenu()
  openEditModal(agent)
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
/** 正在编辑的智能体快照（用于区分内置/自定义与是否已修改）；null 表示新建 */
const editingAgent = ref<AgentView | null>(null)
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
  editingAgent.value = null
  form.value = createEmptyForm()
  formErrors.value = { name: '', description: '', systemPrompt: '' }
  modalOpen.value = true
}

/** 打开编辑弹窗（内置与自定义均可编辑；表单回填当前生效值，内置有覆盖时即覆盖值） */
function openEditModal(agent: AgentView): void {
  editingId.value = agent.id
  editingAgent.value = agent
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
    // 内置走覆盖层写入，自定义直接改列表；两分支共用同一套表单校验
    if (editingAgent.value?.builtin) {
      agentsStore.updateBuiltinAgent(editingId.value, payload)
    } else {
      agentsStore.updateCustomAgent(editingId.value, payload)
    }
  } else {
    agentsStore.addCustomAgent(payload)
  }
  modalOpen.value = false
}

/** 恢复内置智能体的代码默认（清空覆盖层，二次确认后关闭弹窗） */
function resetBuiltinFromModal(): void {
  const agent = editingAgent.value
  if (!agent?.builtin) return
  if (!window.confirm('确定恢复该内置智能体的默认设置吗？当前修改将被清除。')) return
  agentsStore.resetBuiltinAgent(agent.id)
  modalOpen.value = false
}

/* —— SkillHub 弹窗：内置技能目录一键添加为自定义智能体 —— */

const skillhubOpen = ref(false)
const skillhubKeyword = ref('')

/** 按名称 / 描述 / 标签模糊过滤 SkillHub 目录 */
const filteredSkillhubAgents = computed<SkillhubAgentDefinition[]>(() => {
  const kw = skillhubKeyword.value.trim().toLowerCase()
  if (!kw) return SKILLHUB_AGENTS
  return SKILLHUB_AGENTS.filter((skill) =>
    `${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase().includes(kw),
  )
})

function openSkillhubModal(): void {
  skillhubKeyword.value = ''
  ghUrl.value = ''
  ghInstalling.value = false
  ghTokenOpen.value = false
  clearGhStatus()
  skillhubOpen.value = true
}

function closeSkillhubModal(): void {
  skillhubOpen.value = false
}

/** 添加 SkillHub 技能为自定义智能体；弹窗保持打开，可连续添加多个 */
function addSkillhubAgent(skill: SkillhubAgentDefinition): void {
  if (agentsStore.isSkillhubAdded(skill.id)) return
  agentsStore.addCustomAgent({
    name: skill.name,
    description: skill.description,
    systemPrompt: skill.systemPrompt,
    icon: skill.icon,
    tags: [...skill.tags],
    skillhubId: skill.id,
  })
}

/* —— SkillHub 弹窗：粘贴 GitHub 链接安装技能 —— */

/** 安装状态文字的语义（决定状态区配色） */
type GhInstallStatusKind = 'loading' | 'success' | 'warn' | 'error'

const ghUrl = ref('')
const ghInstalling = ref(false)
const ghStatusText = ref('')
const ghStatusKind = ref<GhInstallStatusKind>('loading')
/** 状态文字自动清除定时器（成功提示 2.5s 后消失） */
let ghStatusTimer: number | undefined
/** 私有仓库 Token 设置面板展开状态 */
const ghTokenOpen = ref(false)
const ghTokenInput = ref('')
/** 本机是否已保存 GitHub Token（用于面板在「输入保存」与「已配置」两态间切换） */
const ghHasToken = ref(getGithubToken() !== '')

/** 清除安装状态文字与自动清除定时器 */
function clearGhStatus(): void {
  if (ghStatusTimer !== undefined) {
    window.clearTimeout(ghStatusTimer)
    ghStatusTimer = undefined
  }
  ghStatusText.value = ''
}

/** 更新安装状态文字；仅成功状态 2.5s 后自动清除 */
function setGhStatus(kind: GhInstallStatusKind, text: string): void {
  clearGhStatus()
  ghStatusKind.value = kind
  ghStatusText.value = text
  if (kind === 'success') {
    ghStatusTimer = window.setTimeout(() => {
      ghStatusText.value = ''
      ghStatusTimer = undefined
    }, 2500)
  }
}

/** 粘贴链接安装：拉取 SKILL.md → 查重 → 添加为自定义智能体；失败保留输入便于重试 */
async function installFromGithub(): Promise<void> {
  const url = ghUrl.value.trim()
  if (!url || ghInstalling.value) return
  ghInstalling.value = true
  setGhStatus('loading', '正在从 GitHub 拉取技能…')
  try {
    const skill = await fetchSkillFromGithub(url, getGithubToken() || undefined)
    const skillhubId = `gh:${skill.owner}/${skill.repo}/${skill.skillDir}`
    if (agentsStore.isSkillhubAdded(skillhubId)) {
      setGhStatus('warn', '该技能已安装为智能体')
      return
    }
    agentsStore.addCustomAgent({
      name: skill.name,
      description: skill.description,
      systemPrompt: skill.systemPrompt,
      icon: '🧩',
      tags: ['SkillHub'],
      skillhubId,
    })
    ghUrl.value = ''
    setGhStatus('success', `已安装为智能体：${skill.name}`)
  } catch (error) {
    setGhStatus('error', error instanceof Error ? error.message : '安装失败，请稍后再试')
  } finally {
    ghInstalling.value = false
  }
}

/* —— SkillHub 弹窗：上传 ZIP 技能包导入（纯本地解析，无需 Token） —— */

/** 隐藏的文件选择框引用 */
const zipFileInput = ref<HTMLInputElement | null>(null)
/** ZIP 解析中（按钮禁用并显示「解析中…」） */
const zipParsing = ref(false)

/** 触发隐藏的文件选择框 */
function pickZipFile(): void {
  if (zipParsing.value) return
  zipFileInput.value?.click()
}

/** 选中 ZIP 后本地解析 → 按结果类型分流：单技能包装成智能体；合集包装 1 个智能体并把包内技能全部导入技能中心 */
async function onZipFileChange(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  if (zipParsing.value) {
    input.value = ''
    return
  }
  zipParsing.value = true
  setGhStatus('loading', '正在解析 ZIP 技能包…')
  try {
    const result = await parseSkillZip(file)
    if (result.kind === 'expert') {
      installExpertPackage(result)
      return
    }

    const skillhubId = `zip:${result.skillDir}`
    if (agentsStore.isSkillhubAdded(skillhubId)) {
      setGhStatus('warn', '该技能已安装为智能体')
      return
    }
    agentsStore.addCustomAgent({
      name: result.name,
      description: result.description,
      systemPrompt: result.systemPrompt,
      icon: '📦',
      tags: ['SkillHub'],
      skillhubId,
    })
    setGhStatus('success', `已导入为智能体：${result.name}`)
  } catch (error) {
    setGhStatus('error', error instanceof Error ? error.message : '导入失败，请稍后再试')
  } finally {
    zipParsing.value = false
    input.value = ''
  }
}

/** 安装合集包：先逐个导入包内技能（查重后跳过），再创建智能体并关联新创建的技能 id */
function installExpertPackage(pkg: ZipExpertImportResult): void {
  const agentSkillhubId = `zip:${pkg.agent.skillDir}`
  if (agentsStore.isSkillhubAdded(agentSkillhubId)) {
    setGhStatus('warn', '该合集已安装')
    return
  }

  // 先导入技能并收集本次创建出的技能 id（已存在而跳过的不参与关联，避免悬空引用历史版本）
  const linkedSkillIds: string[] = []
  let skippedCount = 0
  for (const skill of pkg.skills) {
    const skillhubId = `${agentSkillhubId}:${skill.skillKey}`
    if (skillsStore.isSkillImported(skillhubId)) {
      skippedCount += 1
      continue
    }
    linkedSkillIds.push(
      skillsStore.addCustomSkill({
        name: skill.name,
        description: skill.description,
        template: skill.template,
        icon: '📚',
        tags: ['SkillHub'],
        skillhubId,
      }),
    )
  }

  agentsStore.addCustomAgent({
    name: pkg.agent.name,
    description: pkg.agent.description,
    systemPrompt: pkg.agent.systemPrompt,
    icon: '📦',
    tags: ['SkillHub'],
    skillhubId: agentSkillhubId,
    linkedSkillIds,
  })
  const addedCount = linkedSkillIds.length

  if (pkg.skills.length === 0) {
    setGhStatus('success', `已导入智能体「${pkg.agent.name}」（包内未解出可导入的技能）`)
    return
  }
  const detail =
    skippedCount > 0 ? `（新增 ${addedCount} 个、跳过已存在 ${skippedCount} 个；技能可在技能中心查看）` : '（技能可在技能中心查看）'
  setGhStatus('success', `已导入智能体「${pkg.agent.name}」与 ${addedCount} 个技能${detail}`)
}

/** 保存 Token 到本机（仅 localStorage），成功后面板切换为「已配置」态 */
function saveGhToken(): void {
  if (!ghTokenInput.value.trim()) return
  setGithubToken(ghTokenInput.value)
  ghTokenInput.value = ''
  ghHasToken.value = getGithubToken() !== ''
}

/** 清除本机保存的 Token */
function clearGhToken(): void {
  setGithubToken('')
  ghHasToken.value = false
}
</script>

<template>
  <div class="page">
    <header class="page-head agents-head">
      <div>
        <h1>智能体中心</h1>
        <p>管理内置与自定义智能体人设，统一用于 AI 对话</p>
      </div>
      <div class="agents-head-actions">
        <button class="btn btn-ghost" type="button" @click="openSkillhubModal">
          <AppIcon name="sparkles" />
          从 SkillHub 添加
        </button>
        <button class="btn btn-primary" type="button" @click="openCreateModal">
          <AppIcon name="plus" />
          新建智能体
        </button>
      </div>
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

    <div v-if="filteredAgents.length" class="agents-list">
      <article
        v-for="agent in filteredAgents"
        :key="agent.id"
        class="agent-row"
        :class="{ 'is-disabled': agent.disabled }"
      >
        <span class="agent-avatar" aria-hidden="true">
          <img
            v-if="agent.avatar && !failedAvatarIds.has(agent.id)"
            :src="agent.avatar"
            :alt="agent.name"
            class="agent-avatar-img"
            @error="failedAvatarIds.add(agent.id)"
          />
          <template v-else>{{ agent.icon || agent.name.slice(0, 1) }}</template>
        </span>

        <div class="agent-main">
          <div class="agent-title-line">
            <h2 class="agent-name">{{ agent.name }}</h2>
            <span v-if="agent.builtin" class="chip chip-builtin">内置</span>
            <span v-if="agent.customized" class="chip chip-modified">已修改</span>
            <span v-if="agent.linkedSkillIds.length > 0" class="chip chip-linked">
              {{ agent.linkedSkillIds.length }} 技能
            </span>
            <span v-if="agent.disabled" class="chip chip-off">停用</span>
            <span v-for="tag in agent.tags" :key="tag" class="chip chip-tag">{{ tag }}</span>
          </div>
          <p class="agent-desc">{{ agent.description }}</p>
        </div>

        <div class="agent-actions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            :disabled="agent.disabled"
            title="跳转到 AI 对话并使用该智能体"
            @click="startChat(agent)"
          >
            <AppIcon name="chat" />
            开始对话
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
              <button class="menu-item" type="button" @click="editAgent(agent)">编辑</button>
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

    <!-- SkillHub 添加模态：内置技能目录，可搜索并一键添加（不自动关闭，可连续添加） -->
    <div v-if="skillhubOpen" class="modal-mask" @click.self="closeSkillhubModal">
      <div
        class="modal skillhub-modal"
        role="dialog"
        aria-modal="true"
        aria-label="从 SkillHub 添加智能体"
      >
        <header class="modal-head">
          <h2>从 SkillHub 添加智能体</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeSkillhubModal">
            <AppIcon name="close" />
          </button>
        </header>

        <div class="skillhub-body">
          <!-- 粘贴 GitHub 链接安装：技能目录或 SKILL.md 链接均可 -->
          <div class="gh-install">
            <div class="gh-install-row">
              <div class="search-box gh-install-search">
                <AppIcon name="download" />
                <input
                  v-model="ghUrl"
                  class="search-input"
                  type="text"
                  placeholder="粘贴 GitHub 技能链接（技能目录或 SKILL.md）"
                  :disabled="ghInstalling"
                  @keydown.enter.prevent="installFromGithub"
                />
              </div>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="ghInstalling || !ghUrl.trim()"
                @click="installFromGithub"
              >
                {{ ghInstalling ? '安装中…' : '安装' }}
              </button>
              <!-- 上传 ZIP 技能包：纯本地解析，与链接安装共用状态行 -->
              <input
                ref="zipFileInput"
                class="zip-file-input"
                type="file"
                accept=".zip"
                aria-hidden="true"
                tabindex="-1"
                @change="onZipFileChange"
              />
              <button class="btn btn-ghost" type="button" :disabled="zipParsing" @click="pickZipFile">
                <AppIcon name="upload" />
                {{ zipParsing ? '解析中…' : '上传 ZIP' }}
              </button>
            </div>

            <p v-if="ghStatusText" class="gh-status" :class="`is-${ghStatusKind}`" role="status">
              {{ ghStatusText }}
            </p>

            <!-- 私有仓库设置：GitHub Token 仅存本机 localStorage -->
            <div class="gh-token">
              <button class="gh-token-toggle" type="button" @click="ghTokenOpen = !ghTokenOpen">
                {{ ghTokenOpen ? '收起私有仓库设置' : '私有仓库设置' }}
              </button>
              <div v-if="ghTokenOpen" class="gh-token-panel">
                <template v-if="ghHasToken">
                  <div class="gh-token-row">
                    <span class="gh-token-status">已配置 Token</span>
                    <button class="btn btn-ghost btn-sm" type="button" @click="clearGhToken">
                      清除
                    </button>
                  </div>
                </template>
                <template v-else>
                  <div class="gh-token-row">
                    <input
                      v-model="ghTokenInput"
                      class="field-input gh-token-input"
                      type="password"
                      placeholder="GitHub Personal Access Token（仅存本机）"
                    />
                    <button
                      class="btn btn-ghost btn-sm"
                      type="button"
                      :disabled="!ghTokenInput.trim()"
                      @click="saveGhToken"
                    >
                      保存
                    </button>
                  </div>
                </template>
                <p class="gh-token-hint">Token 仅保存在本机浏览器 localStorage，用于访问你的私有仓库</p>
              </div>
            </div>
          </div>

          <div class="search-box skillhub-search">
            <AppIcon name="search" />
            <input
              v-model="skillhubKeyword"
              class="search-input"
              type="text"
              placeholder="搜索技能名称、描述或标签…"
            />
          </div>

          <div v-if="filteredSkillhubAgents.length" class="skillhub-list">
            <article
              v-for="skill in filteredSkillhubAgents"
              :key="skill.id"
              class="skillhub-row"
            >
              <span class="agent-avatar skillhub-avatar" aria-hidden="true">{{ skill.icon }}</span>
              <div class="agent-main">
                <div class="agent-title-line">
                  <h3 class="agent-name">{{ skill.name }}</h3>
                  <span v-for="tag in skill.tags" :key="tag" class="chip chip-tag">{{ tag }}</span>
                </div>
                <p class="agent-desc">{{ skill.description }}</p>
              </div>
              <button
                v-if="agentsStore.isSkillhubAdded(skill.id)"
                class="btn btn-ghost btn-sm"
                type="button"
                disabled
              >
                已添加
              </button>
              <button v-else class="btn btn-primary btn-sm" type="button" @click="addSkillhubAgent(skill)">
                添加
              </button>
            </article>
          </div>

          <div v-else class="skillhub-empty">
            <EmptyState title="未找到匹配的技能" description="换个关键词试试，SkillHub 目录共收录 12 个技能。" />
          </div>
        </div>
      </div>
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
            <button
              v-if="editingAgent?.customized"
              class="btn btn-ghost modal-reset"
              type="button"
              @click="resetBuiltinFromModal"
            >
              恢复默认
            </button>
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

/* 头部操作按钮组：「从 SkillHub 添加」+「新建智能体」 */
.agents-head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
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

/* —— 行式列表：垂直堆叠的独立圆角行 —— */
.agents-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.agent-row {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: var(--space-4) var(--space-5);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-theme);
}

.agent-row:hover {
  background: var(--color-surface-muted);
}

/* 停用的行整体降饱和 */
.agent-row.is-disabled {
  opacity: 0.62;
  filter: saturate(0.55);
}

/* —— 圆形头像 —— */
.agent-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  font-size: var(--font-size-xl);
  line-height: 1;
}

/* 图片头像：铺满圆形，圆角随容器 */
.agent-avatar-img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

/* —— 行主体：名称+徽标+标签 / 描述 两行堆叠 —— */
.agent-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.agent-title-line {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
  min-width: 0;
}

.agent-name {
  font-size: var(--font-size-md);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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

/* 已被覆盖层修改的内置智能体提示徽标 */
.chip-modified {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

/* 停用状态徽标（名称旁） */
.chip-off {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

/* 关联技能数量徽标（合集智能体名称旁，表示对话时自动装载这些技能） */
.chip-linked {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.chip-tag {
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
}

/* —— 行操作区（右侧） —— */
.agent-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  margin-left: auto;
}

.btn-sm {
  height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-sm);
}

.agent-more {
  position: relative;
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

/* —— 窄屏：操作区整体换行到第二行，描述保持截断 —— */
@media (max-width: 639px) {
  .agent-actions {
    flex-basis: 100%;
    justify-content: flex-end;
    margin-left: 0;
  }
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

/* 「恢复默认」靠左，与取消/保存分开 */
.modal-reset {
  margin-right: auto;
}

/* —— SkillHub 添加模态 —— */

/* 更宽的弹窗 + 纵向弹性布局：头部固定、列表区在剩余高度内滚动 */
.skillhub-modal {
  display: flex;
  flex-direction: column;
  max-width: 640px;
}

.skillhub-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-height: 0;
  padding: var(--space-5) var(--space-6) var(--space-6);
}

.skillhub-search {
  max-width: none;
}

.skillhub-list {
  flex: 1;
  min-height: 0;
  max-height: 46vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.skillhub-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: background-color var(--transition-fast);
}

.skillhub-row:hover {
  background: var(--color-surface-muted);
}

/* 行内小号头像 */
.skillhub-avatar {
  width: 40px;
  height: 40px;
  font-size: var(--font-size-lg);
}

.skillhub-row .agent-name {
  font-size: var(--font-size-md);
}

/* 行尾按钮固定占位，避免添加前后宽度跳动 */
.skillhub-row .btn-sm {
  min-width: 76px;
  margin-left: auto;
}

.skillhub-empty {
  padding: var(--space-6) 0;
}

/* —— 粘贴 GitHub 链接安装区（标题与目录搜索框之间） —— */

.gh-install {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.gh-install-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 链接输入框撑满剩余宽度 */
.gh-install-search {
  flex: 1;
  max-width: none;
}

/* 隐藏的 ZIP 文件选择框（点击「上传 ZIP」按钮触发） */
.zip-file-input {
  display: none;
}

/* 安装状态文字：加载 / 成功 / 重复（警示） / 失败 */
.gh-status {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.5;
  word-break: break-all;
}

.gh-status.is-loading {
  color: var(--color-text-muted);
}

.gh-status.is-success {
  color: var(--color-success);
}

.gh-status.is-warn {
  color: var(--color-warning);
}

.gh-status.is-error {
  color: var(--color-danger);
}

/* 私有仓库设置：小文字切换 + 可展开面板 */
.gh-token-toggle {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-muted);
  font: inherit;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: color var(--transition-fast);
}

.gh-token-toggle:hover {
  color: var(--color-brand);
}

.gh-token-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.gh-token-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.gh-token-input {
  flex: 1;
  min-width: 0;
}

.gh-token-status {
  flex: 1;
  color: var(--color-success);
  font-size: var(--font-size-sm);
}

.gh-token-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}
</style>
