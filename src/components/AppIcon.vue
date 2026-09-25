<script setup lang="ts">
type IconName =
  'dashboard' | 'tasks' | 'data' | 'settings' | 'chat' | 'menu' | 'sun' | 'moon' | 'monitor' | 'plus'

defineProps<{ name: IconName }>()
</script>

<template>
  <svg
    class="app-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <template v-if="name === 'dashboard'">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
    </template>
    <template v-else-if="name === 'tasks'">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M8.6 12.3l2.5 2.5 4.6-5.1" />
    </template>
    <template v-else-if="name === 'data'">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </template>
    <template v-else-if="name === 'settings'">
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </template>
    <template v-else-if="name === 'chat'">
      <path d="M21 11.5c0 4.14-4.03 7.5-9 7.5-1.02 0-2-.14-2.9-.4L4 21l1.5-4.1C4.2 15.7 3 13.7 3 11.5 3 7.36 7.03 4 12 4s9 3.36 9 7.5z" />
    </template>
    <template v-else-if="name === 'menu'">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="5" />
      <path
        d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
      />
    </template>
    <template v-else-if="name === 'moon'">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </template>
    <template v-else-if="name === 'monitor'">
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </template>
    <template v-else>
      <path d="M12 5v14M5 12h14" />
    </template>
  </svg>
</template>

<style scoped>
.app-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}
</style>
