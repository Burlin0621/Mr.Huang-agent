import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

/** 用户可选择的主题偏好：跟随系统 / 浅色 / 深色 */
export type ThemePreference = 'system' | 'light' | 'dark'

/** 最终应用到页面上的主题 */
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'mr-huang-agent:theme'

/** 三态循环顺序：跟随系统 → 浅色 → 深色 → 跟随系统 */
const CYCLE: Record<ThemePreference, ThemePreference> = {
  system: 'light',
  light: 'dark',
  dark: 'system',
}

const systemMedia = window.matchMedia('(prefers-color-scheme: dark)')

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'system' || stored === 'light' || stored === 'dark') {
      return stored
    }
  } catch {
    // localStorage 不可用时忽略，回退到默认值
  }
  return 'system'
}

export const useThemeStore = defineStore('theme', () => {
  /** 用户偏好（持久化） */
  const preference = ref<ThemePreference>(readPreference())

  /** 系统当前是否为深色（实时监听 prefers-color-scheme 变化） */
  const systemDark = ref(systemMedia.matches)

  /** 计算最终主题：手动选择时覆盖系统偏好，否则跟随系统 */
  const resolvedTheme = computed<ResolvedTheme>(() =>
    preference.value === 'system' ? (systemDark.value ? 'dark' : 'light') : preference.value,
  )

  function setPreference(next: ThemePreference): void {
    preference.value = next
  }

  function cyclePreference(): void {
    preference.value = CYCLE[preference.value]
  }

  function applyToDocument(theme: ResolvedTheme): void {
    document.documentElement.dataset.theme = theme
  }

  systemMedia.addEventListener('change', (event) => {
    systemDark.value = event.matches
  })

  // 偏好变化 → 持久化到 localStorage
  watch(preference, (next) => {
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // 持久化失败时静默降级（仅当前会话生效）
    }
  })

  // 最终主题变化（偏好变化或系统主题变化引起）→ 写入 <html data-theme="...">
  watch(resolvedTheme, (theme) => applyToDocument(theme), { immediate: true })

  return { preference, systemDark, resolvedTheme, setPreference, cyclePreference }
})
