import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { BUILTIN_AGENTS, DEFAULT_AGENT_ID, type AgentAvatar } from '@/lib/agents'
import { useSkillsStore } from '@/stores/skills'
import { storageGet, storageSet } from '@/lib/storage'

/** 自定义智能体在 localStorage 中的持久化 key */
const CUSTOM_AGENTS_KEY = 'mr-huang-agent:custom-agents'
/** 停用的智能体 id 列表在 localStorage 中的持久化 key */
const DISABLED_AGENTS_KEY = 'mr-huang-agent:disabled-agents'
/** 内置智能体覆盖快照（id → 编辑内容）在 localStorage 中的持久化 key */
const BUILTIN_OVERRIDES_KEY = 'mr-huang-agent:builtin-overrides'
/** 内置智能体追加关联技能（id → 追加的技能 id 列表）在 localStorage 中的持久化 key */
const BUILTIN_SKILL_LINKS_KEY = 'mr-huang-agent:builtin-skill-links'
/** 内置智能体手动卸载的技能（id → 被卸载的技能 id 列表）在 localStorage 中的持久化 key */
const BUILTIN_SKILL_UNLINKS_KEY = 'mr-huang-agent:builtin-skill-unlinks'
/** 「小果子」智能体补充 skill_install 工具的一次性迁移标记 key（存在即不再执行） */
const XIAOGUOZI_TOOL_MIGRATION_KEY = 'mr-huang-agent:agent-tool-migration-xiaoguozi'

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
  /** 关联的技能 id 列表（安装合集包时由创建出的技能 id 组成，对话时自动装载进 system 消息）；普通自定义智能体无此字段 */
  linkedSkillIds?: string[]
  /** 绑定的默认模型配置 id（''=未绑定，跟随对话当前选择；旧数据无此字段按未绑定处理） */
  modelConfigId?: string
  /** 绑定的默认模型 id（''或缺失=用该配置的主模型，与对话上下文的语义一致；仅 modelConfigId 非空时生效） */
  modelId?: string
  /** 声明可用的工具名列表（可选；需与 src/lib/agent-tools.ts 的 AGENT_TOOLS 名称对应；旧数据无该字段按无工具处理） */
  tools?: string[]
  /** 头像设置（可选；未设置时回退 icon emoji 展示） */
  avatar?: AgentAvatar
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
  /** 绑定的默认模型配置 id（''=未绑定；模型配置是用户数据，内置代码定义不携带，仅经覆盖层持久化） */
  modelConfigId?: string
  /** 绑定的默认模型 id（''或缺失=该配置的主模型；仅 modelConfigId 非空时生效） */
  modelId?: string
  /** 头像设置（更换头像时随覆盖层保存；未单独设置时沿用内置定义或回退 icon） */
  avatar?: AgentAvatar
  /** 声明可用的工具名列表（可选；编辑内置智能体勾选工具时写入；旧数据无该字段时回退内置代码定义的默认工具集） */
  tools?: string[]
}

/** 合并视图清单条目：内置与自定义统一结构 */
export interface AgentView {
  id: string
  name: string
  description: string
  systemPrompt: string
  icon: string
  tags: string[]
  /** 头像设置（三种来源：系统默认 SVG / emoji / 自定义图片 base64；未设置时回退 icon emoji 展示） */
  avatar?: AgentAvatar
  /** 是否内置智能体（内置不可删除，可通过覆盖层编辑展示字段） */
  builtin: boolean
  /** 是否已被用户修改（内置且存在覆盖快照时 true；自定义恒为 false） */
  customized: boolean
  /** 是否已停用（停用后不出现在 AI 对话的智能体浮层中） */
  disabled: boolean
  /** 关联的技能 id 列表（合集智能体携带；对话时自动把对应技能的方法论附加进 system 消息），其余智能体恒为空数组 */
  linkedSkillIds: string[]
  /** 绑定的默认模型配置 id（''=未绑定，跟随对话当前选择；合并时归一化，缺失/undefined → ''） */
  modelConfigId: string
  /** 绑定的默认模型 id（''=该配置的主模型；仅 modelConfigId 非空时生效） */
  modelId: string
  /** 来源 SkillHub 合集包 id（仅合集包安装的自定义智能体携带，用于删除时按前缀级联清理其自带的技能），内置与普通自定义智能体为 undefined */
  skillhubId?: string
  /** 声明可用的工具名列表（合并时归一化，缺失/undefined → []；名称需与 src/lib/agent-tools.ts 对应） */
  tools: string[]
}

