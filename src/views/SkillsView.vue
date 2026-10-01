<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import { useAgentsStore } from '@/stores/agents'
import { DEFAULT_SKILL_ICON, useSkillsStore, type SkillView } from '@/stores/skills'
import {
  createZip,
  isValidScriptFilename,
  parseSkillPackageMarkdown,
  serializeSkillPackageMarkdown,
  toZipScriptPath,
  type SkillScript,
} from '@/lib/skill-package'
import { parseSkillPackageZip } from '@/lib/skillhub'
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
import SkillMarketModal from '@/components/SkillMarketModal.vue'

const router = useRouter()
const skillsStore = useSkillsStore()
const agentsStore = useAgentsStore()

/* —— 搜索与过滤 —— */

const keyword = ref('')

/** 按名称 / 描述 / 标签模糊过滤合并清单 */
const filteredSkills = computed<SkillView[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return skillsStore.skills
  return skillsStore.skills.filter((skill) =>
    `${skill.name} ${skill.description} ${skill.tags.join(' ')}`.toLowerCase().includes(kw),
  )
})

/* —— 智能体关联反查 —— */

/** 技能 id → 关联了该技能的智能体摘要列表（取合并视图当前生效名称；一个技能可被多个智能体关联） */
const skillLinkedAgents = computed<Map<string, { id: string; name: string }[]>>(() => {
  const map = new Map<string, { id: string; name: string }[]>()
  for (const agent of agentsStore.agents) {
    if (!agent.linkedSkillIds.length) continue
    for (const skillId of agent.linkedSkillIds) {
      const list = map.get(skillId) ?? []
      list.push({ id: agent.id, name: agent.name })
      map.set(skillId, list)
    }
  }
  return map
})

/** 查询某技能被哪些智能体关联（用于卡片展示「随 {智能体名}」标注；未关联返回空数组） */
function linkedAgents(skillId: string): { id: string; name: string }[] {
  return skillLinkedAgents.value.get(skillId) ?? []
}

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
  if (target?.closest('.skill-more')) return
  closeMenu()
}

/** Esc 关闭：优先关模态，其次关菜单 */
function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (marketOpen.value) {
    marketOpen.value = false
  } else if (modalOpen.value) {
    closeModal()
  } else if (openMenuId.value) {
    closeMenu()
  }
}

/* —— 技能市场弹窗 —— */

const marketOpen = ref(false)

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onDocumentKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onDocumentKeydown)
  if (importMessageTimer) clearTimeout(importMessageTimer)
})

/* —— 卡片操作 —— */

/** 跳转 AI 对话并携带 skill 查询参数，把模板追加进输入框 */
function useSkill(skill: SkillView): void {
  void router.push({ path: '/chat', query: { skill: skill.id } })
}

/** 停用 / 启用（技能没有默认兜底，所有技能都可切换） */
function toggleSkillDisabled(skill: SkillView): void {
  closeMenu()
  skillsStore.toggleDisabled(skill.id)
}

/** 复制为自定义副本 */
function duplicateSkill(skill: SkillView): void {
  closeMenu()
  skillsStore.duplicateSkill(skill.id)
}

/** 删除自定义技能（二次确认） */
function removeSkill(skill: SkillView): void {
  closeMenu()
  if (!window.confirm(`确定删除技能「${skill.name}」吗？删除后不可恢复。`)) return
  skillsStore.removeCustomSkill(skill.id)
}

/** 移除内置技能（二次确认；从技能中心与对话浮层消失，可随时恢复） */
function removeBuiltinSkill(skill: SkillView): void {
  closeMenu()
  const message = `确定移除内置技能「${skill.name}」吗？移除后可随时点击页面上的「恢复已移除的内置技能」还原。`
  if (!window.confirm(message)) return
  skillsStore.removeBuiltinSkill(skill.id)
}

/** 恢复全部已移除的内置技能（二次确认） */
function restoreRemovedSkills(): void {
  const count = skillsStore.removedCount
  if (count <= 0) return
  if (!window.confirm(`确定恢复全部已移除的 ${count} 个内置技能吗？`)) return
  skillsStore.restoreRemovedSkills()
}

