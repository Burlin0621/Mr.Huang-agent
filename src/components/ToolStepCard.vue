<script setup lang="ts">
import { computed } from 'vue'
import type { ToolStepRecord } from '@/lib/group-chat'

/**
 * 工具调用卡片（function calling，Chat 与群聊共用）：
 * 🔧 工具名 + 耗时 + 完成/失败徽标；折叠区展示参数与结果原文，失败附错误说明。
 * fs_write / fs_edit 的参数区展示人类可读摘要（目标路径 / 新建或覆盖 / 替换片段长度），
 * 其余工具仍展示参数 JSON 原文。颜色/圆角/字号全部引用 tokens 变量，深浅色随主题联动。
 */
const props = defineProps<{ step: ToolStepRecord }>()

/** 解析参数 JSON；失败返回 null */
const parsedArgs = computed<Record<string, unknown> | null>(() => {
  try {
    const value: unknown = JSON.parse(props.step.argsText || '{}')
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
})

/** 写类文件工具的参数摘要（非此类工具返回空，回落到 JSON 原文） */
const writeArgSummary = computed<string>(() => {
  const args = parsedArgs.value
  if (!args) return ''
  const path = typeof args.path === 'string' ? args.path : ''
  if (!path) return ''
  if (props.step.toolName === 'fs_write') {
    const bytes = typeof args.content === 'string' ? args.content.length : 0
    return `目标：${path}${args.overwrite === true ? '（覆盖已有文件）' : '（新建，已存在则拒绝）'} · ${bytes} 字符`
  }
  if (props.step.toolName === 'fs_edit') {
    const oldLen = typeof args.old_string === 'string' ? args.old_string.length : 0
    const newLen = typeof args.new_string === 'string' ? args.new_string.length : 0
    return `目标：${path} · ${oldLen} 字符 → ${newLen} 字符${args.replace_all === true ? '（replace_all）' : ''}`
  }
  if (props.step.toolName === 'shell_exec') {
    const command = typeof args.command === 'string' ? args.command : ''
    if (!command) return ''
    const cwd =
      typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : '工作区根目录'
    const shown = command.length > 200 ? `${command.slice(0, 200)}…` : command
    return `命令：${shown}\n工作目录：${cwd}`
  }
  return ''
})

/** 参数区展示文本：写类文件工具用摘要，其余用 JSON 原文 */
const argsDisplay = computed(() => writeArgSummary.value || props.step.argsText || '（无参数）')

/**
 * 结果区展示文本：工具结果中嵌入的 [IMAGE:dataURL] 截图标记（如 browser_screenshot）
 * 不渲染 data URL 原文（体积可达数 MB），替换为省略提示
 */
const resultDisplay = computed(() => {
  const raw = props.step.resultText || '（无输出）'
  return raw.replace(/\[IMAGE:data:image\/[a-z+.+-]+;base64,[A-Za-z0-9+/=]*\]/g, '（截图数据已随附图传给模型，此处省略）')
})

/* —— git 工具结果的结构化渲染（解析主进程 git-tools.cjs 的固定文本格式；解析失败回落原文） —— */

/** git_status 解析结果：分支行 + 分组文件清单 */
interface GitStatusView {
  branch: string
  sections: Array<{ title: string; items: string[] }>
}

/** git_diff 解析结果：逐文件 diff 行（+ 增 / - 删 / @@ hunk / 其余上下文） */
interface GitDiffFileView {
  path: string
  lines: string[]
}

/** git_commit 解析结果：hash + 说明 + 变更文件清单 */
interface GitCommitView {
  hash: string
  subject: string
  files: string[]
  note: string
}

/** 解析 git_status 文本输出；格式不符返回 null（回落原文展示） */
const gitStatusView = computed<GitStatusView | null>(() => {
  if (props.step.toolName !== 'git_status' || props.step.error) return null
  const lines = (props.step.resultText || '').split('\n')
  const branchLine = lines.find((line) => line.startsWith('分支：'))
  if (!branchLine) return null
  const sections: GitStatusView['sections'] = []
  let current: GitStatusView['sections'][number] | null = null
  for (const line of lines) {
    const heading = line.match(/^(已暂存|未暂存|未跟踪)（\d+）：(.*)$/)
    if (heading) {
      current = { title: heading[1], items: [] }
      sections.push(current)
      continue
    }
    const item = line.match(/^  (.+)$/)
    if (item && current) current.items.push(item[1])
  }
  return { branch: branchLine.slice(3), sections }
})

/** 解析 git_diff 文本输出为逐文件块；无 diff --git 行时返回 null（回落原文展示） */
const gitDiffFiles = computed<GitDiffFileView[] | null>(() => {
  if (props.step.toolName !== 'git_diff' || props.step.error) return null
  const raw = props.step.resultText || ''
  if (!raw.includes('diff --git ')) return null
  const files: GitDiffFileView[] = []
  let current: GitDiffFileView | null = null
  for (const line of raw.split('\n')) {
    const header = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
    if (header) {
      current = { path: header[2], lines: [] }
      files.push(current)
      continue
    }
    if (!current) continue
    // 跳过 diff --git 之后的元信息行（index / --- / +++ / mode），从 @@ 行开始展示
    if (/^(index |--- |\+\+\+ |old mode|new mode|deleted file mode|new file mode|similarity index|rename (from|to) )/.test(line)) {
      continue
    }
    current.lines.push(line)
  }
  return files.length > 0 ? files : null
})

/** 解析 git_commit 文本输出；格式不符返回 null（回落原文展示） */
const gitCommitView = computed<GitCommitView | null>(() => {
  if (props.step.toolName !== 'git_commit' || props.step.error) return null
  const lines = (props.step.resultText || '').split('\n')
  const hash = lines.find((line) => line.startsWith('提交：'))?.slice(3) ?? ''
  if (!hash) return null
  const subject = lines.find((line) => line.startsWith('说明：'))?.slice(3) ?? ''
  const countIndex = lines.findIndex((line) => line.startsWith('变更文件：'))
  const note = lines.find((line) => line.startsWith('注意：')) ?? ''
  const files = countIndex >= 0
    ? lines.slice(countIndex + 1).filter((line) => line.startsWith('  ')).map((line) => line.trim())
    : []
  return { hash, subject, files, note }
})

/** diff 行的样式类：+ 增行 / - 删行 / @@ hunk 头，其余为上下文 */
function diffLineClass(line: string): string {
  if (line.startsWith('+')) return 'is-add'
  if (line.startsWith('-')) return 'is-del'
  if (line.startsWith('@@')) return 'is-hunk'
  return ''
}
</script>

<template>
  <details class="tool-step">
    <summary>
      <span aria-hidden="true">🔧</span>
      <span class="tool-name">{{ step.toolName }}</span>
      <span class="tool-meta">{{ step.durationMs }}ms</span>
      <span class="tool-badge" :class="step.error ? 'is-failed' : 'is-ok'">
        {{ step.error ? '失败' : '完成' }}
      </span>
    </summary>
    <div class="tool-body">
      <p class="tool-label">参数</p>
      <pre class="tool-pre">{{ argsDisplay }}</pre>
      <p class="tool-label">结果</p>
      <!-- git_status：分支 + 分组文件清单 -->
      <div v-if="gitStatusView" class="git-status">
        <p class="git-branch">🌿 {{ gitStatusView.branch }}</p>
        <div v-for="section in gitStatusView.sections" :key="section.title" class="git-section">
          <p class="git-section-title">{{ section.title }}（{{ section.items.length }}）</p>
          <p v-if="section.items.length === 0" class="git-empty">无</p>
          <p v-for="item in section.items" :key="item" class="git-file">{{ item }}</p>
        </div>
      </div>
      <!-- git_diff：逐文件 diff（增删行着色） -->
      <div v-else-if="gitDiffFiles" class="git-diff">
        <p v-if="gitDiffFiles.length === 0" class="git-empty">（无差异）</p>
        <div v-for="file in gitDiffFiles" :key="file.path" class="git-file-block">
          <p class="git-file-head">📄 {{ file.path }}</p>
          <pre class="git-diff-pre"><span
            v-for="(line, index) in file.lines"
            :key="index"
            class="git-diff-line"
            :class="diffLineClass(line)"
          >{{ line || ' ' }}</span></pre>
        </div>
      </div>
      <!-- git_commit：提交摘要 -->
      <div v-else-if="gitCommitView" class="git-commit">
        <p class="git-commit-head">✅ 提交成功 <code class="git-hash">{{ gitCommitView.hash }}</code></p>
        <p class="git-subject">{{ gitCommitView.subject }}</p>
        <p class="git-section-title">变更文件（{{ gitCommitView.files.length }}）</p>
        <p v-for="file in gitCommitView.files" :key="file" class="git-file">{{ file }}</p>
        <p v-if="gitCommitView.note" class="git-note">{{ gitCommitView.note }}</p>
      </div>
      <pre v-else class="tool-pre">{{ resultDisplay }}</pre>
      <p v-if="step.error" class="tool-error">{{ step.error }}</p>
    </div>
  </details>
</template>

<style scoped>
.tool-step {
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  overflow: hidden;
}

.tool-step summary {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
  list-style: none;
}

.tool-step summary::-webkit-details-marker {
  display: none;
}

.tool-name {
  font-weight: 600;
  color: var(--color-text);
}

.tool-meta {
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.tool-badge {
  margin-left: auto;
  padding: 0 var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 600; /* 贴纸感：状态胶囊统一加重字重 */
}

.tool-badge.is-ok {
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
}

.tool-badge.is-failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.tool-body {
  padding: 0 var(--space-3) var(--space-2);
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tool-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  margin-top: var(--space-1);
}

.tool-pre {
  margin: 0;
  padding: var(--space-2);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow-y: auto;
}

.tool-error {
  font-size: var(--font-size-xs);
  color: var(--color-danger);
}

/* —— git 工具结果结构化渲染 —— */
.git-status,
.git-diff,
.git-commit {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2);
  border-radius: var(--radius-sm, 6px);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
}

.git-branch,
.git-commit-head {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text);
}

.git-hash {
  font-family: var(--font-mono);
  font-weight: 400;
  color: var(--color-text-secondary);
}

.git-section-title {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.git-empty {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.git-file {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  word-break: break-all;
}

.git-file-block {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.git-file-head {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text);
  word-break: break-all;
}

.git-diff-pre {
  margin: 0;
  display: flex;
  flex-direction: column;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  max-height: 240px;
  overflow-y: auto;
}

.git-diff-line {
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--color-text-secondary);
}

.git-diff-line.is-add {
  color: var(--color-success, #2e7d32);
  background: color-mix(in srgb, var(--color-success, #2e7d32) 10%, transparent);
}

.git-diff-line.is-del {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.git-diff-line.is-hunk {
  color: var(--color-text-muted);
}

.git-subject {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.git-note {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}
</style>
