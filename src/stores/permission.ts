import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { storageGet, storageSet } from '@/lib/storage'

/** 权限模式：plan=计划模式（只读） / confirm=变更前确认 / auto-edit=自动编辑 / full=完全访问 */
export type PermissionMode = 'plan' | 'confirm' | 'auto-edit' | 'full'

const STORAGE_KEY = 'mr-huang-agent:permission-mode'

const VALID_MODES: PermissionMode[] = ['plan', 'confirm', 'auto-edit', 'full']

/** AppIcon 图标名（图标集中已有的名称） */
export type PermissionModeIcon = 'compass' | 'check' | 'pen' | 'sparkles'

export interface PermissionModeMeta {
  value: PermissionMode
  label: string
  description: string
  icon: PermissionModeIcon
}

/** 四档模式的中文元信息（label + 一行描述 + 图标），供 ChatView 下拉与 SettingsView 设置项复用 */
export const PERMISSION_MODES: PermissionModeMeta[] = [
  {
    value: 'plan',
    label: '计划模式',
    description: '编辑前先出计划。',
    icon: 'compass',
  },
  {
    value: 'confirm',
    label: '变更前确认',
    description: '改动文件前先问我。',
    icon: 'check',
  },
  {
    value: 'auto-edit',
    label: '自动编辑',
    description: '自动编辑文件。',
    icon: 'pen',
  },
  {
    value: 'full',
    label: '完全访问',
    description: '减少确认次数。',
    icon: 'sparkles',
  },
]

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'confirm'

/** 取某模式的元信息；未知模式回退默认档（纯函数，可单测） */
export function getPermissionModeMeta(mode: PermissionMode): PermissionModeMeta {
  const found = PERMISSION_MODES.find((meta) => meta.value === mode)
  if (found) return found
  return (
    PERMISSION_MODES.find((meta) => meta.value === DEFAULT_PERMISSION_MODE) ?? PERMISSION_MODES[0]
  )
}

/** 从 localStorage 防御式读取权限模式；坏数据 / 不可用时回退默认值 */
function readMode(): PermissionMode {
  try {
    const stored = storageGet(STORAGE_KEY)
    if (stored && (VALID_MODES as string[]).includes(stored)) {
      return stored as PermissionMode
    }
  } catch {
    // localStorage 不可用时忽略，回退到默认值
  }
  return DEFAULT_PERMISSION_MODE
}

export const usePermissionStore = defineStore('permission', () => {
  const mode = ref<PermissionMode>(readMode())

  function setMode(next: PermissionMode): void {
    mode.value = next
  }

  // 模式变化 → 持久化到 localStorage
  watch(mode, (next) => {
    try {
      storageSet(STORAGE_KEY, next)
    } catch {
      // 持久化失败时静默降级（仅当前会话生效）
    }
  })

  return { mode, setMode }
})
