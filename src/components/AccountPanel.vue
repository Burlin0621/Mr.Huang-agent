<script setup lang="ts">
import { computed, ref } from 'vue'

import AgentAvatar from '@/components/AgentAvatar.vue'
import AvatarPickerModal from '@/components/AvatarPickerModal.vue'
import { useAccountStore, DEFAULT_NICKNAME } from '@/stores/account'
import type { AgentAvatar as AgentAvatarValue } from '@/lib/agents'
import type { AgentView } from '@/stores/agents'

/**
 * 账号与个人资料面板：昵称、签名简介即时编辑并自动持久化；
 * 头像复用 AvatarPickerModal（构造一个仅用于头像选择的合成智能体视图）。
 */

const accountStore = useAccountStore()

/** 展示用昵称（未填时回退默认） */
const displayNickname = computed(() => accountStore.displayName())

/** 头像选择弹窗开关 */
const showAvatarPicker = ref(false)

/** 仅用于头像选择器的合成智能体视图（AvatarPickerModal 只依赖 name / icon / avatar 三个展示字段） */
const syntheticAgent = computed<AgentView>(() => ({
  id: '__user_profile__',
  name: displayNickname.value,
  description: '',
  systemPrompt: '',
  icon: '🙂',
  tags: [],
  avatar: accountStore.avatar ?? undefined,
  builtin: false,
  customized: false,
  disabled: false,
  linkedSkillIds: [],
  tools: [],
  modelConfigId: '',
  modelId: '',
}))

/** 头像选择器确认：写入 store（null 表示清除头像，回退昵称首字展示） */
function onAvatarConfirm(avatar: AgentAvatarValue | null): void {
  accountStore.avatar = avatar
  showAvatarPicker.value = false
}
</script>

<template>
  <div class="account-panel">
    <!-- 资料预览卡：头像 + 昵称 + 简介 -->
    <div class="account-preview">
      <span class="account-avatar" aria-hidden="true">
        <AgentAvatar
          v-if="accountStore.avatar"
          :avatar="accountStore.avatar"
          :icon="'🙂'"
          :name="displayNickname"
        />
        <span v-else class="account-avatar-fallback">{{ displayNickname.slice(0, 1) }}</span>
      </span>
      <div class="account-preview-body">
        <strong class="account-preview-name">{{ displayNickname }}</strong>
        <p class="account-preview-bio">
          {{ accountStore.bio.trim() || '还没有签名，写一句介绍自己吧。' }}
        </p>
        <button class="account-edit-avatar" type="button" @click="showAvatarPicker = true">
          更换头像
        </button>
      </div>
    </div>

    <label class="account-field">
      <span class="account-field-label">昵称</span>
      <input
        v-model="accountStore.nickname"
        class="account-input"
        type="text"
        maxlength="24"
        :placeholder="DEFAULT_NICKNAME"
        aria-label="昵称"
      />
      <small class="account-field-hint">最多 24 个字；留空时显示「{{ DEFAULT_NICKNAME }}」。</small>
    </label>

    <label class="account-field">
      <span class="account-field-label">签名 / 简介</span>
      <textarea
        v-model="accountStore.bio"
        class="account-textarea"
        rows="3"
        maxlength="120"
        placeholder="一句话介绍自己（可选）"
        aria-label="签名或简介"
      ></textarea>
      <small class="account-field-hint">最多 120 个字，修改后自动保存到本地。</small>
    </label>

    <p class="account-status">资料保存在本地（localStorage），不会上传到服务器。</p>

    <AvatarPickerModal
      v-if="showAvatarPicker"
      :agent="syntheticAgent"
      @close="showAvatarPicker = false"
      @confirm="onAvatarConfirm"
    />
  </div>
</template>

<style scoped>
.account-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.account-preview {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}

.account-avatar {
  display: inline-flex;
  width: 72px;
  height: 72px;
  flex-shrink: 0;
  overflow: hidden;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-brand);
}

.account-preview-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.account-preview-name {
  font-size: var(--font-size-lg);
}

.account-preview-bio {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.6;
}

.account-edit-avatar {
  align-self: flex-start;
  margin-top: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.account-edit-avatar:hover {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.account-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.account-field-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.account-input,
.account-textarea {
  width: 100%;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-md);
}

.account-textarea {
  resize: vertical;
  line-height: 1.6;
}

.account-field-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.account-status {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}
</style>
