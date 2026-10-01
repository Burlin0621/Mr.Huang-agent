<script setup lang="ts">
/**
 * 会话侧栏「Vault 笔记」面板：浏览当前工作区关联的 Obsidian vault（.md）。
 * - 空搜索词展示文件树（按目录缩进），有搜索词展示全文检索结果；
 * - 点击笔记弹出预览（Markdown 渲染），支持「插入到对话」与「作为上下文发送」；
 * - 仅桌面端可用（桥接不可用或未关联文件夹时由父组件负责提示）。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import RichText from '@/components/RichText.vue'
import {
  readVaultFile,
  readVaultTree,
  searchVault,
  type VaultFileEntry,
  type VaultSearchHit,
} from '@/lib/desktop-bridge'

const props = defineProps<{ folderPath: string }>()

const emit = defineEmits<{
  insert: [note: { path: string; content: string }]
  attach: [note: { path: string; content: string }]
  notice: [text: string]
}>()

interface VaultTreeNode {
  key: string
  name: string
  depth: number
  isDir: boolean
  path: string
}

const files = ref<VaultFileEntry[]>([])
const treeTruncated = ref(false)
const loading = ref(false)
const loadError = ref('')

const searchQuery = ref('')
const searchResults = ref<VaultSearchHit[]>([])
const searchTruncated = ref(false)
const searching = ref(false)

const preview = ref<{ path: string; content: string } | null>(null)
const previewLoading = ref(false)

/** 按目录分组的树节点（目录在前、同级按名称排序，深度驱动缩进） */
const treeNodes = computed<VaultTreeNode[]>(() => {
  const dirSet = new Set<string>()
  for (const file of files.value) {
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      dirSet.add(parts.slice(0, index).join('/'))
    }
  }
  const compare = (a: string, b: string): number => {
    const as = a.split('/')
    const bs = b.split('/')
    for (let index = 0; index < Math.min(as.length, bs.length); index += 1) {
      const cmp = as[index].localeCompare(bs[index], 'zh-Hans-CN')
      if (cmp !== 0) return cmp
    }
    return as.length - bs.length
  }
  const nodes: VaultTreeNode[] = []
  for (const dir of [...dirSet].sort(compare)) {
    const parts = dir.split('/')
    nodes.push({
      key: `dir:${dir}`,
      name: parts[parts.length - 1],
      depth: parts.length - 1,
      isDir: true,
      path: dir,
    })
  }
  for (const file of [...files.value].sort((a, b) => compare(a.path, b.path))) {
    const parts = file.path.split('/')
    nodes.push({
      key: `file:${file.path}`,
      name: parts[parts.length - 1],
      depth: parts.length - 1,
      isDir: false,
      path: file.path,
    })
  }
  return nodes
})

