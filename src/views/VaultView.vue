<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
import {
  hasVaultBridge,
  pickFolderViaBridge,
  readVaultFile,
  readVaultTree,
  searchVault,
  writeVaultFile,
  type VaultFileEntry,
  type VaultSearchHit,
} from '@/lib/desktop-bridge'
import { renderMarkdown } from '@/lib/markdown'
import { useWorkspacesStore } from '@/stores/workspaces'
import { storageGet, storageSet } from '@/lib/storage'

const VAULT_PATH_STORAGE_KEY = 'mr-huang-agent:vault-path'

interface VaultTreeNode {
  key: string
  name: string
  depth: number
  isDir: boolean
  path: string
}

interface OpenNote {
  path: string
  content: string
}

const workspacesStore = useWorkspacesStore()

const hasBridge = hasVaultBridge()
const manualPath = ref(loadStoredPath())
const vaultPath = computed(() => manualPath.value || workspacesStore.activeWorkspace?.folderPath || '')

const files = ref<VaultFileEntry[]>([])
const treeTruncated = ref(false)
const loading = ref(false)
const loadError = ref('')
const collapsedDirs = ref(new Set<string>())

const searchQuery = ref('')
const searchResults = ref<VaultSearchHit[]>([])
const searchTruncated = ref(false)
const searching = ref(false)

const currentNote = ref<OpenNote | null>(null)
const noteLoading = ref(false)
const editing = ref(false)
const draftContent = ref('')

const creating = ref(false)
const newPath = ref('')
const createError = ref('')

const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

const elidedPath = computed(() => elideMiddle(vaultPath.value, 46))
const renderedHtml = computed(() => (currentNote.value ? renderMarkdown(currentNote.value.content) : ''))

function loadStoredPath(): string {
  try {
    return storageGet(VAULT_PATH_STORAGE_KEY)?.trim() || ''
  } catch {
    return ''
  }
}

function elideMiddle(text: string, max: number): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = max - 1 - head
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

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

const visibleNodes = computed(() =>
  treeNodes.value.filter((node) => {
    const parts = node.path.split('/')
    for (let index = 1; index < parts.length; index += 1) {
      if (collapsedDirs.value.has(parts.slice(0, index).join('/'))) return false
    }
    return true
  }),
)

function toggleDir(path: string): void {
  const next = new Set(collapsedDirs.value)
  if (next.has(path)) {
    next.delete(path)
  } else {
    next.add(path)
  }
  collapsedDirs.value = next
}

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 2400)
}

function resetViewState(): void {
  files.value = []
  treeTruncated.value = false
  loadError.value = ''
  collapsedDirs.value = new Set()
  searchQuery.value = ''
  searchResults.value = []
  searchTruncated.value = false
  currentNote.value = null
  editing.value = false
  creating.value = false
  newPath.value = ''
  createError.value = ''
}

