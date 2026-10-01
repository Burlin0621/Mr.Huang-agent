<script setup lang="ts">
import { computed, ref } from 'vue'

import AgentAvatar from '@/components/AgentAvatar.vue'
import AppIcon from '@/components/AppIcon.vue'
import {
  EMOJI_AVATARS,
  SYSTEM_AVATARS,
  type AgentAvatar as AgentAvatarValue,
} from '@/lib/agents'
import type { AgentView } from '@/stores/agents'

/** 上传图片大小上限（字节），2MB */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024
/** 允许上传的图片 MIME 类型 */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

const props = defineProps<{ agent: AgentView }>()
const emit = defineEmits<{
  close: []
  /** confirm 携带草稿头像；null 表示恢复该智能体默认（回退 icon emoji 展示） */
  confirm: [avatar: AgentAvatarValue | null]
}>()

/** 草稿头像（null 表示跟随智能体默认，用 icon 兜底展示）；选中即在大预览区生效 */
const draft = ref<AgentAvatarValue | null>(props.agent.avatar ?? null)

/** 当前草稿的文字说明（预览区展示当前选择） */
const draftLabel = computed(() => {
  const current = draft.value
  if (!current) return `默认（跟随图标 ${props.agent.icon || '🤖'}）`
  if (current.kind === 'default') {
    const label = SYSTEM_AVATARS.find((item) => item.id === current.id)?.label
    return `系统默认 · ${label ?? '头像'}`
  }
  if (current.kind === 'emoji') return `Emoji · ${current.value}`
  return '自定义上传图片'
})

/** 上传校验错误文字（空串表示无错误） */
const uploadError = ref('')

/** 隐藏的文件选择输入 */
const fileInput = ref<HTMLInputElement | null>(null)

/** 系统 SVG 分组当前选中 id（未选或来源不同时为 null） */
const selectedSystemId = computed(() =>
  draft.value?.kind === 'default' ? draft.value.id : null,
)

/** Emoji 分组当前选中值（未选或来源不同时为 null） */
const selectedEmoji = computed(() => (draft.value?.kind === 'emoji' ? draft.value.value : null))

/** 选中系统默认头像 */
function pickSystem(id: string): void {
  draft.value = { kind: 'default', id }
}

/** 选中 emoji 头像 */
function pickEmoji(value: string): void {
  draft.value = { kind: 'emoji', value }
}

/** 恢复该智能体默认头像（清除头像设置，展示回退 icon emoji） */
function resetToDefault(): void {
  draft.value = null
  uploadError.value = ''
}

/** 触发文件选择器 */
function pickUploadFile(): void {
  uploadError.value = ''
  fileInput.value?.click()
}

/** 选择上传文件后：校验类型与大小，FileReader 转 base64 data URL 进草稿 */
function onFileChange(event: Event): void {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  // 清空 value 允许连续选择同一文件再次触发 change
  input.value = ''
  if (!file) return

  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    uploadError.value = '不支持的图片格式，请选择 PNG / JPG / WebP / GIF 图片'
    return
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    uploadError.value = '图片大小超过 2MB，请压缩后再上传'
    return
  }

  const reader = new FileReader()
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      draft.value = { kind: 'image', data: reader.result }
      uploadError.value = ''
    } else {
      uploadError.value = '图片读取失败，请重试'
    }
  }
  reader.onerror = () => {
    uploadError.value = '图片读取失败，请重试'
  }
  reader.readAsDataURL(file)
}

/** 确认：把草稿头像交给父级写入 store */
function confirmPicker(): void {
  emit('confirm', draft.value)
}
</script>

