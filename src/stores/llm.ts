import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { storageGet, storageSet } from '@/lib/storage'

/** 一套模型配置（OpenAI 兼容端点 + 采样参数） */
export interface LlmConfig {
  id: string
  /** 显示名称 */
  name: string
  /** 厂商预设 key（model-presets.ts 中的 key 或 'custom'） */
  providerKey: string
  baseUrl: string
  apiKey: string
  /** 主模型 ID（冗余字段，恒等于 modelIds[0]，保留以兼容既有调用点） */
  modelId: string
  /** 可用模型列表（多选），第一个元素为主模型 */
  modelIds: string[]
  temperature: number
  timeoutSeconds: number
  maxRetries: number
  /** 是否支持视觉（图片输入）：发送图片附件时据此提示用户（未勾选仅提示不阻止） */
  supportsVision: boolean
}

const CONFIGS_STORAGE_KEY = 'mr-huang-agent:llm-configs'
const ACTIVE_STORAGE_KEY = 'mr-huang-agent:llm-active'

export const DEFAULT_TEMPERATURE = 0.7
export const DEFAULT_TIMEOUT_SECONDS = 600
export const DEFAULT_MAX_RETRIES = 2

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

/** 新建配置的默认值（供设置页表单使用） */
export function createDefaultConfigDraft(): LlmConfig {
  return {
    id: '',
    name: '',
    providerKey: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    modelId: '',
    modelIds: [],
    temperature: DEFAULT_TEMPERATURE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    maxRetries: DEFAULT_MAX_RETRIES,
    supportsVision: false,
  }
}

/**
 * 归一化模型列表：逐项去空白、去重；列表缺失/为空时回退到旧的 modelId 单值字段
 * （旧数据迁移：modelId(string) → modelIds = [modelId]）。纯函数，便于直接单测。
 */
export function normalizeModelIds(rawModelIds: unknown, fallbackModelId: unknown): string[] {
  const ids: string[] = []
  if (Array.isArray(rawModelIds)) {
    for (const item of rawModelIds) {
      if (typeof item === 'string' && item.trim() && !ids.includes(item.trim())) {
        ids.push(item.trim())
      }
    }
  }
  if (ids.length === 0 && typeof fallbackModelId === 'string' && fallbackModelId.trim()) {
    ids.push(fallbackModelId.trim())
  }
  return ids
}

/** 读取持久化的配置列表，逐条做防御性归一化（坏数据直接丢弃） */
export function loadConfigs(): LlmConfig[] {
  try {
    const raw = storageGet(CONFIGS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const configs: LlmConfig[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const record = item as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : ''
      const name = typeof record.name === 'string' ? record.name : ''
      const baseUrl = typeof record.baseUrl === 'string' ? record.baseUrl : ''
      const modelIds = normalizeModelIds(record.modelIds, record.modelId)
      if (!id || !name.trim() || !baseUrl.trim() || modelIds.length === 0) continue
      configs.push({
        id,
        name: name.trim(),
        providerKey: typeof record.providerKey === 'string' ? record.providerKey : 'custom',
        baseUrl: baseUrl.trim(),
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
        modelId: modelIds[0],
        modelIds,
        temperature: clampNumber(record.temperature, 0, 2, DEFAULT_TEMPERATURE),
        timeoutSeconds: Math.round(
          clampNumber(record.timeoutSeconds, 1, 3600, DEFAULT_TIMEOUT_SECONDS),
        ),
        maxRetries: Math.round(clampNumber(record.maxRetries, 0, 5, DEFAULT_MAX_RETRIES)),
        supportsVision: record.supportsVision === true,
      })
    }
    return configs
  } catch {
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
    // localStorage 不可用时静默降级（仅当前会话生效）
  }
}

export const useLlmStore = defineStore('llm', () => {
  /** 全部模型配置 */
  const configs = ref<LlmConfig[]>(loadConfigs())

  /** 当前使用的配置 id（空字符串表示尚未选择） */
  const activeConfigId = ref<string>(loadActiveId())

  /** 当前使用的配置 */
  const activeConfig = computed<LlmConfig | null>(
    () => configs.value.find((config) => config.id === activeConfigId.value) ?? null,
  )

  watch(
    configs,
    (next) => {
      persistTo(CONFIGS_STORAGE_KEY, JSON.stringify(next))
    },
    { deep: true },
  )

  watch(activeConfigId, (next) => {
    persistTo(ACTIVE_STORAGE_KEY, next)
  })

  /** 当前 id 失效（例如被删除）时自动清空选择 */
  watch(
    configs,
    (next) => {
      if (activeConfigId.value && !next.some((config) => config.id === activeConfigId.value)) {
        activeConfigId.value = ''
      }
    },
    { deep: true },
  )

  /** 写入前归一化模型列表，并保持 modelId = modelIds[0]（主模型冗余） */
  function withNormalizedModels<T extends LlmConfig | Omit<LlmConfig, 'id'>>(input: T): T {
    const modelIds = normalizeModelIds(input.modelIds, input.modelId)
    return { ...input, modelIds, modelId: modelIds[0] ?? '' }
  }

  /** 新增配置；若当前没有选中的配置则自动设为当前使用。返回新配置 id。 */
  function addConfig(input: Omit<LlmConfig, 'id'>): string {
    const id = crypto.randomUUID()
    configs.value.push({ ...withNormalizedModels(input), id })
    if (!activeConfigId.value) {
      activeConfigId.value = id
    }
    return id
  }

  /** 按 id 全量更新配置 */
  function updateConfig(next: LlmConfig): void {
    const index = configs.value.findIndex((config) => config.id === next.id)
    if (index >= 0) {
      configs.value[index] = { ...withNormalizedModels(next) }
    }
  }

  /** 删除配置；若删除的是当前使用项则清空选择 */
  function removeConfig(id: string): void {
    const index = configs.value.findIndex((config) => config.id === id)
    if (index >= 0) {
      configs.value.splice(index, 1)
    }
    if (activeConfigId.value === id) {
      activeConfigId.value = ''
    }
  }

  /** 设为当前使用 */
  function setActiveConfig(id: string): void {
    if (configs.value.some((config) => config.id === id)) {
      activeConfigId.value = id
    }
  }

  return {
    configs,
    activeConfigId,
    activeConfig,
    addConfig,
    updateConfig,
    removeConfig,
    setActiveConfig,
  }
})