async function refreshTree(): Promise<void> {
  const root = vaultPath.value
  if (!root) return
  loading.value = true
  loadError.value = ''
  try {
    const result = await readVaultTree(root)
    if (vaultPath.value !== root) return
    if (!result) {
      loadError.value = '桌面桥接不可用'
      return
    }
    files.value = result.files
    treeTruncated.value = result.truncated
  } catch (err) {
    if (vaultPath.value === root) {
      loadError.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (vaultPath.value === root) loading.value = false
  }
}

async function chooseVault(): Promise<void> {
  const picked = await pickFolderViaBridge()
  if (!picked) return
  manualPath.value = picked
  try {
    storageSet(VAULT_PATH_STORAGE_KEY, picked)
  } catch {
    showNotice('路径已生效，但本地存储失败，刷新后需重新选择')
  }
  resetViewState()
  void refreshTree()
}

async function openNote(path: string): Promise<void> {
  const root = vaultPath.value
  noteLoading.value = true
  try {
    const result = await readVaultFile(root, path)
    if (vaultPath.value !== root) return
    if (!result) {
      showNotice('桌面桥接不可用')
      return
    }
    currentNote.value = { path, content: result.content }
    editing.value = false
  } catch (err) {
    showNotice(err instanceof Error ? err.message : String(err))
  } finally {
    if (vaultPath.value === root) noteLoading.value = false
  }
}

function startEdit(): void {
  if (!currentNote.value) return
  draftContent.value = currentNote.value.content
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  draftContent.value = ''
}

async function saveNote(): Promise<void> {
  if (!currentNote.value || !editing.value) return
  const root = vaultPath.value
  const path = currentNote.value.path
  try {
    const result = await writeVaultFile(root, path, draftContent.value, true)
    if (!result) {
      showNotice('桌面桥接不可用')
      return
    }
    currentNote.value = { path, content: draftContent.value }
    editing.value = false
    draftContent.value = ''
    showNotice(`已保存：${path}`)
    void refreshTree()
  } catch (err) {
    showNotice(err instanceof Error ? err.message : String(err))
  }
}

function startCreate(): void {
  creating.value = true
  newPath.value = ''
  createError.value = ''
}

function cancelCreate(): void {
  creating.value = false
  newPath.value = ''
  createError.value = ''
}

function normalizeRelPath(raw: string): string {
  let value = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!value) return ''
  if (!value.toLowerCase().endsWith('.md')) value += '.md'
  return value
}

