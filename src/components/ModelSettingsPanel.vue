<script setup lang="ts">
import { computed, reactive, ref } from 'vue'

import {
  CUSTOM_PROVIDER_KEY,
  PROVIDER_PRESETS,
  getProviderPreset,
  providerLabel,
} from '@/lib/model-presets'
import { testLlmConnection, type ConnectivityResult } from '@/lib/llm'
import { createDefaultConfigDraft, useLlmStore, type LlmConfig } from '@/stores/llm'

const llmStore = useLlmStore()

/* —— 表单状态 —— */

const isEditing = ref(false)
/** 正在编辑的配置 id；空字符串表示新增 */
const editingId = ref('')
const showApiKey = ref(false)

const form = reactive<LlmConfig>(createDefaultConfigDraft())

const formErrors = ref<string[]>([])

/** 当前表单对应的预设是否允许不填 API Key */
const apiKeyOptional = computed(() => getProviderPreset(form.providerKey)?.apiKeyOptional ?? false)

function startCreate(): void {
  Object.assign(form, createDefaultConfigDraft())
  editingId.value = ''
  formErrors.value = []
  testResult.value = null
  showApiKey.value = false
  isEditing.value = true
}

function startEdit(config: LlmConfig): void {
  Object.assign(form, { ...config })
  editingId.value = config.id
  formErrors.value = []
  testResult.value = null
  showApiKey.value = false
  isEditing.value = true
}

function cancelEdit(): void {
  isEditing.value = false
  editingId.value = ''
}

/** 切换厂商预设时自动填充 baseUrl（自定义则保留原值由用户填写） */
function onProviderChange(): void {
  const preset = getProviderPreset(form.providerKey)
  if (preset) {
    form.baseUrl = preset.baseUrl
  }
  formErrors.value = []
}

function validateForm(): string[] {
  const errors: string[] = []
  if (!form.name.trim()) errors.push('显示名称不能为空')
  if (!form.baseUrl.trim()) {
    errors.push('接口地址（baseUrl）不能为空')
  } else if (!/^https?:\/\//i.test(form.baseUrl.trim())) {
    errors.push('接口地址必须以 http:// 或 https:// 开头')
  }
  if (!form.modelId.trim()) errors.push('模型 ID 不能为空')
  if (!form.apiKey.trim() && !apiKeyOptional.value) {
    errors.push(`该厂商需要填写 API Key（${providerLabel(form.providerKey)}）`)
  }
  return errors
}

