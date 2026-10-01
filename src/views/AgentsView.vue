<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'

import { DEFAULT_AGENT_ID, findAgentById, type AgentAvatar as AgentAvatarValue } from '@/lib/agents'
import { AGENT_TOOLS } from '@/lib/agent-tools'
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
import { useLlmStore } from '@/stores/llm'
import { useSkillsStore } from '@/stores/skills'
import AgentAvatar from '@/components/AgentAvatar.vue'
import AppIcon from '@/components/AppIcon.vue'
import AvatarPickerModal from '@/components/AvatarPickerModal.vue'
import EmptyState from '@/components/EmptyState.vue'

const router = useRouter()
const agentsStore = useAgentsStore()
const skillsStore = useSkillsStore()
// 默认模型绑定的可选来源：全部模型配置（id + 名称 + modelIds）
const llmStore = useLlmStore()
const { configs } = storeToRefs(llmStore)

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

const selectedAgentId = ref<string | null>(null)
const selectedAgent = computed<AgentView | null>(() => {
  if (!filteredAgents.value.length) return null
  return (
    filteredAgents.value.find((agent) => agent.id === selectedAgentId.value) ??
    filteredAgents.value[0]
  )
})

function selectAgent(agent: AgentView): void {
  selectedAgentId.value = agent.id
}

function onAgentIndexKeydown(event: KeyboardEvent, agent: AgentView): void {
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  selectAgent(agent)
}

/** 详情卡上的默认模型标识：绑定已解析生效（配置仍存在）时返回「配置名 / 模型」文案，否则不展示 */
const selectedAgentBindingLabel = computed<string>(() => {
  const agent = selectedAgent.value
  if (!agent?.modelConfigId) return ''
  const config = configs.value.find((item) => item.id === agent.modelConfigId)
  // 配置已被删除视为未绑定，不展示标识
  if (!config) return ''
  const modelLabel =
    agent.modelId && config.modelIds.includes(agent.modelId) ? agent.modelId : '主模型'
  return `${config.name} / ${modelLabel}`
})

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

/** Esc 关闭：优先关模态（新建/编辑、更换头像或 SkillHub），最后关菜单 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (modalOpen.value) {
    closeModal()
  } else if (avatarPickerId.value) {
    closeAvatarPicker()
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
  /** 绑定的默认模型配置 id（''=未绑定，跟随对话当前选择） */
  modelConfigId: string
  /** 绑定的默认模型 id（''=该配置的主模型；仅 modelConfigId 非空时生效） */
  modelId: string
  /** 勾选的工具能力（agent-tools.ts 注册表的工具名；空数组=不挂工具） */
  tools: string[]
  /** 勾选的可加载技能（技能库中技能的 id；保存时与原关联做差量挂载/卸载） */
  linkedSkillIds: string[]
}

