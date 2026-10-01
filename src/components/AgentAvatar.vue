<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { findSystemAvatar, type AgentAvatar } from '@/lib/agents'

/**
 * 智能体头像渲染组件：按 avatar 字段的三种来源（系统默认素材图 / emoji / 自定义图片）渲染，
 * 未设置或图片加载失败时回退 icon emoji → 名称首字 → 默认机器人。
 * 系统默认素材为透明底 PNG，容器垫一层暖色对角渐变底（引用现有令牌、随主题联动）保证质感；
 * 自定义 / 内置图片仍按 object-fit: cover 铺满。组件尺寸与圆角由外层容器控制。
 */
const props = withDefaults(
  defineProps<{
    avatar?: AgentAvatar
    icon?: string
    name?: string
  }>(),
  { avatar: undefined, icon: '', name: '' },
)

/** 图片头像加载失败标记（@error 时置位，触发回退展示） */
const imageFailed = ref(false)

// 头像来源切换后重置失败标记，避免新图片被旧来源的失败状态挡住
watch(
  () => props.avatar,
  () => {
    imageFailed.value = false
  },
)

/** 系统默认头像资源 URL（id 未命中素材库时为 undefined，走兜底展示，旧数据不致报错） */
const systemSrc = computed(() =>
  props.avatar?.kind === 'default' ? findSystemAvatar(props.avatar.id)?.src : undefined,
)

/** 自定义图片 data URL（加载失败后不再渲染，转回退展示） */
const imageSrc = computed(() =>
  props.avatar?.kind === 'image' && !imageFailed.value ? props.avatar.data : undefined,
)

/** 兜底文字：emoji 头像 → icon 字段 → 名称首字 → 默认机器人 */
const fallbackText = computed(() => {
  if (props.avatar?.kind === 'emoji') return props.avatar.value
  return props.icon.trim() || props.name.slice(0, 1) || '🤖'
})
</script>

<template>
  <span class="agent-avatar-view" :class="{ 'is-system': systemSrc }">
    <img
      v-if="systemSrc"
      class="agent-avatar-img is-contain"
      :src="systemSrc"
      :alt="name"
      draggable="false"
    />
    <img
      v-else-if="imageSrc"
      class="agent-avatar-img"
      :src="imageSrc"
      :alt="name"
      @error="imageFailed = true"
    />
    <template v-else>{{ fallbackText }}</template>
  </span>
</template>

<style scoped>
.agent-avatar-view {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  overflow: hidden;
  line-height: 1;
}

/* 系统默认素材（透明底 PNG）垫一层橙黄族对角渐变底：品牌软橙 → 品牌黄，引用现有令牌随主题联动 */
.agent-avatar-view.is-system {
  background: linear-gradient(135deg, var(--color-brand-soft), var(--color-brand-accent));
}

/* 图片头像：自定义 / 内置图铺满容器，圆角随外层容器 */
.agent-avatar-img {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

/* 系统素材等比缩放居中，不裁切 */
.agent-avatar-img.is-contain {
  object-fit: contain;
}
</style>
