<script setup lang="ts">
import { computed } from 'vue'

import AgentAvatar from '@/components/AgentAvatar.vue'
import type { AgentAvatar as AgentAvatarData } from '@/lib/agents'

/**
 * 群聊头像：成员头像九宫格拼图（仿微信群头像）。
 * 1 人占满整格，2 人上下平分，3-4 人 2x2 平铺；超出 4 人取前 4 个；
 * 成员全部缺失时回退占位 emoji。
 */
const props = defineProps<{
  members: Array<{
    avatar?: AgentAvatarData
    icon: string
    name: string
  }>
}>()

/** 展示前 4 个成员；用 computed 保持随 members 变化（切换群聊时复用同一组件实例） */
const shownMembers = computed(() => props.members.slice(0, 4))
const countClass = computed(() => `count-${Math.max(1, Math.min(shownMembers.value.length, 4))}`)
</script>

<template>
  <span class="group-avatar" :class="countClass">
    <span v-if="shownMembers.length === 0" class="group-avatar-cell is-empty">👥</span>
    <span v-for="(member, index) in shownMembers" :key="index" class="group-avatar-cell">
      <AgentAvatar :avatar="member.avatar" :icon="member.icon" :name="member.name" />
    </span>
  </span>
</template>

<style scoped>
.group-avatar {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  grid-template-rows: repeat(2, 1fr);
  gap: 2px;
  width: 100%;
  height: 100%;
  padding: 2px;
  border-radius: inherit;
  background: var(--color-surface-muted);
  overflow: hidden;
  box-sizing: border-box;
}

.group-avatar-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  overflow: hidden;
  font-size: 14px;
  line-height: 1;
}

/* 1 人 / 2 人时放宽为纵向整格 */
.group-avatar.count-1 .group-avatar-cell {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
}

.group-avatar.count-2 .group-avatar-cell {
  grid-column: 1 / -1;
}

.group-avatar-cell.is-empty {
  grid-column: 1 / -1;
  grid-row: 1 / -1;
}
</style>