function clampField(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function buildConfigFromForm(): LlmConfig {
  return {
    id: editingId.value || form.id,
    name: form.name.trim(),
    providerKey: form.providerKey,
    baseUrl: form.baseUrl.trim(),
    apiKey: form.apiKey.trim(),
    modelId: form.modelId.trim(),
    temperature: clampField(Number(form.temperature), 0, 2),
    timeoutSeconds: Math.round(clampField(Number(form.timeoutSeconds), 1, 3600)),
    maxRetries: Math.round(clampField(Number(form.maxRetries), 0, 5)),
  }
}

function saveForm(): void {
  const errors = validateForm()
  formErrors.value = errors
  if (errors.length > 0) return

  const config = buildConfigFromForm()
  if (editingId.value) {
    llmStore.updateConfig(config)
  } else {
    llmStore.addConfig(config)
  }
  cancelEdit()
}

function removeConfig(config: LlmConfig): void {
  if (editingId.value === config.id) {
    cancelEdit()
  }
  llmStore.removeConfig(config.id)
}

/* —— 连接测试 —— */

const testing = ref(false)
const testResult = ref<ConnectivityResult | null>(null)

async function runTest(): Promise<void> {
  const errors = validateForm()
  if (errors.length > 0) {
    formErrors.value = errors
    testResult.value = null
    return
  }
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await testLlmConnection(buildConfigFromForm())
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="model-settings">
    <header class="section-head">
      <h2>模型接入</h2>
      <p>
        支持多套 OpenAI 兼容模型配置（智谱 GLM、DeepSeek、阿里百炼等），保存后可在「AI
        对话」页切换使用；配置仅存储在本机浏览器 localStorage，不会上传。
      </p>
    </header>

    <!-- 配置列表 -->
    <ul v-if="llmStore.configs.length > 0" class="config-list">
      <li
        v-for="config in llmStore.configs"
        :key="config.id"
        class="config-item"
        :class="{ 'is-active': config.id === llmStore.activeConfigId }"
      >
        <div class="config-info">
          <div class="config-title-row">
            <span class="config-name">{{ config.name }}</span>
            <span class="badge badge-info">{{ providerLabel(config.providerKey) }}</span>
            <span v-if="config.id === llmStore.activeConfigId" class="badge badge-muted">
              当前使用
            </span>
          </div>
          <div class="config-meta">
            <code class="config-model">{{ config.modelId }}</code>
            <span class="config-url" :title="config.baseUrl">{{ config.baseUrl }}</span>
          </div>
        </div>
        <div class="config-actions">
          <button
            v-if="config.id !== llmStore.activeConfigId"
            class="btn btn-ghost btn-sm"
            type="button"
            @click="llmStore.setActiveConfig(config.id)"
          >
            设为当前
          </button>
          <button class="btn btn-ghost btn-sm" type="button" @click="startEdit(config)">
            编辑
          </button>
          <button
            class="btn btn-ghost btn-sm btn-danger"
            type="button"
            @click="removeConfig(config)"
          >
            删除
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="config-empty">还没有模型配置，点击下方按钮新增一套，即可在 AI 对话页使用。</p>

    <div v-if="!isEditing" class="config-add-row">
      <button class="btn btn-primary" type="button" @click="startCreate">新增配置</button>
    </div>

    <!-- 新增 / 编辑表单 -->
    <form v-else class="config-form" @submit.prevent="saveForm">
      <h3>{{ editingId ? '编辑配置' : '新增配置' }}</h3>

      <div class="form-grid">
        <label class="field">
          <span class="field-label">显示名称 <em>*</em></span>
          <input
            v-model.trim="form.name"
            class="field-input"
            type="text"
            placeholder="例如：智谱主力模型"
          />
        </label>

        <label class="field">
          <span class="field-label">厂商预设</span>
          <select v-model="form.providerKey" class="field-input" @change="onProviderChange">
            <option v-for="preset in PROVIDER_PRESETS" :key="preset.key" :value="preset.key">
              {{ preset.label }}
            </option>
            <option :value="CUSTOM_PROVIDER_KEY">自定义</option>
          </select>
        </label>

        <label class="field field-wide">
          <span class="field-label">接口地址 baseUrl <em>*</em></span>
          <input
            v-model.trim="form.baseUrl"
            class="field-input"
            type="text"
            placeholder="https://api.example.com/v1"
            spellcheck="false"
          />
          <span v-if="getProviderPreset(form.providerKey)" class="field-hint">
            {{ getProviderPreset(form.providerKey)?.desc }}
          </span>
        </label>

        <label class="field field-wide">
          <span class="field-label">
            API Key <em v-if="!apiKeyOptional">*</em>
            <em v-else class="field-optional">（可不填）</em>
          </span>
          <span class="api-key-row">
            <input
              v-model.trim="form.apiKey"
              class="field-input"
              :type="showApiKey ? 'text' : 'password'"
              placeholder="sk-..."
              autocomplete="off"
              spellcheck="false"
            />
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              :aria-label="showApiKey ? '隐藏 API Key' : '显示 API Key'"
              @click="showApiKey = !showApiKey"
            >
              {{ showApiKey ? '隐藏' : '显示' }}
            </button>
          </span>
        </label>

        <label class="field field-wide">
          <span class="field-label">模型 ID <em>*</em></span>
          <input
            v-model.trim="form.modelId"
            class="field-input"
            type="text"
            placeholder="例如：glm-4.6 / deepseek-chat"
            spellcheck="false"
          />
        </label>

        <label class="field">
          <span class="field-label">温度（0 - 2）</span>
          <input
            v-model.number="form.temperature"
            class="field-input"
            type="number"
            min="0"
            max="2"
            step="0.1"
          />
        </label>

        <label class="field">
          <span class="field-label">请求超时（秒）</span>
          <input
            v-model.number="form.timeoutSeconds"
            class="field-input"
            type="number"
            min="1"
            max="3600"
            step="1"
          />
        </label>

        <label class="field">
          <span class="field-label">重试次数</span>
          <input
            v-model.number="form.maxRetries"
            class="field-input"
            type="number"
            min="0"
            max="5"
            step="1"
          />
        </label>
      </div>

      <p v-if="formErrors.length > 0" class="form-errors" role="alert">
        <template v-for="(error, index) in formErrors" :key="index">
          {{ error }}
          <br v-if="index < formErrors.length - 1" />
        </template>
      </p>

      <!-- 连接测试结果 -->
      <p
        v-if="testResult"
        class="test-result"
        :class="testResult.ok ? 'is-ok' : 'is-fail'"
        role="status"
      >
        <template v-if="testResult.ok">
          连接成功（耗时 {{ testResult.durationMs }} ms）：模型回复「{{ testResult.message }}」
        </template>
        <template v-else>
          连接失败（{{ testResult.httpStatus ? `HTTP ${testResult.httpStatus}，` : ''
          }}{{ testResult.durationMs }} ms）：{{ testResult.message }}
        </template>
      </p>

      <div class="form-actions">
        <button class="btn btn-primary" type="submit">
          {{ editingId ? '保存修改' : '保存配置' }}
        </button>
        <button
          class="btn btn-ghost"
          type="button"
          :disabled="testing"
          @click="runTest"
        >
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn btn-ghost" type="button" @click="cancelEdit">取消</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.section-head h2 {
  font-size: var(--font-size-xl);
}

.section-head p {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
}

/* —— 配置列表 —— */
.config-list {
  margin-top: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.config-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1.5px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: border-color var(--transition-fast);
}

.config-item.is-active {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.config-info {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.config-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.config-name {
  font-weight: 600;
}

.config-meta {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.config-model {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text);
  white-space: nowrap;
}

.config-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.config-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.btn-sm {
  height: 30px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-sm);
}

.btn-danger {
  color: var(--color-danger);
}

.btn-danger:not(:disabled):hover {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.config-empty {
  margin-top: var(--space-5);
  padding: var(--space-5);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  text-align: center;
}

.config-add-row {
  margin-top: var(--space-4);
}

/* —— 表单 —— */
.config-form {
  margin-top: var(--space-5);
  padding: var(--space-5);
  border: 1.5px solid var(--color-brand);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}

.config-form h3 {
  font-size: var(--font-size-lg);
  margin-bottom: var(--space-4);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.field-wide {
  grid-column: 1 / -1;
}

.field-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.field-label em {
  color: var(--color-danger);
  font-style: normal;
}

.field-optional {
  color: var(--color-text-muted) !important;
}

.field-input {
  height: 38px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  width: 100%;
  transition: border-color var(--transition-fast);
}

.field-input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.field-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.api-key-row {
  display: flex;
  gap: var(--space-2);
}

.api-key-row .field-input {
  flex: 1;
}

.form-errors {
  margin-top: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}

.test-result {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  word-break: break-all;
}

.test-result.is-ok {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.test-result.is-fail {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.form-actions {
  margin-top: var(--space-5);
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
}

@media (max-width: 640px) {
  .config-item {
    flex-direction: column;
    align-items: stretch;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