/** 空表单（图标留空，展示时回退默认 emoji） */
function createEmptyForm(): AgentFormState {
  return {
    name: '',
    description: '',
    systemPrompt: '',
    icon: '',
    tags: '',
    modelConfigId: '',
    modelId: '',
    tools: [],
    linkedSkillIds: [],
  }
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
  // 默认模型绑定回填：绑定的配置已被删除时按未绑定（''）回填；
  // 绑定的模型不在该配置 modelIds 中时按主模型（''）回填
  const boundConfig = agent.modelConfigId
    ? (configs.value.find((config) => config.id === agent.modelConfigId) ?? null)
    : null
  form.value = {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    icon: agent.icon,
    tags: agent.tags.join(TAGS_SEPARATOR),
    modelConfigId: boundConfig?.id ?? '',
    modelId:
      boundConfig && agent.modelId && boundConfig.modelIds.includes(agent.modelId)
        ? agent.modelId
        : '',
    tools: [...agent.tools],
    linkedSkillIds: [...agent.linkedSkillIds],
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

/** 表单当前所选的模型配置对象（未选配置或配置已被删除时为 null） */
const formModelConfig = computed(
  () => configs.value.find((config) => config.id === form.value.modelConfigId) ?? null,
)

/**
 * 「模型」下拉的显示值：''（主模型）在选项中无对应项（第一项 value 为其 modelId 本身），
 * 直接绑定会出现空白选中态；读取时把 '' 解析为该配置主模型 id 仅用于展示，写入仍存所选 id。
 */
const formModelIdDisplay = computed<string>({
  get: () => {
    const config = formModelConfig.value
    if (!config) return form.value.modelId
    if (config.modelIds.includes(form.value.modelId)) return form.value.modelId
    return config.modelIds[0] ?? ''
  },
  set: (value) => {
    form.value.modelId = value
  },
})

/** 切换「模型配置」下拉时校验已选模型：不在新配置的 modelIds 中则回退主模型（''） */
function onFormConfigChange(): void {
  const config = formModelConfig.value
  if (!config || !config.modelIds.includes(form.value.modelId)) {
    form.value.modelId = ''
  }
}

/** 勾选/取消工具能力（内置与自定义智能体表单通用；内置保存后写入覆盖层 tools） */
function toggleFormTool(name: string): void {
  form.value.tools = form.value.tools.includes(name)
    ? form.value.tools.filter((item) => item !== name)
    : [...form.value.tools, name]
}

/** 「恢复默认工具」：把表单 tools 重置为该内置智能体代码定义的默认清单 */
function resetFormToolsToDefault(): void {
  const id = editingId.value
  if (!id) return
  const defaults = findAgentById(id)?.tools ?? []
  form.value.tools = [...defaults]
}

/** 勾选/取消「可加载技能」（内置与自定义智能体表单通用；保存时与原关联做差量挂载/卸载） */
function toggleFormSkill(skillId: string): void {
  form.value.linkedSkillIds = form.value.linkedSkillIds.includes(skillId)
    ? form.value.linkedSkillIds.filter((item) => item !== skillId)
    : [...form.value.linkedSkillIds, skillId]
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

  // 默认模型绑定：未选配置时两字段均为 ''（未绑定）；模型不在所选配置中时归一为主模型（''）
  const boundConfig = form.value.modelConfigId
    ? (configs.value.find((config) => config.id === form.value.modelConfigId) ?? null)
    : null
  const payload = {
    name,
    description,
    systemPrompt,
    icon: form.value.icon.trim(),
    tags: parseTags(form.value.tags),
    modelConfigId: boundConfig?.id ?? '',
    modelId:
      boundConfig && form.value.modelId && boundConfig.modelIds.includes(form.value.modelId)
        ? form.value.modelId
        : '',
    // 工具能力：内置走覆盖层 tools，自定义按勾选写入列表
    tools: [...form.value.tools],
  }
  if (editingId.value) {
    // 内置走覆盖层写入，自定义直接改列表；两分支共用同一套表单校验
    if (editingAgent.value?.builtin) {
      agentsStore.updateBuiltinAgent(editingId.value, payload)
    } else {
      agentsStore.updateCustomAgent(editingId.value, payload)
    }
    // 可加载技能：与编辑前的原关联做差量（勾选补挂载、取消调卸载），未勾选项不触碰原关联
    const originalSkillIds = editingAgent.value?.linkedSkillIds ?? []
    for (const skillId of form.value.linkedSkillIds) {
      if (!originalSkillIds.includes(skillId)) {
        agentsStore.linkSkillToAgent(editingId.value, skillId)
      }
    }
    for (const skillId of originalSkillIds) {
      if (!form.value.linkedSkillIds.includes(skillId)) {
        agentsStore.detachSkillFromAgent(editingId.value, skillId)
      }
    }
  } else {
    // 新建自定义智能体：勾选的技能随表单一并写入 linkedSkillIds
    agentsStore.addCustomAgent({ ...payload, linkedSkillIds: [...form.value.linkedSkillIds] })
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

/* —— 更换头像弹窗：预览 / 上传图片 / 系统默认素材 / Emoji，确定后写入 store —— */

/** 正在更换头像的智能体 id；null 表示弹窗关闭 */
const avatarPickerId = ref<string | null>(null)

/** 弹窗对应的智能体（按 id 实时取合并清单，跟随名称等字段变化） */
const avatarPickerAgent = computed<AgentView | null>(
  () => (avatarPickerId.value ? (agentsStore.findAgent(avatarPickerId.value) ?? null) : null),
)

/** 从更多菜单打开 */
function openAvatarPicker(agent: AgentView): void {
  closeMenu()
  avatarPickerId.value = agent.id
}

function closeAvatarPicker(): void {
  avatarPickerId.value = null
}

/** 确认更换：null 表示恢复该智能体默认头像（回退 icon emoji 展示） */
function confirmAvatarPicker(avatar: AgentAvatarValue | null): void {
  if (!avatarPickerId.value) return
  agentsStore.setAgentAvatar(avatarPickerId.value, avatar)
  avatarPickerId.value = null
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
        <p class="eyebrow">智能体工作台</p>
        <h1>智能体中心</h1>
        <p>管理内置与自定义智能体人设，统一用于 AI 对话</p>
      </div>
      <div class="agents-head-actions">
        <button class="btn btn-primary" type="button" @click="openCreateModal">
          <AppIcon name="plus" />
          新建智能体
        </button>
        <button class="btn btn-ghost" type="button" @click="openSkillhubModal">
          <AppIcon name="sparkles" />
          从 SkillHub 添加
        </button>
      </div>
    </header>

    <section v-if="filteredAgents.length" class="agent-workbench" aria-label="智能体工作台">
      <aside class="agent-index" aria-label="智能体索引">
        <div class="index-head">
          <div>
            <span class="section-kicker">档案索引</span>
            <h2>智能体档案</h2>
          </div>
          <span class="agents-count">{{ filteredAgents.length }} 项</span>
        </div>
        <div class="index-tools">
          <div class="search-box">
            <AppIcon name="search" />
            <input
              v-model="keyword"
              class="search-input"
              type="text"
              placeholder="搜索名称、描述或标签…"
            />
          </div>
        </div>
        <nav class="index-list" aria-label="智能体列表">
          <button
            v-for="(agent, index) in filteredAgents"
            :key="agent.id"
            class="index-item"
            :class="{ 'is-selected': selectedAgent?.id === agent.id, 'is-disabled': agent.disabled }"
            type="button"
            :aria-current="selectedAgent?.id === agent.id ? 'true' : undefined"
            @click="selectAgent(agent)"
            @keydown="onAgentIndexKeydown($event, agent)"
          >
            <span class="index-number">{{ String(index + 1).padStart(2, '0') }}</span>
            <span class="index-avatar" aria-hidden="true">
              <AgentAvatar :avatar="agent.avatar" :icon="agent.icon" :name="agent.name" />
            </span>
            <span class="index-copy">
              <strong>{{ agent.name }}</strong>
              <span>{{ agent.disabled ? '停用' : '可用' }}</span>
            </span>
            <span class="index-skills">{{ agent.linkedSkillIds.length }} 技能</span>
          </button>
        </nav>
      </aside>

      <section v-if="selectedAgent" :key="selectedAgent.id" class="agent-detail" aria-live="polite">
        <div class="detail-topline">
          <span class="geo-ring" aria-hidden="true"></span>
          <span class="section-kicker">当前档案</span>
          <span class="detail-id">ID / {{ selectedAgent.id }}</span>
        </div>
        <div class="detail-identity">
          <span class="detail-avatar" aria-hidden="true">
            <AgentAvatar :avatar="selectedAgent.avatar" :icon="selectedAgent.icon" :name="selectedAgent.name" />
          </span>
          <div class="detail-title">
            <div class="agent-title-line">
              <h2>{{ selectedAgent.name }}</h2>
              <span v-if="selectedAgent.builtin" class="chip chip-builtin">内置</span>
              <span v-if="selectedAgent.customized" class="chip chip-modified">已修改</span>
              <span v-if="selectedAgent.disabled" class="chip chip-off">停用</span>
              <span v-if="selectedAgentBindingLabel" class="chip chip-tag" title="默认模型">
                ⚙ {{ selectedAgentBindingLabel }}
              </span>
            </div>
            <p class="detail-status"><span :class="['status-dot', { 'is-off': selectedAgent.disabled }]" />{{ selectedAgent.disabled ? '当前停用' : '当前可用' }}</p>
          </div>
          <div class="detail-primary-action">
            <button class="btn btn-primary" type="button" :disabled="selectedAgent.disabled" @click="startChat(selectedAgent)">
              <AppIcon name="chat" />
              开始对话
            </button>
            <div class="agent-more">
              <button class="icon-button" type="button" aria-label="更多操作" @click.stop="toggleMenu(selectedAgent.id)">
                <AppIcon name="more" />
              </button>
              <div v-if="openMenuId === selectedAgent.id" class="agent-menu">
                <button class="menu-item" type="button" @click="editAgent(selectedAgent!)">编辑</button>
                <button class="menu-item" type="button" @click="openAvatarPicker(selectedAgent!)">更换头像</button>
                <button v-if="selectedAgent.id !== DEFAULT_AGENT_ID" class="menu-item" type="button" @click="toggleAgentDisabled(selectedAgent!)">{{ selectedAgent.disabled ? '启用' : '停用' }}</button>
                <button class="menu-item" type="button" @click="duplicateAgent(selectedAgent!)">复制</button>
                <button v-if="!selectedAgent.builtin" class="menu-item menu-danger" type="button" @click="removeAgent(selectedAgent!)">删除</button>
              </div>
            </div>
          </div>
        </div>

        <div class="detail-grid">
          <section class="detail-section detail-summary">
            <span class="section-kicker">摘要</span>
            <p>{{ selectedAgent.description }}</p>
          </section>
          <section class="detail-section">
            <span class="section-kicker">能力与技能</span>
            <div v-if="selectedAgent.linkedSkillIds.length || selectedAgent.tags.length" class="detail-tags">
              <span v-for="skillId in selectedAgent.linkedSkillIds" :key="skillId" class="chip chip-linked">{{ skillsStore.findSkill(skillId)?.name ?? skillId }}</span>
              <span v-for="tag in selectedAgent.tags" :key="tag" class="chip chip-tag">{{ tag }}</span>
            </div>
            <p v-else class="muted-copy">暂无关联技能或标签</p>
          </section>
          <section class="detail-section detail-source">
            <span class="section-kicker">来源</span>
            <p>{{ selectedAgent.builtin ? '系统内置智能体' : '自定义智能体' }}<span v-if="selectedAgent.customized"> · 已保留自定义修改</span></p>
          </section>
          <section class="detail-section detail-secondary">
            <span class="section-kicker">次级操作</span>
            <div class="secondary-actions">
              <button class="btn btn-ghost btn-sm" type="button" @click="editAgent(selectedAgent!)">编辑</button>
              <button class="btn btn-ghost btn-sm" type="button" @click="duplicateAgent(selectedAgent!)">复制</button>
            </div>
          </section>
        </div>
      </section>
    </section>

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

          <div class="field">
            <span class="field-label">默认模型</span>
            <div class="model-binding">
              <select
                v-model="form.modelConfigId"
                class="field-input"
                aria-label="默认模型配置"
                @change="onFormConfigChange"
              >
                <option value="">跟随对话选择（不绑定）</option>
                <option v-for="config in configs" :key="config.id" :value="config.id">
                  {{ config.name }}
                </option>
              </select>
              <select
                v-model="formModelIdDisplay"
                class="field-input"
                aria-label="默认模型"
                :disabled="!formModelConfig"
              >
                <template v-if="formModelConfig">
                  <!-- 第一项即主模型（modelIds[0]），value 直接用 modelId 本身 -->
                  <option
                    v-for="(modelOption, index) in formModelConfig.modelIds"
                    :key="modelOption"
                    :value="modelOption"
                  >
                    {{ modelOption }}{{ index === 0 ? '（主）' : '' }}
                  </option>
                </template>
                <option v-else value="">未选择配置</option>
              </select>
            </div>
            <span class="field-hint">绑定后，对话中选中该智能体会自动切换到该模型，仍可随时手动更换</span>
          </div>

          <!-- 工具能力：内置与自定义均可勾选编辑；内置保存后写入覆盖层 tools -->
          <div class="field">
            <span class="field-label">工具能力</span>
            <div class="tool-picker" role="group" aria-label="工具能力多选">
              <label
                v-for="tool in AGENT_TOOLS"
                :key="tool.name"
                class="tool-option"
                :class="{ 'is-selected': form.tools.includes(tool.name) }"
              >
                <input
                  type="checkbox"
                  class="tool-option-input"
                  :checked="form.tools.includes(tool.name)"
                  @change="toggleFormTool(tool.name)"
                />
                <span class="tool-option-body">
                  <span class="tool-option-title">
                    {{ tool.name }}
                    <span
                      v-if="tool.name === 'http_post_json'"
                      class="badge badge-warn tool-confirm-badge"
                    >
                      需确认
                    </span>
                  </span>
                  <span class="tool-option-desc">{{ tool.description }}</span>
                </span>
              </label>
              <span class="field-hint">
                勾选后，该智能体在对话中可自主调用工具（桌面端生效，工具执行前可按需弹窗确认）。
              </span>
              <button
                v-if="editingAgent?.builtin"
                class="btn btn-ghost tool-reset-default"
                type="button"
                @click="resetFormToolsToDefault"
              >
                恢复默认工具
              </button>
            </div>
          </div>

          <!-- 可加载技能：内置与自定义均可勾选编辑；disabled 技能置灰不可选 -->
          <div class="field">
            <span class="field-label">可加载技能</span>
            <div class="tool-picker" role="group" aria-label="可加载技能多选">
              <label
                v-for="skill in skillsStore.skills"
                :key="skill.id"
                class="tool-option"
                :class="{ 'is-selected': form.linkedSkillIds.includes(skill.id), 'is-disabled': skill.disabled }"
              >
                <input
                  type="checkbox"
                  class="tool-option-input"
                  :checked="form.linkedSkillIds.includes(skill.id)"
                  :disabled="skill.disabled"
                  @change="toggleFormSkill(skill.id)"
                />
                <span class="tool-option-body">
                  <span class="tool-option-title">{{ skill.name }}</span>
                  <span v-if="skill.description" class="tool-option-desc">{{ skill.description }}</span>
                </span>
              </label>
              <span v-if="!skillsStore.skills.length" class="field-hint">技能库暂无技能，可先到技能中心添加。</span>
              <span v-else class="field-hint">
                勾选后，该智能体在对话时自动装载对应技能的方法论；已停用的技能置灰不可选。
              </span>
            </div>
          </div>

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

    <!-- 更换头像模态：预览 / 上传图片 / 系统默认素材 / Emoji，确定后写入 store -->
    <AvatarPickerModal
      v-if="avatarPickerAgent"
      :agent="avatarPickerAgent"
      @close="closeAvatarPicker"
      @confirm="confirmAvatarPicker"
    />
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

/* 搜索框样式已上提为 base.css 全局 .search-box / .search-input */
.agents-count {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
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

/* 徽章 chips 样式已上提为 base.css 全局 .chip / .chip-* 系列 */

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

/* 菜单项样式已上提为 base.css 全局 .menu-item / .menu-danger */

/* —— 窄屏：操作区整体换行到第二行，描述保持截断 —— */
@media (max-width: 639px) {
  .agent-actions {
    flex-basis: 100%;
    justify-content: flex-end;
    margin-left: 0;
  }
}

/* —— Archive Index + Master-Detail 工作台 —— */
.eyebrow,
.section-kicker {
  display: block;
  margin-bottom: var(--space-2);
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
}

.agents-head {
  align-items: flex-start;
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.agents-head h1 {
  color: var(--color-text);
  letter-spacing: -0.025em;
}

.agents-head p:not(.eyebrow) {
  margin-top: var(--space-2);
  color: var(--color-text-secondary);
}

.agents-head-actions {
  gap: var(--space-2);
}

.agent-workbench {
  display: grid;
  grid-template-columns: minmax(250px, 0.34fr) minmax(0, 0.66fr);
  min-height: 560px;
  margin-top: var(--space-5);
  overflow: hidden;
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}

.agent-index {
  min-width: 0;
  padding: var(--space-5);
  background: var(--color-surface-muted);
  border-right: 1px solid var(--color-border);
}

.index-head,
.detail-topline,
.detail-identity,
.detail-primary-action,
.secondary-actions {
  display: flex;
  align-items: center;
}

.index-head {
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-4);
}

.index-head h2 {
  color: var(--color-text);
  font-size: var(--font-size-md);
}

.index-tools .search-box {
  max-width: none;
  min-width: 0;
  height: 36px;
  background: var(--color-surface);
  border-color: var(--color-border-strong);
  border-radius: var(--radius-sm);
}

.index-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: var(--space-4);
}

.index-item {
  display: grid;
  grid-template-columns: 26px 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 58px;
  padding: var(--space-2) var(--space-2);
  color: var(--color-text);
  text-align: left;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

/* hover 暖底（brand-soft 双主题暖色），选中保持 surface 底 + 左橙条 */
.index-item:hover {
  background: var(--color-brand-soft);
  border-color: transparent;
}

.index-item.is-selected {
  background: var(--color-surface);
  border-color: var(--color-border-strong);
  box-shadow: inset 3px 0 0 var(--color-brand);
}

.index-item.is-disabled {
  opacity: 0.58;
}

.index-number,
.index-skills,
.index-copy span,
.detail-id,
.detail-status,
.muted-copy {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.index-number {
  font-variant-numeric: tabular-nums;
}

.index-avatar {
  display: inline-flex;
  width: 32px;
  height: 32px;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--color-brand-soft);
  border-radius: var(--radius-sm);
}

.index-avatar .agent-avatar {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  background: transparent;
}

.index-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.index-copy strong {
  overflow: hidden;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.index-skills {
  white-space: nowrap;
}

.agent-detail {
  min-width: 0;
  padding: clamp(24px, 5vw, 56px);
  background: var(--color-surface);
  animation: detail-arrive 180ms ease both;
}

@keyframes detail-arrive {
  from { opacity: 0.7; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.detail-topline {
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.detail-topline .section-kicker {
  margin: 0;
}

/* 品牌几何点缀：空心圆环（纯装饰） */
.geo-ring {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  margin-right: var(--space-2);
  border: 2px solid var(--color-brand-200);
  border-radius: 50%;
}

.detail-identity {
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-5) 0 clamp(28px, 5vw, 48px);
  border-bottom: 1px solid var(--color-border);
}

.detail-avatar {
  display: inline-flex;
  width: 72px;
  height: 72px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: var(--color-brand-soft);
  border-radius: var(--radius-sm);
}

.detail-avatar .agent-avatar {
  width: 72px;
  height: 72px;
  border-radius: var(--radius-sm);
}

.detail-title {
  min-width: 0;
  flex: 1;
}

.detail-title h2 {
  color: var(--color-text);
  font-size: clamp(24px, 4vw, 34px);
  font-weight: var(--font-weight-display);
  letter-spacing: -0.035em;
}

/* 能力/技能 chip：信息语义走 info 蓝（贴纸感软底），与行动橙不混用 */
.detail-tags .chip.chip-linked {
  background: var(--color-info-soft);
  color: var(--color-info-500);
}

.detail-status {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--space-2);
}

.status-dot {
  width: 7px;
  height: 7px;
  background: var(--color-success);
  border-radius: 50%;
}

.status-dot.is-off { background: var(--color-text-muted); }

.detail-primary-action {
  align-items: center;
  align-self: flex-start;
  gap: var(--space-2);
  margin-left: auto;
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(180px, 0.65fr);
  gap: 0 var(--space-5);
}

.detail-section {
  min-width: 0;
  padding: var(--space-5) 0;
  border-bottom: 1px solid var(--color-border);
}

.detail-section .section-kicker {
  margin-bottom: var(--space-3);
}

.detail-summary p,
.detail-source p {
  max-width: 62ch;
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  line-height: 1.75;
}

.detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.secondary-actions {
  flex-wrap: wrap;
  gap: var(--space-2);
}

@media (max-width: 767px) {
  .agent-workbench {
    display: block;
    min-height: 0;
    overflow: visible;
  }

  .agent-index {
    border-right: 0;
    border-bottom: 1px solid var(--color-border);
  }

  .index-list {
    max-width: 100%;
    flex-direction: row;
    overflow-x: auto;
    padding-bottom: 4px;
  }

  .index-item {
    flex: 0 0 min(240px, 72vw);
  }

  .agent-detail {
    padding: var(--space-5);
  }

  .detail-identity {
    flex-wrap: wrap;
  }

  .detail-primary-action {
    width: 100%;
    margin-left: 0;
  }

  .detail-primary-action .btn-primary {
    flex: 1;
  }

  .detail-grid {
    display: block;
  }

  .detail-section {
    padding: var(--space-4) 0;
  }
}

/* —— 新建 / 编辑模态 —— */
/* 模态与表单字段样式已上提为 base.css 全局 .modal-* / .field-* 系列 */
/* 图标预览在弹窗内保持 40px（不随行内 .agent-avatar 的 48px） */
.icon-preview {
  width: 40px;
  height: 40px;
  font-size: var(--font-size-lg);
}

/* 默认模型绑定：配置与模型两个下拉纵向排列 */
.model-binding {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
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

/* —— 工具能力编辑器 —— */
.tool-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.tool-option {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.tool-option:hover {
  border-color: var(--color-border-strong);
}

.tool-option.is-selected {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

/* 停用技能置灰不可选 */
.tool-option.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tool-option-input {
  margin-top: 3px;
  accent-color: var(--color-brand);
}

.tool-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.tool-option-title {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.tool-confirm-badge {
  font-family: inherit;
}

.tool-reset-default {
  align-self: flex-start;
  font-size: var(--font-size-xs);
}

.tool-option-desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.tool-picker-readonly {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}

.tool-readonly-tag {
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}
</style>
