import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { storageGet, storageSet } from '@/lib/storage'
import type { AgentAvatar } from '@/lib/agents'

/**
 * 账号与个人资料 / 通知偏好（localStorage 持久化）：
 * - 资料字段：昵称、签名简介、头像（复用智能体头像的三种来源结构 AgentAvatar）。
 * - 通知偏好：任务完成提醒、消息声音、桌面通知三个开关。
 * 所有字段变更即自动写回统一存储层（桌面端文件存储 / 浏览器 localStorage）。
 */

const STORAGE_KEY = 'mr-huang-agent:account'

/** 通知偏好（三个独立开关，新增字段时向 DEFAULT_NOTIFICATIONS 补默认值即可） */
export interface NotificationPrefs {
  /** 任务完成提醒 */
  taskDone: boolean
  /** 消息声音 */
  messageSound: boolean
  /** 桌面通知 */
  desktopNotify: boolean
}

/** 持久化结构（读入时逐字段防御式合并，坏数据 / 缺字段回退默认值） */
interface AccountPersisted {
  nickname: string
  bio: string
  avatar: AgentAvatar | null
  notifications: NotificationPrefs
}

const DEFAULT_NICKNAME = '用户'

const DEFAULT_NOTIFICATIONS: NotificationPrefs = {
  taskDone: true,
  messageSound: true,
  desktopNotify: false,
}

/** 防御式读取持久化数据：解析失败 / 字段类型不符时逐项回退默认值 */
function readPersisted(): AccountPersisted {
  const fallback: AccountPersisted = {
    nickname: DEFAULT_NICKNAME,
    bio: '',
    avatar: null,
    notifications: { ...DEFAULT_NOTIFICATIONS },
  }
  try {
    const raw = storageGet(STORAGE_KEY)
    if (!raw) return fallback
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return fallback
    const data = parsed as Partial<AccountPersisted>
    return {
      nickname: typeof data.nickname === 'string' && data.nickname.trim() ? data.nickname : DEFAULT_NICKNAME,
      bio: typeof data.bio === 'string' ? data.bio : '',
      avatar: (data.avatar ?? null) as AgentAvatar | null,
      notifications: {
        taskDone: data.notifications?.taskDone ?? DEFAULT_NOTIFICATIONS.taskDone,
        messageSound: data.notifications?.messageSound ?? DEFAULT_NOTIFICATIONS.messageSound,
        desktopNotify: data.notifications?.desktopNotify ?? DEFAULT_NOTIFICATIONS.desktopNotify,
      },
    }
  } catch {
    return fallback
  }
}

export const useAccountStore = defineStore('account', () => {
  const initial = readPersisted()

  /** 昵称（空串时展示层回退默认昵称） */
  const nickname = ref(initial.nickname)
  /** 签名 / 简介 */
  const bio = ref(initial.bio)
  /** 头像（null 表示未设置，展示层用昵称首字兜底） */
  const avatar = ref<AgentAvatar | null>(initial.avatar)
  /** 通知偏好开关组 */
  const notifications = ref<NotificationPrefs>({ ...initial.notifications })

  /** 任一字段变化 → 自动持久化（失败时静默降级，仅当前会话生效） */
  watch(
    [nickname, bio, avatar, notifications],
    () => {
      try {
        storageSet(
          STORAGE_KEY,
          JSON.stringify({
            nickname: nickname.value,
            bio: bio.value,
            avatar: avatar.value,
            notifications: notifications.value,
          }),
        )
      } catch {
        // 忽略持久化失败
      }
    },
    { deep: true },
  )

  /** 展示用昵称：用户未填时回退默认值 */
  function displayName(): string {
    return nickname.value.trim() || DEFAULT_NICKNAME
  }

  /** 切换单个通知开关 */
  function toggleNotification(key: keyof NotificationPrefs): void {
    notifications.value = { ...notifications.value, [key]: !notifications.value[key] }
  }

  return { nickname, bio, avatar, notifications, displayName, toggleNotification }
})

/** 默认昵称（供展示层兜底复用） */
export { DEFAULT_NICKNAME }
