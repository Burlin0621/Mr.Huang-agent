/**
 * 大模型厂商预设（OpenAI 兼容接口）
 * baseUrl 均不含 /chat/completions 后缀，请求层会自动拼接
 */

export interface ModelProviderPreset {
  /** 预设唯一标识 */
  key: string
  /** 展示名称 */
  label: string
  /** OpenAI 兼容 baseUrl（例如 https://api.deepseek.com/v1） */
  baseUrl: string
  /** 是否允许不填 API Key（本地推理服务无需鉴权） */
  apiKeyOptional: boolean
  /** 补充说明 */
  desc: string
}

/** 自定义厂商的预设 key */
export const CUSTOM_PROVIDER_KEY = 'custom'

/** 常用厂商预设（参考 EvoPanel 的 PROVIDER_PRESETS 精简而来） */
export const PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    key: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyOptional: false,
    desc: '智谱 AI 开放平台，支持 GLM 全系列模型',
  },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyOptional: false,
    desc: 'DeepSeek 官方接口，deepseek-chat / deepseek-reasoner 等',
  },
  {
    key: 'aliyun',
    label: '阿里百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyOptional: false,
    desc: '阿里云百炼模型服务，支持通义千问全系列',
  },
  {
    key: 'moonshot',
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKeyOptional: false,
    desc: '月之暗面官方接口，支持 Kimi 系列模型',
  },
  {
    key: 'volcengine',
    label: '火山方舟',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKeyOptional: false,
    desc: '火山引擎方舟推理服务，模型 ID 通常为接入点 ID（ep-xxx）',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    apiKeyOptional: false,
    desc: 'OpenAI 官方接口，也可改填任意 OpenAI 兼容网关地址',
  },
  {
    key: 'ollama',
    label: 'Ollama（本地）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeyOptional: true,
    desc: '本机 Ollama 服务的 OpenAI 兼容接口，无需 API Key',
  },
]

/** 按 key 查找预设，找不到（含 custom）返回 null */
export function getProviderPreset(key: string): ModelProviderPreset | null {
  return PROVIDER_PRESETS.find((preset) => preset.key === key) ?? null
}

/** 是否为自定义厂商 */
export function isCustomProvider(key: string): boolean {
  return key === CUSTOM_PROVIDER_KEY
}

/** 获取厂商展示名；未知 key 回退为「自定义」 */
export function providerLabel(key: string): string {
  return getProviderPreset(key)?.label ?? '自定义'
}
