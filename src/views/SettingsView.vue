<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import AppIcon from '@/components/AppIcon.vue'
import ModelSettingsPanel from '@/components/ModelSettingsPanel.vue'
import { useThemeStore } from '@/stores/theme'
import type { ThemePreference } from '@/stores/theme'

const themeStore = useThemeStore()
const route = useRoute()

type SettingsTab = 'appearance' | 'models'

/** 当前设置分区（支持通过 /settings?tab=models 直达） */
const activeTab = ref<SettingsTab>(route.query.tab === 'models' ? 'models' : 'appearance')

watch(
  () => route.query.tab,
  (tab) => {
    if (tab === 'models' || tab === 'appearance') {
      activeTab.value = tab
    }
  },
)

const tabs: Array<{ value: SettingsTab; label: string }> = [
  { value: 'appearance', label: '外观' },
  { value: 'models', label: '模型接入' },
]

interface ThemeOption {
  value: ThemePreference
  label: string
  description: string
  icon: 'monitor' | 'sun' | 'moon'
}

const themeOptions: ThemeOption[] = [
  {
    value: 'system',
    label: '跟随系统',
    description: '自动匹配操作系统的深浅色外观，并随系统变化实时切换',
    icon: 'monitor',
  },
  { value: 'light', label: '浅色模式', description: '始终使用浅色主题', icon: 'sun' },
  { value: 'dark', label: '深色模式', description: '始终使用深色主题', icon: 'moon' },
]

const resolvedLabel = computed(() => (themeStore.resolvedTheme === 'dark' ? '深色' : '浅色'))
const systemLabel = computed(() => (themeStore.systemDark ? '深色' : '浅色'))
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>设置</h1>
      <p>偏好将保存在本地浏览器中（localStorage），不会上传到服务器。</p>
    </header>

    <div class="settings-tabs" role="tablist" aria-label="设置分区">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="settings-tab"
        :class="{ 'is-active': activeTab === tab.value }"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.value"
        @click="activeTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 外观 -->
    <template v-if="activeTab === 'appearance'">
      <section class="card" aria-labelledby="appearance-title">
        <header class="section-head">
          <h2 id="appearance-title">外观</h2>
          <p>
            选择主题模式后即时生效；顶栏的主题切换按钮与此处联动（三态循环：跟随系统 → 浅色 → 深色）。
          </p>
        </header>

        <div class="theme-options" role="radiogroup" aria-label="主题模式">
          <label
            v-for="option in themeOptions"
            :key="option.value"
            class="theme-option"
            :class="{ 'is-selected': themeStore.preference === option.value }"
          >
            <input
              class="theme-option-input"
              type="radio"
              name="theme-preference"
              :value="option.value"
              :checked="themeStore.preference === option.value"
              @change="themeStore.setPreference(option.value)"
            />
            <AppIcon :name="option.icon" class="theme-option-icon" />
            <span class="theme-option-body">
              <span class="theme-option-title">{{ option.label }}</span>
              <span class="theme-option-desc">{{ option.description }}</span>
            </span>
            <span class="theme-option-check" aria-hidden="true">✓</span>
          </label>
        </div>

        <p class="theme-hint">
          当前生效：<strong>{{ resolvedLabel }}</strong
          >主题<template v-if="themeStore.preference === 'system'"
            >（跟随系统，系统当前为{{ systemLabel }}）</template
          >。
        </p>
      </section>

      <section class="card" aria-labelledby="more-title">
        <header class="section-head">
          <h2 id="more-title">更多设置</h2>
          <p>以下设置项将随业务模块一起开放。</p>
        </header>
        <ul class="pending-list">
          <li>账号与个人资料<span class="badge badge-muted">建设中</span></li>
          <li>通知偏好<span class="badge badge-muted">建设中</span></li>
          <li>关于与版本信息<span class="badge badge-muted">建设中</span></li>
        </ul>
      </section>
    </template>

    <!-- 模型接入 -->
    <section v-else class="card" aria-labelledby="models-title">
      <ModelSettingsPanel />
    </section>
  </div>
</template>

<style scoped>
.settings-tabs {
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  align-self: flex-start;
}

.settings-tab {
  height: 34px;
  padding: 0 var(--space-5);
  border-radius: var(--radius-sm);
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.settings-tab:hover {
  color: var(--color-text);
}

.settings-tab.is-active {
  background: var(--color-surface);
  color: var(--color-text);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.section-head h2 {
  font-size: var(--font-size-xl);
}

.section-head p {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
}

.theme-options {
  margin-top: var(--space-5);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
}

.theme-option {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-7) var(--space-4) var(--space-4);
  border: 1.5px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.theme-option:hover {
  border-color: var(--color-border-strong);
}

.theme-option.is-selected {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.theme-option-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.theme-option-input:focus-visible + .theme-option-icon {
  outline: 2px solid var(--color-brand);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}

.theme-option-icon {
  width: 20px;
  height: 20px;
  margin-top: 2px;
  color: var(--color-text-secondary);
}

.theme-option.is-selected .theme-option-icon {
  color: var(--color-brand);
}

.theme-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.theme-option-title {
  font-weight: 600;
}

.theme-option-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.theme-option-check {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  display: none;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: 12px;
}

.theme-option.is-selected .theme-option-check {
  display: inline-flex;
}

.theme-hint {
  margin-top: var(--space-5);
  color: var(--color-text-secondary);
}

.pending-list {
  margin-top: var(--space-4);
}

.pending-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-top: 1px dashed var(--color-border);
  color: var(--color-text-secondary);
}

.pending-list li:first-child {
  border-top: 0;
}

@media (max-width: 860px) {
  .theme-options {
    grid-template-columns: 1fr;
  }
}
</style>
