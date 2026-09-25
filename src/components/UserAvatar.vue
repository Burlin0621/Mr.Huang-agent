<template>
  <button type="button" class="user-avatar" title="用户（占位）" aria-label="打开用户菜单（占位）">
    H
  </button>
</template>

<style scoped>
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-md);
  font-weight: 700;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.user-avatar:hover {
  border-color: var(--color-brand);
}
</style>
