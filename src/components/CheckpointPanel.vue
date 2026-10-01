<script setup lang="ts">
import { onMounted, ref } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import {
  deleteCheckpoint,
  hasCheckpointBridge,
  listCheckpoints,
  restoreCheckpoint,
  type CheckpointSummary,
} from '@/lib/desktop-bridge'

/**
 * 检查点面板（回滚到检查点）：
 * - 列出当前会话的全部检查点（时间、操作、涉及文件数、文件路径）；
 * - 「还原」经确认后调用主进程还原（还原前主进程自动二次快照，可撤销误恢复）；
 * - 「删除」用于清理不需要的检查点；
 * - 非桌面环境（无桥接）时展示不可用说明。
 */
const props = defineProps<{ conversationId: string }>()

const emit = defineEmits<{ close: [] }>()

const items = ref<CheckpointSummary[]>([])
const loading = ref(false)
const busyId = ref('')
const message = ref('')

/** 时间格式化为本地短格式 */
function formatTime(timestamp: number): string {
  if (!timestamp) return '未知时间'
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 操作类型的中文展示 */
function operationText(item: CheckpointSummary): string {
  if (item.operation === 'restore') return '还原前快照'
  if (item.tool === 'fs_write') return '写入文件'
  if (item.tool === 'fs_edit') return '编辑文件'
  return item.operation || '未知操作'
}

async function refresh(): Promise<void> {
  loading.value = true
  message.value = ''
  try {
    items.value = await listCheckpoints(props.conversationId)
  } finally {
    loading.value = false
  }
}

/** 还原到指定检查点（主进程在还原前会自动对当前状态二次快照） */
async function restore(item: CheckpointSummary): Promise<void> {
  const ok = window.confirm(
    `确定回滚到该检查点吗？\n\n时间：${formatTime(item.createdAt)}\n操作：${operationText(item)}\n涉及文件：${item.fileCount} 个\n\n当前同名文件的最新状态会先自动快照一份，可在列表中再次回滚撤销本次还原。`,
  )
  if (!ok) return
  busyId.value = item.id
  message.value = ''
  try {
    const result = await restoreCheckpoint(props.conversationId, item.id)
    if (result) {
      message.value = `已回滚：还原 ${result.restored} 个文件，删除 ${result.deleted} 个新建文件。已自动保存还原前快照，可再次回滚撤销。`
    } else {
      message.value = '回滚失败：需要桌面端应用支持。'
    }
    await refresh()
  } catch (err) {
    message.value = `回滚失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    busyId.value = ''
  }
}

/** 删除检查点（清理旧快照，不影响工作区文件） */
async function remove(item: CheckpointSummary): Promise<void> {
  if (!window.confirm(`确定删除该检查点吗？删除后无法再回滚到该时点。`)) return
  busyId.value = item.id
  try {
    const ok = await deleteCheckpoint(props.conversationId, item.id)
    message.value = ok ? '检查点已删除。' : '删除失败：需要桌面端应用支持。'
    await refresh()
  } finally {
    busyId.value = ''
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <div class="cp-overlay" role="dialog" aria-label="检查点与回滚" @click.self="emit('close')">
    <div class="cp-panel">
      <div class="cp-head">
        <span class="cp-title">检查点与回滚</span>
        <button class="cp-close" type="button" title="关闭" @click="emit('close')">
          <AppIcon name="close" />
        </button>
      </div>

      <p v-if="!hasCheckpointBridge()" class="cp-empty">
        检查点功能需要桌面端应用支持（浏览器模式下不可用）。
      </p>
      <p v-else-if="loading" class="cp-empty">正在加载检查点…</p>
      <p v-else-if="items.length === 0" class="cp-empty">
        暂无检查点。智能体执行 fs_write / fs_edit 前会自动创建检查点。
      </p>

      <p v-if="message" class="cp-message">{{ message }}</p>

      <ul v-if="items.length" class="cp-list">
        <li v-for="item in items" :key="item.id" class="cp-item">
          <div class="cp-item-head">
            <span class="cp-op">{{ operationText(item) }}</span>
            <span class="cp-time">{{ formatTime(item.createdAt) }}</span>
            <span class="cp-count">{{ item.fileCount }} 个文件</span>
            <span class="cp-item-actions">
              <button
                class="cp-btn cp-btn-primary"
                type="button"
                :disabled="busyId !== ''"
                @click="restore(item)"
              >
                回滚到此处
              </button>
              <button
                class="cp-btn"
                type="button"
                :disabled="busyId !== ''"
                title="删除该检查点"
                @click="remove(item)"
              >
                删除
              </button>
            </span>
          </div>
          <p class="cp-files">{{ item.files.join('\n') }}</p>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.cp-overlay {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: var(--overlay-bg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.cp-panel {
  width: min(560px, calc(100vw - var(--space-8)));
  max-height: 70vh;
  overflow: auto;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.cp-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.cp-title {
  font-weight: 600;
  color: var(--color-text);
}

.cp-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: var(--space-1);
}

.cp-empty {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.cp-message {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  font-size: var(--font-size-xs);
  color: var(--color-text);
  white-space: pre-wrap;
}

.cp-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.cp-item {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.cp-item-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.cp-op {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text);
}

.cp-time {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.cp-count {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.cp-item-actions {
  margin-left: auto;
  display: flex;
  gap: var(--space-1);
}

.cp-btn {
  padding: 2px var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.cp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.cp-btn-primary {
  color: var(--color-brand);
  border-color: var(--color-brand);
}

.cp-files {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
