<script setup lang="ts">
import { ref } from 'vue'

/**
 * 关于与版本信息面板：应用名称 / 版本 / 简介，以及「检查更新」入口
 * （当前仅做本地版本比对提示，不实现真实更新流程）。
 */

/** 应用版本号：与 package.json 的 version 保持一致（升级时同步修改） */
const APP_NAME = 'Mr.Huang Agent'
const APP_VERSION = '0.2.0'
const APP_DESCRIPTION =
  '一个运行在本地桌面端的智能体工作台：支持多智能体对话、群聊协作、任务编排、MCP 服务器接入与工作区记忆。'

/** 检查更新的结果提示（空串表示无） */
const updateStatus = ref('')
/** 检查中状态 */
const checking = ref(false)

/** 模拟检查更新：延迟后提示当前已是最新版本 */
function checkUpdate(): void {
  if (checking.value) return
  checking.value = true
  updateStatus.value = ''
  window.setTimeout(() => {
    checking.value = false
    updateStatus.value = `已是最新版本（v${APP_VERSION}）。`
  }, 600)
}
</script>

<template>
  <div class="about-panel">
    <div class="about-hero">
      <span class="about-logo" aria-hidden="true">H</span>
      <div class="about-hero-body">
        <p class="about-name">{{ APP_NAME }}</p>
        <p class="about-version">版本 v{{ APP_VERSION }}</p>
      </div>
    </div>

    <p class="about-desc">{{ APP_DESCRIPTION }}</p>

    <dl class="about-meta">
      <div class="about-meta-row">
        <dt>应用名称</dt>
        <dd>{{ APP_NAME }}</dd>
      </div>
      <div class="about-meta-row">
        <dt>版本号</dt>
        <dd>v{{ APP_VERSION }}</dd>
      </div>
      <div class="about-meta-row">
        <dt>运行环境</dt>
        <dd>Electron 桌面端 / 现代浏览器</dd>
      </div>
      <div class="about-meta-row">
        <dt>数据存储</dt>
        <dd>本地（localStorage / 桌面端文件存储），不上传服务器</dd>
      </div>
    </dl>

    <div class="about-actions">
      <button class="about-check-btn" type="button" :disabled="checking" @click="checkUpdate">
        {{ checking ? '检查中…' : '检查更新' }}
      </button>
      <p v-if="updateStatus" class="about-status" role="status">{{ updateStatus }}</p>
    </div>
  </div>
</template>

<style scoped>
.about-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.about-hero {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.about-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-2xl);
  font-weight: 700;
}

.about-name {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.about-version {
  margin: var(--space-1) 0 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.about-desc {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: 1.7;
  font-size: var(--font-size-sm);
}

.about-meta {
  margin: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px dashed var(--color-border);
}

.about-meta-row {
  display: flex;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-2) 0;
  border-bottom: 1px dashed var(--color-border);
}

.about-meta-row dt {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}

.about-meta-row dd {
  margin: 0;
  font-size: var(--font-size-sm);
  text-align: right;
  overflow-wrap: anywhere;
}

.about-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.about-check-btn {
  padding: var(--space-2) var(--space-5);
  border: 1px solid var(--color-brand);
  border-radius: var(--radius-md);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.about-check-btn:not(:disabled):hover {
  background: var(--color-brand-strong);
  border-color: var(--color-brand-strong);
}

.about-check-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.about-status {
  margin: 0;
  color: var(--color-success);
  font-size: var(--font-size-sm);
}
</style>
