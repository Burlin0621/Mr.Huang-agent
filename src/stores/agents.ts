import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { BUILTIN_AGENTS, DEFAULT_AGENT_ID } from '@/lib/agents'

/** 自定义智能体在 localStorage 中的持久化 key */
const CUSTOM_AGENTS_KEY = 'mr-huang-agent:custom-agents'
/** 停用的智能体 id 列表在 localStorage 中的持久化 key */
const DISABLED_AGENTS_KEY = 'mr-huang-agent:disabled-agents'
/** 内置智能体覆盖快照（id → 编辑内容）在 localStorage 中的持久化 key */
const BUILTIN_OVERRIDES_KEY = 'mr-huang-agent:builtin-overrides'

/** 图标缺省时的默认 emoji */
export const DEFAULT_AGENT_ICON = '🤖'

/** 自定义智能体的持久化数据结构 */
export interface CustomAgentData {
  id: string
  name: string
  description: string
  systemPrompt: string
  icon: string
  tags: string[]
  /** 来源 SkillHub 技能 id（从 SkillHub 添加时携带，用于判断是否已添加）；普通自定义智能体无此字段 */
  skillhubId?: string
}

/** 新建/编辑自定义智能体时的入参（id 由 store 生成或按原 id 保留） */
export type CustomAgentInput = Omit<CustomAgentData, 'id'>

/** 内置智能体覆盖快照的持久化结构（编辑内置时保存的完整字段） */
export interface BuiltinAgentOverride {
  name: string
  description: string
  systemPrompt: string
  icon: string
  tags: string[]
}

/** 合并视图清单条目：内置与自定义统一结构 */
export interface AgentView {
  id: string
  name: string
  description: string
  systemPrompt: string
  icon: string
  tags: string[]
  /** 图片头像 URL（仅内置定义携带；覆盖层不修改此字段，自定义智能体恒为 undefined） */
  avatar?: string
  /** 是否内置智能体（内置不可删除，可通过覆盖层编辑展示字段） */
  builtin: boolean
  /** 是否已被用户修改（内置且存在覆盖快照时 true；自定义恒为 false） */
  customized: boolean
  /** 是否已停用（停用后不出现在 AI 对话的智能体浮层中） */
  disabled: boolean
}

/** 校验 localStorage 中读出的条目是否为合法的自定义智能体 */
function isValidCustomAgent(value: unknown): value is CustomAgentData {
  if (typeof value !== 'object' || value === null) return false
  const agent = value as Record<string, unknown>
  return (
    typeof agent.id === 'string' &&
    typeof agent.name === 'string' &&
    typeof agent.description === 'string' &&
    typeof agent.systemPrompt === 'string' &&
    typeof agent.icon === 'string' &&
    Array.isArray(agent.tags) &&
    agent.tags.every((tag) => typeof tag === 'string')
  )
}

/** 读取自定义智能体列表；localStorage 不可用或数据损坏时回退空数组 */
function readCustomAgents(): CustomAgentData[] {
  try {
    const raw = localStorage.getItem(CUSTOM_AGENTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidCustomAgent).map((agent) => ({ ...agent, tags: [...agent.tags] }))
  } catch {
    // 数据损坏（非法 JSON 等）时回退空列表
    return []
  }
}

/** 读取停用的智能体 id 列表；异常时回退空数组 */
function readDisabledIds(): string[] {
  try {
    const raw = localStorage.getItem(DISABLED_AGENTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === 'string')
  } catch {
    return []
  }
}

/** 校验 localStorage 中读出的条目是否为合法的内置覆盖快照 */
function isValidBuiltinOverride(value: unknown): value is BuiltinAgentOverride {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Record<string, unknown>
  return (
    typeof snapshot.name === 'string' &&
    typeof snapshot.description === 'string' &&
    typeof snapshot.systemPrompt === 'string' &&
    typeof snapshot.icon === 'string' &&
    Array.isArray(snapshot.tags) &&
    snapshot.tags.every((tag) => typeof tag === 'string')
  )
}

/** 读取内置覆盖快照表；localStorage 不可用或数据损坏时回退空对象（仅保留内置 id 的有效条目） */
function readBuiltinOverrides(): Record<string, BuiltinAgentOverride> {
  try {
    const raw = localStorage.getItem(BUILTIN_OVERRIDES_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const overrides: Record<string, BuiltinAgentOverride> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!BUILTIN_AGENTS.some((agent) => agent.id === id)) continue
      if (!isValidBuiltinOverride(value)) continue
      overrides[id] = { ...value, tags: [...value.tags] }
    }
    return overrides
  } catch {
    // 数据损坏（非法 JSON 等）时回退空表
    return {}
  }
}

