<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import {
  MARKET_CATALOG,
  MARKET_CATEGORIES,
  inferSuggestedAgents,
  type MarketSkill,
  type MarketSkillCategory,
} from '@/lib/market-catalog'
import { fetchSkillFromGithub, getGithubToken } from '@/lib/skillhub'
import { useSkillsStore, type SkillView } from '@/stores/skills'
import { useAgentsStore } from '@/stores/agents'
import AppIcon from '@/components/AppIcon.vue'

/* —— 弹窗开关与状态文字 —— */

const emit = defineEmits<{ close: [] }>()

/** 状态文字的语义（决定状态区配色） */
type MarketStatusKind = 'loading' | 'success' | 'warn' | 'error'

const statusText = ref('')
const statusKind = ref<MarketStatusKind>('loading')
/** 成功提示自动清除定时器 */
let statusTimer: number | undefined

function clearStatus(): void {
  if (statusTimer !== undefined) {
    window.clearTimeout(statusTimer)
    statusTimer = undefined
  }
  statusText.value = ''
}

function setStatus(kind: MarketStatusKind, text: string): void {
  clearStatus()
  statusKind.value = kind
  statusText.value = text
  if (kind === 'success') {
    statusTimer = window.setTimeout(() => {
      statusText.value = ''
      statusTimer = undefined
    }, 2500)
  }
}

function closeModal(): void {
  clearStatus()
  emit('close')
}

/* —— 页签：发现 / 已安装 —— */

type MarketTab = 'discover' | 'installed'

const activeTab = ref<MarketTab>('discover')

/* —— 搜索与分类筛选 —— */

const keyword = ref('')
/** 当前分类；'全部' 表示不筛选 */
const activeCategory = ref<'全部' | MarketSkillCategory>('全部')
/** 在线搜索结果（有关键词时展示在精选之后） */
const onlineResults = ref<MarketSkill[]>([])
const searching = ref(false)
const searchError = ref('')
/** 防抖定时器 */
let debounceTimer: number | undefined

/** 搜索框引用：打开弹窗时自动聚焦，保证可以直接输入 */
const searchInputEl = ref<HTMLInputElement | null>(null)

onMounted(() => {
  shuffleDiscovery()
  searchInputEl.value?.focus()
})

/* —— 随机发现：洗牌精选 + 随机 topic 在线内容 —— */

/** 洗牌后取前 N 条的精选条目（每次打开 / 点刷新重新洗牌） */
const discoveredItems = ref<MarketSkill[]>([])
/** 随机挑选的 GitHub topic 对应的在线条目 */
const topicResults = ref<MarketSkill[]>([])
/** 正在拉取随机 topic 内容 */
const topicLoading = ref(false)
/** 高星热门：GitHub 高星技能仓库（按星数降序），常驻展示在发现页最前 */
const topStars = ref<MarketSkill[]>([])
/** 正在拉取高星热门 */
const topStarsLoading = ref(false)

/** 拉取高星热门：固定查询 topic:claude-skills 按星数降序取前 15；限流/失败静默返回（不影响其他部分） */
async function loadTopStars(): Promise<void> {
  if (topStarsLoading.value) return
  topStarsLoading.value = true
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  const token = getGithubToken()
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const result = await searchOneQuery('topic:claude-skills stars:>100', headers)
    topStars.value = result ?? []
  } finally {
    topStarsLoading.value = false
  }
}

/** 发现模式展示的精选条数 */
const DISCOVER_COUNT = 12

/** 随机 topic 候选池（每次从中挑 1~2 个） */
const DISCOVERY_TOPICS: readonly string[] = [
  'claude-skills',
  'agent-skills',
  'ai-tools',
  'prompt-engineering',
  'design-systems',
  'automation',
  'writing-tools',
  'developer-tools',
  'productivity',
]