/* —— 新建 / 编辑模态表单 —— */

interface SkillFormState {
  name: string
  description: string
  template: string
  icon: string
  /** 标签以逗号分隔的原文，提交时再解析 */
  tags: string
  /** 触发词以逗号分隔的原文，提交时再解析（命中后按需注入正文） */
  triggers: string
  /** 技能脚本清单（scripts/ 目录文件） */
  scripts: SkillScript[]
}

/** 空表单（图标留空，展示时回退默认 emoji） */
function createEmptyForm(): SkillFormState {
  return { name: '', description: '', template: '', icon: '', tags: '', triggers: '', scripts: [] }
}

const modalOpen = ref(false)
/** 正在编辑的技能 id；null 表示新建 */
const editingId = ref<string | null>(null)
/** 正在编辑的技能快照（用于区分内置/自定义与是否已修改）；null 表示新建 */
const editingSkill = ref<SkillView | null>(null)
const form = ref<SkillFormState>(createEmptyForm())
const formErrors = ref({ name: '', description: '', template: '' })

/** 图标实时预览：优先图标字段，回退默认 emoji */
const iconPreview = computed(() => form.value.icon.trim() || DEFAULT_SKILL_ICON)

/** 标签占位回显用分隔符 */
const TAGS_SEPARATOR = '，'

function openCreateModal(): void {
  editingId.value = null
  editingSkill.value = null
  form.value = createEmptyForm()
  formErrors.value = { name: '', description: '', template: '' }
  modalOpen.value = true
}

