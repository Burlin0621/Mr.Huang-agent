<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'

import AppIcon from '@/components/AppIcon.vue'
import ThemeToggle from '@/components/ThemeToggle.vue'
import AgentAvatar from '@/components/AgentAvatar.vue'
import { useAccountStore } from '@/stores/account'

type NavIcon =
  | 'dashboard'
  | 'tasks'
  | 'settings'
  | 'chat'
  | 'bot'
  | 'sparkles'
  | 'group-chat'
  | 'pen'
  | 'compass'
  | 'note'

interface NavItem {
  to: string
  label: string
  icon: NavIcon
}

const route = useRoute()

/** 账号信息（侧边栏底部用户区展示：头像 + 昵称 + 设置入口） */
const accountStore = useAccountStore()

/** 窄屏抽屉开关（<900px 时侧边栏收起为抽屉） */
const drawerOpen = ref(false)

const navItems: NavItem[] = [
  { to: '/', label: '工作台', icon: 'dashboard' },
  { to: '/chat', label: 'AI 对话', icon: 'chat' },
  { to: '/group-chat', label: '群聊协作', icon: 'group-chat' },
  { to: '/wechat-writing', label: '公众号写作', icon: 'pen' },
  { to: '/xhs-writing', label: '小红书写作', icon: 'note' },
  { to: '/today-topics', label: '今日选题', icon: 'compass' },
  { to: '/agents', label: '智能体中心', icon: 'bot' },
  { to: '/skills', label: '技能中心', icon: 'sparkles' },
  { to: '/prompts', label: '提示词库', icon: 'note' },
  { to: '/vault', label: '笔记库', icon: 'note' },
  { to: '/tasks', label: '任务中心', icon: 'tasks' },
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

      <RouterLink class="sidebar-user" to="/settings" title="账号与设置">
        <span class="sidebar-user-avatar" aria-hidden="true">
          <AgentAvatar
            :avatar="accountStore.avatar ?? undefined"
            :name="accountStore.displayName()"
          />
        </span>
        <span class="sidebar-user-name">{{ accountStore.displayName() }}</span>
        <span class="sidebar-user-gear" aria-hidden="true">
          <AppIcon name="settings" />
        </span>
      </RouterLink>
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
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: linear-gradient(135deg, var(--color-brand), var(--color-brand-accent));
  color: var(--color-on-accent);
  font-size: var(--font-size-lg);
  font-weight: 700;
  box-shadow: var(--shadow-sm);
}

/* 品牌几何点缀：logo 右下角小圆点（纯装饰） */
.logo-mark::after {
  content: '';
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: 9px;
  height: 9px;
  border-radius: var(--radius-full);
  background: var(--color-brand-accent);
  border: 2px solid var(--sidebar-bg);
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
  border-radius: var(--radius-full);
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
  font-weight: 600;
  /* 圆角胶囊选中块（贴纸感），替代旧的 inset 橙条 */
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-sm);
}

.nav-item svg {
  width: 18px;
  height: 18px;
}

/* —— 侧边栏底部用户区：头像 + 昵称 + 设置入口（同 nav-item 视觉语言） —— */
.sidebar-user {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  margin: 0 var(--space-3) var(--space-3);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-full);
  color: var(--sidebar-text);
  font-size: var(--font-size-md);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.sidebar-user:hover {
  background: var(--sidebar-hover-bg);
  color: var(--sidebar-active-text);
}

.sidebar-user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  overflow: hidden;
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-sm);
  font-weight: 700;
}

.sidebar-user-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sidebar-user-gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: var(--sidebar-text-muted);
  opacity: 0.7;
  transition: opacity var(--transition-fast);
}

.sidebar-user:hover .sidebar-user-gear {
  opacity: 1;
  color: var(--sidebar-active-text);
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
  /* 右侧留出安全空区，避免内容与系统窗口控制按钮（titleBarOverlay）重叠 */
  padding: 0 calc(var(--space-6) + 148px) 0 var(--space-6);
  background: var(--topbar-bg);
  border-bottom: 1px solid var(--topbar-border);
  backdrop-filter: blur(10px);
  /* 无边框窗口：顶栏可拖拽移动窗口 */
  -webkit-app-region: drag;
}

/* 顶栏内所有可交互元素不允许拖拽，保证点击可用 */
.topbar :deep(button),
.topbar :deep(a),
.topbar :deep(input),
.topbar :deep(select),
.topbar :deep([role='button']) {
  -webkit-app-region: no-drag;
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
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: var(--space-3);
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
  background: var(--overlay-bg);
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
    padding: 0 calc(var(--space-4) + 148px) 0 var(--space-4);
  }

  .breadcrumb-root,
  .breadcrumb-sep {
    display: none;
  }
}
</style>