/** Fisher-Yates 洗牌（返回新数组，不改原目录） */
function shuffle<T>(list: readonly T[]): T[] {
  const result = [...list]
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/** 从候选池随机挑 count 个不重复 topic */
function pickRandomTopics(count: number): string[] {
  return shuffle(DISCOVERY_TOPICS).slice(0, count)
}

/** 拉取一路 topic 下的热门仓库；失败静默返回空数组（403 限流沿用既有中文提示） */
async function fetchTopicSkills(topic: string, headers: Record<string, string>): Promise<MarketSkill[]> {
  try {
    const response = await fetch(
      `https://api.github.com/search/repositories?topic=${encodeURIComponent(topic)}&sort=stars&order=desc&per_page=6`,
      { headers },
    )
    if (response.status === 403) {
      searchError.value =
        'GitHub 搜索受限（未认证每分钟约 10 次）：请稍后再试，或在「从 SkillHub 添加」中配置 Token 提升限额'
      return []
    }
    if (!response.ok) return []
    const data: unknown = await response.json()
    const items =
      typeof data === 'object' && data !== null && Array.isArray((data as { items?: unknown }).items)
        ? ((data as { items: Array<Record<string, unknown>> }).items ?? [])
        : []
    return items.map(mapRepoItem)
  } catch {
    return []
  }
}

/** 拉取随机 topic 的在线内容，与内置目录按 owner/repo 去重后合并 */
async function loadTopicSkills(): Promise<void> {
  if (topicLoading.value) return
  topicLoading.value = true
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  const token = getGithubToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const topics = pickRandomTopics(1 + Math.floor(Math.random() * 2))
  try {
    const settled = await Promise.all(topics.map((topic) => fetchTopicSkills(topic, headers)))
    const known = new Set(MARKET_CATALOG.map((skill) => `${skill.owner}/${skill.repo}`.toLowerCase()))
    const merged: MarketSkill[] = []
    for (const result of settled) {
      for (const skill of result) {
        const key = `${skill.owner}/${skill.repo}`.toLowerCase()
        if (known.has(key)) continue
        known.add(key)
        merged.push(skill)
      }
    }
    topicResults.value = merged
  } finally {
    topicLoading.value = false
  }
}

/** 重新随机发现：洗牌精选 + 重新随机 topic + 刷新高星热门（弹窗打开与「刷新」按钮共用） */
function shuffleDiscovery(): void {
  discoveredItems.value = shuffle(MARKET_CATALOG).slice(0, DISCOVER_COUNT)
  topicResults.value = []
  searchError.value = ''
  void loadTopicSkills()
  void loadTopStars()
}

/** 单条仓库搜索结果 → 市场卡片结构 */
function mapRepoItem(item: Record<string, unknown>): MarketSkill {
  const owner =
    typeof item.owner === 'object' && item.owner !== null
      ? String((item.owner as { login?: unknown }).login ?? '')
      : ''
  const repo = typeof item.name === 'string' ? item.name : ''
  const description = typeof item.description === 'string' ? item.description : ''
  const stars = typeof item.stargazers_count === 'number' ? item.stargazers_count : 0
  const finalDescription = description || '（仓库未填写描述）'
  return {
    name: repo,
    owner,
    repo,
    branch: '',
    path: '',
    description: finalDescription,
    detail: finalDescription,
    suggestedAgents: inferSuggestedAgents(finalDescription),
    category: '其他' as MarketSkillCategory,
    icon: '🧩',
    stars,
  }
}

/** 执行一路 /search/repositories 查询，失败时返回 null（不影响其他路） */
async function searchOneQuery(query: string, headers: Record<string, string>): Promise<MarketSkill[] | null> {
  try {
    const response = await fetch(
      `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=15`,
      { headers },
    )
    if (response.status === 403) {
      throw new Error('GitHub 搜索受限（未认证每分钟约 10 次）：请稍后再试，或在「从 SkillHub 添加」中配置 Token 提升限额')
    }
    if (!response.ok) {
      throw new Error(`GitHub 搜索失败（HTTP ${response.status}）`)
    }
    const data: unknown = await response.json()
    const items =
      typeof data === 'object' && data !== null && Array.isArray((data as { items?: unknown }).items)
        ? ((data as { items: Array<Record<string, unknown>> }).items ?? [])
        : []
    return items.map(mapRepoItem)
  } catch (error) {
    console.warn(`[技能市场] 查询 "${query}" 失败：`, error)
    return null
  }
}

/**
 * GitHub 在线搜索：并行发 3 路查询变体提升召回率
 * ① 关键词 + topic:claude-skills（高精度）
 * ② 关键词 + topic:agent-skills（高精度）
 * ③ 关键词 + agent/claude skill 字样（宽松兜底）
 * 三路结果按 full_name 去重、按星数降序，取前 30 条；单路失败不影响整体。
 */
async function searchGithub(): Promise<void> {
  const kw = keyword.value.trim()
  if (!kw) {
    onlineResults.value = []
    searchError.value = ''
    return
  }
  if (searching.value) return
  searching.value = true
  searchError.value = ''
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  const token = getGithubToken()
  if (token) headers.Authorization = `Bearer ${token}`
  try {
    const queries = [
      `${kw} topic:claude-skills`,
      `${kw} topic:agent-skills`,
      `${kw} agent skill OR claude skill in:name,description,readme`,
    ]
    const settled = await Promise.all(queries.map((q) => searchOneQuery(q, headers)))
    const merged = new Map<string, MarketSkill>()
    for (const result of settled) {
      if (result === null) continue
      for (const skill of result) {
        const key = `${skill.owner}/${skill.repo}`.toLowerCase()
        if (!merged.has(key)) merged.set(key, skill)
      }
    }
    if (settled.every((r) => r === null)) {
      throw new Error('GitHub 搜索受限（未认证每分钟约 10 次）：请稍后再试，或在「从 SkillHub 添加」中配置 Token 提升限额')
    }
    onlineResults.value = [...merged.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, 30)
  } catch (error) {
    onlineResults.value = []
    searchError.value = error instanceof Error ? error.message : '搜索失败，请稍后再试'
  } finally {
    searching.value = false
  }
}

/** 关键词防抖 400ms 触发在线搜索 */
watch(keyword, () => {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
  debounceTimer = window.setTimeout(() => {
    debounceTimer = undefined
    void searchGithub()
  }, 400)
})

onBeforeUnmount(() => {
  if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
  clearStatus()
})

/** 关键词模糊匹配单条技能 */
function matchKeyword(skill: MarketSkill, kw: string): boolean {
  return `${skill.name} ${skill.owner}/${skill.repo} ${skill.description}`.toLowerCase().includes(kw)
}

/** 发现页签展示的精选条目：无关键词且未选分类时展示洗牌后的随机精选；筛选时按全量目录过滤 */
const catalogItems = computed<MarketSkill[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw && activeCategory.value === '全部') return discoveredItems.value
  return MARKET_CATALOG.filter((skill) => {
    if (activeCategory.value !== '全部' && skill.category !== activeCategory.value) return false
    return !kw || matchKeyword(skill, kw)
  })
})

