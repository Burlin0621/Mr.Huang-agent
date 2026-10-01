<script setup lang="ts">
type IconName =
  | 'dashboard'
  | 'tasks'
  | 'data'
  | 'settings'
  | 'chat'
  | 'group-chat'
  | 'menu'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'plus'
  | 'target'
  | 'paperclip'
  | 'bot'
  | 'sparkles'
  | 'more'
  | 'check'
  | 'chevron-down'
  | 'arrow-right'
  | 'close'
  | 'download'
  | 'upload'
  | 'copy'
  | 'trash'
  | 'search'
  | 'edit'
  | 'archive'
  | 'quote'
  | 'pen'
  | 'compass'
  | 'note'
  | 'refresh'
  | 'send'

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
    <template v-else-if="name === 'group-chat'">
      <path d="M21 11.5c0 4.14-4.03 7.5-9 7.5-1.02 0-2-.14-2.9-.4L4 21l1.5-4.1C4.2 15.7 3 13.7 3 11.5 3 7.36 7.03 4 12 4s9 3.36 9 7.5z" />
      <circle cx="8.5" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
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
    <template v-else-if="name === 'target'">
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'paperclip'">
      <path
        d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"
      />
    </template>
    <template v-else-if="name === 'bot'">
      <path d="M12 8V4H8" />
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M2 14h2M20 14h2M9 13v2M15 13v2" />
    </template>
    <template v-else-if="name === 'sparkles'">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7L19 17z" />
    </template>
    <template v-else-if="name === 'pen'">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5L16.5 3.5z" />
    </template>
    <template v-else-if="name === 'compass'">
      <circle cx="12" cy="12" r="9" />
      <path d="M15.5 8.5l-2.1 5-4.9 2 2.1-5 4.9-2z" />
    </template>
    <template v-else-if="name === 'note'">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M9 13h6M9 17h4" />
    </template>
    <template v-else-if="name === 'refresh'">
      <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
      <path d="M21 3v5h-5" />
    </template>
    <template v-else-if="name === 'send'">
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </template>
    <template v-else-if="name === 'more'">
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
    </template>
    <template v-else-if="name === 'check'">
      <path d="M20 6L9 17l-5-5" />
    </template>
    <template v-else-if="name === 'chevron-down'">
      <path d="M6 9l6 6 6-6" />
    </template>
    <template v-else-if="name === 'arrow-right'">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </template>
    <template v-else-if="name === 'close'">
      <path d="M18 6L6 18M6 6l12 12" />
    </template>
    <template v-else-if="name === 'download'">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </template>
    <template v-else-if="name === 'upload'">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </template>
    <template v-else-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.35-4.35" />
    </template>
    <template v-else-if="name === 'edit'">
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </template>
    <template v-else-if="name === 'archive'">
      <rect x="3" y="4" width="18" height="4" rx="1.5" />
      <path d="M5 8v11a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8" />
      <path d="M10 12h4" />
    </template>
    <template v-else-if="name === 'quote'">
      <path d="M10 11H6.5A2.5 2.5 0 0 1 4 8.5v-1A2.5 2.5 0 0 1 6.5 5h1A2.5 2.5 0 0 1 10 7.5V14a4 4 0 0 1-4 4" />
      <path d="M20 11h-3.5A2.5 2.5 0 0 1 14 8.5v-1A2.5 2.5 0 0 1 16.5 5h1A2.5 2.5 0 0 1 20 7.5V14a4 4 0 0 1-4 4" />
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