function isValidRelPath(value: string): boolean {
  if (!value || value.endsWith('/')) return false
  if (/[*?:\"<>|]/.test(value)) return false
  return value.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
}

async function confirmCreate(): Promise<void> {
  const path = normalizeRelPath(newPath.value)
  if (!isValidRelPath(path)) {
    createError.value = '路径无效：不能为空，不能包含 * ? : \" < > | 等字符，各级目录名不能为 . 或 ..'
    return
  }
  createError.value = ''
  const root = vaultPath.value
  try {
    const result = await writeVaultFile(root, path, '', false)
    if (!result) {
      createError.value = '桌面桥接不可用'
      return
    }
    creating.value = false
    newPath.value = ''
    showNotice(`已创建：${path}`)
    void refreshTree()
    void openNote(path)
  } catch (err) {
    createError.value = err instanceof Error ? err.message : String(err)
  }
}

async function runSearch(keyword: string): Promise<void> {
  searching.value = true
  const root = vaultPath.value
  try {
    const result = await searchVault(root, keyword)
    if (searchQuery.value.trim() !== keyword || vaultPath.value !== root) return
    if (!result) {
      showNotice('桌面桥接不可用')
      return
    }
    searchResults.value = result.hits
    searchTruncated.value = result.truncated
  } catch (err) {
    showNotice(err instanceof Error ? err.message : String(err))
  } finally {
    if (searchQuery.value.trim() === keyword) searching.value = false
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchQuery, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  const keyword = value.trim()
  if (!keyword) {
    searchResults.value = []
    searchTruncated.value = false
    searching.value = false
    return
  }
  searchTimer = setTimeout(() => void runSearch(keyword), 300)
})

function pickSearchResult(path: string): void {
  searchQuery.value = ''
  searchResults.value = []
  void openNote(path)
}

watch(vaultPath, (next, prev) => {
  if (next === prev) return
  resetViewState()
  if (next) void refreshTree()
})

onMounted(() => {
  if (hasBridge && vaultPath.value) void refreshTree()
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
  if (noticeTimer) clearTimeout(noticeTimer)
})
</script>

<template>
  <div class="page vault-page">
    <header class="page-head">
      <div>
        <h1>笔记库</h1>
        <p>浏览、编辑与检索本地 Obsidian vault 中的 Markdown 笔记。</p>
      </div>
    </header>

    <EmptyState
      v-if="!hasBridge"
      class="vault-empty"
      title="笔记库功能需在桌面端使用"
      description="本地笔记仓库读写依赖桌面壳的文件桥接，请在 Mr.Huang Agent 桌面版中打开本页面。"
    />

    <EmptyState
      v-else-if="!vaultPath"
      class="vault-empty"
      title="尚未选择笔记仓库"
      description="选择一个包含 Markdown 笔记的本地文件夹（Obsidian vault），即可在这里浏览与编辑。"
    >
      <button class="btn btn-primary" type="button" @click="chooseVault">
        <AppIcon name="note" />
        选择仓库
      </button>
    </EmptyState>

    <div v-else class="vault-layout">
      <aside class="vault-side card">
        <div class="vault-side-head">
          <span class="vault-path" :title="vaultPath">{{ elidedPath }}</span>
          <button
            class="icon-button"
            type="button"
            title="刷新文件树"
            :disabled="loading"
            @click="refreshTree"
          >
            <AppIcon name="refresh" />
          </button>
        </div>

        <div class="vault-side-actions">
          <button class="btn btn-ghost" type="button" @click="chooseVault">
            <AppIcon name="archive" />
            选择仓库
          </button>
          <button class="btn btn-primary" type="button" @click="creating ? cancelCreate() : startCreate()">
            <AppIcon name="plus" />
            {{ creating ? '取消新建' : '新建笔记' }}
          </button>
        </div>

        <form v-if="creating" class="vault-create" @submit.prevent="confirmCreate">
          <input
            v-model="newPath"
            class="vault-create-input"
            type="text"
            placeholder="如：日记/2026-09-27"
            autofocus
          />
          <p v-if="createError" class="vault-create-error">{{ createError }}</p>
          <div class="vault-create-actions">
            <button class="btn btn-primary" type="submit">确认创建</button>
            <button class="btn btn-ghost" type="button" @click="cancelCreate">取消</button>
          </div>
        </form>

        <div class="vault-tree">
          <p v-if="loading" class="vault-hint">正在读取文件树…</p>
          <template v-else-if="loadError">
            <p class="vault-hint is-error">{{ loadError }}</p>
            <button class="btn btn-ghost vault-retry" type="button" @click="refreshTree">
              <AppIcon name="refresh" />
              重试
            </button>
          </template>
          <p v-else-if="visibleNodes.length === 0" class="vault-hint">该仓库还没有 .md 笔记</p>
          <template v-for="node in visibleNodes" :key="node.key">
            <button
              v-if="node.isDir"
              class="vault-dir"
              type="button"
              :style="{ paddingLeft: `${10 + node.depth * 16}px` }"
              @click="toggleDir(node.path)"
            >
              <AppIcon name="chevron-down" class="vault-chevron" :class="{ 'is-collapsed': collapsedDirs.has(node.path) }" />
              <span>{{ node.name }}</span>
            </button>
            <button
              v-else
              class="vault-file"
              type="button"
              :class="{ 'is-active': currentNote?.path === node.path }"
              :title="node.path"
              :style="{ paddingLeft: `${10 + node.depth * 16 + 6}px` }"
              @click="openNote(node.path)"
            >
              {{ node.name }}
            </button>
          </template>
          <p v-if="treeTruncated" class="vault-hint">文件数超出上限，清单已截断</p>
        </div>
      </aside>

      <section class="vault-main card">
        <div class="vault-searchbar">
          <AppIcon name="search" class="vault-search-icon" />
          <input
            v-model="searchQuery"
            class="vault-search-input"
            type="text"
            placeholder="搜索笔记内容…"
          />
          <button
            v-if="searchQuery"
            class="vault-search-clear"
            type="button"
            title="清空搜索"
            @click="searchQuery = ''"
          >
            <AppIcon name="close" />
          </button>
        </div>

        <div v-if="searchQuery.trim()" class="vault-results">
          <p v-if="searching" class="vault-hint">正在搜索…</p>
          <template v-else>
            <p v-if="searchResults.length === 0" class="vault-hint">没有匹配的笔记</p>
            <button
              v-for="(hit, index) in searchResults"
              :key="`${hit.path}:${hit.line}:${index}`"
              class="vault-hit"
              type="button"
              :title="hit.snippet"
              @click="pickSearchResult(hit.path)"
            >
              <span class="vault-hit-path">{{ hit.path }}:{{ hit.line }}</span>
              <span class="vault-hit-snippet">{{ hit.snippet }}</span>
            </button>
            <p v-if="searchTruncated" class="vault-hint">命中数超出上限，结果已截断</p>
          </template>
        </div>

        <template v-else>
          <div v-if="noteLoading" class="vault-placeholder">
            <p class="vault-hint">正在打开笔记…</p>
          </div>
          <div v-else-if="!currentNote" class="vault-placeholder">
            <EmptyState
              title="未打开笔记"
              description="从左侧文件树选择一篇笔记，或使用搜索找到内容。"
            />
          </div>
          <div v-else class="vault-note">
            <header class="vault-note-head">
              <span class="vault-note-path" :title="currentNote.path">{{ currentNote.path }}</span>
              <div class="vault-note-actions">
                <template v-if="editing">
                  <button class="btn btn-primary" type="button" @click="saveNote">
                    <AppIcon name="check" />
                    保存
                  </button>
                  <button class="btn btn-ghost" type="button" @click="cancelEdit">取消</button>
                </template>
                <button v-else class="btn btn-ghost" type="button" @click="startEdit">
                  <AppIcon name="edit" />
                  编辑
                </button>
              </div>
            </header>
            <textarea
              v-if="editing"
              v-model="draftContent"
              class="vault-editor"
              spellcheck="false"
            ></textarea>
            <!-- eslint-disable-next-line vue/no-v-html -->
            <div v-else class="vault-note-body" v-html="renderedHtml"></div>
          </div>
        </template>
      </section>
    </div>

    <Transition name="vault-toast">
      <div v-if="notice" class="vault-toast" role="status">{{ notice }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.vault-page {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  max-width: var(--content-max-width);
  margin: 0 auto;
  padding: var(--space-6);
  min-height: 100%;
}

.vault-empty {
  flex: 1;
  justify-content: center;
}

.vault-layout {
  display: flex;
  gap: var(--space-4);
  flex: 1;
  min-height: 0;
}

.vault-side {
  display: flex;
  flex-direction: column;
  width: 300px;
  flex-shrink: 0;
  padding: var(--space-3);
  gap: var(--space-2);
  max-height: calc(100vh - var(--topbar-height) - 160px);
  min-height: 360px;
}

.vault-side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}

.vault-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.vault-side-actions {
  display: flex;
  gap: var(--space-2);
}

.vault-side-actions .btn {
  flex: 1;
  justify-content: center;
}

.vault-create {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-2);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}

.vault-create-input {
  height: 30px;
  padding: 0 var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
  outline: none;
  transition: border-color var(--transition-fast);
}

.vault-create-input:focus {
  border-color: var(--color-brand);
}

.vault-create-error {
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}

.vault-create-actions {
  display: flex;
  gap: var(--space-2);
}

.vault-create-actions .btn {
  flex: 1;
  justify-content: center;
}

.vault-tree {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.vault-hint {
  margin: var(--space-2) 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: center;
}

.vault-hint.is-error {
  color: var(--color-danger);
}

.vault-retry {
  align-self: center;
}

.vault-dir {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.vault-dir:hover {
  background: var(--color-surface-muted);
}

.vault-chevron {
  width: 12px;
  height: 12px;
  color: var(--color-text-muted);
  transition: transform var(--transition-fast);
}

.vault-chevron.is-collapsed {
  transform: rotate(-90deg);
}

.vault-file {
  padding: 5px 10px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast);
}

.vault-file:hover {
  background: var(--color-brand-soft);
  color: var(--color-brand);
}

.vault-file.is-active {
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-weight: 500;
}

.vault-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  padding: var(--space-3);
  gap: var(--space-3);
  max-height: calc(100vh - var(--topbar-height) - 160px);
  min-height: 360px;
}

.vault-searchbar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  height: 34px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  transition: border-color var(--transition-fast);
}

