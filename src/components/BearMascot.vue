<script setup lang="ts">
// 「不懒小熊」品牌吉祥物：内联 SVG 卡通小熊头像（棕色系）
// 颜色全部引用 tokens.css 设计令牌，自动适配明暗主题
defineProps<{ size?: number }>()
</script>

<template>
  <svg
    class="bear-mascot"
    :width="size ?? 72"
    :height="size ?? 72"
    viewBox="0 0 96 96"
    fill="none"
    role="img"
    aria-label="不懒小熊"
  >
    <!-- 耳朵 -->
    <circle cx="22" cy="22" r="13" class="bear-fur" />
    <circle cx="74" cy="22" r="13" class="bear-fur" />
    <circle cx="22" cy="22" r="6.5" class="bear-soft" />
    <circle cx="74" cy="22" r="6.5" class="bear-soft" />
    <!-- 头 -->
    <ellipse cx="48" cy="54" rx="34" ry="31" class="bear-fur" />
    <!-- 口鼻 -->
    <ellipse cx="48" cy="63" rx="15" ry="11.5" class="bear-soft" />
    <!-- 鼻子 -->
    <ellipse cx="48" cy="58" rx="5" ry="3.8" class="bear-dark" />
    <path d="M48 61.5v3.5M43 67.5q5 3.6 10 0" class="bear-line" />
    <!-- 眼睛 -->
    <circle cx="35" cy="48" r="3.6" class="bear-dark" />
    <circle cx="61" cy="48" r="3.6" class="bear-dark" />
    <circle cx="36.2" cy="46.8" r="1.2" class="bear-glint" />
    <circle cx="62.2" cy="46.8" r="1.2" class="bear-glint" />
    <!-- 腮红 -->
    <ellipse cx="26" cy="60" rx="5.5" ry="3.5" class="bear-blush" />
    <ellipse cx="70" cy="60" rx="5.5" ry="3.5" class="bear-blush" />
  </svg>
</template>

<style scoped>
.bear-mascot {
  flex-shrink: 0;
  display: block;
}

/* 毛色：暖棕（警告棕橙阶，两主题下均有暖棕观感） */
.bear-fur {
  fill: var(--color-warning);
}

/* 内耳 / 口鼻：暖棕浅底 */
.bear-soft {
  fill: var(--color-warning-soft);
}

/* 眼睛 / 鼻子：暖近黑 */
.bear-dark {
  fill: var(--color-text);
}

/* 眼睛高光：卡片表面色 */
.bear-glint {
  fill: var(--color-surface);
}

/* 嘴巴线稿 */
.bear-line {
  stroke: var(--color-text);
  stroke-width: 2.4;
  stroke-linecap: round;
}

/* 腮红：品牌橙软底 */
.bear-blush {
  fill: var(--color-brand-200);
  opacity: 0.75;
}
</style>