/** 校验 localStorage 中读出的头像设置是否合法（三种来源各校验对应载荷字段） */
function isValidAgentAvatar(value: unknown): value is AgentAvatar {
  if (typeof value !== 'object' || value === null) return false
  const avatar = value as Record<string, unknown>
  if (avatar.kind === 'default') return typeof avatar.id === 'string'
  if (avatar.kind === 'emoji') return typeof avatar.value === 'string'
  if (avatar.kind === 'image') return typeof avatar.data === 'string'
  return false
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
    agent.tags.every((tag) => typeof tag === 'string') &&
    (agent.avatar === undefined || isValidAgentAvatar(agent.avatar)) &&
    (agent.linkedSkillIds === undefined ||
      (Array.isArray(agent.linkedSkillIds) &&
        agent.linkedSkillIds.every((skillId) => typeof skillId === 'string'))) &&
    // 默认模型绑定：undefined（旧数据无该字段）或字符串均可，读取时再归一化为 ''
    (agent.modelConfigId === undefined || typeof agent.modelConfigId === 'string') &&
    (agent.modelId === undefined || typeof agent.modelId === 'string') &&
    (agent.tools === undefined ||
      (Array.isArray(agent.tools) && agent.tools.every((toolId) => typeof toolId === 'string')))
  )
}

/** 读取自定义智能体列表；localStorage 不可用或数据损坏时回退空数组 */
function readCustomAgents(): CustomAgentData[] {
  try {
    const raw = storageGet(CUSTOM_AGENTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidCustomAgent).map((agent) => ({
      ...agent,
      tags: [...agent.tags],
      // 关联技能 id 列表读取时拷贝，避免外部引用与持久化状态共享同一数组
      ...(agent.linkedSkillIds ? { linkedSkillIds: [...agent.linkedSkillIds] } : {}),
    }))
  } catch {
    // 数据损坏（非法 JSON 等）时回退空列表
    return []
  }
}

/** 读取停用的智能体 id 列表；异常时回退空数组 */
function readDisabledIds(): string[] {
  try {
    const raw = storageGet(DISABLED_AGENTS_KEY)
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
    snapshot.tags.every((tag) => typeof tag === 'string') &&
    (snapshot.avatar === undefined || isValidAgentAvatar(snapshot.avatar)) &&
    // 默认模型绑定：undefined（旧数据无该字段）或字符串均可，读取时再归一化为 ''
    (snapshot.modelConfigId === undefined || typeof snapshot.modelConfigId === 'string') &&
    (snapshot.modelId === undefined || typeof snapshot.modelId === 'string') &&
    (snapshot.tools === undefined ||
      (Array.isArray(snapshot.tools) && snapshot.tools.every((tool) => typeof tool === 'string')))
  )
}

/** 读取内置覆盖快照表；localStorage 不可用或数据损坏时回退空对象（仅保留内置 id 的有效条目） */
function readBuiltinOverrides(): Record<string, BuiltinAgentOverride> {
  try {
    const raw = storageGet(BUILTIN_OVERRIDES_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const overrides: Record<string, BuiltinAgentOverride> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!BUILTIN_AGENTS.some((agent) => agent.id === id)) continue
      if (!isValidBuiltinOverride(value)) continue
      overrides[id] = {
        ...value,
        tags: [...value.tags],
        // 工具列表读取时拷贝，避免外部引用与持久化状态共享同一数组
        ...(value.tools ? { tools: [...value.tools] } : {}),
      }
    }
    return overrides
  } catch {
    // 数据损坏（非法 JSON 等）时回退空表
    return {}
  }
}