.vault-searchbar:focus-within {
  border-color: var(--color-brand);
}

.vault-search-icon {
  width: 15px;
  height: 15px;
  color: var(--color-text-muted);
}

.vault-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
  outline: none;
}

.vault-search-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast);
}

.vault-search-clear:hover {
  color: var(--color-text);
  background: var(--color-surface-muted);
}

.vault-search-clear .app-icon {
  width: 13px;
  height: 13px;
}

.vault-results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.vault-hit {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.vault-hit:hover {
  background: var(--color-brand-soft);
}

.vault-hit-path {
  color: var(--color-brand);
  font-weight: 500;
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
}

.vault-hit-snippet {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.vault-placeholder {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.vault-note {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: var(--space-3);
}

.vault-note-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border);
}

.vault-note-path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.vault-note-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.vault-note-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  font-size: var(--font-size-sm);
  line-height: 1.7;
  color: var(--color-text);
}

.vault-note-body :deep(h1),
.vault-note-body :deep(h2),
.vault-note-body :deep(h3),
.vault-note-body :deep(h4) {
  margin: var(--space-4) 0 var(--space-2);
  font-weight: 700;
  line-height: 1.4;
}

.vault-note-body :deep(h1) {
  font-size: var(--font-size-xl);
}

.vault-note-body :deep(h2) {
  font-size: var(--font-size-lg);
}

