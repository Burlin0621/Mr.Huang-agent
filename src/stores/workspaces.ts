import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { readLegacyActiveConversationId, useConversationsStore } from '@/stores/conversations'
import { storageGet, storageSet } from '@/lib/storage'

/**
 * 工作区：对话之上的顶层分组（参照 agent harness 的 workspace 概念）。
 * 每个工作区拥有独立的一套对话（进行中 + 已归档）与「最近打开的对话」记录。
 * 依赖方向：workspaces → conversations（单向；conversations 不感知工作区 store）。
 */
export interface Workspace {
  id: string
  /** 显示名称 */
  name: string
  /** emoji 图标（如 📁） */
  icon: string
  /** 关联的本机文件夹绝对路径（'' 表示未关联；桌面封装后用于绑定真实目录） */
  folderPath: string
  createdAt: number
  /** 该工作区最近打开的对话 id（'' 表示草稿态/无） */
  lastConversationId: string
}

const WORKSPACES_STORAGE_KEY = 'mr-huang-agent:workspaces'
const ACTIVE_STORAGE_KEY = 'mr-huang-agent:active-workspace'

/** 默认工作区名称与图标 */
export const DEFAULT_WORKSPACE_NAME = '默认工作区'
export const DEFAULT_WORKSPACE_ICON = '📁'

/** 新建/编辑工作区浮层的预置 emoji 单选 */
export const WORKSPACE_ICON_PRESETS = ['📁', '💼', '🧠', '🚀', '📚', '🎨', '🛠️', '🌱', '💬', '⚡']

/** 防御性归一化单个工作区：缺 id/名称（核心标识）时丢弃，其余字段逐项兜底 */
function normalizeWorkspace(value: unknown): Workspace | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!id || !name) return null
  return {
    id,
    name,
    icon:
      typeof record.icon === 'string' && record.icon.trim()
        ? record.icon.trim()
        : DEFAULT_WORKSPACE_ICON,
    folderPath: typeof record.folderPath === 'string' ? record.folderPath.trim() : '',
    createdAt:
      typeof record.createdAt === 'number' &&
      Number.isFinite(record.createdAt) &&
      record.createdAt > 0
        ? record.createdAt
        : Date.now(),
    lastConversationId:
      typeof record.lastConversationId === 'string' ? record.lastConversationId : '',
  }
}

/** 读取持久化的工作区列表；localStorage 不可用或数据损坏时回退空数组 */
function loadWorkspaces(): Workspace[] {
  try {
    const raw = storageGet(WORKSPACES_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeWorkspace)
      .filter((workspace): workspace is Workspace => workspace !== null)
  } catch {
    // 数据损坏（非法 JSON 等）时回退空列表（随后初始化默认工作区）
    return []
  }
}