/** 打开编辑弹窗（内置与自定义均可编辑；表单回填当前生效值，内置有覆盖时即覆盖值） */
function openEditModal(skill: SkillView): void {
  editingId.value = skill.id
  editingSkill.value = skill
  form.value = {
    name: skill.name,
    description: skill.description,
    template: skill.template,
    icon: skill.icon,
    tags: skill.tags.join(TAGS_SEPARATOR),
    triggers: skill.triggers.join(TAGS_SEPARATOR),
    scripts: skill.scripts.map((script) => ({ ...script })),
  }
  formErrors.value = { name: '', description: '', template: '' }
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
  const template = form.value.template.trim()
  formErrors.value = {
    name: name ? '' : '请输入名称',
    description: description ? '' : '请输入描述',
    template: template ? '' : '请输入正文指令',
  }
  // 脚本校验：文件名非法或重名时阻止提交（错误信息复用模板行提示位）
  const names = new Set<string>()
  for (const script of form.value.scripts) {
    if (!isValidScriptFilename(script.filename)) {
      formErrors.value.template = `脚本文件名不合法：${script.filename || '（空）'}`
      return
    }
    const normalized = script.filename.trim().replace(/^scripts\//, '')
    if (names.has(normalized)) {
      formErrors.value.template = `脚本文件名重复：${normalized}`
      return
    }
    names.add(normalized)
  }
  if (!name || !description || !template) return

  const payload = {
    name,
    description,
    template,
    icon: form.value.icon.trim(),
    tags: parseTags(form.value.tags),
    triggers: parseTags(form.value.triggers).length > 0 ? parseTags(form.value.triggers) : parseTags(form.value.tags),
    scripts: form.value.scripts.map((script) => ({
      filename: script.filename.trim().replace(/^scripts\//, ''),
      content: script.content,
    })),
  }
  if (editingId.value) {
    // 内置走覆盖层写入，自定义直接改列表；两分支共用同一套表单校验
    if (editingSkill.value?.builtin) {
      skillsStore.updateBuiltinSkill(editingId.value, payload)
    } else {
      skillsStore.updateCustomSkill(editingId.value, payload)
    }
  } else {
    skillsStore.addCustomSkill(payload)
  }
  modalOpen.value = false
}

/* —— 脚本文件管理（技能包 scripts/ 目录） —— */

/** 新增一个空脚本（默认文件名自动编号避免重名） */
function addScript(): void {
  const existing = new Set(form.value.scripts.map((script) => script.filename))
  let index = 1
  while (existing.has(`script_${index}.py`)) index += 1
  form.value.scripts = [...form.value.scripts, { filename: `script_${index}.py`, content: '' }]
}

/** 删除指定脚本 */
function removeScript(index: number): void {
  form.value.scripts = form.value.scripts.filter((_, i) => i !== index)
}

/* —— 导入（技能包 ZIP / SKILL.md / 旧版 JSON 模板） —— */

const importInputEl = ref<HTMLInputElement | null>(null)
/** 导入结果提示（成功 / 失败文案，8 秒后自动清除） */
const importMessage = ref('')
let importMessageTimer: ReturnType<typeof setTimeout> | null = null

function showImportMessage(text: string): void {
  importMessage.value = text
  if (importMessageTimer) clearTimeout(importMessageTimer)
  importMessageTimer = setTimeout(() => {
    importMessage.value = ''
  }, 8000)
}

function openImportDialog(): void {
  importInputEl.value?.click()
}

async function handleImportFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const lower = file.name.toLowerCase()
  try {
    if (lower.endsWith('.zip')) {
      // 新格式：SKILL.md + scripts/；旧格式 ZIP（无 triggers/scripts）同样兼容
      const parsed = await parseSkillPackageZip(file)
      skillsStore.addCustomSkill({
        name: parsed.name,
        description: parsed.description,
        template: parsed.body,
        icon: '📦',
        tags: ['导入'],
        triggers: parsed.triggers,
        scripts: parsed.scripts,
        source: 'import',
      })
      showImportMessage(
        `已导入技能「${parsed.name}」（${parsed.scripts.length} 个脚本）`,
      )
    } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      // 单文件 SKILL.md
      const parsed = parseSkillPackageMarkdown(await file.text(), file.name.replace(/\.(md|markdown)$/i, ''))
      skillsStore.addCustomSkill({
        name: parsed.name,
        description: parsed.description,
        template: parsed.body,
        icon: parsed.icon || '📝',
        tags: parsed.tags.length > 0 ? parsed.tags : ['导入'],
        triggers: parsed.triggers,
        scripts: [],
        source: 'import',
      })
      showImportMessage(`已导入技能「${parsed.name}」`)
    } else if (lower.endsWith('.json')) {
      // 旧版纯提示词模板 JSON（{name, description, template, ...}）→ 转为技能包结构
      const raw: unknown = JSON.parse(await file.text())
      if (typeof raw !== 'object' || raw === null) throw new Error('JSON 内容不是对象')
      const record = raw as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name.trim() : ''
      const template = typeof record.template === 'string' ? record.template : ''
      if (!name || !template) throw new Error('JSON 缺少 name 或 template 字段（旧版技能模板格式）')
      const description = typeof record.description === 'string' ? record.description : '从 JSON 导入的技能'
      const tags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === 'string') : []
      skillsStore.addCustomSkill({
        name,
        description,
        template,
        icon: typeof record.icon === 'string' && record.icon.trim() ? record.icon : '📝',
        tags: tags.length > 0 ? tags : ['导入'],
        triggers: tags,
        scripts: [],
        source: 'import',
      })
      showImportMessage(`已导入技能「${name}」（旧版模板已转换为技能包）`)
    } else {
      throw new Error('不支持的文件类型：请选择技能包 ZIP、SKILL.md 或旧版 JSON 模板文件')
    }
  } catch (error) {
    showImportMessage(`导入失败：${error instanceof Error ? error.message : '未知错误'}`)
  }
}

/* —— 导出（SKILL.md 风格 ZIP：SKILL.md + scripts/） —— */

