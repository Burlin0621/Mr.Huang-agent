<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import AppIcon from '@/components/AppIcon.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import UserAvatar from '@/components/UserAvatar.vue'

type NavIcon = 'dashboard' | 'tasks' | 'data' | 'settings'

interface NavItem {
  to: string
  label: string
  icon: NavIcon
}

const route = useRoute()

/** 窄屏抽屉开关（<900px 时侧边栏收起为抽屉） */
const drawerOpen = ref(false)

const navItems: NavItem[] = [
  { to: '/', label: '工作台', icon: 'dashboard' },
  { to: '/tasks', label: '任务中心', icon: 'tasks' },
  { to: '/data', label: '数据中心', icon: 'data' },
  { to: '/settings', label: '设置', icon: 'settings' },
]

// 切换路由后自动关闭窄屏抽屉
watch(
  () => route.fullPath,
  () => {
    drawerOpen.value = false
  },
)
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar" :class="{ 'is-open': drawerOpen }">
      <div class="sidebar-header">
        <span class="logo-mark" aria-hidden="true">H</span>
        <span class="sidebar-title-group">
          <span class="sidebar-title">Mr.Huang Agent</span>
          <span class="sidebar-subtitle">智能工作台</span>
        </span>
      </div>

      <nav class="sidebar-nav" aria-label="主导航">
        <RouterLink v-for="item in navItems" :key="item.to" class="nav-item" :to="item.to">
          <AppIcon :name="item.icon" />
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>

      <footer class="sidebar-footer">
        <span class="status-dot" aria-hidden="true"></span>
        <span class="sidebar-version">v0.1.0</span>
      </footer>
    </aside>

    <div
      class="sidebar-backdrop"
      :class="{ 'is-visible': drawerOpen }"
      aria-hidden="true"
      @click="drawerOpen = false"
    ></div>

    <div class="app-main">
      <header class="topbar">
        <div class="topbar-left">
          <button
            class="icon-button menu-button"
            type="button"
            aria-label="打开导航菜单"
            :aria-expanded="drawerOpen"
            @click="drawerOpen = !drawerOpen"
          >
            <AppIcon name="menu" />
          </button>
          <nav class="breadcrumb" aria-label="面包屑">
            <span class="breadcrumb-root">Mr.Huang Agent</span>
            <span class="breadcrumb-sep" aria-hidden="true">/</span>
            <span class="breadcrumb-current" aria-current="page">{{ route.meta.title }}</span>
          </nav>
        </div>

        <div class="topbar-right">
          <ThemeToggle />
          <span class="topbar-divider" aria-hidden="true"></span>
          <UserAvatar />
        </div>
      </header>

      <main id="main-content" class="app-content">
        <RouterView />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  height: 100%;
  min-width: 320px;
}

/* —— 侧边栏 —— */
.sidebar {
  display: flex;
  flex-direction: column;
  width: var(--sidebar-width);
  flex-shrink: 0;
  background: var(--sidebar-bg);
  color: var(--sidebar-text);
  border-right: 1px solid var(--sidebar-border);
  z-index: 40;
  transition: background-color var(--transition-theme);
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-5) var(--space-4);
}

.logo-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--color-brand), #7a5cff);
  color: #ffffff;
  font-size: var(--font-size-lg);
  font-weight: 700;
  box-shadow: var(--shadow-sm);
}

.sidebar-title-group {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sidebar-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--sidebar-active-text);
  white-space: nowrap;
}

.sidebar-subtitle {
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--sidebar-text-muted);
}

.sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--space-2) var(--space-3);
  overflow-y: auto;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: 10px var(--space-3);
  border-radius: var(--radius-md);
  color: var(--sidebar-text);
  font-size: var(--font-size-md);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.nav-item:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-active-text);
}

.nav-item.router-link-active {
  background: var(--sidebar-active-bg);
  color: var(--sidebar-active-text);
  font-weight: 500;
  box-shadow: inset 3px 0 0 0 var(--color-brand);
}

.nav-item svg {
  width: 18px;
  height: 18px;
}

.sidebar-footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  border-top: 1px solid var(--sidebar-border);
  font-size: var(--font-size-xs);
  color: var(--sidebar-text-muted);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--color-success);
  box-shadow: 0 0 0 3px var(--color-success-soft);
}

.sidebar-version {
  font-family: var(--font-mono);
  letter-spacing: 0.3px;
}

/* —— 右侧主体 —— */
.app-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  height: var(--topbar-height);
  flex-shrink: 0;
  padding: 0 var(--space-6);
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--topbar-border);
  backdrop-filter: blur(10px);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.menu-button {
  display: none;
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  font-size: var(--font-size-md);
  white-space: nowrap;
}

.breadcrumb-root,
.breadcrumb-sep {
  color: var(--color-text-muted);
}

.breadcrumb-current {
  color: var(--color-text);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.topbar-divider {
  width: 1px;
  height: 20px;
  background: var(--color-border);
}

.app-content {
  flex: 1;
  overflow-y: auto;
}

/* —— 窄屏抽屉（<900px） —— */
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  z-index: 30;
  background: rgba(8, 12, 24, 0.55);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast);
}

@media (max-width: 899px) {
  .sidebar {
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    transform: translateX(-102%);
    transition: transform 240ms ease;
    box-shadow: var(--shadow-lg);
  }

  .sidebar.is-open {
    transform: translateX(0);
  }

  .sidebar-backdrop.is-visible {
    opacity: 1;
    pointer-events: auto;
  }

  .menu-button {
    display: inline-flex;
  }

  .topbar {
    padding: 0 var(--space-4);
  }

  .breadcrumb-root,
  .breadcrumb-sep {
    display: none;
  }
}
</style>
