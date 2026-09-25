import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { BUILTIN_SKILLS } from '@/lib/skills'

/** 自定义技能在 localStorage 中的持久化 key */
const CUSTOM_SKILLS_KEY = 'mr-huang-agent:custom-skills'
/** 停用的技能 id 列表在 localStorage 中的持久化 key */
const DISABLED_SKILLS_KEY = 'mr-huang-agent:disabled-skills'
/** 内置技能覆盖快照（id → 编辑内容）在 localStorage 中的持久化 key */
const BUILTIN_OVERRIDES_KEY = 'mr-huang-agent:builtin-skill-overrides'

/** 图标缺省时的默认 emoji */
export const DEFAULT_SKILL_ICON = '⚡'

/** 自定义技能的持久化数据结构 */
export interface CustomSkillData {
  id: string
  name: string
  description: string
  template: string
  icon: string
  tags: string[]
}

/** 新建/编辑自定义技能时的入参（id 由 store 生成或按原 id 保留） */
export type CustomSkillInput = Omit<CustomSkillData, 'id'>

/** 内置技能覆盖快照的持久化结构（编辑内置时保存的完整字段） */
export interface BuiltinSkillOverride {
  name: string
  description: string
  template: string
  icon: string
  tags: string[]
}

/** 合并视图清单条目：内置与自定义统一结构 */
export interface SkillView {
  id: string
  name: string
  description: string
  template: string
  icon: string
  tags: string[]
  /** 是否内置技能（内置不可删除，可通过覆盖层编辑展示字段） */
  builtin: boolean
  /** 是否已被用户修改（内置且存在覆盖快照时 true；自定义恒为 false） */
  customized: boolean
  /** 是否已停用（停用后不出现在 AI 对话的技能浮层中） */
  disabled: boolean
}

/** 校验 localStorage 中读出的条目是否为合法的自定义技能 */
function isValidCustomSkill(value: unknown): value is CustomSkillData {
  if (typeof value !== 'object' || value === null) return false
  const skill = value as Record<string, unknown>
  return (
    typeof skill.id === 'string' &&
    typeof skill.name === 'string' &&
    typeof skill.description === 'string' &&
    typeof skill.template === 'string' &&
    typeof skill.icon === 'string' &&
    Array.isArray(skill.tags) &&
    skill.tags.every((tag) => typeof tag === 'string')
  )
}

/** 读取自定义技能列表；localStorage 不可用或数据损坏时回退空数组 */
function readCustomSkills(): CustomSkillData[] {
  try {
    const raw = localStorage.getItem(CUSTOM_SKILLS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidCustomSkill).map((skill) => ({ ...skill, tags: [...skill.tags] }))
  } catch {
    // 数据损坏（非法 JSON 等）时回退空列表
    return []
  }
}

