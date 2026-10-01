<script setup lang="ts">
import { computed, ref } from 'vue'

import CheckpointPanel from '@/components/CheckpointPanel.vue'
import ToolStepCard from '@/components/ToolStepCard.vue'
import { isTaskActive, type TaskRun, type TaskStep } from '@/lib/task-runner'

/** 可绑定的模型选项（来自 llm-configs store：配置 × 模型 组合） */
export interface TaskModelOption {
  configId: string
  modelId: string
  label: string
}

/**
 * 执行任务卡片（计划闭环）：展示任务标题、整体进度与步骤清单。
 * 每步显示状态徽标（并行/模型标注以角标提示）；待执行步骤可下拉改绑模型；
 * 执行中步骤内的子智能体工具调用复用 ToolStepCard 折叠展示；
 * 完成步骤展开结果摘要，失败步骤附错误与「重新执行剩余步骤」入口。
 * 停止语义：仅中止后续步骤，已开始的当前步等待其自然结束。
 * 「检查点」入口：打开检查点面板，可回滚 fs_write / fs_edit 修改前的工作区文件。
 */
const props = defineProps<{ taskRun: TaskRun; conversationId?: string; modelOptions?: TaskModelOption[] }>()

const emit = defineEmits<{
  stop: []
  resume: []
  bindModel: [stepIndex: number, modelConfigId: string, modelId: string]
}>()

const showCheckpoints = ref(false)

const running = computed(() => isTaskActive(props.taskRun.status))

const doneCount = computed(
  () => props.taskRun.steps.filter((step) => step.status === 'done').length,
)

const progressPercent = computed(() =>
  props.taskRun.steps.length === 0
    ? 0
    : Math.round((doneCount.value / props.taskRun.steps.length) * 100),
)

/** 整体状态徽标文案与样式类 */
const statusBadge = computed(() => {
  switch (props.taskRun.status) {
    case 'running':
      return { text: '执行中', cls: 'is-running' }
    case 'completed':
      return { text: '已完成', cls: 'is-done' }
    case 'failed':
      return { text: '失败', cls: 'is-failed' }
    case 'stopped':
      return { text: '已停止', cls: 'is-stopped' }
    case 'interrupted':
      return { text: '已中断', cls: 'is-stopped' }
    default:
      return { text: props.taskRun.status, cls: '' }
  }
})

/** 单步状态徽标文案 */
function stepStatusText(step: TaskStep): string {
  switch (step.status) {
    case 'pending':
      return '待执行'
    case 'running':
      return '执行中'
    case 'done':
      return '完成'
    case 'failed':
      return '失败'
    default:
      return step.status
  }
}

/** 未完成且可续跑（失败/停止/中断后从剩余步骤继续，已完成步骤结果复用） */
const canResume = computed(
  () =>
    !running.value &&
    props.taskRun.steps.some((step) => step.status !== 'done'),
)

/** 下拉当前值：绑定配置+模型 → 「configId|modelId」，未绑定为 ''（跟随会话模型） */
function stepModelValue(step: TaskStep): string {
  return step.modelConfigId ? `${step.modelConfigId}|${step.modelId ?? ''}` : ''
}

/** 下拉改绑：回传配置与模型（空选项 = 跟随会话模型） */
function onModelChange(stepIndex: number, event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  if (!value) {
    emit('bindModel', stepIndex, '', '')
    return
  }
  const separatorIndex = value.indexOf('|')
  emit('bindModel', stepIndex, value.slice(0, separatorIndex), value.slice(separatorIndex + 1))
}

/** 绑定模型的展示文案（下拉不可用时只读展示） */
function boundModelLabel(step: TaskStep): string {
  const option = props.modelOptions?.find(
    (item) => item.configId === step.modelConfigId && item.modelId === (step.modelId ?? ''),
  )
  return option?.label ?? (step.modelRef ? `@${step.modelRef}` : '指定模型')
}
</script>

