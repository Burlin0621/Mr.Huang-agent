<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'

import EmptyState from '@/components/EmptyState.vue'
import RichText from '@/components/RichText.vue'
import ToolStepCard from '@/components/ToolStepCard.vue'
import { hasHtmlPreviewBridge } from '@/lib/desktop-bridge'
import {
  NOTE_AUTHOR,
  WRITING_AUDIENCES,
  WRITING_GOALS,
  WRITING_POSITIONINGS,
  WRITING_STAGES,
  WRITING_STYLES,
  buildNoteHtml,
  buildNoteMarkdown,
  buildNotePreviewMarkdown,
  buildNoteWithPlaceholders,
  extractFirstHeading,
  extractHashtags,
} from '@/lib/xhs-writing'
import type { ImagePromptItem } from '@/lib/xhs-writing'
import { useXhsWritingStore } from '@/stores/xhs-writing'
import type { PipelineStageState } from '@/stores/xhs-writing'

/**
 * 小红书写作（纯展示视图）：六阶段写作流水线的表单与结果渲染。
 * 运行状态与编排逻辑全部在 useXhsWritingStore（Pinia 常驻内存），
 * 切换左侧菜单后任务继续运行，回到本页原样展示（含流式中途进度）。
 */

const store = useXhsWritingStore()
const {
  topic,
  authorRole,
  positioning,
  audience,
  goal,
  styleText,
  stages,
  expanded,
  images,
} = storeToRefs(store)
const running = computed(() => store.running)
const activeConfig = computed(() => store.activeConfig)

const route = useRoute()

/** 阶段状态徽标文案 */
const STATUS_LABEL: Record<PipelineStageState['status'], string> = {
  idle: '待运行',
  running: '运行中',
  done: '已完成',
  error: '失败',
  aborted: '已中止',
}

/* —— 需求输入区（字段存于 store，切路由输入不丢） —— */

/** 下拉兼容旧自由文本：持久化恢复出的历史值不在选项列表且非空时，动态追加为首个选项（不丢弃用户已填内容） */
function withLegacyOption(options: readonly string[], value: string): string[] {
  const trimmed = value.trim()
  return trimmed && !options.includes(trimmed) ? [trimmed, ...options] : [...options]
}

const positioningOptions = computed(() => withLegacyOption(WRITING_POSITIONINGS, positioning.value))
const audienceOptions = computed(() => withLegacyOption(WRITING_AUDIENCES, audience.value))
const styleOptions = computed(() => withLegacyOption(WRITING_STYLES, styleText.value))

/** 「今日选题」卡片跳转携带 ?topic=：挂载时非空则自动填入主题输入框 */
onMounted(() => {
  store.applyQueryTopic(route.query.topic)
})

/** 轻量提示（复制成功等） */
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 2200)
}

/** 点击「开始写作」：校验主题后由 store 从头执行完整流水线 */
function startWriting(): void {
  if (!topic.value.trim()) {
    showNotice('请先填写主题/关键词')
    return
  }
  void store.startPipeline()
}

/** 点击「清空」（二次确认）：表单、全部阶段产出与配图回到初始态，并同步清掉持久化数据 */
function clearAll(): void {
  if (!window.confirm('确定清空写作需求与全部阶段产出（含配图）吗？此操作不可撤销。')) return
  store.clearAll()
  showNotice('已清空全部写作内容')
}

/** 单阶段重试入口：主题缺失或前置阶段未完成时给出提示 */
async function retryStage(stageIndex: number): Promise<void> {
  if (!topic.value.trim()) {
    showNotice('请先填写主题/关键词')
    return
  }
  if (!store.prerequisitesDone(stageIndex)) {
    showNotice('请先完成前置阶段，或从开始写作重新运行')
    return
  }
  await store.retryStage(stageIndex)
}

/* —— 笔记预览：小红书卡片渲染 / 复制 / 导出 —— */

/** 笔记预览数据源（润色阶段产出） */
const polishStage = computed(() => stages.value[3])

const noteReady = computed(() => Boolean(polishStage.value.content.trim()))
const noteTitle = computed(() => extractFirstHeading(polishStage.value.content) || topic.value.trim() || '未命名笔记')

/** 预览话题标签：从润色全文中提取 # 标签，无则回退默认引导文案 */
const noteHashtags = computed(() => {
  const tags = extractHashtags(polishStage.value.content)
  return tags.length > 0 ? tags : ['#小红书写作']
})