/** 读取停用的技能 id 列表；异常时回退空数组 */
function readDisabledIds(): string[] {
  try {
    const raw = localStorage.getItem(DISABLED_SKILLS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** 校验 localStorage 中读出的条目是否为合法的内置覆盖快照 */
function isValidBuiltinOverride(value: unknown): value is BuiltinSkillOverride {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Record<string, unknown>
  return (
    typeof snapshot.name === 'string' &&
    typeof snapshot.description === 'string' &&
    typeof snapshot.template === 'string' &&
    typeof snapshot.icon === 'string' &&
    Array.isArray(snapshot.tags) &&
    snapshot.tags.every((tag) => typeof tag === 'string')
  )
}

/** 读取内置覆盖快照表；localStorage 不可用或数据损坏时回退空对象（仅保留内置 id 的有效条目） */
function readBuiltinOverrides(): Record<string, BuiltinSkillOverride> {
  try {
    const raw = localStorage.getItem(BUILTIN_OVERRIDES_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const overrides: Record<string, BuiltinSkillOverride> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!BUILTIN_SKILLS.some((skill) => skill.id === id)) continue
      if (!isValidBuiltinOverride(value)) continue
      overrides[id] = { ...value, tags: [...value.tags] }
    }
    return overrides
  } catch {
    // 数据损坏（非法 JSON 等）时回退空表
    return {}
  }
}

export const useSkillsStore = defineStore('skills', () => {
  /** 自定义技能列表（持久化到 localStorage） */
  const customSkills = ref<CustomSkillData[]>(readCustomSkills())

  /** 停用的技能 id 列表（持久化到 localStorage） */
  const disabledIds = ref<string[]>(readDisabledIds())

  /** 内置技能覆盖快照表：id → 编辑内容（持久化到 localStorage） */
  const builtinOverrides = ref<Record<string, BuiltinSkillOverride>>(readBuiltinOverrides())

  /** 合并视图清单：内置在前、自定义在后；内置存在覆盖快照时用快照整体覆盖展示字段 */
  const skills = computed<SkillView[]>(() => [
    ...BUILTIN_SKILLS.map((skill) => {
      const override = builtinOverrides.value[skill.id]
      return {
        id: skill.id,
        name: override?.name ?? skill.name,
        description: override?.description ?? skill.description,
        template: override?.template ?? skill.template,
        icon: override?.icon ?? skill.icon ?? DEFAULT_SKILL_ICON,
        tags: override ? [...override.tags] : [...(skill.tags ?? [])],
        builtin: true,
        customized: Boolean(override),
        disabled: disabledIds.value.includes(skill.id),
      }
    }),
    ...customSkills.value.map((skill) => ({
      ...skill,
      builtin: false,
      customized: false,
      disabled: disabledIds.value.includes(skill.id),
    })),
  ])

  /** 过滤掉停用后的清单（AI 对话浮层使用） */
  const enabledSkills = computed<SkillView[]>(() => skills.value.filter((skill) => !skill.disabled))

  /** 自定义技能数量 */
  const customCount = computed(() => customSkills.value.length)

  /** 在合并清单中按 id 查找；找不到返回 undefined（调用方自行兜底） */
  function findSkill(id: string): SkillView | undefined {
    return skills.value.find((skill) => skill.id === id)
  }

  /** 新建自定义技能，返回生成的 id（新建即为启用态） */
  function addCustomSkill(data: CustomSkillInput): string {
    const id = crypto.randomUUID()
    customSkills.value = [
      ...customSkills.value,
      { ...data, icon: data.icon.trim() || DEFAULT_SKILL_ICON, tags: [...data.tags], id },
    ]
    return id
  }

  /** 编辑自定义技能；id 不存在时返回 false */
  function updateCustomSkill(id: string, data: CustomSkillInput): boolean {
    const exists = customSkills.value.some((skill) => skill.id === id)
    if (!exists) return false
    customSkills.value = customSkills.value.map((skill) =>
      skill.id === id
        ? { ...data, icon: data.icon.trim() || DEFAULT_SKILL_ICON, tags: [...data.tags], id }
        : skill,
    )
    return true
  }

  /** 编辑内置技能：写入/更新覆盖快照（id 非内置时忽略并返回 false） */
  function updateBuiltinSkill(id: string, data: CustomSkillInput): boolean {
    const isBuiltin = BUILTIN_SKILLS.some((skill) => skill.id === id)
    if (!isBuiltin) return false
    builtinOverrides.value = {
      ...builtinOverrides.value,
      [id]: { ...data, icon: data.icon.trim() || DEFAULT_SKILL_ICON, tags: [...data.tags] },
    }
    return true
  }

  /** 恢复内置技能的代码默认：删除该 id 的覆盖快照 */
  function resetBuiltinSkill(id: string): void {
    if (!builtinOverrides.value[id]) return
    const next = { ...builtinOverrides.value }
    delete next[id]
    builtinOverrides.value = next
  }

  /** 删除自定义技能（内置不可删除），并同步清理停用列表中的残留 id */
  function removeCustomSkill(id: string): void {
    customSkills.value = customSkills.value.filter((skill) => skill.id !== id)
    disabledIds.value = disabledIds.value.filter((disabledId) => disabledId !== id)
  }

  /** 复制任意技能（含内置）为自定义副本，名称加「副本」后缀，返回新 id；源不存在返回 null */
  function duplicateSkill(id: string): string | null {
    const source = findSkill(id)
    if (!source) return null
    const newId = crypto.randomUUID()
    customSkills.value = [
      ...customSkills.value,
      {
        id: newId,
        name: `${source.name} 副本`,
        description: source.description,
        template: source.template,
        icon: source.icon,
        tags: [...source.tags],
      },
    ]
    return newId
  }

  /** 切换停用/启用（技能没有默认兜底，所有技能都可停用/启用） */
  function toggleDisabled(id: string): void {
    disabledIds.value = disabledIds.value.includes(id)
      ? disabledIds.value.filter((item) => item !== id)
      : [...disabledIds.value, id]
  }

  // 三份状态变化 → 各自持久化到 localStorage（失败时静默降级，仅当前会话生效）
  watch(customSkills, (next) => {
    try {
      localStorage.setItem(CUSTOM_SKILLS_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  watch(disabledIds, (next) => {
    try {
      localStorage.setItem(DISABLED_SKILLS_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  watch(builtinOverrides, (next) => {
    try {
      localStorage.setItem(BUILTIN_OVERRIDES_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  return {
    skills,
    enabledSkills,
    customCount,
    findSkill,
    addCustomSkill,
    updateCustomSkill,
    updateBuiltinSkill,
    resetBuiltinSkill,
    removeCustomSkill,
    duplicateSkill,
    toggleDisabled,
  }
})