/** 触发词/标签作为文件名的一部分不安全，导出文件名只保留安全字符 */
function downloadSkillZip(skill: SkillView): void {
  const markdown = serializeSkillPackageMarkdown({
    name: skill.name,
    description: skill.description,
    triggers: skill.triggers,
    body: skill.template,
    icon: skill.icon,
    tags: skill.tags,
  })
  const entries = [
    { name: 'SKILL.md', content: markdown },
    ...skill.scripts.map((script) => ({
      name: toZipScriptPath(script.filename),
      content: script.content,
    })),
  ]
  const bytes = createZip(entries)
  const blob = new Blob([bytes.slice().buffer], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${skill.name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'skill'}.zip`
  anchor.click()
  URL.revokeObjectURL(url)
  closeMenu()
}

/** 恢复内置技能的代码默认（清空覆盖层，二次确认后关闭弹窗） */
function resetBuiltinFromModal(): void {
  const skill = editingSkill.value
  if (!skill?.builtin) return
  if (!window.confirm('确定恢复该内置技能的默认设置吗？当前修改将被清除。')) return
  skillsStore.resetBuiltinSkill(skill.id)
  modalOpen.value = false
}
</script>

<template>
  <div class="page">
    <header class="page-head skills-head">
      <div>
        <h1>技能中心</h1>
        <p>管理内置与自定义提示词模板技能，统一用于 AI 对话</p>
      </div>
      <div class="skills-head-actions">
        <button class="btn btn-ghost" type="button" @click="openImportDialog">
          <AppIcon name="plus" />
          导入
        </button>
        <button class="btn btn-ghost" type="button" @click="marketOpen = true">
          <AppIcon name="compass" />
          技能市场
        </button>
        <button class="btn btn-primary" type="button" @click="openCreateModal">
          <AppIcon name="plus" />
          新建技能
        </button>
      </div>
    </header>
    <input
      ref="importInputEl"
      class="import-input"
      type="file"
      accept=".zip,.md,.markdown,.json"
      @change="handleImportFile"
    />
    <p v-if="importMessage" class="import-message" :class="{ 'is-error': importMessage.startsWith('导入失败') }">
      {{ importMessage }}
    </p>

    <div class="skills-toolbar">
      <div class="search-box">
        <AppIcon name="search" />
        <input
          v-model="keyword"
          class="search-input"
          type="text"
          placeholder="搜索名称、描述或标签…"
        />
      </div>
      <div class="skills-toolbar-meta">
        <span class="skills-count">共 {{ filteredSkills.length }} 个技能</span>
        <button
          v-if="skillsStore.removedCount > 0"
          class="restore-link"
          type="button"
          @click="restoreRemovedSkills"
        >
          已移除 {{ skillsStore.removedCount }} 个内置技能 · 恢复
        </button>
      </div>
    </div>

    <div v-if="filteredSkills.length" class="skills-grid">
      <article
        v-for="skill in filteredSkills"
        :key="skill.id"
        class="skill-card"
        :class="{ 'is-disabled': skill.disabled }"
      >
        <div class="skill-card-head">
          <span class="skill-avatar" aria-hidden="true">{{
            skill.icon || DEFAULT_SKILL_ICON
          }}</span>
          <div class="skill-title-group">
            <h2 class="skill-name">{{ skill.name }}</h2>
            <div class="skill-meta">
              <span v-if="skill.builtin" class="chip chip-builtin">内置</span>
              <span v-if="skill.customized" class="chip chip-modified">已修改</span>
              <span
                v-for="agent in linkedAgents(skill.id)"
                :key="`linked-${agent.id}`"
                class="chip chip-linked-agent"
                :title="`该技能随智能体「${agent.name}」对话时自动装载`"
              >
                随 {{ agent.name }}
              </span>
              <span class="chip" :class="skill.disabled ? 'chip-off' : 'chip-on'">
                {{ skill.disabled ? '停用' : '启用' }}
              </span>
            </div>
          </div>
        </div>

        <p class="skill-desc">{{ skill.description }}</p>
        <p class="skill-template">{{ skill.template }}</p>
        <div v-if="skill.triggers.length" class="skill-tags">
          <span class="chip chip-trigger-label">触发</span>
          <span v-for="trigger in skill.triggers" :key="`t-${trigger}`" class="chip chip-trigger">
            {{ trigger }}
          </span>
        </div>
        <div v-if="skill.tags.length" class="skill-tags">
          <span v-for="tag in skill.tags" :key="tag" class="chip chip-tag">{{ tag }}</span>
        </div>
        <p v-if="skill.scripts.length" class="skill-scripts-note">
          附带 {{ skill.scripts.length }} 个脚本：{{
            skill.scripts.map((script) => script.filename).join('、')
          }}
        </p>

        <div class="skill-actions">
          <button
            class="btn btn-primary btn-sm"
            type="button"
            :disabled="skill.disabled"
            title="跳转到 AI 对话并把模板追加进输入框"
            @click="useSkill(skill)"
          >
            <AppIcon name="chat" />
            使用
          </button>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            title="编辑技能"
            @click="openEditModal(skill)"
          >
            <AppIcon name="edit" />
            编辑
          </button>
          <div class="skill-more">
            <button
              class="icon-button"
              type="button"
              aria-label="更多操作"
              @click.stop="toggleMenu(skill.id)"
            >
              <AppIcon name="more" />
            </button>
            <div v-if="openMenuId === skill.id" class="skill-menu">
              <button class="menu-item" type="button" @click="toggleSkillDisabled(skill)">
                {{ skill.disabled ? '启用' : '停用' }}
              </button>
              <button class="menu-item" type="button" @click="duplicateSkill(skill)">复制</button>
              <button class="menu-item" type="button" @click="downloadSkillZip(skill)">
                导出 ZIP
              </button>
              <button
                v-if="!skill.builtin"
                class="menu-item menu-danger"
                type="button"
                @click="removeSkill(skill)"
              >
                删除
              </button>
              <button
                v-else
                class="menu-item menu-danger"
                type="button"
                @click="removeBuiltinSkill(skill)"
              >
                移除
              </button>
            </div>
          </div>
        </div>
      </article>
    </div>

    <div v-else class="card">
      <EmptyState title="未找到匹配的技能" description="换个关键词试试，或新建一个自定义技能。">
        <button class="btn btn-primary" type="button" @click="openCreateModal">
          <AppIcon name="plus" />
          新建技能
        </button>
      </EmptyState>
    </div>

    <!-- 新建 / 编辑模态 -->
    <div v-if="modalOpen" class="modal-mask" @click.self="closeModal">
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        :aria-label="editingId ? '编辑技能' : '新建技能'"
      >
        <header class="modal-head">
          <h2>{{ editingId ? '编辑技能' : '新建技能' }}</h2>
          <button class="icon-button" type="button" aria-label="关闭" @click="closeModal">
            <AppIcon name="close" />
          </button>
        </header>

        <form class="modal-form" @submit.prevent="submitForm">
          <label class="field">
            <span class="field-label"
              >名称<span class="field-required" aria-hidden="true">*</span></span
            >
            <input
              v-model="form.name"
              class="field-input"
              type="text"
              placeholder="例如：周报生成器"
            />
            <span v-if="formErrors.name" class="field-error">{{ formErrors.name }}</span>
          </label>

          <label class="field">
            <span class="field-label"
              >描述<span class="field-required" aria-hidden="true">*</span></span
            >
            <input
              v-model="form.description"
              class="field-input"
              type="text"
              placeholder="一句话说明用途，例如：审查代码改动并给出改进建议"
            />
            <span v-if="formErrors.description" class="field-error">{{
              formErrors.description
            }}</span>
          </label>

          <label class="field">
            <span class="field-label"
              >正文指令（SKILL.md）<span class="field-required" aria-hidden="true">*</span></span
            >
            <textarea
              v-model="form.template"
              class="field-input field-textarea"
              rows="7"
              placeholder="技能正文指令（Markdown）：命中或激活该技能后注入给模型的完整方法论与执行步骤"
            ></textarea>
            <span v-if="formErrors.template" class="field-error">{{ formErrors.template }}</span>
          </label>

          <label class="field">
            <span class="field-label">触发词</span>
            <input
              v-model="form.triggers"
              class="field-input"
              type="text"
              placeholder="多个触发词用逗号分隔；用户消息命中后自动注入本技能。留空时回退为标签"
            />
          </label>

          <div class="field">
            <span class="field-label">脚本文件（scripts/）</span>
            <p class="field-hint">
              脚本随技能激活后告知模型，由模型先经 fs_write 落盘到工作区、再用 shell_exec 执行。
            </p>
            <div
              v-for="(script, index) in form.scripts"
              :key="`script-${index}`"
              class="script-item"
            >
              <div class="script-item-head">
                <input
                  v-model="script.filename"
                  class="field-input script-filename"
                  type="text"
                  placeholder="文件名，如 run.py"
                />
                <button
                  class="btn btn-ghost btn-sm"
                  type="button"
                  @click="removeScript(index)"
                >
                  删除
                </button>
              </div>
              <textarea
                v-model="script.content"
                class="field-input field-textarea script-content"
                rows="4"
                placeholder="脚本内容"
              ></textarea>
            </div>
            <button class="btn btn-ghost btn-sm" type="button" @click="addScript">
              <AppIcon name="plus" />
              添加脚本
            </button>
          </div>

          <div class="field">
            <span class="field-label">图标（emoji）</span>
            <div class="icon-field">
              <span class="skill-avatar icon-preview" aria-hidden="true">{{ iconPreview }}</span>
              <input
                v-model="form.icon"
                class="field-input"
                type="text"
                placeholder="默认 ⚡，可留空"
              />
            </div>
          </div>

          <label class="field">
            <span class="field-label">标签</span>
            <input
              v-model="form.tags"
              class="field-input"
              type="text"
              placeholder="多个标签用逗号分隔，例如：写作, 润色"
            />
          </label>

          <footer class="modal-foot">
            <button
              v-if="editingSkill?.customized"
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
    <!-- 技能市场：内置精选索引 + GitHub 在线搜索，一键安装 -->
    <SkillMarketModal v-if="marketOpen" @close="marketOpen = false" />
  </div>
</template>

<style scoped>
/* —— 页面头部 —— */
.skills-head {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

/* —— 工具行：搜索 + 计数 —— */
.skills-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
}

/* 搜索框样式已上提为 base.css 全局 .search-box / .search-input */
.skills-toolbar-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  white-space: nowrap;
}

.skills-count {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

/* 次要文字按钮：恢复已移除的内置技能（hover 变主色，弱化展示不抢视觉） */
.restore-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  transition: color var(--transition-fast);
}

.restore-link:hover {
  color: var(--color-brand);
}

/* 页头按钮组：导入 + 新建 */
.skills-head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

/* 隐藏的导入文件选择框 */
.import-input {
  display: none;
}

/* 导入结果提示条 */
.import-message {
  margin: 0 0 var(--space-4);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-success-soft);
  color: var(--color-success);
  font-size: var(--font-size-sm);
}

.import-message.is-error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* 触发词 chips */
.chip-trigger-label {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}

.chip-trigger {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

/* 附带脚本清单说明 */
.skill-scripts-note {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 表单辅助说明 */
.field-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

/* 脚本编辑条目 */
.script-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
}

.script-item-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.script-filename {
  flex: 1;
  font-family: monospace;
}

.script-content {
  font-family: monospace;
  font-size: var(--font-size-sm);
}

/* —— 卡片网格 —— */
.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-5);
}

.skill-card {
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
    box-shadow var(--transition-fast),
    transform var(--transition-fast);
}

/* 贴纸悬浮感：hover 边框加深 + 轻微上浮 */
.skill-card:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}

/* 停用的卡片整体降饱和 */
.skill-card.is-disabled {
  opacity: 0.62;
  filter: saturate(0.55);
}

.skill-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.skill-avatar {
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

.skill-title-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.skill-name {
  font-size: var(--font-size-lg);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.skill-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-template {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

/* 徽章 chips 样式已上提为 base.css 全局 .chip / .chip-* 系列 */

/* —— 卡片操作 —— */
.skill-actions {
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

.skill-more {
  position: relative;
  margin-left: auto;
}

.skill-menu {
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

/* —— 新建 / 编辑模态 —— */
/* 模态与表单字段样式已上提为 base.css 全局 .modal-* / .field-* 系列 */
/* 图标预览在弹窗内保持 40px（不随卡片 .skill-avatar 的 44px） */
.icon-preview {
  width: 40px;
  height: 40px;
  font-size: var(--font-size-lg);
}

/* —— 窄屏适配 —— */
@media (max-width: 640px) {
  .skills-head {
    flex-direction: column;
    align-items: stretch;
  }

  .skills-head .btn {
    width: 100%;
  }

  .skills-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .search-box {
    max-width: none;
  }

  .skills-toolbar-meta {
    justify-content: space-between;
    white-space: normal;
  }

  .modal-mask {
    padding: var(--space-3);
  }
}
</style>