/** 首图 prompt 条目（预览卡片置顶显示占位框，图片由用户拿 prompt 去外部工具生成） */
const coverPrompt = computed(() => images.value.find((img) => img.role === 'cover'))

/** 首图全局编号（配图卡片顺序 = 生成顺序 = 编号，首图固定第 1 张） */
const coverNumber = computed(() => images.value.findIndex((img) => img.role === 'cover') + 1)

/**
 * 预览正文：有配图时用 preview 模式构建——在 anchor 命中的行后插入可见的
 * blockquote 提示块（📷 此处插入 图N），让用户直接看出每张图该插在哪；
 * 无配图时回退纯润色产出。内页图标记位置与导出 md 中的注释占位严格一致（共用定位逻辑）。
 */
const previewBody = computed(() =>
  images.value.length > 0
    ? buildNotePreviewMarkdown(polishStage.value.content, images.value)
    : polishStage.value.content,
)

/** 完整版 markdown（复制/导出用：首图固定在文首 + 内页图按 anchor 插入 HTML 注释占位） */
const fullMarkdown = computed(() => buildNoteWithPlaceholders(polishStage.value.content, images.value, true))

/** HTML 网页版：独立完整文档（内联样式、无外部资源），供浏览器预览与 .html 导出 */
const previewHtml = computed(() =>
  buildNoteHtml(store.buildRequirement(), polishStage.value.content, images.value),
)

/**
 * 在浏览器打开 HTML 预览：
 * - 桌面端（有桥接）：走 preview:open-html IPC——主进程写临时文件 + shell.openPath
 *   用系统默认浏览器打开。为什么不直接 window.open：本应用 Electron 环境渲染进程
 *   的 window.open 不可用（页面报 "TypeError: window.open is not a function"）；
 * - 纯浏览器（npm run dev 无桥接）：Blob URL + window.open，弹窗被拦截或抛错时
 *   降级为下载 .html 文件。
 */