/** 发现页签展示的在线结果：有关键词时为搜索结果，无关键词时为随机 topic 内容（均仅在「全部」分类下展示） */
const onlineItems = computed<MarketSkill[]>(() => {
  if (activeCategory.value !== '全部') return []
  if (keyword.value.trim()) return onlineResults.value
  return topicResults.value
})

/** 高星热门分组：仅无关键词且「全部」分类下常驻展示；按星数降序，与内置目录去重 */
const starItems = computed<MarketSkill[]>(() => {
  if (activeCategory.value !== '全部' || keyword.value.trim()) return []
  const known = new Set(MARKET_CATALOG.map((skill) => `${skill.owner}/${skill.repo}`.toLowerCase()))
  return topStars.value
    .filter((skill) => !known.has(`${skill.owner}/${skill.repo}`.toLowerCase()))
    .sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0))
    .slice(0, 15)
})

function cardKey(skill: MarketSkill): string {
  return `${skill.owner}/${skill.repo}/${skill.path}`
}

/** 点「刷新」：有关键词时重跑在线搜索，否则重新随机发现 */
function onRefresh(): void {
  if (keyword.value.trim()) {
    void searchGithub()
  } else {
    shuffleDiscovery()
  }
}

/** 分类 chips 与数量（基于精选索引统计） */
const categoryChips = computed<Array<{ label: '全部' | MarketSkillCategory; count: number }>>(() => {
  const chips: Array<{ label: '全部' | MarketSkillCategory; count: number }> = [
    { label: '全部', count: MARKET_CATALOG.length },
  ]
  for (const category of MARKET_CATEGORIES) {
    chips.push({
      label: category,
      count: MARKET_CATALOG.filter((skill) => skill.category === category).length,
    })
  }
  return chips
})

