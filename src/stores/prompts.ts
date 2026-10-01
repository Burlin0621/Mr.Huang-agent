import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

import { BUILTIN_PROMPTS, type BuiltinPrompt } from '@/lib/builtin-prompts'
import { storageGet, storageSet } from '@/lib/storage'

/** 自定义提示词在 localStorage 中的持久化 key */
const CUSTOM_PROMPTS_KEY = 'mr-huang-agent:custom-prompts'

/** 图标缺省时的默认 emoji */
export const DEFAULT_PROMPT_ICON = '📝'

/** 提示词条目的持久化数据结构（内置与自定义共用同一套字段） */
export interface PromptEntry {
  id: string
  name: string
  description: string
  /** 提示词正文（支持多行模板与 {{变量}} 占位符） */
  content: string
  icon: string
  tags: string[]
  /** 来源标记（builtin=内置只读 / manual=手工创建） */
  source: 'builtin' | 'manual'
  /** 创建时间戳（毫秒） */
  createdAt: number
  /** 最近更新时间戳（毫秒）；内置条目恒为其定义时刻的固定值 */
  updatedAt: number
}

/** 新建/编辑自定义提示词的入参（id 与时间戳由 store 生成） */
export type PromptInput = Omit<PromptEntry, 'id' | 'source' | 'createdAt' | 'updatedAt'>

/** 合并视图清单条目：内置在前、自定义在后，统一结构（内置即 BuiltinPrompt 加时间戳） */
export type PromptView = PromptEntry

/** 校验 localStorage 中读出的条目是否为合法的自定义提示词 */
function isValidCustomPrompt(value: unknown): value is PromptEntry {
  if (typeof value !== 'object' || value === null) return false
  const prompt = value as Record<string, unknown>
  return (
    typeof prompt.id === 'string' &&
    typeof prompt.name === 'string' &&
    typeof prompt.description === 'string' &&
    typeof prompt.content === 'string' &&
    typeof prompt.icon === 'string' &&
    Array.isArray(prompt.tags) &&
    prompt.tags.every((tag) => typeof tag === 'string') &&
    typeof prompt.createdAt === 'number' &&
    typeof prompt.updatedAt === 'number'
  )
}

/** 读取自定义提示词列表；localStorage 不可用或数据损坏时回退空数组 */
function readCustomPrompts(): PromptEntry[] {
  try {
    const raw = storageGet(CUSTOM_PROMPTS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isValidCustomPrompt).map((prompt) => ({
      ...prompt,
      tags: [...prompt.tags],
    }))
  } catch {
    // 数据损坏（非法 JSON 等）时回退空列表
    return []
  }
}

export const usePromptsStore = defineStore('prompts', () => {
  /** 自定义提示词列表（持久化到 localStorage） */
  const customPrompts = ref<PromptEntry[]>(readCustomPrompts())

  /** 合并视图清单：内置只读在前，自定义在后（每次返回新数组与全新 tags，避免外部直接改内置数据） */
  const prompts = computed<PromptView[]>(() => [
    ...BUILTIN_PROMPTS.map((prompt: BuiltinPrompt): PromptView => ({
      ...prompt,
      tags: [...prompt.tags],
      // 内置条目不可编辑，时间戳固定为模块定义时刻
      createdAt: 0,
      updatedAt: 0,
    })),
    ...customPrompts.value.map((prompt) => ({ ...prompt, tags: [...prompt.tags] })),
  ])

  /** 自定义提示词数量 */
  const customCount = computed(() => customPrompts.value.length)

  /** 全部标签去重清单（标签筛选器用） */
  const allTags = computed<string[]>(() => {
    const tags = new Set<string>()
    for (const prompt of prompts.value) {
      for (const tag of prompt.tags) tags.add(tag)
    }
    return [...tags]
  })

  /** 在合并清单中按 id 查找；找不到返回 undefined（调用方自行兜底） */
  function findPrompt(id: string): PromptView | undefined {
    return prompts.value.find((prompt) => prompt.id === id)
  }

  /** 新建自定义提示词，返回生成的 id（source 标记 manual） */
  function addCustomPrompt(data: PromptInput): string {
    const now = Date.now()
    const id = crypto.randomUUID()
    const entry: PromptEntry = {
      ...data,
      icon: data.icon.trim() || DEFAULT_PROMPT_ICON,
      id,
      source: 'manual',
      createdAt: now,
      updatedAt: now,
    }
    customPrompts.value = [...customPrompts.value, entry]
    return id
  }

  /** 编辑自定义提示词；id 不存在或为内置条目时返回 false */
  function updateCustomPrompt(id: string, data: PromptInput): boolean {
    const exists = customPrompts.value.some((prompt) => prompt.id === id)
    if (!exists) return false
    customPrompts.value = customPrompts.value.map((prompt) =>
      prompt.id === id
        ? {
            ...prompt,
            ...data,
            icon: data.icon.trim() || DEFAULT_PROMPT_ICON,
            updatedAt: Date.now(),
          }
        : prompt,
    )
    return true
  }

  /** 删除自定义提示词（内置不可删除，返回 false） */
  function removeCustomPrompt(id: string): boolean {
    const exists = customPrompts.value.some((prompt) => prompt.id === id)
    if (!exists) return false
    customPrompts.value = customPrompts.value.filter((prompt) => prompt.id !== id)
    return true
  }

  // 状态变化 → 持久化到 localStorage（失败时静默降级，仅当前会话生效）
  watch(customPrompts, (next) => {
    try {
      storageSet(CUSTOM_PROMPTS_KEY, JSON.stringify(next))
    } catch {
      // 忽略持久化失败
    }
  })

  return {
    prompts,
    customCount,
    allTags,
    findPrompt,
    addCustomPrompt,
    updateCustomPrompt,
    removeCustomPrompt,
  }
})