async function openHtmlPreview(): Promise<void> {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  if (hasHtmlPreviewBridge()) {
    try {
      const result = await window.mrHuangDesktop!.openHtmlPreview!(`小红书笔记预览-${stamp}.html`, previewHtml.value)
      showNotice(result.ok ? '已在系统默认浏览器打开预览' : `打开失败：${result.error ?? '未知错误'}`)
    } catch (err) {
      showNotice(`打开失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return
  }
  try {
    const url = URL.createObjectURL(new Blob([previewHtml.value], { type: 'text/html;charset=utf-8' }))
    const opened = window.open(url, '_blank', 'noopener')
    if (!opened) throw new Error('弹窗被拦截')
    // Blob URL 给新窗口留出加载时间后释放，避免长期占用
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  } catch {
    // window.open 不可用或弹窗被阻止：降级为下载 .html（复用导出逻辑）
    exportHtml()
    showNotice('浏览器阻止了弹窗，已改为下载 HTML 文件')
  }
}

/** 导出 .html 文件（与导出 .md 同模式：a[download] 触发下载） */
function exportHtml(): void {
  const url = URL.createObjectURL(new Blob([previewHtml.value], { type: 'text/html;charset=utf-8' }))
  const link = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  link.href = url
  link.download = `小红书笔记-${stamp}.html`
  link.click()
  URL.revokeObjectURL(url)
  showNotice('已导出 HTML 文件')
}

async function copyNote(): Promise<void> {
  if (!fullMarkdown.value.trim()) {
    showNotice('暂无笔记可复制')
    return
  }
  try {
    await navigator.clipboard.writeText(fullMarkdown.value)
    showNotice('带配图占位笔记已复制到剪贴板')
  } catch {
    showNotice('复制失败：未授权剪贴板，可改用「导出 .md」')
  }
}

function exportNote(): void {
  if (!fullMarkdown.value.trim()) {
    showNotice('暂无笔记可导出')
    return
  }
  const markdown = buildNoteMarkdown(store.buildRequirement(), fullMarkdown.value)
  const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  link.href = url
  link.download = `小红书笔记-${stamp}.md`
  link.click()
  URL.revokeObjectURL(url)
  showNotice('已导出 Markdown 文件')
}

/** 复制单条配图 prompt：用户粘贴到外部生图工具生成图片 */
async function copyPrompt(item: ImagePromptItem): Promise<void> {
  try {
    await navigator.clipboard.writeText(item.prompt)
    showNotice(item.role === 'cover' ? '首图 prompt 已复制' : '内页图 prompt 已复制')
  } catch {
    showNotice('复制失败：未授权剪贴板')
  }
}
</script>

<template>
  <div class="xhs-writing">
    <!-- 未配置模型：引导去设置页 -->
    <EmptyState
      v-if="!activeConfig"
      title="尚未配置模型"
      description="小红书写作需要一个大模型接口。请先到「设置 → 模型配置」填写接口地址与密钥。"
    >
      <RouterLink class="primary-button" to="/settings">去设置模型</RouterLink>
    </EmptyState>

    <template v-else>
      <!-- 顶部需求输入区 -->
      <section class="requirement-card">
        <header class="card-header">
          <span class="card-kicker">写作需求</span>
          <h2 class="card-title">告诉「社媒运营专家」你想写什么笔记</h2>
        </header>
        <div class="form-grid">
          <label class="form-field form-span">
            <span class="form-label">主题 / 关键词 <em class="required">*</em></span>
            <input
              v-model="topic"
              class="form-input"
              type="text"
              placeholder="例如：打工人 10 分钟快手早餐"
              :disabled="running"
            />
          </label>
          <label class="form-field">
            <span class="form-label">作者职业</span>
            <input
              v-model="authorRole"
              class="form-input"
              type="text"
              placeholder="例如：10 年大厂 HR（留空由 AI 自定）"
              maxlength="60"
              :disabled="running"
            />
          </label>
          <label class="form-field">
            <span class="form-label">账号定位</span>
            <select v-model="positioning" class="form-input" :disabled="running">
              <option value="">不指定（由 AI 自定）</option>
              <option v-for="item in positioningOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="form-field">
            <span class="form-label">目标读者</span>
            <select v-model="audience" class="form-input" :disabled="running">
              <option value="">不指定（由 AI 自定）</option>
              <option v-for="item in audienceOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="form-field">
            <span class="form-label">写作目标</span>
            <select v-model="goal" class="form-input" :disabled="running">
              <option v-for="item in WRITING_GOALS" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
          <label class="form-field form-span">
            <span class="form-label">风格与字数</span>
            <select v-model="styleText" class="form-input" :disabled="running">
              <option value="">不指定（由 AI 自定）</option>
              <option v-for="item in styleOptions" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
        </div>
        <footer class="card-actions">
          <button class="primary-button" type="button" :disabled="running" @click="startWriting">
            开始写作
          </button>
          <button class="ghost-button" type="button" :disabled="running" @click="clearAll">
            清空
          </button>
          <button
            v-if="running"
            class="ghost-button"
            type="button"
            @click="store.stop"
          >
            停止
          </button>
        </footer>
      </section>

      <!-- 阶段流水线 -->
      <section class="stage-list">
        <article
          v-for="(stage, index) in WRITING_STAGES"
          :key="stage.id"
          class="stage-card"
          :class="`is-${stages[index].status}`"
        >
          <button
            class="stage-summary"
            type="button"
            :aria-expanded="expanded[index]"
            @click="expanded[index] = !expanded[index]"
          >
            <span class="stage-index" aria-hidden="true">{{ index + 1 }}</span>
            <span class="stage-heading">
              <span class="stage-title">{{ stage.title }}</span>
              <span class="stage-hint">{{ stage.hint }}</span>
            </span>
            <span class="stage-status" :class="`status-${stages[index].status}`">
              {{ STATUS_LABEL[stages[index].status] }}
              <span v-if="stages[index].status === 'running'" class="typing-dots" aria-hidden="true">
                <i></i><i></i><i></i>
              </span>
            </span>
          </button>

          <div v-show="expanded[index]" class="stage-body">
            <!-- 工具调用步骤（热点提取阶段，桌面端） -->
            <div v-if="stages[index].toolSteps.length > 0" class="stage-tools">
              <ToolStepCard
                v-for="(step, stepIndex) in stages[index].toolSteps"
                :key="stepIndex"
                :step="step"
              />
            </div>

            <!-- 配图阶段：只展示最终 prompt 卡片，不渲染规划过程的原始 JSON（content 仍供 parseImagePlan 与持久化） -->
            <template v-if="stage.id === 'images'">
              <p v-if="stages[index].status === 'running' && images.length === 0" class="stage-placeholder">
                正在规划配图 prompt，请稍候…
              </p>
              <div v-if="images.length > 0" class="prompt-list">
                <p class="prompt-list-note">小红书配图为轮播上传：按 图1→图{{ images.length }} 顺序，图1 为首图</p>
                <article
                  v-for="(item, itemIndex) in images"
                  :key="`${item.role}-${itemIndex}`"
                  class="prompt-item"
                >
                  <header class="prompt-item-header">
                    <span class="image-role">图{{ itemIndex + 1 }} · {{ item.role === 'cover' ? '首图' : '内页' }} {{ item.ratio }}</span>
                    <span class="prompt-size">参考尺寸 {{ item.size }}</span>
                  </header>
                  <p class="prompt-text">{{ item.prompt }}</p>
                  <p v-if="item.caption" class="prompt-meta">图注：{{ item.caption }}</p>
                  <p v-if="item.role === 'illustration' && item.anchor" class="prompt-meta">
                    对应正文内容：{{ item.anchor }}
                  </p>
                  <p v-if="item.role === 'cover'" class="prompt-hint">
                    若生图工具不支持中文文字渲染，可生成底图后用醒图/稿定叠加标题
                  </p>
                  <footer class="prompt-actions">
                    <button class="ghost-button" type="button" @click="copyPrompt(item)">
                      复制 prompt
                    </button>
                  </footer>
                </article>
              </div>
            </template>

            <!-- 产出正文（LLM 阶段） -->
            <template v-else>
              <RichText v-if="stages[index].content" :content="stages[index].content" class="stage-output" />
              <p v-else-if="stages[index].status === 'running'" class="stage-placeholder">
                正在生成，请稍候…
              </p>
              <p v-else-if="stages[index].status === 'idle'" class="stage-placeholder">
                尚未运行。完成后此处展示本阶段产出。
              </p>
            </template>

            <!-- 错误信息与重试 -->
            <p v-if="stages[index].errorText" class="stage-error">{{ stages[index].errorText }}</p>
            <footer
              v-if="stages[index].status === 'error' || stages[index].status === 'aborted'"
              class="stage-actions"
            >
              <button
                class="ghost-button"
                type="button"
                :disabled="running || !store.prerequisitesDone(index)"
                @click="retryStage(index)"
              >
                {{ stage.id === 'images' ? '重新规划配图' : '重试本阶段' }}
              </button>
              <span v-if="stages[index].status === 'aborted'" class="stage-note">
                已中止，已生成内容保留。
              </span>
            </footer>
            <footer
              v-if="stage.id === 'images' && stages[index].status === 'done'"
              class="stage-actions"
            >
              <button
                class="ghost-button"
                type="button"
                :disabled="running"
                @click="retryStage(index)"
              >
                重新规划配图
              </button>
            </footer>
          </div>
        </article>

        <!-- Block 6：笔记预览（渲染润色结果与配图，不发起请求） -->
        <article class="preview-card" :class="{ 'is-done': noteReady }">
          <header class="stage-summary preview-summary">
            <span class="stage-index" aria-hidden="true">6</span>
            <span class="stage-heading">
              <span class="stage-title">笔记预览</span>
              <span class="stage-hint">小红书笔记卡片样式预览，可复制或导出</span>
            </span>
          </header>

          <div v-if="noteReady" class="preview-body">
            <div class="xhs-preview">
              <!-- 笔记作者行 -->
              <div class="xhs-author">
                <span class="xhs-avatar" aria-hidden="true">{{ NOTE_AUTHOR.slice(0, 1) }}</span>
                <span class="xhs-author-name">{{ NOTE_AUTHOR }}</span>
              </div>
              <!-- 首图（竖版 3:4）与正文：应用内已不生图，首图位置显示占位框 -->
              <div v-if="coverPrompt" class="xhs-cover-placeholder">
                图{{ coverNumber }} · 首图占位 · {{ coverPrompt.ratio }}<br />
                请用配图 prompt 生成后上传
              </div>
              <h1 class="xhs-title">{{ noteTitle }}</h1>
              <RichText :content="previewBody" class="xhs-content" />
              <!-- 话题标签 -->
              <p class="xhs-tags">
                <span v-for="tag in noteHashtags" :key="tag" class="xhs-tag">{{ tag }}</span>
              </p>
              <!-- 模拟互动区 -->
              <div class="xhs-interactions" aria-label="互动数据（仅预览示意）">
                <span class="xhs-interaction">❤️ 点赞</span>
                <span class="xhs-interaction">⭐ 收藏</span>
                <span class="xhs-interaction">💬 评论</span>
              </div>
            </div>
            <footer class="stage-actions">
              <button class="primary-button" type="button" @click="copyNote">复制笔记</button>
              <button class="ghost-button" type="button" @click="exportNote">导出 .md</button>
              <button class="ghost-button" type="button" @click="openHtmlPreview">在浏览器打开</button>
              <button class="ghost-button" type="button" @click="exportHtml">导出 .html</button>
            </footer>
          </div>
          <p v-else class="stage-placeholder">
            完成前五个阶段后，这里会以小红书笔记卡片样式展示润色后的笔记与配图占位。
          </p>
        </article>
      </section>
    </template>

    <!-- 轻量提示 -->
    <Transition name="notice-fade">
      <div v-if="notice" class="notice-toast" role="status">{{ notice }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.xhs-writing {
  position: relative;
  max-width: 920px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-5) var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* —— 顶部需求卡 —— */
.requirement-card,
.stage-card,
.preview-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
}

.requirement-card {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.card-header {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.card-kicker {
  font-size: var(--font-size-xs);
  color: var(--color-brand);
  font-weight: 600;
  letter-spacing: 0.4px;
}

.card-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

.form-span {
  grid-column: 1 / -1;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.form-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.required {
  color: var(--color-danger);
  font-style: normal;
}

.form-input {
  height: 38px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  color: var(--color-text);
  font-size: var(--font-size-md);
  transition: border-color var(--transition-fast);
}

.form-input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.form-input:disabled {
  opacity: 0.6;
}

select.form-input {
  appearance: none;
}

.card-actions {
  display: flex;
  gap: var(--space-3);
}

.primary-button,
.ghost-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 38px;
  padding: 0 var(--space-5);
  border-radius: var(--radius-md);
  font-size: var(--font-size-md);
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.primary-button {
  border: 1px solid transparent;
  background: var(--color-brand);
  color: var(--color-on-brand);
}

.primary-button:not(:disabled):hover {
  background: var(--color-brand-strong);
}

.primary-button:not(:disabled):active {
  background: var(--color-brand-deep);
}

.primary-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ghost-button {
  border: 1px solid var(--color-border-strong);
  background: transparent;
  color: var(--color-text);
}

.ghost-button:not(:disabled):hover {
  background: var(--color-surface-muted);
}

.ghost-button:not(:disabled):active {
  background: var(--color-border);
}

.ghost-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* —— 阶段卡片 —— */
.stage-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.stage-card,
.preview-card {
  overflow: hidden;
  transition: border-color var(--transition-fast);
}

.stage-card.is-running {
  border-color: var(--color-brand);
}

.stage-card.is-error {
  border-color: var(--color-danger);
}

.stage-summary {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  width: 100%;
  padding: var(--space-4) var(--space-5);
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.preview-summary {
  cursor: default;
}

.stage-index {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

/* 序号圆标：运行中橙 soft，已完成品牌橙实底 */
.stage-card.is-running .stage-index {
  background: var(--color-brand-soft);
  color: var(--color-brand);
}

.stage-card.is-done .stage-index {
  background: var(--color-brand);
  color: var(--color-on-brand);
}

.stage-heading {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.stage-title {
  font-size: var(--font-size-md);
  font-weight: 600;
  color: var(--color-text);
}

.stage-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* 状态徽标：贴纸语言（radius-full + 字重 600），中性底为默认（待运行/已中止） */
.stage-status {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: 2px var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600;
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
}

/* 运行中：info 蓝（信息语义，不占用品牌橙行动色） */
.status-running {
  background: var(--color-info-soft);
  color: var(--color-info-500);
}

.status-done {
  background: var(--color-success-soft);
  color: var(--color-success);
}

.status-error {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* 运行中打字指示点 */
.typing-dots {
  display: inline-flex;
  gap: 3px;
}

.typing-dots i {
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: currentColor;
  animation: typing-bounce 1.2s infinite ease-in-out;
}

.typing-dots i:nth-child(2) {
  animation-delay: 0.15s;
}

.typing-dots i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes typing-bounce {
  0%,
  100% {
    opacity: 0.3;
    transform: translateY(0);
  }
  50% {
    opacity: 1;
    transform: translateY(-2px);
  }
}

.stage-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0 var(--space-5) var(--space-4);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.stage-tools {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.stage-output {
  font-size: var(--font-size-md);
  line-height: 1.7;
  color: var(--color-text);
  overflow-wrap: anywhere;
}

.stage-placeholder {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.stage-error {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--font-size-sm);
}

.stage-actions {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.stage-actions .ghost-button,
.stage-actions .primary-button {
  height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-sm);
}

.stage-note {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* —— 配图阶段（首图与内页图 prompt 卡片，竖版 3:4） —— */
.prompt-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

/* 卡片列表顶部说明：小红书轮播上传顺序 */
.prompt-list-note {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.prompt-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.prompt-item-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.image-role {
  flex-shrink: 0;
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.prompt-size {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* prompt 全文：引用块样式，完整可读、便于逐字复制核对 */
.prompt-text {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-left: 3px solid var(--color-brand-soft);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
  font-size: var(--font-size-sm);
  line-height: 1.7;
  color: var(--color-text);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.prompt-meta {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

/* 首图卡片专属提示：外部工具不支持中文文字渲染时的替代方案 */
.prompt-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.prompt-actions {
  display: flex;
  justify-content: flex-end;
}

.prompt-actions .ghost-button {
  height: 28px;
  padding: 0 var(--space-3);
  font-size: var(--font-size-xs);
}

/* —— 笔记预览（小红书卡片样式） —— */
.preview-body {
  padding: 0 var(--space-5) var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  align-items: center;
}

/* 移动端宽度的居中预览卡片（模拟小红书笔记详情页） */
.xhs-preview {
  width: 100%;
  max-width: 414px;
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  /* 外部媒体仿真区：模拟真实小红书白底，保留纯白，不随 --color-surface 暖化 */
  background: #ffffff;
  box-shadow: var(--shadow-md);
}

.xhs-author {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-3);
}

.xhs-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.xhs-author-name {
  font-size: var(--font-size-sm);
  color: #1c1917;
  font-weight: 600;
}

/* 首图占位框：应用内已不生图，图片由用户拿 prompt 去外部工具生成后上传 */
.xhs-cover-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 3 / 4;
  margin: 0 0 var(--space-3);
  border: 1px dashed #d2cec7;
  border-radius: var(--radius-md);
  text-align: center;
  font-size: var(--font-size-sm);
  line-height: 1.8;
  color: #78716c;
}

/* 预览内部文字写死深色：白底仿真区不随暗色令牌翻转 */
.xhs-title {
  margin: 0 0 var(--space-2);
  font-size: 18px;
  line-height: 1.5;
  font-weight: 700;
  color: #1c1917;
}

.xhs-content {
  font-size: 15px;
  line-height: 1.8;
  color: #3f3a36;
  overflow-wrap: anywhere;
}

/* 白底仿真区内的富文本元素同样写死浅色表现（优先级高于 RichText 的令牌样式），
   避免深色主题下暗底暗字被带进白底预览 */
.xhs-preview .xhs-content :deep(code) {
  background: #f5f3f0;
  color: #c95400;
}

.xhs-preview .xhs-content :deep(pre) {
  background: #f5f3f0;
  border-color: #e4e1dc;
}

.xhs-preview .xhs-content :deep(pre code) {
  background: transparent;
  color: #3f3a36;
}

.xhs-preview .xhs-content :deep(blockquote) {
  background: transparent;
  border-left-color: #d2cec7;
  color: #57534e;
}

.xhs-preview .xhs-content :deep(a) {
  color: #e85f00;
}

/* 话题标签行：蓝色话题色 */
.xhs-tags {
  margin: var(--space-3) 0 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.xhs-tag {
  font-size: var(--font-size-sm);
  color: #13386c;
  font-weight: 600;
}

/* 模拟互动区 */
.xhs-interactions {
  display: flex;
  gap: var(--space-4);
  margin-top: var(--space-3);
  padding-top: var(--space-3);
  border-top: 1px solid #f0eee9;
  font-size: var(--font-size-sm);
  color: #78716c;
}

/* —— 轻量提示 —— */
.notice-toast {
  position: fixed;
  left: 50%;
  bottom: 40px;
  transform: translateX(-50%);
  padding: var(--space-2) var(--space-4);
  border-radius: var(--radius-full);
  background: var(--color-text);
  color: var(--color-surface);
  font-size: var(--font-size-sm);
  box-shadow: var(--shadow-lg);
  z-index: 60;
}

.notice-fade-enter-active,
.notice-fade-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.notice-fade-enter-from,
.notice-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}

@media (max-width: 640px) {
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>
