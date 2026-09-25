<script setup lang="ts">
defineProps<{
  label: string
  value: string
  note?: string
}>()
</script>

<template>
  <article class="stat-card card">
    <span class="stat-label">{{ label }}</span>
    <span class="stat-value">{{ value }}</span>
    <span v-if="note" class="stat-note">{{ note }}</span>
  </article>
</template>

<style scoped>
.stat-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
}

.stat-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.stat-value {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.stat-note {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
</style>
