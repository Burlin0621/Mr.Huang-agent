import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

/** 一套模型配置（OpenAI 兼容端点 + 采样参数） */
export interface LlmConfig {
  id: string
  /** 显示名称 */
  name: string
  /** 厂商预设 key（model-presets.ts 中的 key 或 'custom'） */
  providerKey: string
  baseUrl: string
  apiKey: string
  modelId: string
  temperature: number
  timeoutSeconds: number
  maxRetries: number
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
    temperature: DEFAULT_TEMPERATURE,
    timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
    maxRetries: DEFAULT_MAX_RETRIES,
  }
}

/** 读取持久化的配置列表，逐条做防御性归一化（坏数据直接丢弃） */
function loadConfigs(): LlmConfig[] {
  try {
    const raw = localStorage.getItem(CONFIGS_STORAGE_KEY)
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
      const modelId = typeof record.modelId === 'string' ? record.modelId : ''
      if (!id || !name.trim() || !baseUrl.trim() || !modelId.trim()) continue
      configs.push({
        id,
        name: name.trim(),
        providerKey: typeof record.providerKey === 'string' ? record.providerKey : 'custom',
        baseUrl: baseUrl.trim(),
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : '',
        modelId: modelId.trim(),
        temperature: clampNumber(record.temperature, 0, 2, DEFAULT_TEMPERATURE),
        timeoutSeconds: Math.round(
          clampNumber(record.timeoutSeconds, 1, 3600, DEFAULT_TIMEOUT_SECONDS),
        ),
        maxRetries: Math.round(clampNumber(record.maxRetries, 0, 5, DEFAULT_MAX_RETRIES)),
      })
    }
    return configs
  } catch {
    return []
  }
}

function loadActiveId(): string {
  try {
    return localStorage.getItem(ACTIVE_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

function persistTo(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
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

  /** 新增配置；若当前没有选中的配置则自动设为当前使用。返回新配置 id。 */
  function addConfig(input: Omit<LlmConfig, 'id'>): string {
    const id = crypto.randomUUID()
    configs.value.push({ ...input, id })
    if (!activeConfigId.value) {
      activeConfigId.value = id
    }
    return id
  }

  /** 按 id 全量更新配置 */
  function updateConfig(next: LlmConfig): void {
    const index = configs.value.findIndex((config) => config.id === next.id)
    if (index >= 0) {
      configs.value[index] = { ...next }
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