export const useAgentsStore = defineStore('agents', () => {
  /** 自定义智能体列表（持久化到 localStorage） */
  const customAgents = ref<CustomAgentData[]>(readCustomAgents())

  /** 停用的智能体 id 列表（持久化到 localStorage） */
  const disabledIds = ref<string[]>(readDisabledIds())

  /** 内置智能体覆盖快照表：id → 编辑内容（持久化到 localStorage） */
  const builtinOverrides = ref<Record<string, BuiltinAgentOverride>>(readBuiltinOverrides())

  /** 合并视图清单：内置在前、自定义在后；内置存在覆盖快照时用快照整体覆盖展示字段 */
  const agents = computed<AgentView[]>(() => [
    ...BUILTIN_AGENTS.map((agent) => {
      const override = builtinOverrides.value[agent.id]
      return {
        id: agent.id,
        name: override?.name ?? agent.name,
        description: override?.description ?? agent.description,
        systemPrompt: override?.systemPrompt ?? agent.systemPrompt,
        icon: override?.icon ?? agent.icon ?? DEFAULT_AGENT_ICON,
        // 图片头像始终取内置定义（覆盖层只改名称/描述/提示词等字段，不改头像）
        avatar: agent.avatar,
        tags: override ? [...override.tags] : [...(agent.tags ?? [])],
        builtin: true,
        customized: Boolean(override),
        disabled: disabledIds.value.includes(agent.id),
      }
    }),
    ...customAgents.value.map((agent) => ({
      ...agent,
      builtin: false,
      customized: false,
      disabled: disabledIds.value.includes(agent.id),
    })),
  ])

  /** 过滤掉停用后的清单（AI 对话浮层使用） */
  const enabledAgents = computed<AgentView[]>(() => agents.value.filter((agent) => !agent.disabled))

  /** 自定义智能体数量 */
  const customCount = computed(() => customAgents.value.length)

  /** 默认兜底智能体（通用助手，始终启用且位于合并清单首位） */
  const defaultAgent = computed<AgentView>(
    () => agents.value.find((agent) => agent.id === DEFAULT_AGENT_ID) ?? agents.value[0],
  )

  /** 在合并清单中按 id 查找；找不到返回 undefined（调用方自行兜底到通用助手） */
  function findAgent(id: string): AgentView | undefined {
    return agents.value.find((agent) => agent.id === id)
  }

  /** 新建自定义智能体，返回生成的 id（新建即为启用态） */
  function addCustomAgent(data: CustomAgentInput): string {
    const id = crypto.randomUUID()
    customAgents.value = [
      ...customAgents.value,
      { ...data, icon: data.icon.trim() || DEFAULT_AGENT_ICON, tags: [...data.tags], id },
    ]
    return id
  }

  /** 编辑自定义智能体；id 不存在时返回 false（未显式修改时保留原 skillhubId，避免编辑后丢失来源） */
  function updateCustomAgent(id: string, data: CustomAgentInput): boolean {
    const exists = customAgents.value.some((agent) => agent.id === id)
    if (!exists) return false
    customAgents.value = customAgents.value.map((agent) =>
      agent.id === id
        ? { ...agent, ...data, icon: data.icon.trim() || DEFAULT_AGENT_ICON, tags: [...data.tags], id }
        : agent,
    )
    return true
  }

  /** 判断某 SkillHub 技能是否已添加为自定义智能体（存在同 skillhubId 的条目即 true） */
  function isSkillhubAdded(skillhubId: string): boolean {
    return customAgents.value.some((agent) => agent.skillhubId === skillhubId)
  }

  /** 编辑内置智能体：写入/更新覆盖快照（id 非内置时忽略并返回 false） */
  function updateBuiltinAgent(id: string, data: CustomAgentInput): boolean {
    const isBuiltin = BUILTIN_AGENTS.some((agent) => agent.id === id)
    if (!isBuiltin) return false
    builtinOverrides.value = {
      ...builtinOverrides.value,
      [id]: { ...data, icon: data.icon.trim() || DEFAULT_AGENT_ICON, tags: [...data.tags] },
    }
    return true
  }

  /** 恢复内置智能体的代码默认：删除该 id 的覆盖快照 */
  function resetBuiltinAgent(id: string): void {
    if (!builtinOverrides.value[id]) return
    const next = { ...builtinOverrides.value }
    delete next[id]
    builtinOverrides.value = next
  }

  /** 删除自定义智能体（内置不可删除），并同步清理停用列表中的残留 id */
  function removeCustomAgent(id: string): void {
    customAgents.value = customAgents.value.filter((agent) => agent.id !== id)
    disabledIds.value = disabledIds.value.filter((disabledId) => disabledId !== id)
  }

  /** 复制任意智能体（含内置）为自定义副本，名称加「副本」后缀，返回新 id；源不存在返回 null */
  function duplicateAgent(id: string): string | null {
    const source = findAgent(id)
    if (!source) return null
    const newId = crypto.randomUUID()
    customAgents.value = [
      ...customAgents.value,
      {
        id: newId,
        name: `${source.name} 副本`,
        description: source.description,
        systemPrompt: source.systemPrompt,
        icon: source.icon,
        tags: [...source.tags],
      },
    ]
    return newId
  }

  /** 切换停用/启用；通用助手为默认兜底，不允许停用（直接忽略） */
  function toggleDisabled(id: string): void {
    if (id === DEFAULT_AGENT_ID) return
    disabledIds.value = disabledIds.value.includes(id)
      ? disabledIds.value.filter((item) => item !== id)
      : [...disabledIds.value, id]
  }

  // 三份状态变化 → 各自持久化到 localStorage（失败时静默降级，仅当前会话生效）
  watch(customAgents, (next) => {
    try {
      localStorage.setItem(CUSTOM_AGENTS_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  watch(disabledIds, (next) => {
    try {
      localStorage.setItem(DISABLED_AGENTS_KEY, JSON.stringify(next))
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
    agents,
    enabledAgents,
    customCount,
    defaultAgent,
    findAgent,
    addCustomAgent,
    updateCustomAgent,
    isSkillhubAdded,
    updateBuiltinAgent,
    resetBuiltinAgent,
    removeCustomAgent,
    duplicateAgent,
    toggleDisabled,
  }
})