/* —— 安装 —— */

const skillsStore = useSkillsStore()
const agentsStore = useAgentsStore()

/** 正在安装的条目 key（owner/repo/path），用于按钮加载态 */
const installingKey = ref('')

/** 已点「安装」、等待确认挂载智能体的条目 key；空串表示无待确认条目 */
const pendingKey = ref('')
/** 待确认条目上选择的挂载智能体 id；''=暂不挂载，仅装入技能中心 */
const pendingAgentId = ref('')

/** 可选挂载的智能体：全部可用智能体（内置 + 自定义，已停用的不出现） */
const agentOptions = computed(() => agentsStore.enabledAgents)

/** 拼出技能安装链接（path 为空串时走仓库根链接） */
function skillUrl(skill: MarketSkill): string {
  if (!skill.path) return `https://github.com/${skill.owner}/${skill.repo}`
  const branch = skill.branch || 'main'
  return `https://github.com/${skill.owner}/${skill.repo}/tree/${branch}/${skill.path}`
}

/** 条目是否已安装（按 skills store 中 gh:owner/repo 前缀查重；skillDir 拉取后才知道） */
function isInstalled(skill: MarketSkill): boolean {
  const prefix = `gh:${skill.owner}/${skill.repo}`
  return skillsStore.skills.some(
    (item) => item.skillhubId === prefix || (item.skillhubId?.startsWith(`${prefix}/`) ?? false),
  )
}

/** 点「安装」：未安装时先弹卡片内联确认层选择挂载智能体；已安装的按钮本就禁用，不会走到这里 */
function requestInstall(skill: MarketSkill): void {
  if (isInstalled(skill)) return
  pendingKey.value = cardKey(skill)
  pendingAgentId.value = ''
}

/** 取消挂载确认层 */
function cancelInstall(): void {
  pendingKey.value = ''
  pendingAgentId.value = ''
}

/** 一键安装：拉取 SKILL.md → 查重 → 写入技能中心为自定义技能 → 按选择挂载到智能体 */
async function installSkill(skill: MarketSkill, agentId: string): Promise<void> {
  const key = cardKey(skill)
  if (installingKey.value) return
  installingKey.value = key
  setStatus('loading', `正在安装「${skill.name}」…`)
  try {
    const installed = await fetchSkillFromGithub(skillUrl(skill), getGithubToken() || undefined)
    const skillhubId = `gh:${installed.owner}/${installed.repo}/${installed.skillDir}`
    if (skillsStore.isSkillImported(skillhubId)) {
      setStatus('warn', '该技能已安装')
      return
    }
    const newSkillId = skillsStore.addCustomSkill({
      name: installed.name,
      description: installed.description,
      template: installed.systemPrompt,
      icon: skill.icon,
      tags: ['技能市场'],
      skillhubId,
      source: 'import',
    })
    if (agentId) {
      agentsStore.linkSkillToAgent(agentId, newSkillId)
      const agentName = agentsStore.findAgent(agentId)?.name ?? ''
      setStatus('success', `已安装「${installed.name}」并挂载到「${agentName}」，对话中按需触发`)
    } else {
      setStatus('success', `已安装到技能中心：${installed.name}（AI 对话中按需触发）`)
    }
  } catch (error) {
    setStatus('error', error instanceof Error ? error.message : '安装失败，请稍后再试')
  } finally {
    installingKey.value = ''
    if (pendingKey.value === key) cancelInstall()
  }
}

