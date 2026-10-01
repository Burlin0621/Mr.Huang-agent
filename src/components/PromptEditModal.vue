<script setup lang="ts">
import { computed, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { extractTemplateVars } from '@/lib/builtin-prompts'

/** 新建/编辑提示词的表单数据（tags 以分隔符原文回显，提交时再解析） */
export interface PromptEditForm {
  name: string
  description: string
  content: string
  icon: string
  tags: string
}

const props = defineProps<{
  /** 正在编辑的提示词 id；null 表示新建 */
  editingId: string | null
  /** 表单初始值（新建传空表单，编辑回填当前值） */
  initial: PromptEditForm
}>()

const emit = defineEmits<{
  close: []
  /** 提交成功：返回整理后的表单数据 */
  submit: [form: PromptEditForm]
}>()

/** 正文输入框占位文案（含 {{变量}} 示例，经绑定传入避免与模板插值冲突） */
const CONTENT_PLACEHOLDER = '完整提示词模板；用 {{变量}} 标记需要每次填写的内容，例如 {{原文}}'

/** 正文字段标签提示文案（同上，经绑定传入避免与模板插值冲突） */
const VARS_HINT = '（支持多行，可用 {{变量}} 占位符）'

const form = ref<PromptEditForm>({ ...props.initial })
const formErrors = ref({ name: '', description: '', content: '' })

/** 图标实时预览：留空回退默认 emoji（展示兜底逻辑在卡片层，这里仅提示输入） */
const iconPreview = computed(() => form.value.icon.trim() || '📝')

/** 正文中的 {{变量}} 名列表（展示占位符提示） */
const templateVars = computed(() => extractTemplateVars(form.value.content))

/** 解析标签输入：按中英文逗号拆分，trim 后去空去重 */
function parseTags(input: string): string[] {
  return Array.from(
    new Set(
      input
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  )
}

function submitForm(): void {
  const name = form.value.name.trim()
  const description = form.value.description.trim()
  const content = form.value.content.trim()
  formErrors.value = {
    name: name ? '' : '请输入名称',
    description: description ? '' : '请输入一句话描述',
    content: content ? '' : '请输入提示词正文',
  }
  if (!name || !description || !content) return
  emit('submit', {
    name,
    description,
    content,
    icon: form.value.icon.trim(),
    tags: parseTags(form.value.tags).join('，'),
  })
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div
      class="modal"
      role="dialog"
      aria-modal="true"
      :aria-label="editingId ? '编辑提示词' : '新建提示词'"
    >
      <header class="modal-head">
        <h2>{{ editingId ? '编辑提示词' : '新建提示词' }}</h2>
        <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')">
          <AppIcon name="close" />
        </button>
      </header>

      <form class="modal-form" @submit.prevent="submitForm">
        <div class="form-row">
          <label class="field">
            <span class="field-label">
              图标<span class="field-hint">（emoji，留空默认 📝）</span>
            </span>
            <span class="icon-field">
              <input
                v-model="form.icon"
                class="field-input"
                type="text"
                maxlength="4"
                placeholder="📝"
              />
              <span class="icon-preview" aria-hidden="true">{{ iconPreview }}</span>
            </span>
          </label>

          <label class="field field-grow">
            <span class="field-label"
              >名称<span class="field-required" aria-hidden="true">*</span></span
            >
            <input
              v-model="form.name"
              class="field-input"
              type="text"
              placeholder="例如：会议纪要整理"
            />
            <span v-if="formErrors.name" class="field-error">{{ formErrors.name }}</span>
          </label>
        </div>

        <label class="field">
          <span class="field-label"
            >一句话描述<span class="field-required" aria-hidden="true">*</span></span
          >
          <input
            v-model="form.description"
            class="field-input"
            type="text"
            placeholder="一句话说明用途，例如：把会议速记整理成规范纪要"
          />
          <span v-if="formErrors.description" class="field-error">{{
            formErrors.description
          }}</span>
        </label>

        <label class="field">
          <span class="field-label">
            提示词正文<span class="field-required" aria-hidden="true">*</span>
            <span class="field-hint">{{ VARS_HINT }}</span>
          </span>
          <textarea
            v-model="form.content"
            class="field-input field-textarea"
            rows="10"
            :placeholder="CONTENT_PLACEHOLDER"
          ></textarea>
          <span v-if="formErrors.content" class="field-error">{{ formErrors.content }}</span>
          <span v-if="templateVars.length" class="field-hint-line">
            已识别 {{ templateVars.length }} 个变量：{{ templateVars.join('、') }}
          </span>
        </label>

        <label class="field">
          <span class="field-label">标签</span>
          <input
            v-model="form.tags"
            class="field-input"
            type="text"
            placeholder="多个标签用逗号分隔，例如：办公，写作"
          />
        </label>

        <footer class="modal-foot">
          <button class="btn btn-ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn btn-primary" type="submit">保存</button>
        </footer>
      </form>
    </div>
  </div>
</template>

<style scoped>
.form-row {
  display: flex;
  gap: var(--space-4);
}

.icon-field {
  position: relative;
  display: block;
}

.icon-field .field-input {
  padding-right: 40px;
}

.icon-preview {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  font-size: var(--font-size-lg);
  pointer-events: none;
}

.field-grow {
  flex: 1;
}

.field-hint {
  color: var(--color-text-muted);
  font-weight: 400;
}

.field-hint-line {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.modal-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

@media (max-width: 640px) {
  .form-row {
    flex-direction: column;
  }
}
</style>