/** 读取内置智能体的追加关联技能表；异常时回退空对象（仅保留内置 id 的 string[] 条目） */
function readBuiltinSkillLinks(): Record<string, string[]> {
  try {
    const raw = storageGet(BUILTIN_SKILL_LINKS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const links: Record<string, string[]> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!BUILTIN_AGENTS.some((agent) => agent.id === id)) continue
      if (!Array.isArray(value)) continue
      const ids = value.filter((item): item is string => typeof item === 'string')
      if (ids.length) links[id] = ids
    }
    return links
  } catch {
    return {}
  }
}

/** 读取内置智能体手动卸载的技能表；异常时回退空对象（仅保留内置 id 的 string[] 条目） */
function readBuiltinSkillUnlinks(): Record<string, string[]> {
  try {
    const raw = storageGet(BUILTIN_SKILL_UNLINKS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const unlinks: Record<string, string[]> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!BUILTIN_AGENTS.some((agent) => agent.id === id)) continue
      if (!Array.isArray(value)) continue
      const ids = value.filter((item): item is string => typeof item === 'string')
      if (ids.length) unlinks[id] = ids
    }
    return unlinks
  } catch {
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

  /** 内置智能体追加关联技能表：id → 追加的技能 id 列表（持久化到 localStorage；代码定义之外的运行时挂载） */
  const builtinSkillLinks = ref<Record<string, string[]>>(readBuiltinSkillLinks())

  /** 内置智能体手动卸载的技能表：id → 被卸载的技能 id 列表（持久化到 localStorage；用于从合并视图中排除代码定义/追加的关联） */
  const builtinSkillUnlinks = ref<Record<string, string[]>>(readBuiltinSkillUnlinks())

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
        // 头像优先取覆盖快照（更换头像写入覆盖层），其次内置定义，均未设置时回退 icon emoji
        avatar: override?.avatar ?? agent.avatar,
        tags: override ? [...override.tags] : [...(agent.tags ?? [])],
        builtin: true,
        customized: Boolean(override),
        disabled: disabledIds.value.includes(agent.id),
        // 内置智能体的技能关联透传代码定义；覆盖层（builtin-overrides）不涉及 linkedSkillIds，
        // 用户编辑名称/描述/提示词后仍保留代码里定义的技能串联
        // 内置智能体的技能关联 = 代码定义 + 追加关联表（技能市场安装时挂载的运行时数据）
        linkedSkillIds: [
          ...(agent.linkedSkillIds ?? []),
          ...(builtinSkillLinks.value[agent.id] ?? []),
          // 手动卸载的技能从最终关联中排除（代码定义不可变，卸载记录存独立表）
        ].filter((skillId) => !(builtinSkillUnlinks.value[agent.id] ?? []).includes(skillId)),
        // 默认模型绑定仅存于覆盖快照（代码定义不携带用户数据），缺失/undefined 归一化为 ''
        modelConfigId: override?.modelConfigId ?? '',
        modelId: override?.modelId ?? '',
        // 工具声明优先取覆盖快照（编辑内置智能体勾选工具时写入），无覆盖时回退代码定义
        tools: override?.tools ? [...override.tools] : [...(agent.tools ?? [])],
      }
    }),
    ...customAgents.value.map((agent) => ({
      ...agent,
      builtin: false,
      customized: false,
      disabled: disabledIds.value.includes(agent.id),
      linkedSkillIds: [...(agent.linkedSkillIds ?? [])],
      // 旧 localStorage 数据可能缺失绑定字段，统一归一化为 ''（未绑定）
      modelConfigId: agent.modelConfigId ?? '',
      modelId: agent.modelId ?? '',
      // 旧数据无工具字段时归一化为空数组
      tools: [...(agent.tools ?? [])],
    })),
  ])

  /** 过滤掉停用后的清单（AI 对话浮层使用） */
  const enabledAgents = computed<AgentView[]>(() => agents.value.filter((agent) => !agent.disabled))

  /** 自定义智能体数量 */
  const customCount = computed(() => customAgents.value.length)

  /** 默认兜底智能体：优先通用助手，其次合并清单首位；清单为空时为 undefined（调用方自行兜底展示与空提示词） */
  const defaultAgent = computed<AgentView | undefined>(
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
      {
        ...data,
        icon: data.icon.trim() || DEFAULT_AGENT_ICON,
        tags: [...data.tags],
        ...(data.linkedSkillIds ? { linkedSkillIds: [...data.linkedSkillIds] } : {}),
        tools: [...(data.tools ?? [])],
        id,
      },
    ]
    return id
  }

  /** 编辑自定义智能体；id 不存在时返回 false（未显式修改时保留原 skillhubId 与 linkedSkillIds，避免编辑后丢失来源与关联） */
  function updateCustomAgent(id: string, data: CustomAgentInput): boolean {
    const exists = customAgents.value.some((agent) => agent.id === id)
    if (!exists) return false
      customAgents.value = customAgents.value.map((agent) =>
        agent.id === id
          ? {
              ...agent,
              ...data,
              icon: data.icon.trim() || DEFAULT_AGENT_ICON,
              tags: [...data.tags],
              // 表单始终提交 tools 字段（未勾选即空数组），不提交时保留原值
              tools: [...(data.tools ?? agent.tools ?? [])],
              id,
            }
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
      [id]: {
        ...data,
        icon: data.icon.trim() || DEFAULT_AGENT_ICON,
        tags: [...data.tags],
        // 编辑表单不含头像字段：保留覆盖层已设置的头像，避免编辑档案时被清掉
        avatar: data.avatar ?? builtinOverrides.value[id]?.avatar,
        // 默认模型绑定随表单 payload 写入（''=清除绑定）；payload 未携带（旧调用方）时
        // 保留覆盖层已有绑定，避免被误清
        modelConfigId: data.modelConfigId ?? builtinOverrides.value[id]?.modelConfigId ?? '',
        modelId: data.modelId ?? builtinOverrides.value[id]?.modelId ?? '',
        // 工具勾选随表单 payload 写入覆盖层；payload 未携带（旧调用方）时保留覆盖层已有值
        tools: [...(data.tools ?? builtinOverrides.value[id]?.tools ?? [])],
      },
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

  /**
   * 删除自定义智能体（内置不可删除），并同步清理停用列表中的残留 id；
   * 若目标为合集包安装的智能体（携带 skillhubId），则级联删除技能中心里其自带的技能
   * （自定义技能中 skillhubId 以「该智能体 skillhubId + 冒号」为前缀的条目）。
   * 级联按 skillhubId 前缀匹配而非 linkedSkillIds：duplicateAgent 复制的副本会拷贝
   * linkedSkillIds 但不带 skillhubId（副本与正主共享同一批技能），若按 linkedSkillIds
   * 级联，删除副本会误删正主的自带技能；手动新建与单技能（gh/zip）导入的智能体无
   * skillhubId 或前缀不命中，均不触发级联。
   */
  function removeCustomAgent(id: string): void {
    // 删除前先快照目标：删除后 customAgents 中已查不到该智能体的 skillhubId
    const target = customAgents.value.find((agent) => agent.id === id)
    customAgents.value = customAgents.value.filter((agent) => agent.id !== id)
    disabledIds.value = disabledIds.value.filter((disabledId) => disabledId !== id)
    if (!target?.skillhubId) return
    // 在 action 函数体内调用 useSkillsStore()（Pinia setup store 支持跨 store 组合；skills store 不依赖本 store，无循环引用）
    const skillsStore = useSkillsStore()
    skillsStore.removeCustomSkillsByIds(skillsStore.findBundledSkillIds(target.skillhubId))
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
        // 副本沿用源智能体的头像设置（浅拷贝载荷字段即可，内容不再单独修改）
        ...(source.avatar ? { avatar: { ...source.avatar } } : {}),
        // 副本沿用源智能体的关联技能（副本与源共享同一批技能文档）
        linkedSkillIds: [...source.linkedSkillIds],
        // 副本沿用源智能体的工具声明
        tools: [...source.tools],
        // 副本沿用源智能体的默认模型绑定（源未绑定时写 ''，与自定义数据的语义保持一致）
        modelConfigId: source.modelConfigId,
        modelId: source.modelId,
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

  /**
   * 设置智能体头像（内置与自定义均可）：avatar 为 null 时清除设置，回到默认 icon emoji 展示。
   * 内置走覆盖快照（无快照时以当前生效值补全其余字段再写入），自定义直接改列表；
   * 两种来源均由各自的 watch 持久化到 localStorage。
   */
  function setAgentAvatar(id: string, avatar: AgentAvatar | null): void {
    const isBuiltin = BUILTIN_AGENTS.some((agent) => agent.id === id)
    if (isBuiltin) {
      const current = findAgent(id)
      if (!current) return
      // 清除头像且原本就没有覆盖快照时无需写入，避免把「已修改」标记误置为 true
      if (!avatar && !builtinOverrides.value[id]) return
      builtinOverrides.value = {
        ...builtinOverrides.value,
        [id]: {
          name: current.name,
          description: current.description,
          systemPrompt: current.systemPrompt,
          icon: current.icon,
          tags: [...current.tags],
          // 手工重建快照时必须带上当前视图里的默认模型绑定与工具勾选，否则换头像会把它们清掉
          modelConfigId: current.modelConfigId,
          modelId: current.modelId,
          tools: [...current.tools],
          ...(avatar ? { avatar } : {}),
        },
      }
      return
    }
    customAgents.value = customAgents.value.map((agent) =>
      agent.id === id ? { ...agent, ...(avatar ? { avatar } : { avatar: undefined }) } : agent,
    )
  }

  /**
   * 把技能挂载到智能体（内置与自定义均可）：往 linkedSkillIds 追加去重。
   * 内置走独立的追加关联表（内置代码定义的 linkedSkillIds 不可变，覆盖快照不涉及技能关联）；
   * 自定义直接改列表。重复挂载幂等（已存在时直接返回）。
   */
  function linkSkillToAgent(agentId: string, skillId: string): void {
    if (!skillId) return
    const isBuiltin = BUILTIN_AGENTS.some((agent) => agent.id === agentId)
    if (isBuiltin) {
      // 若此前手动卸载过该技能，先清掉卸载记录，避免挂载与卸载同时生效
      clearBuiltinSkillUnlink(agentId, skillId)
      const current = builtinSkillLinks.value[agentId] ?? []
      if (current.includes(skillId)) return
      builtinSkillLinks.value = {
        ...builtinSkillLinks.value,
        [agentId]: [...current, skillId],
      }
      return
    }
    customAgents.value = customAgents.value.map((agent) =>
      agent.id === agentId && !agent.linkedSkillIds?.includes(skillId)
        ? { ...agent, linkedSkillIds: [...(agent.linkedSkillIds ?? []), skillId] }
        : agent,
    )
  }

  /**
   * 把技能从智能体卸载（内置与自定义均可）：从 linkedSkillIds 移除，不存在时幂等返回。
   * 内置走两张独立表：从追加关联表移除；若卸载的是代码定义的关联，则记入手动卸载表，
   * 合并视图按卸载表过滤（代码定义不可变，覆盖快照不涉及技能关联）。
   * 自定义直接从列表移除。
   */
  function detachSkillFromAgent(agentId: string, skillId: string): void {
    if (!skillId) return
    const isBuiltin = BUILTIN_AGENTS.some((agent) => agent.id === agentId)
    if (isBuiltin) {
      const linked = builtinSkillLinks.value[agentId]
      if (linked?.includes(skillId)) {
        const nextLinked = linked.filter((item) => item !== skillId)
        builtinSkillLinks.value = {
          ...builtinSkillLinks.value,
          ...(nextLinked.length ? { [agentId]: nextLinked } : {}),
        }
        if (!nextLinked.length) {
          const { [agentId]: _removed, ...rest } = builtinSkillLinks.value
          builtinSkillLinks.value = rest
        }
      }
      const unlinked = builtinSkillUnlinks.value[agentId] ?? []
      if (!unlinked.includes(skillId)) {
        builtinSkillUnlinks.value = {
          ...builtinSkillUnlinks.value,
          [agentId]: [...unlinked, skillId],
        }
      }
      return
    }
    customAgents.value = customAgents.value.map((agent) =>
      agent.id === agentId && agent.linkedSkillIds?.includes(skillId)
        ? {
            ...agent,
            linkedSkillIds: agent.linkedSkillIds.filter((item) => item !== skillId),
          }
        : agent,
    )
  }

  /** 重新挂载技能时清掉手动卸载记录（与 detach 互逆，避免关联表里同时存在挂载与卸载记录） */
  function clearBuiltinSkillUnlink(agentId: string, skillId: string): void {
    const unlinked = builtinSkillUnlinks.value[agentId]
    if (!unlinked?.includes(skillId)) return
    const nextUnlinked = unlinked.filter((item) => item !== skillId)
    builtinSkillUnlinks.value = {
      ...builtinSkillUnlinks.value,
      ...(nextUnlinked.length ? { [agentId]: nextUnlinked } : {}),
    }
    if (!nextUnlinked.length) {
      const { [agentId]: _removed, ...rest } = builtinSkillUnlinks.value
      builtinSkillUnlinks.value = rest
    }
  }

  /**
   * 一次性迁移：为智能体「小果子」（自定义或改过名的内置）自动补充 skill_install 工具：
   * - 启动（首次实例化 store）时执行；未找到该名字的智能体则不标记，下次启动再试（用户可能稍后改名）；
   * - 已含该工具时只补标记不重复写入；仅改目标智能体，不影响其他智能体的 tools；
   * - 内置（覆盖快照）走 updateBuiltinAgent 重建快照，自定义直接改列表；watch 负责持久化。
   */
  function migrateXiaoguoziSkillInstall(): void {
    try {
      if (storageGet(XIAOGUOZI_TOOL_MIGRATION_KEY)) return
      const target = agents.value.find((agent) => agent.name === '小果子')
      if (!target) return
      if (!target.tools.includes('skill_install')) {
        if (target.builtin) {
          updateBuiltinAgent(target.id, {
            name: target.name,
            description: target.description,
            systemPrompt: target.systemPrompt,
            icon: target.icon,
            tags: [...target.tags],
            modelConfigId: target.modelConfigId,
            modelId: target.modelId,
            tools: [...target.tools, 'skill_install'],
            ...(target.avatar ? { avatar: target.avatar } : {}),
          })
        } else {
          customAgents.value = customAgents.value.map((agent) =>
            agent.id === target.id
              ? { ...agent, tools: [...(agent.tools ?? []), 'skill_install'] }
              : agent,
          )
        }
      }
      storageSet(XIAOGUOZI_TOOL_MIGRATION_KEY, '1')
    } catch {
      // localStorage 不可用时静默跳过（未写标记，下次再试）
    }
  }

  migrateXiaoguoziSkillInstall()

  // 各份状态变化 → 各自持久化到 localStorage（失败时静默降级，仅当前会话生效）
  watch(customAgents, (next) => {
    try {
      storageSet(CUSTOM_AGENTS_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  watch(disabledIds, (next) => {
    try {
      storageSet(DISABLED_AGENTS_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  watch(builtinOverrides, (next) => {
    try {
      storageSet(BUILTIN_OVERRIDES_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  watch(builtinSkillLinks, (next) => {
    try {
      storageSet(BUILTIN_SKILL_LINKS_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  watch(builtinSkillUnlinks, (next) => {
    try {
      storageSet(BUILTIN_SKILL_UNLINKS_KEY, JSON.stringify(next))
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
    setAgentAvatar,
    linkSkillToAgent,
    detachSkillFromAgent,
  }
})