.vault-note-body :deep(h3),
.vault-note-body :deep(h4) {
  font-size: var(--font-size-md);
}

.vault-note-body :deep(p) {
  margin: var(--space-2) 0;
}

.vault-note-body :deep(ul),
.vault-note-body :deep(ol) {
  margin: var(--space-2) 0;
  padding-left: var(--space-5);
}

.vault-note-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
}

.vault-note-body :deep(pre) {
  margin: var(--space-2) 0;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  overflow-x: auto;
}

.vault-note-body :deep(pre code) {
  padding: 0;
  background: transparent;
}

.vault-note-body :deep(blockquote) {
  margin: var(--space-2) 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
  font-style: italic;
}

.vault-note-body :deep(a) {
  color: var(--color-brand);
}

.vault-note-body :deep(table) {
  border-collapse: collapse;
  margin: var(--space-2) 0;
}

.vault-note-body :deep(th),
.vault-note-body :deep(td) {
  border: 1px solid var(--color-border);
  padding: var(--space-1) var(--space-2);
}

.vault-note-body :deep(hr) {
  border: none;
  border-top: 1px solid var(--color-border);
  margin: var(--space-3) 0;
}

.vault-editor {
  flex: 1;
  min-height: 0;
  resize: none;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.7;
  outline: none;
  transition: border-color var(--transition-fast);
}

.vault-editor:focus {
  border-color: var(--color-brand);
}

.vault-toast {
  position: fixed;
  left: 50%;
  bottom: 32px;
  transform: translateX(-50%);
  z-index: 70;
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-full);
  background: var(--color-brand-deep);
  color: var(--color-on-brand);
  font-size: var(--font-size-sm);
  box-shadow: var(--shadow-lg);
}

.vault-toast-enter-active,
.vault-toast-leave-active {
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.vault-toast-enter-from,
.vault-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}

@media (max-width: 899px) {
  .vault-layout {
    flex-direction: column;
  }

  .vault-side,
  .vault-main {
    width: auto;
    max-height: none;
    min-height: 0;
  }

  .vault-side {
    max-height: 320px;
  }
}
</style>
