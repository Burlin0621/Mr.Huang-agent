<script setup lang="ts">
import { useAccountStore, type NotificationPrefs } from '@/stores/account'

/**
 * 通知偏好面板：三个独立开关（任务完成提醒 / 消息声音 / 桌面通知），
 * 切换即写入 account store 并自动持久化到本地。
 */

const accountStore = useAccountStore()

interface NotificationOption {
  key: keyof NotificationPrefs
  label: string
  description: string
}

const options: NotificationOption[] = [
  {
    key: 'taskDone',
    label: '任务完成提醒',
    description: '子智能体完成任务步骤时给出提示。',
  },
  {
    key: 'messageSound',
    label: '消息声音',
    description: '收到新消息时播放提示音。',
  },
  {
    key: 'desktopNotify',
    label: '桌面通知',
    description: '应用在后台时通过系统通知提醒（需系统授权）。',
  },
]
</script>

<template>
  <div class="notify-panel">
    <ul class="notify-list">
      <li v-for="option in options" :key="option.key" class="notify-item">
        <div class="notify-item-body">
          <p class="notify-item-label">{{ option.label }}</p>
          <p class="notify-item-desc">{{ option.description }}</p>
        </div>
        <button
          class="notify-toggle"
          type="button"
          role="switch"
          :aria-checked="accountStore.notifications[option.key]"
          :class="{ 'is-on': accountStore.notifications[option.key] }"
          @click="accountStore.toggleNotification(option.key)"
        >
          <span class="notify-toggle-thumb" aria-hidden="true"></span>
          <span class="notify-toggle-text">
            {{ accountStore.notifications[option.key] ? '已开启' : '已关闭' }}
          </span>
        </button>
      </li>
    </ul>
    <p class="notify-hint">开关状态保存在本地（localStorage），修改后即时生效。</p>
  </div>
</template>

<style scoped>
.notify-list {
  display: flex;
  flex-direction: column;
}

.notify-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-3) 0;
  border-top: 1px dashed var(--color-border);
}

.notify-item:first-child {
  border-top: 0;
  padding-top: 0;
}

.notify-item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.notify-item-label {
  font-size: var(--font-size-md);
  font-weight: 600;
}

.notify-item-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

/* 开关（与设置页工具启停开关同款视觉） */
.notify-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.notify-toggle:hover {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.notify-toggle-thumb {
  width: 28px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--color-border-strong);
  position: relative;
  transition: background-color var(--transition-fast);
}

.notify-toggle-thumb::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transition: transform var(--transition-fast);
}

.notify-toggle.is-on .notify-toggle-thumb {
  background: var(--color-brand);
}

.notify-toggle.is-on .notify-toggle-thumb::after {
  transform: translateX(12px);
}

.notify-toggle-text {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.notify-hint {
  margin-top: var(--space-3);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
</style>