<template>
  <div class="modal-mask avatar-picker-mask" @click.self="emit('close')">
    <div class="modal avatar-picker" role="dialog" aria-modal="true" aria-label="更换头像">
      <header class="modal-head">
        <h2>更换头像</h2>
        <button class="icon-button" type="button" aria-label="关闭" @click="emit('close')">
          <AppIcon name="close" />
        </button>
      </header>

      <div class="avatar-picker-body">
        <!-- 预览区：大尺寸所见即所得 + 上传 / 恢复默认 -->
        <div class="avatar-preview">
          <span class="avatar-preview-figure" aria-hidden="true">
            <AgentAvatar :avatar="draft ?? undefined" :icon="agent.icon" :name="agent.name" />
          </span>
          <div class="avatar-preview-copy">
            <strong class="avatar-preview-name">{{ agent.name }}</strong>
            <p class="avatar-preview-state">{{ draftLabel }}</p>
            <div class="avatar-preview-actions">
              <button class="btn btn-primary" type="button" @click="pickUploadFile">
                <AppIcon name="upload" />
                上传图片
              </button>
              <button
                class="btn btn-ghost"
                type="button"
                :disabled="draft === null"
                @click="resetToDefault"
              >
                恢复默认
              </button>
            </div>
            <p class="avatar-preview-hint">支持 PNG / JPG / WebP / GIF，大小不超过 2MB，建议使用方形图片</p>
            <p v-if="uploadError" class="avatar-preview-error" role="alert">{{ uploadError }}</p>
          </div>
          <!-- 隐藏的文件选择输入：由「上传图片」按钮触发 -->
          <input
            ref="fileInput"
            class="avatar-file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-hidden="true"
            tabindex="-1"
            @change="onFileChange"
          />
        </div>

        <!-- 系统默认分组：职业角色头像（内联 SVG 插画） -->
        <section class="avatar-group">
          <h3 class="avatar-group-title">系统默认</h3>
          <div class="avatar-system-grid" role="listbox" aria-label="系统默认头像">
            <button
              v-for="item in SYSTEM_AVATARS"
              :key="item.id"
              class="avatar-option"
              :class="{ 'is-selected': selectedSystemId === item.id }"
              type="button"
              role="option"
              :aria-selected="selectedSystemId === item.id"
              @click="pickSystem(item.id)"
            >
              <span class="avatar-option-figure" aria-hidden="true">
                <AgentAvatar :avatar="{ kind: 'default', id: item.id }" />
              </span>
              <span class="avatar-option-label">{{ item.label }}</span>
            </button>
          </div>
        </section>

        <!-- Emoji 分组：常用 emoji 网格 -->
        <section class="avatar-group">
          <h3 class="avatar-group-title">Emoji</h3>
          <div class="avatar-emoji-grid" role="listbox" aria-label="Emoji 头像">
            <button
              v-for="value in EMOJI_AVATARS"
              :key="value"
              class="avatar-emoji"
              :class="{ 'is-selected': selectedEmoji === value }"
              type="button"
              role="option"
              :aria-selected="selectedEmoji === value"
              :title="value"
              @click="pickEmoji(value)"
            >
              {{ value }}
            </button>
          </div>
        </section>
      </div>

      <footer class="avatar-picker-foot">
        <button class="btn btn-ghost" type="button" @click="emit('close')">取消</button>
        <button class="btn btn-primary" type="button" @click="confirmPicker">确定</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* —— 弹窗骨架（视觉与 AgentsView 的模态一致，组件内自包含） —— */
.modal-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-5);
  background: var(--overlay-bg);
}

.modal {
  width: 100%;
  max-width: 560px;
  max-height: calc(100vh - var(--space-8));
  overflow-y: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
}

.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-6);
  border-bottom: 1px solid var(--color-border);
}

.modal-head h2 {
  font-size: var(--font-size-lg);
  font-weight: 600;
}

/* 弹窗主体：头部 / 内容区 / 底部操作条三段纵向布局，内容区内部滚动 */
.avatar-picker {
  display: flex;
  flex-direction: column;
  max-width: 560px;
}

.avatar-picker-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-height: 0;
  max-height: calc(78vh - 120px);
  overflow-y: auto;
  padding: var(--space-5) var(--space-6);
}

/* —— 预览区 —— */
.avatar-preview {
  display: flex;
  align-items: flex-start;
  gap: var(--space-5);
  padding: var(--space-5);
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.avatar-preview-figure {
  display: inline-flex;
  width: 104px;
  height: 104px;
  flex-shrink: 0;
  overflow: hidden;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
}

.avatar-preview-copy {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  min-width: 0;
  flex: 1;
}

.avatar-preview-name {
  font-size: var(--font-size-lg);
}

.avatar-preview-state {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.avatar-preview-actions {
  display: flex;
  gap: var(--space-3);
  flex-wrap: wrap;
  margin-top: var(--space-1);
}

.avatar-preview-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.avatar-preview-error {
  margin: 0;
  color: var(--color-danger);
  font-size: var(--font-size-xs);
}

/* 隐藏文件输入 */
.avatar-file-input {
  display: none;
}

/* —— 分组标题 —— */
.avatar-group {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.avatar-group-title {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

/* —— 系统默认网格：桌面端 5 列，窄屏降列 —— */
.avatar-system-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: var(--space-3);
}

.avatar-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: var(--space-2);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  font: inherit;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.avatar-option:hover {
  border-color: var(--color-border-strong);
}

.avatar-option.is-selected {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
  color: var(--color-text);
}

.avatar-option-figure {
  display: inline-flex;
  width: 44px;
  height: 44px;
  overflow: hidden;
  border-radius: var(--radius-md);
}

.avatar-option-label {
  font-size: var(--font-size-xs);
  line-height: 1.2;
}

/* —— Emoji 网格：小方格密集排列 —— */
.avatar-emoji-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
  gap: var(--space-2);
}

.avatar-emoji {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  padding: 0;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: var(--font-size-xl);
  line-height: 1;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.avatar-emoji:hover {
  border-color: var(--color-border-strong);
}

.avatar-emoji.is-selected {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

/* —— 底部操作条 —— */
.avatar-picker-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-6);
  border-top: 1px solid var(--color-border);
}

/* 窄屏：预览区改纵向、系统网格降为 3 列 */
@media (max-width: 560px) {
  .avatar-preview {
    flex-direction: column;
  }

  .avatar-system-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}
</style>
