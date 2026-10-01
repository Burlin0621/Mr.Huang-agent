import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { storageGet, storageSet } from '@/lib/storage'
import {
  GROUP_CHAT_MAX_ROUNDS,
  makeGroupChatTitle,
  normalizeGroupChat,
  type GroupChat,
  type TranscriptEntry,
} from '@/lib/group-chat'

/** 群聊会话在 localStorage 中的持久化 key（与普通对话的 mr-huang-agent:conversations 并列） */
const GROUP_CHATS_STORAGE_KEY = 'mr-huang-agent:group-chats'

/** 持久化防抖（流式期间 token 级更新会频繁触发 deep watch，照 conversations store 的模式） */
const PERSIST_DEBOUNCE_MS = 500

/** 读取持久化的群聊列表；localStorage 不可用或数据损坏时回退空数组 */
export function loadGroupChats(): GroupChat[] {
  try {
    const raw = storageGet(GROUP_CHATS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(normalizeGroupChat)
      .filter((groupChat): groupChat is GroupChat => groupChat !== null)
  } catch {
    // 数据损坏（非法 JSON 等）时回退空列表
    return []
  }
}

function persistTo(key: string, value: string): void {
  try {
    storageSet(key, value)
  } catch {
    // localStorage 不可用（配额满等）时静默降级，仅当前会话生效
  }
}

export const useGroupChatsStore = defineStore('group-chats', () => {
  /** 全部群聊会话（持久化到 localStorage） */
  const groupChats = ref<GroupChat[]>(loadGroupChats())

  /** 按 updatedAt 倒序的列表 */
  const sortedGroupChats = computed(() =>
    [...groupChats.value].sort((a, b) => b.updatedAt - a.updatedAt),
  )

  // 群聊数据 deep watch + 500ms 防抖后写入 localStorage（失败时静默降级）
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  watch(
    groupChats,
    () => {
      if (persistTimer) clearTimeout(persistTimer)
      persistTimer = setTimeout(() => {
        persistTimer = null
        persistTo(GROUP_CHATS_STORAGE_KEY, JSON.stringify(groupChats.value))
      }, PERSIST_DEBOUNCE_MS)
    },
    { deep: true },
  )

  function findGroupChat(id: string): GroupChat | null {
    return groupChats.value.find((groupChat) => groupChat.id === id) ?? null
  }

  /** 新建群聊：task 由视图校验非空，members 至少一人；模型绑定随会话持久化。返回新 id。 */
  function createGroupChat(
    members: string[],
    task: string,
    bindings?: {
      /** agentId → llm 配置 id（'' = 跟随激活配置） */
      memberConfigIds?: Record<string, string>
      /** 主持人 llm 配置 id（'' = 跟随激活配置） */
      moderatorConfigId?: string
    },
  ): string {
    const id = crypto.randomUUID()
    const now = Date.now()
    groupChats.value.push({
      id,
      title: makeGroupChatTitle(task),
      createdAt: now,
      updatedAt: now,
      // 拷贝数组，避免调用方后续原地修改时串改群聊内的引用
      members: [...members],
      task: task.trim(),
      transcript: [],
      status: 'discussing',
      deliverable: '',
      maxRounds: GROUP_CHAT_MAX_ROUNDS,
      // 拷贝映射，避免与视图层响应式对象共享引用
      memberConfigIds: bindings?.memberConfigIds ? { ...bindings.memberConfigIds } : {},
      moderatorConfigId: bindings?.moderatorConfigId ?? '',
    })
    return id
  }

  /** 追加一条发言并 touch；返回 store 内的响应式发言对象（供流式回写） */
  function appendTranscriptEntry(groupChatId: string, entry: TranscriptEntry): TranscriptEntry | null {
    const groupChat = findGroupChat(groupChatId)
    if (!groupChat) return null
    groupChat.transcript.push(entry)
    groupChat.updatedAt = Date.now()
    return groupChat.transcript[groupChat.transcript.length - 1]
  }

  /** 记录主持人最终交付物并标记为已交付 */
  function finishGroupChat(groupChatId: string, deliverable: string): void {
    const groupChat = findGroupChat(groupChatId)
    if (!groupChat) return
    groupChat.deliverable = deliverable
    groupChat.status = 'delivered'
    groupChat.updatedAt = Date.now()
  }

  /** 已交付群聊重开讨论：状态回到 discussing（旧 deliverable 保留，新一轮汇总完成后覆盖） */
  function reopenGroupChat(id: string): void {
    const groupChat = findGroupChat(id)
    if (!groupChat || groupChat.status !== 'delivered') return
    groupChat.status = 'discussing'
    groupChat.updatedAt = Date.now()
  }

  /** 删除群聊 */
  function removeGroupChat(id: string): void {
    const index = groupChats.value.findIndex((groupChat) => groupChat.id === id)
    if (index >= 0) groupChats.value.splice(index, 1)
  }

  return {
    groupChats,
    sortedGroupChats,
    findGroupChat,
    createGroupChat,
    appendTranscriptEntry,
    finishGroupChat,
    reopenGroupChat,
    removeGroupChat,
  }
})