/** 确认层里的「确认安装」：带上当前选择的智能体执行安装 */
function confirmInstall(skill: MarketSkill): void {
  void installSkill(skill, pendingAgentId.value)
}

/* —— 已安装页签 —— */

/** 本机通过市场（gh:/zip: 来源）导入的自定义技能 */
const installedSkills = computed<SkillView[]>(() =>
  skillsStore.skills.filter(
    (item) => item.skillhubId?.startsWith('gh:') || item.skillhubId?.startsWith('zip:'),
  ),
)

/** 启用/停用已安装的技能 */
function toggleInstalled(skill: SkillView): void {
  skillsStore.toggleDisabled(skill.id)
}

/** 删除已安装的技能 */
function removeInstalled(skill: SkillView): void {
  if (!window.confirm(`确定删除「${skill.name}」吗？该操作不可撤销。`)) return
  skillsStore.removeCustomSkill(skill.id)
  setStatus('success', `已删除：${skill.name}`)
}
</script>

<template>
  <div class="modal-mask" @click.self="closeModal">
    <div class="modal market-modal" role="dialog" aria-modal="true" aria-label="技能市场">
      <header class="modal-head">
        <div>
          <h2>技能市场</h2>
          <p class="market-subtitle">精选开源 Agent Skills，可搜索、可分类、一键安装</p>
        </div>
        <button class="icon-button" type="button" aria-label="关闭" @click="closeModal">
          <AppIcon name="close" />
        </button>
      </header>

      <div class="market-tabs" role="tablist">
        <button
          class="market-tab"
          :class="{ 'is-active': activeTab === 'discover' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'discover'"
          @click="activeTab = 'discover'"
        >
          发现
        </button>
        <button
          class="market-tab"
          :class="{ 'is-active': activeTab === 'installed' }"
          type="button"
          role="tab"
          :aria-selected="activeTab === 'installed'"
          @click="activeTab = 'installed'"
        >
          已安装（{{ installedSkills.length }}）
        </button>
      </div>

      <!-- —— 发现页签 —— -->
      <div v-if="activeTab === 'discover'" class="market-body">
        <div class="market-toolbar">
          <div class="search-box market-search">
            <AppIcon name="search" />
            <input
              ref="searchInputEl"
              v-model="keyword"
              class="search-input"
              type="text"
              placeholder="搜索技能名或描述（回车立即搜索 GitHub 在线仓库）…"
              @keydown.enter.prevent="void searchGithub()"
            />
          </div>
          <button class="btn btn-ghost" type="button" :disabled="searching || topicLoading || topStarsLoading" @click="onRefresh">
            <AppIcon name="refresh" />
            {{ searching || topicLoading || topStarsLoading ? '刷新中…' : '刷新' }}
          </button>
        </div>

        <div class="market-chips" role="group" aria-label="分类筛选">
          <button
            v-for="chip in categoryChips"
            :key="chip.label"
            class="market-chip"
            :class="{ 'is-active': activeCategory === chip.label }"
            type="button"
            @click="activeCategory = chip.label"
          >
            {{ chip.label }}
            <span class="market-chip-count">{{ chip.count }}</span>
          </button>
        </div>

        <p v-if="statusText" :class="['market-status', `is-${statusKind}`]" role="status">
          {{ statusText }}
        </p>

        <div v-if="catalogItems.length || onlineItems.length || starItems.length" class="market-grid">
          <!-- —— 高星热门：GitHub 高星技能仓库，常驻展示在列表最前 —— -->
          <div v-if="starItems.length" class="market-grid-head">
            高星热门
            <span class="market-grid-head-hint">GitHub 高星技能仓库 · 按星数排序</span>
          </div>
          <article v-for="skill in starItems" :key="`s-${skill.owner}/${skill.repo}`" class="market-card">
            <div class="market-card-head">
              <span class="market-card-icon" aria-hidden="true">{{ skill.icon }}</span>
              <div class="market-card-title">
                <strong>{{ skill.name }}</strong>
                <span class="market-card-owner">{{ skill.owner }}/{{ skill.repo }}</span>
              </div>
              <span v-if="typeof skill.stars === 'number'" class="market-card-stars">★ {{ skill.stars }}</span>
            </div>
            <p class="market-card-desc">{{ skill.description }}</p>
            <div class="market-card-detail">
              <p class="market-card-detail-line">
                <span class="market-card-detail-label">用途</span>{{ skill.detail }}
              </p>
              <p class="market-card-detail-line">
                <span class="market-card-detail-label">适合挂载</span>{{ skill.suggestedAgents.join('；') }}
              </p>
            </div>
            <button
              class="btn btn-primary market-install"
              type="button"
              :disabled="isInstalled(skill) || installingKey === cardKey(skill)"
              @click="requestInstall(skill)"
            >
              <AppIcon name="download" />
              {{ isInstalled(skill) ? '已安装' : installingKey === cardKey(skill) ? '安装中…' : '安装' }}
            </button>
            <div v-if="pendingKey === cardKey(skill)" class="market-install-confirm">
              <label class="market-confirm-label" :for="`mount-s-${skill.owner}-${skill.repo}`">挂载到智能体</label>
              <select
                :id="`mount-s-${skill.owner}-${skill.repo}`"
                v-model="pendingAgentId"
                class="market-select"
              >
                <option value="">暂不挂载，仅装入技能中心</option>
                <option v-for="agent in agentOptions" :key="agent.id" :value="agent.id">
                  {{ agent.icon }} {{ agent.name }}
                </option>
              </select>
              <div class="market-confirm-actions">
                <button class="btn btn-ghost btn-sm" type="button" @click="cancelInstall">取消</button>
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  :disabled="installingKey === cardKey(skill)"
                  @click="confirmInstall(skill)"
                >
                  确认安装
                </button>
              </div>
            </div>
          </article>

          <article v-for="skill in catalogItems" :key="`c-${skill.owner}/${skill.repo}/${skill.path}`" class="market-card">
            <div class="market-card-head">
              <span class="market-card-icon" aria-hidden="true">{{ skill.icon }}</span>
              <div class="market-card-title">
                <strong>{{ skill.name }}</strong>
                <span class="market-card-owner">{{ skill.owner }}/{{ skill.repo }}</span>
              </div>
              <span class="market-chip-tag">{{ skill.category }}</span>
            </div>
            <p class="market-card-desc">{{ skill.description }}</p>
            <div class="market-card-detail">
              <p class="market-card-detail-line">
                <span class="market-card-detail-label">用途</span>{{ skill.detail }}
              </p>
              <p class="market-card-detail-line">
                <span class="market-card-detail-label">适合挂载</span>{{ skill.suggestedAgents.join('；') }}
              </p>
            </div>
            <p class="market-card-hint">安装后可在技能中心管理，AI 对话中按需触发</p>
            <button
              class="btn btn-primary market-install"
              type="button"
              :disabled="isInstalled(skill) || installingKey === cardKey(skill)"
              @click="requestInstall(skill)"
            >
              <AppIcon name="download" />
              {{ isInstalled(skill) ? '已安装' : installingKey === cardKey(skill) ? '安装中…' : '安装' }}
            </button>
            <div v-if="pendingKey === cardKey(skill)" class="market-install-confirm">
              <label class="market-confirm-label" :for="`mount-c-${skill.owner}-${skill.repo}-${skill.path}`">挂载到智能体</label>
              <select
                :id="`mount-c-${skill.owner}-${skill.repo}-${skill.path}`"
                v-model="pendingAgentId"
                class="market-select"
              >
                <option value="">暂不挂载，仅装入技能中心</option>
                <option v-for="agent in agentOptions" :key="agent.id" :value="agent.id">
                  {{ agent.icon }} {{ agent.name }}
                </option>
              </select>
              <div class="market-confirm-actions">
                <button class="btn btn-ghost btn-sm" type="button" @click="cancelInstall">取消</button>
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  :disabled="installingKey === cardKey(skill)"
                  @click="confirmInstall(skill)"
                >
                  确认安装
                </button>
              </div>
            </div>
          </article>

          <article v-for="skill in onlineItems" :key="`o-${skill.owner}/${skill.repo}`" class="market-card">
            <div class="market-card-head">
              <span class="market-card-icon" aria-hidden="true">{{ skill.icon }}</span>
              <div class="market-card-title">
                <strong>{{ skill.name }}</strong>
                <span class="market-card-owner">{{ skill.owner }}/{{ skill.repo }}</span>
              </div>
              <span v-if="typeof skill.stars === 'number'" class="market-card-stars">★ {{ skill.stars }}</span>
            </div>
            <p class="market-card-desc">{{ skill.description }}</p>
            <div class="market-card-detail">
              <p class="market-card-detail-line">
                <span class="market-card-detail-label">用途</span>{{ skill.detail }}
              </p>
              <p class="market-card-detail-line">
                <span class="market-card-detail-label">适合挂载</span>{{ skill.suggestedAgents.join('；') }}
              </p>
            </div>
            <button
              class="btn btn-primary market-install"
              type="button"
              :disabled="isInstalled(skill) || installingKey === cardKey(skill)"
              @click="requestInstall(skill)"
            >
              <AppIcon name="download" />
              {{ isInstalled(skill) ? '已安装' : installingKey === cardKey(skill) ? '安装中…' : '安装' }}
            </button>
            <div v-if="pendingKey === cardKey(skill)" class="market-install-confirm">
              <label class="market-confirm-label" :for="`mount-o-${skill.owner}-${skill.repo}`">挂载到智能体</label>
              <select
                :id="`mount-o-${skill.owner}-${skill.repo}`"
                v-model="pendingAgentId"
                class="market-select"
              >
                <option value="">暂不挂载，仅装入技能中心</option>
                <option v-for="agent in agentOptions" :key="agent.id" :value="agent.id">
                  {{ agent.icon }} {{ agent.name }}
                </option>
              </select>
              <div class="market-confirm-actions">
                <button class="btn btn-ghost btn-sm" type="button" @click="cancelInstall">取消</button>
                <button
                  class="btn btn-primary btn-sm"
                  type="button"
                  :disabled="installingKey === cardKey(skill)"
                  @click="confirmInstall(skill)"
                >
                  确认安装
                </button>
              </div>
            </div>
          </article>
        </div>

        <p v-else class="market-empty">没有匹配的技能，换个关键词或分类试试。</p>

        <p v-if="searchError" class="market-status is-error" role="alert">{{ searchError }}</p>
        <p v-else-if="searching" class="market-hint">正在搜索 GitHub 在线仓库…</p>
        <p v-else-if="!keyword.trim() && topicLoading" class="market-hint">正在为你随机挑选 GitHub 话题内容…</p>
        <p v-else-if="keyword.trim() && !onlineItems.length" class="market-hint">
          在线结果为空或未加载；未认证限流约每分钟 10 次，可在「从 SkillHub 添加」中配置 GitHub Token 提升限额。
        </p>
      </div>

      <!-- —— 已安装页签 —— -->
      <div v-else class="market-body">
        <ul v-if="installedSkills.length" class="market-installed">
          <li v-for="skill in installedSkills" :key="skill.id" class="market-installed-item">
            <span class="market-card-icon" aria-hidden="true">{{ skill.icon }}</span>
            <div class="market-installed-copy">
              <strong>{{ skill.name }}</strong>
              <span>{{ skill.description }}</span>
              <code class="market-installed-id">{{ skill.skillhubId }}</code>
            </div>
            <div class="market-installed-actions">
              <button class="btn btn-ghost btn-sm" type="button" @click="toggleInstalled(skill)">
                {{ skill.disabled ? '启用' : '停用' }}
              </button>
              <button class="btn btn-ghost btn-sm market-remove" type="button" @click="removeInstalled(skill)">
                <AppIcon name="trash" />
                删除
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="market-empty">还没有通过市场安装的技能，去「发现」页签挑一个吧。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.market-modal {
  width: min(880px, 94vw);
  max-width: min(880px, 94vw);
  display: flex;
  flex-direction: column;
}

