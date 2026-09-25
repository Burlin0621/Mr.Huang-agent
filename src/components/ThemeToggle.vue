<script setup lang="ts">
import { computed } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import { useThemeStore } from '@/stores/theme'
import type { ThemePreference } from '@/stores/theme'

const themeStore = useThemeStore()

const META: Record<ThemePreference, { label: string; icon: 'monitor' | 'sun' | 'moon'; hint: string }> = {
  system: { label: '跟随系统', icon: 'monitor', hint: '当前：跟随系统，点击切换为浅色' },
  light: { label: '浅色', icon: 'sun', hint: '当前：浅色，点击切换为深色' },
  dark: { label: '深色', icon: 'moon', hint: '当前：深色，点击切换为跟随系统' }
}

const current = computed(() => META[themeStore.preference])
</script>

<template>
  <button
    type="button"
    class="theme-toggle"
    :title="current.hint"
    :aria-label="current.hint"
    @click="themeStore.cyclePreference()"
  >
    <AppIcon :name="current.icon" />
    <span class="theme-toggle-label">{{ current.label }}</span>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.theme-toggle:hover {
  color: var(--color-text);
  border-color: var(--color-border-strong);
  background: var(--color-surface-muted);
}

.theme-toggle svg {
  width: 16px;
  height: 16px;
}

@media (max-width: 640px) {
  .theme-toggle {
    width: 36px;
    padding: 0;
    justify-content: center;
  }

  .theme-toggle-label {
    display: none;
  }
}
</style>