async function refresh(): Promise<void> {
  if (!props.folderPath) return
  loading.value = true
  loadError.value = ''
  try {
    const result = await readVaultTree(props.folderPath)
    if (!result) {
      loadError.value = '桌面桥接不可用'
      return
    }
    files.value = result.files
    treeTruncated.value = result.truncated
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function runSearch(keyword: string): Promise<void> {
  searching.value = true
  try {
    const result = await searchVault(props.folderPath, keyword)
    if (searchQuery.value.trim() !== keyword) return
    if (!result) {
      emit('notice', '桌面桥接不可用')
      return
    }
    searchResults.value = result.hits
    searchTruncated.value = result.truncated
  } catch (err) {
    emit('notice', err instanceof Error ? err.message : String(err))
  } finally {
    searching.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQuery, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  const keyword = value.trim()
  if (!keyword) {
    searchResults.value = []
    searchTruncated.value = false
    return
  }
  searchTimer = setTimeout(() => void runSearch(keyword), 300)
})

watch(
  () => props.folderPath,
  () => {
    files.value = []
    searchResults.value = []
    searchQuery.value = ''
    preview.value = null
    void refresh()
  },
)

onMounted(() => void refresh())

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

async function openNote(path: string): Promise<void> {
  previewLoading.value = true
  try {
    const result = await readVaultFile(props.folderPath, path)
    if (!result) {
      emit('notice', '桌面桥接不可用')
      return
    }
    preview.value = { path, content: result.content }
  } catch (err) {
    emit('notice', err instanceof Error ? err.message : String(err))
  } finally {
    previewLoading.value = false
  }
}

function insertNote(): void {
  if (!preview.value) return
  emit('insert', { ...preview.value })
  preview.value = null
}

function attachNote(): void {
  if (!preview.value) return
  emit('attach', { ...preview.value })
  preview.value = null
}

defineExpose({ refresh })
</script>

<template>
  <div class="vault-panel">
    <div class="vault-head">
      <span class="vault-title">
        <AppIcon name="note" class="vault-title-icon" />
        <span>Vault 笔记</span>
      </span>
      <button
        class="vault-refresh"
        type="button"
        title="刷新文件树"
        :disabled="loading"
        @click="refresh"
      >
        <AppIcon name="refresh" />
      </button>
    </div>

    <input
      v-model="searchQuery"
      class="vault-search"
      type="text"
      placeholder="搜索笔记内容…"
    />

    <div class="vault-body">
      <p v-if="loading" class="vault-hint">正在读取文件树…</p>
      <p v-else-if="loadError" class="vault-hint is-error">{{ loadError }}</p>

      <template v-else-if="searchQuery.trim()">
        <p v-if="searching" class="vault-hint">正在搜索…</p>
        <template v-else>
          <p v-if="searchResults.length === 0" class="vault-hint">没有匹配的笔记</p>
          <button
            v-for="(hit, index) in searchResults"
            :key="`${hit.path}:${hit.line}:${index}`"
            class="vault-hit"
            type="button"
            :title="hit.snippet"
            @click="openNote(hit.path)"
          >
            <span class="vault-hit-path">{{ hit.path }}:{{ hit.line }}</span>
            <span class="vault-hit-snippet">{{ hit.snippet }}</span>
          </button>
          <p v-if="searchTruncated" class="vault-hint">命中数超出上限，结果已截断</p>
        </template>
      </template>

      <template v-else>
        <p v-if="treeNodes.length === 0" class="vault-hint">vault 中还没有 .md 笔记</p>
        <template v-for="node in treeNodes" :key="node.key">
          <span v-if="node.isDir" class="vault-dir" :style="{ paddingLeft: `${10 + node.depth * 14}px` }">
            {{ node.name }}
          </span>
          <button
            v-else
            class="vault-file"
            type="button"
            :title="node.path"
            :style="{ paddingLeft: `${10 + node.depth * 14 + 4}px` }"
            @click="openNote(node.path)"
          >
            {{ node.name }}
          </button>
        </template>
        <p v-if="treeTruncated" class="vault-hint">文件数超出上限，清单已截断</p>
      </template>
    </div>

    <!-- 笔记预览（Markdown 渲染） -->
    <div v-if="preview" class="vault-modal" role="dialog" aria-modal="true" @click.self="preview = null">
      <div class="vault-modal-card">
        <header class="vault-modal-head">
          <span class="vault-modal-path" :title="preview.path">{{ preview.path }}</span>
          <button class="vault-modal-close" type="button" title="关闭预览" @click="preview = null">
            <AppIcon name="close" />
          </button>
        </header>
        <div class="vault-modal-body">
          <RichText class="vault-modal-text" :content="preview.content" />
        </div>
        <footer class="vault-modal-actions">
          <button class="vault-modal-btn" type="button" @click="insertNote">插入到对话</button>
          <button class="vault-modal-btn is-primary" type="button" @click="attachNote">
            作为上下文发送
          </button>
        </footer>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vault-panel {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  margin: 0 var(--space-2) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  overflow: hidden;
}

.vault-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-2) 0;
}

.vault-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  font-weight: 500;
}

.vault-title-icon {
  width: 14px;
  height: 14px;
  color: var(--color-brand);
}

.vault-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.vault-refresh:hover:not(:disabled) {
  color: var(--color-brand);
  background: var(--color-surface-muted);
}

.vault-refresh:disabled {
  opacity: 0.5;
  cursor: default;
}

.vault-refresh .app-icon {
  width: 14px;
  height: 14px;
}

.vault-search {
  margin: var(--space-2);
  padding: 0 var(--space-2);
  height: 26px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-xs);
  outline: none;
  transition: border-color var(--transition-fast);
}

.vault-search:focus {
  border-color: var(--color-brand);
}

.vault-body {
  max-height: 220px;
  overflow-y: auto;
  padding: 0 var(--space-1) var(--space-1);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.vault-hint {
  margin: var(--space-2);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: center;
}

.vault-hint.is-error {
  color: var(--color-danger);
}

.vault-dir {
  padding: 3px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vault-file,
.vault-hit {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 4px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-xs);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.vault-file:hover,
.vault-hit:hover {
  background: var(--color-brand-soft);
  color: var(--color-brand);
}

.vault-hit-path {
  color: var(--color-brand);
  font-weight: 500;
}

.vault-hit-snippet {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
}

/* —— 预览模态 —— */
.vault-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--overlay-bg);
}

.vault-modal-card {
  display: flex;
  flex-direction: column;
  width: min(720px, calc(100vw - var(--space-8)));
  max-height: min(80vh, 640px);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.vault-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.vault-modal-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text);
}

.vault-modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.vault-modal-close:hover {
  color: var(--color-text);
  background: var(--color-surface-muted);
}

.vault-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-4);
  font-size: var(--font-size-sm);
}

.vault-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--color-border);
}

.vault-modal-btn {
  height: 30px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.vault-modal-btn:hover {
  color: var(--color-brand);
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.vault-modal-btn.is-primary {
  border-color: var(--color-brand);
  background: var(--color-brand);
  color: var(--color-on-brand);
}

.vault-modal-btn.is-primary:hover {
  border-color: var(--color-brand-strong);
  background: var(--color-brand-strong);
  color: var(--color-on-brand);
}
</style>
