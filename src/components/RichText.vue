<script setup lang="ts">
import { computed } from 'vue'

import { renderMarkdown } from '@/lib/markdown'

/**
 * Markdown 富文本容器（仅用于展示模型/成员输出的可信化内容）：
 * - 内容经 renderMarkdown（markdown-it + DOMPurify）消毒后 v-html；
 * - 流式期间 markdown-it 对未闭合语法天然容错，每次增量整条重解析（实例模块级复用）；
 * - 排版样式随组件携带，外部容器只负责字号/行距等基础排版（不使用 pre-wrap，避免与块级元素双重换行）。
 */
const props = defineProps<{ content: string }>()

const html = computed(() => renderMarkdown(props.content))
</script>

<template>
  <!-- 消毒后的静态内容，禁用 vue/no-v-html 指令告警 -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="rich-text" v-html="html"></div>
</template>

<style scoped>
.rich-text {
  /* 覆盖外部容器可能继承的 pre-wrap：块级元素已自带换行 */
  white-space: normal;
  word-break: break-word;
}

.rich-text :deep(p) {
  margin: 0 0 var(--space-2);
}

.rich-text :deep(p:last-child) {
  margin-bottom: 0;
}

.rich-text :deep(h1),
.rich-text :deep(h2),
.rich-text :deep(h3),
.rich-text :deep(h4) {
  margin: var(--space-3) 0 var(--space-2);
  font-size: var(--font-size-md);
  font-weight: 700;
  line-height: 1.4;
}

.rich-text :deep(h1:first-child),
.rich-text :deep(h2:first-child),
.rich-text :deep(h3:first-child),
.rich-text :deep(h4:first-child) {
  margin-top: 0;
}

.rich-text :deep(ul),
.rich-text :deep(ol) {
  margin: 0 0 var(--space-2);
  padding-left: 1.4em;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rich-text :deep(li > p) {
  margin: 0;
}

.rich-text :deep(code) {
  padding: 1px var(--space-1);
  border-radius: var(--radius-sm, 4px);
  background: var(--color-surface-muted);
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.rich-text :deep(pre) {
  margin: 0 0 var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  overflow-x: auto;
}

.rich-text :deep(pre code) {
  padding: 0;
  border: 0;
  background: transparent;
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.rich-text :deep(blockquote) {
  margin: 0 0 var(--space-2);
  padding: var(--space-1) var(--space-3);
  border-left: 3px solid var(--color-border-strong);
  color: var(--color-text-secondary);
}

.rich-text :deep(blockquote p) {
  margin: 0;
}

.rich-text :deep(a) {
  color: var(--color-brand);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.rich-text :deep(a:hover) {
  color: var(--color-brand);
  opacity: 0.85;
}

.rich-text :deep(hr) {
  margin: var(--space-3) 0;
  border: 0;
  border-top: 1px solid var(--color-border);
}

.rich-text :deep(table) {
  margin: 0 0 var(--space-2);
  border-collapse: collapse;
  font-size: var(--font-size-sm);
  display: block;
  overflow-x: auto;
}

.rich-text :deep(th),
.rich-text :deep(td) {
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  text-align: left;
}

.rich-text :deep(th) {
  background: var(--color-surface-muted);
  font-weight: 600;
}

.rich-text :deep(img) {
  max-width: 100%;
  border-radius: var(--radius-sm, 4px);
}
</style>