.market-subtitle {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.market-tabs {
  display: flex;
  gap: var(--space-2);
  padding: 0 var(--space-5);
  border-bottom: 1px solid var(--color-border);
}

.market-tab {
  appearance: none;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}

.market-tab.is-active {
  color: var(--color-brand);
  border-bottom-color: var(--color-brand);
  font-weight: 600;
}

.market-body {
  padding: var(--space-4) var(--space-5) var(--space-5);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.market-toolbar {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.market-search {
  flex: 1;
}

.market-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.market-chip {
  appearance: none;
  border: 1px solid var(--color-border);
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
  border-radius: var(--radius-full);
  padding: var(--space-1) var(--space-3);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.market-chip.is-active {
  background: var(--color-brand-soft);
  border-color: var(--color-brand);
  color: var(--color-brand);
}

.market-chip-count {
  margin-left: var(--space-1);
  font-size: var(--font-size-xs);
  opacity: 0.75;
}

.market-status {
  border-radius: var(--radius-md);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-sm);
}

.market-status.is-loading {
  background: var(--color-info-soft);
  color: var(--color-info-600);
}

.market-status.is-success {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.market-status.is-warn {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.market-status.is-error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.market-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

/* 分组标题：占满整行 */
.market-grid-head {
  grid-column: 1 / -1;
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  color: var(--color-text);
  font-size: var(--font-size-md);
  font-weight: 600;
  padding-top: var(--space-1);
}

.market-grid-head-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 400;
}

.market-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-4);
}

.market-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.market-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  font-size: var(--font-size-xl);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
}

.market-card-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.market-card-title strong {
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.market-card-owner {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.market-chip-tag {
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-xs);
  padding: 2px var(--space-2);
  white-space: nowrap;
}

.market-card-stars {
  flex-shrink: 0;
  color: var(--color-warning);
  font-size: var(--font-size-sm);
  white-space: nowrap;
}

.market-card-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}

.market-card-detail {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  padding: var(--space-2) var(--space-3);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.market-card-detail-line {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.market-card-detail-label {
  display: inline-block;
  margin-right: var(--space-2);
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.market-install {
  justify-content: center;
}

/* 卡片内联挂载确认层 */
.market-install-confirm {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  padding: var(--space-3);
}

.market-confirm-label {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.market-select {
  appearance: auto;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  padding: var(--space-1) var(--space-2);
  width: 100%;
}

.market-select:focus {
  outline: none;
  border-color: var(--color-brand);
}

.market-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}

.market-card-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.market-empty {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
  padding: var(--space-6) 0;
}

.market-installed {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.market-installed-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  padding: var(--space-3) var(--space-4);
}

.market-installed-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  gap: 2px;
}

.market-installed-copy strong {
  color: var(--color-text);
}

.market-installed-copy span {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-installed-id {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-installed-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.market-remove {
  color: var(--color-danger);
}

/* base.css 无 .btn-sm；与 AgentsView 一致的小号按钮尺寸 */
.btn-sm {
  font-size: var(--font-size-sm);
  padding: var(--space-1) var(--space-3);
}

@media (max-width: 720px) {
  .market-grid {
    grid-template-columns: 1fr;
  }

  .market-installed-item {
    flex-direction: column;
    align-items: flex-start;
  }
}
</style>
