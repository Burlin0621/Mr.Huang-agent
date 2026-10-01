<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue'

defineProps<{
  label: string
  value: string
  note?: string
  /** 路由地址：传入后整卡可点击跳转 */
  to?: string
}>()
</script>

<template>
  <article class="stat-card card" :class="{ 'is-link': Boolean(to) }">
    <router-link v-if="to" :to="to" class="stat-link" :aria-label="`查看${label}`">
      <div class="stat-body">
        <span class="stat-label">{{ label }}</span>
        <span class="stat-value">{{ value }}</span>
        <span v-if="note" class="stat-note">{{ note }}</span>
      </div>
      <AppIcon name="arrow-right" class="stat-arrow" />
    </router-link>
    <template v-else>
      <span class="stat-label">{{ label }}</span>
      <span class="stat-value">{{ value }}</span>
      <span v-if="note" class="stat-note">{{ note }}</span>
    </template>
  </article>
</template>

<style scoped>
.stat-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
  overflow: hidden;
}

/* 品牌几何点缀：左侧 4px 品牌橙竖条（单元素内装饰） */
.stat-card::before {
  content: '';
  position: absolute;
  left: 0;
  top: var(--space-4);
  bottom: var(--space-4);
  width: 4px;
  border-radius: var(--radius-full);
  background: var(--color-brand);
}

.stat-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
}

.stat-value {
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-display);
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.stat-note {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* 可点击态：整卡 router-link，hover 上浮 + 边框高亮 + 箭头浮现 */
.stat-card.is-link {
  padding: 0;
}

.stat-link {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--space-3);
  height: 100%;
  padding: var(--space-5);
  text-decoration: none;
  color: inherit;
  border-radius: inherit;
  outline: none;
  transition:
    transform var(--transition-fast),
    background-color var(--transition-fast);
}

.stat-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.stat-arrow {
  width: 18px;
  height: 18px;
  color: var(--color-text-muted);
  opacity: 0;
  transform: translateX(-4px);
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.stat-card.is-link:hover,
.stat-card.is-link:focus-within {
  border-color: var(--color-brand);
  box-shadow: var(--shadow-md);
}

.stat-card.is-link:hover .stat-link,
.stat-card.is-link:focus-within .stat-link {
  transform: translateY(-2px);
}

.stat-card.is-link:hover .stat-arrow,
.stat-card.is-link:focus-within .stat-arrow {
  opacity: 1;
  transform: translateX(0);
  color: var(--color-brand);
}
</style>