<template>
  <div class="task-run-card" :class="{ 'is-running': running }">
    <div class="task-head">
      <span aria-hidden="true">🗂️</span>
      <span class="task-title">{{ taskRun.title }}</span>
      <span class="task-badge" :class="statusBadge.cls">{{ statusBadge.text }}</span>
      <button
        v-if="running"
        class="task-btn"
        type="button"
        title="中止后续步骤（已开始的当前步将等待其自然结束）"
        @click="emit('stop')"
      >
        停止
      </button>
      <button
        v-else-if="canResume"
        class="task-btn"
        type="button"
        title="从失败/未执行的步骤继续，已完成步骤的结果复用"
        @click="emit('resume')"
      >
        重新执行剩余步骤
      </button>
      <button
        v-if="conversationId"
        class="task-btn task-btn-checkpoint"
        type="button"
        title="查看本会话检查点并回滚工作区文件"
        @click="showCheckpoints = true"
      >
        检查点
      </button>
    </div>

    <CheckpointPanel
      v-if="showCheckpoints && conversationId"
      :conversation-id="conversationId"
      @close="showCheckpoints = false"
    />

    <div class="task-progress">
      <div class="task-progress-bar">
        <div class="task-progress-fill" :style="{ width: `${progressPercent}%` }"></div>
      </div>
      <span class="task-progress-text">{{ doneCount }}/{{ taskRun.steps.length }} 步</span>
    </div>

    <p v-if="taskRun.errorText" class="task-error">{{ taskRun.errorText }}</p>

    <ol class="task-steps">
      <li
        v-for="(step, index) in taskRun.steps"
        :key="index"
        class="task-step"
        :class="`is-${step.status}`"
      >
        <div class="task-step-head">
          <span class="task-step-badge">{{ stepStatusText(step) }}</span>
          <span class="task-step-content">{{ step.content }}</span>
          <span v-if="step.parallel && taskRun.parallelEnabled" class="task-step-tag" title="该步骤标注了 [并行]，开关开启时与相邻并行步骤并发执行">并行</span>
          <select
            v-if="modelOptions && modelOptions.length > 0 && step.status === 'pending'"
            class="task-step-model"
            :value="stepModelValue(step)"
            :title="step.modelRef ? `计划标注模型：@${step.modelRef}` : '为本步选择执行模型（默认跟随当前会话模型）'"
            @change="onModelChange(index, $event)"
          >
            <option value="">跟随会话模型</option>
            <option v-for="option in modelOptions" :key="`${option.configId}|${option.modelId}`" :value="`${option.configId}|${option.modelId}`">
              {{ option.label }}
            </option>
          </select>
          <span v-else-if="stepModelValue(step)" class="task-step-tag" title="本步绑定的执行模型">
            {{ boundModelLabel(step) }}
          </span>
        </div>
        <div v-if="step.toolSteps.length" class="task-step-tools">
          <ToolStepCard v-for="(tool, toolIndex) in step.toolSteps" :key="toolIndex" :step="tool" />
        </div>
        <p v-if="step.result" class="task-step-result">{{ step.result }}</p>
        <p v-if="step.error" class="task-step-error">{{ step.error }}</p>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.task-run-card {
  margin: var(--space-3) 0;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md, 10px);
  background: var(--color-surface);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.task-run-card.is-running {
  border-color: var(--color-brand);
}

.task-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.task-title {
  font-weight: 600;
  color: var(--color-text);
}

.task-badge {
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600; /* 贴纸感：状态胶囊统一加重字重 */
}

.task-badge.is-running {
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
}

.task-badge.is-done {
  background: var(--color-success-soft, var(--color-surface-muted));
  color: var(--color-success, var(--color-text-secondary));
}

.task-badge.is-failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.task-badge.is-stopped {
  background: var(--color-surface-muted);
  color: var(--color-text-muted);
}

.task-btn {
  margin-left: auto;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.task-btn:hover:not(:disabled) {
  color: var(--color-text);
  border-color: var(--color-text-muted);
}

.task-btn:active:not(:disabled) {
  background: var(--color-surface-muted);
  border-color: var(--color-border-strong);
  color: var(--color-text);
}

.task-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

/* 「检查点」按钮不与首个按钮抢 margin-left:auto：整体靠右排列 */
.task-btn-checkpoint {
  margin-left: var(--space-2);
}

.task-progress {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.task-progress-bar {
  flex: 1;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  overflow: hidden;
}

.task-progress-fill {
  height: 100%;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  transition: width 0.3s ease;
}

.task-progress-text {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.task-error {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}

.task-steps {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.task-step {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.task-step.is-running {
  border-color: var(--color-brand);
}

.task-step.is-failed {
  border-color: var(--color-danger);
}

.task-step-head {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
}

.task-step-badge {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  min-width: 3em;
}

.task-step.is-done .task-step-badge {
  color: var(--color-success, var(--color-text-secondary));
}

.task-step.is-failed .task-step-badge,
.task-step.is-running .task-step-badge {
  color: var(--color-text);
}

.task-step-content {
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

/* 步骤角标：并行标注 / 绑定模型（只读展示） */
.task-step-tag {
  flex-shrink: 0;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

/* 步骤模型下拉（仅待执行步骤显示） */
.task-step-model {
  flex-shrink: 0;
  max-width: 14em;
  padding: 0 var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.task-step-tools {
  margin-left: calc(3em + var(--space-2));
}

.task-step-result {
  margin: 0 0 0 calc(3em + var(--space-2));
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.task-step-error {
  margin: 0 0 0 calc(3em + var(--space-2));
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}
</style>