function loadActiveId(): string {
  try {
    return storageGet(ACTIVE_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function persistTo(key: string, value: string): void {
  try {
    storageSet(key, value)
  } catch {
    // localStorage 不可用（配额满等）时静默降级，仅当前会话生效
  }
}

function createDefaultWorkspace(): Workspace {
  return {
    id: crypto.randomUUID(),
    name: DEFAULT_WORKSPACE_NAME,
    icon: DEFAULT_WORKSPACE_ICON,
    folderPath: '',
    createdAt: Date.now(),
    lastConversationId: '',
  }
}

export const useWorkspacesStore = defineStore('workspaces', () => {
  // 工作区 store 初始化时可能需要迁移对话数据，故在此创建对话 store
  const conversationsStore = useConversationsStore()

  /** 全部工作区（持久化到 localStorage） */
  const workspaces = ref<Workspace[]>(loadWorkspaces())

  /** 当前活动工作区 id */
  const activeWorkspaceId = ref<string>(loadActiveId())

  // 初始化迁移：无任何工作区（全新环境或旧版存量用户）→ 建一个默认工作区并设为当前；
  // 存量用户同时读取旧版「全局最近对话」key（读取后清理），恢复到默认工作区
  if (workspaces.value.length === 0) {
    const workspace = createDefaultWorkspace()
    workspace.lastConversationId = readLegacyActiveConversationId()
    workspaces.value = [workspace]
    activeWorkspaceId.value = workspace.id
  }

  // 存量对话迁移：无 workspaceId 的旧对话归入首个工作区（默认工作区）
  const fallbackWorkspaceId = workspaces.value[0].id
  for (const conversation of conversationsStore.conversations) {
    if (!conversation.workspaceId) {
      conversation.workspaceId = fallbackWorkspaceId
    }
  }

  // 读到的 active id 无效（被删除等）时回落第一个工作区
  if (!workspaces.value.some((workspace) => workspace.id === activeWorkspaceId.value)) {
    activeWorkspaceId.value = workspaces.value[0].id
  }

  /** 按创建时间正序的工作区列表 */
  const sortedWorkspaces = computed(() =>
    [...workspaces.value].sort((a, b) => a.createdAt - b.createdAt),
  )

  /** 当前活动工作区（active id 短暂失效时兜底第一个） */
  const activeWorkspace = computed(
    () =>
      workspaces.value.find((workspace) => workspace.id === activeWorkspaceId.value) ??
      workspaces.value[0] ??
      null,
  )

  // 状态变化 → 持久化（失败时静默降级，仅当前会话生效）
  watch(
    workspaces,
    (next) => {
      persistTo(WORKSPACES_STORAGE_KEY, JSON.stringify(next))
    },
    { deep: true },
  )

  watch(activeWorkspaceId, (next) => {
    persistTo(ACTIVE_STORAGE_KEY, next)
  })

  // 初始化（含迁移）发生在 watch 注册之前，此处显式落盘一次，
  // 避免全新环境在未触发任何工作区变更前关闭页面导致 workspaces key 缺失
  persistTo(WORKSPACES_STORAGE_KEY, JSON.stringify(workspaces.value))
  persistTo(ACTIVE_STORAGE_KEY, activeWorkspaceId.value)

  function findWorkspace(id: string): Workspace | null {
    return workspaces.value.find((workspace) => workspace.id === id) ?? null
  }

  /** 切换当前活动工作区（不存在的 id 忽略） */
  function setActiveWorkspace(id: string): void {
    if (workspaces.value.some((workspace) => workspace.id === id)) {
      activeWorkspaceId.value = id
    }
  }

  /** 记录工作区最近打开的对话（'' 表示草稿态） */
  function setLastConversation(workspaceId: string, conversationId: string): void {
    const workspace = findWorkspace(workspaceId)
    if (workspace && workspace.lastConversationId !== conversationId) {
      workspace.lastConversationId = conversationId
    }
  }

  /** 新建工作区并设为当前（不预建对话），返回新 id；folderPath 为关联文件夹路径（'' 表示未关联） */
  function createWorkspace(name: string, icon: string, folderPath = ''): string {
    const id = crypto.randomUUID()
    workspaces.value.push({
      id,
      name: name.trim() || DEFAULT_WORKSPACE_NAME,
      icon: icon.trim() || DEFAULT_WORKSPACE_ICON,
      folderPath: folderPath.trim(),
      createdAt: Date.now(),
      lastConversationId: '',
    })
    activeWorkspaceId.value = id
    return id
  }

  /**
   * 重命名（空名称忽略）；icon 可选，传入且非空时一并更新；
   * folderPath 可选，传入时（含 ''）即更新——'' 表示清除文件夹关联
   */
  function renameWorkspace(id: string, name: string, icon?: string, folderPath?: string): void {
    const workspace = findWorkspace(id)
    if (!workspace) return
    const trimmed = name.trim()
    if (trimmed) workspace.name = trimmed
    if (icon && icon.trim()) workspace.icon = icon.trim()
    if (typeof folderPath === 'string') workspace.folderPath = folderPath.trim()
  }

  /**
   * 删除工作区：连带删除其全部对话（含归档）；删光后自动重建一个空的默认工作区兜底；
   * 删的是当前工作区时切到剩余的第一个（视图层负责跳草稿态）。
   */
  function removeWorkspace(id: string): void {
    conversationsStore.removeConversationsInWorkspace(id)
    const index = workspaces.value.findIndex((workspace) => workspace.id === id)
    if (index >= 0) workspaces.value.splice(index, 1)
    if (workspaces.value.length === 0) {
      workspaces.value = [createDefaultWorkspace()]
    }
    if (
      activeWorkspaceId.value === id ||
      !workspaces.value.some((workspace) => workspace.id === activeWorkspaceId.value)
    ) {
      activeWorkspaceId.value = workspaces.value[0].id
    }
  }

  return {
    workspaces,
    activeWorkspaceId,
    sortedWorkspaces,
    activeWorkspace,
    findWorkspace,
    setActiveWorkspace,
    setLastConversation,
    createWorkspace,
    renameWorkspace,
    removeWorkspace,
  }
})
