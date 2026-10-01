<script setup lang="ts">
defineProps<{
  title: string
  description?: string
}>()
</script>

<template>
  <div class="empty-state">
    <svg class="empty-art" viewBox="0 0 160 116" aria-hidden="true">
      <circle class="art-dot" cx="22" cy="24" r="6" />
      <rect class="art-frame" x="26" y="12" width="108" height="88" rx="14" />
      <path class="art-lines" d="M52 44h56M52 62h40" />
      <circle class="art-badge" cx="118" cy="88" r="19" />
      <path class="art-check" d="M110 88l5.5 5.5L127 83" />
    </svg>
    <h2 class="empty-title">{{ title }}</h2>
    <p v-if="description" class="empty-desc">{{ description }}</p>
    <div class="empty-actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--space-3);
  padding: var(--space-7) var(--space-6);
}

.empty-art {
  width: 180px;
  height: auto;
  margin-bottom: var(--space-2);
}

.art-dot {
  fill: var(--color-brand-accent); /* 几何点缀：品牌黄圆点，低干扰 */
}

.art-frame {
  fill: var(--color-surface-muted);
  stroke: var(--color-border-strong);
  stroke-width: 2;
  stroke-dasharray: 7 6;
}

.art-lines {
  fill: none;
  stroke: var(--color-border-strong);
  stroke-width: 4;
  stroke-linecap: round;
}

.art-badge {
  fill: var(--color-brand); /* 徽章实底品牌橙，深浅主题各自取对应提亮值 */
}

.art-check {
  fill: none;
  stroke: var(--color-on-brand); /* 勾随 on-brand 令牌自适应（浅色白 / 深色深棕） */
  stroke-width: 3.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.empty-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-display);
}

.empty-desc {
  max-width: 380px;
  color: var(--color-text-secondary);
}

.empty-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin-top: var(--space-3);
}
</style>
