<script setup lang="ts">
/**
 * MCP 服务器设置面板（设置页「MCP 服务器」分组）：
 * - 卡片式管理 stdio MCP 服务器（名称/命令/参数/环境变量/启用开关），风格与模型接入一致；
 * - 保存即写主进程配置（userData/mcp-servers.json）并触发重连，连接状态随之刷新；
 * - 纯浏览器模式（无桥接）显示「MCP 需要桌面端应用」的空状态；
 * - 各服务器已注册的工具清单只读展示（来自 mcp:list-tools）。
 */
import { computed, onMounted, ref } from 'vue'

import { hasMcpBridge, type McpServerConfig, type McpServerStatus, type McpToolsResult } from '@/lib/desktop-bridge'

/** 表单草稿（args/env 用多行文本编辑，保存时解析） */
interface McpServerDraft {
  name: string
  command: string
  argsText: string
  envText: string
  enabled: boolean
}

/** 已配置服务器列表（来自主进程） */
const configs = ref<McpServerConfig[]>([])
/** 各服务器连接状态快照 */
const statuses = ref<Record<string, McpServerStatus>>({})
/** 按服务器分组的工具清单 */
const toolsResult = ref<McpToolsResult | null>(null)

const loading = ref(false)
const saving = ref(false)
const statusMessage = ref('')

/** 是否纯浏览器模式（无桌面桥接） */
const browserOnly = computed(() => !hasMcpBridge())

/** 表单可见性：null 表示收起，'new' 表示新增，否则为被编辑服务器的原始名称 */
const editingKey = ref<string | null>(null)
/** 表单草稿（编辑原名为 null 时表示新增） */
const draft = ref<McpServerDraft>({ name: '', command: '', argsText: '', envText: '', enabled: true })
/** 表单校验错误 */
const draftError = ref('')

/** 把配置转为可编辑草稿 */
function toDraft(config: McpServerConfig): McpServerDraft {
  return {
    name: config.name,
    command: config.command,
    argsText: config.args.join('\n'),
    envText: Object.entries(config.env)
      .map(([key, value]) => `${key}=${value}`)
      .join('\n'),
    enabled: config.enabled,
  }
}

/** 解析多行 args 文本：每行一个参数（去空行与首尾空白） */
function parseArgsText(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

/** 解析多行 env 文本：每行一条 KEY=VALUE（非法行忽略） */
function parseEnvText(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key) env[key] = value
  }
  return env
}

/** 从主进程加载配置与状态 */
async function loadAll(): Promise<void> {
  if (!hasMcpBridge()) return
  loading.value = true
  try {
    const result = await window.mrHuangDesktop!.getMcpConfigs!()
    configs.value = result.configs ?? []
    statuses.value = result.statuses ?? {}
    toolsResult.value = await window.mrHuangDesktop!.listMcpTools!()
  } catch (err) {
    statusMessage.value = `加载 MCP 配置失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadAll()
})

/** 打开新增表单 */
function startCreate(): void {
  editingKey.value = 'new'
  draftError.value = ''
  draft.value = { name: '', command: '', argsText: '', envText: '', enabled: true }
}

/** 打开编辑表单（按名称定位） */
function startEdit(name: string): void {
  const config = configs.value.find((item) => item.name === name)
  if (!config) return
  editingKey.value = name
  draftError.value = ''
  draft.value = toDraft(config)
}

function cancelEdit(): void {
  editingKey.value = null
  draftError.value = ''
}

/** 保存草稿：写主进程配置并触发重连（全量替换，编辑沿用原 key 时按新名替换） */
async function saveDraft(): Promise<void> {
  const name = draft.value.name.trim()
  const command = draft.value.command.trim()
  if (!name) {
    draftError.value = '请填写服务器名称。'
    return
  }
  if (!command) {
    draftError.value = '请填写启动命令（command）。'
    return
  }
  if (editingKey.value === 'new' && configs.value.some((item) => item.name === name)) {
    draftError.value = `已存在同名服务器「${name}」，请换一个名称。`
    return
  }
  const next: McpServerConfig[] =
    editingKey.value === 'new'
      ? [
          ...configs.value,
          { name, command, args: parseArgsText(draft.value.argsText), env: parseEnvText(draft.value.envText), enabled: draft.value.enabled, confirmTools: [] },
        ]
      : configs.value.map((item) =>
          item.name === editingKey.value
            ? {
                name,
                command,
                args: parseArgsText(draft.value.argsText),
                env: parseEnvText(draft.value.envText),
                enabled: draft.value.enabled,
                confirmTools: item.confirmTools ?? [],
              }
            : item,
        )
  saving.value = true
  try {
    const result = await window.mrHuangDesktop!.saveMcpConfigs!(next)
    configs.value = result.configs ?? next
    statuses.value = result.statuses ?? {}
    statusMessage.value = `已保存并重连「${name}」。`
    editingKey.value = null
    toolsResult.value = await window.mrHuangDesktop!.listMcpTools!()
  } catch (err) {
    statusMessage.value = `保存失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

/** 删除服务器（带确认）：写主进程配置，主进程会断开对应连接 */
async function removeServer(name: string): Promise<void> {
  if (!window.confirm(`确定删除 MCP 服务器「${name}」吗？删除后会断开其连接。`)) return
  saving.value = true
  try {
    const next = configs.value.filter((item) => item.name !== name)
    const result = await window.mrHuangDesktop!.saveMcpConfigs!(next)
    configs.value = result.configs ?? next
    statuses.value = result.statuses ?? {}
    statusMessage.value = `已删除「${name}」。`
    toolsResult.value = await window.mrHuangDesktop!.listMcpTools!()
  } catch (err) {
    statusMessage.value = `删除失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    saving.value = false
  }
}

/** 工具合格名（mcp__<server>__<tool>）中的裸工具名（最后一个 __ 之后的片段） */
function bareToolName(qualifiedName: string): string {
  const index = qualifiedName.lastIndexOf('__')
  return index >= 0 ? qualifiedName.slice(index + 2) : qualifiedName
}

/** 某工具是否被配置为「执行前确认」（读所属服务器配置的 confirmTools） */
function isConfirmTool(serverName: string, qualifiedName: string): boolean {
  const config = configs.value.find((item) => item.name === serverName)
  return config?.confirmTools?.includes(bareToolName(qualifiedName)) ?? false
}

/** 切换某工具的「执行前确认」：即时保存全量配置（主进程保存后自动重连生效） */
async function toggleConfirmTool(serverName: string, qualifiedName: string, checked: boolean): Promise<void> {
  const bare = bareToolName(qualifiedName)
  const next = configs.value.map((item) => {
    if (item.name !== serverName) return item
    const current = item.confirmTools ?? []
    const updated = checked ? [...new Set([...current, bare])] : current.filter((name) => name !== bare)
    return { ...item, confirmTools: updated }
  })
  saving.value = true
  try {
    const result = await window.mrHuangDesktop!.saveMcpConfigs!(next)
    configs.value = result.configs ?? next
    statuses.value = result.statuses ?? {}
    statusMessage.value = `已${checked ? '开启' : '关闭'}「${serverName} / ${bare}」的执行前确认。`
  } catch (err) {
    statusMessage.value = `保存确认设置失败：${err instanceof Error ? err.message : String(err)}`
    // 保存失败时回读主进程配置，避免 UI 与实际状态漂移
    try {
      const fresh = await window.mrHuangDesktop!.getMcpConfigs!()
      configs.value = fresh.configs ?? []
      statuses.value = fresh.statuses ?? {}
    } catch {
      // 回读失败则保持现状，仅提示错误
    }
  } finally {
    saving.value = false
  }
}

/** 状态徽标文案 */
function statusLabel(name: string): string {
  const status = statuses.value[name]
  if (!status) return '未连接'
  switch (status.status) {
    case 'connected':
      return `已连接 · ${status.toolCount} 个工具`
    case 'failed':
      return status.errorKind === 'bad-config'
        ? `失败（配置错误，请检查命令与参数）：${status.error || '未知错误'}`
        : `失败：${status.error || '未知错误'}`
    case 'connecting':
      return '连接中…'
    case 'reconnecting': {
      const attempt = status.reconnectAttempt ?? 0
      const delaySeconds = Math.round((status.reconnectDelayMs ?? 0) / 1000)
      const suffix = attempt > 0 ? `第 ${attempt} 次重连` : '自动重连'
      return delaySeconds > 0 ? `${suffix} · 约 ${delaySeconds} 秒后重试` : `${suffix}…`
    }
    default:
      return '未连接（已停用）'
  }
}

/** 状态徽标样式类：失败=红、重连中=黄、正常=品牌色、其余灰 */
function statusClass(name: string): string {
  const status = statuses.value[name]
  if (!status) return 'badge-muted'
  if (status.status === 'connected') return 'badge-ok'
  if (status.status === 'failed') return 'badge-failed'
  if (status.status === 'reconnecting') return 'badge-reconnecting'
  return 'badge-muted'
}
</script>

<template>
  <section class="card" aria-labelledby="mcp-title">
    <header class="section-head">
      <h2 id="mcp-title">MCP 服务器</h2>
      <p>
        通过 MCP（Model Context Protocol）接入本地 stdio 服务器，其工具会以
        <code>mcp__服务器名__工具名</code> 动态注册进对话工具体系，所有智能体均可调用（无需逐个绑定）。
        保存后自动重连。
      </p>
    </header>

    <!-- 纯浏览器模式：无桥接 -->
    <p v-if="browserOnly" class="mcp-empty">
      MCP 需要桌面端应用：请在 Electron 桌面版中打开设置页进行配置（浏览器模式下无法连接本地 MCP 服务器）。
    </p>

    <template v-else>
      <!-- 服务器列表 -->
      <ul class="mcp-list">
        <li v-for="config in configs" :key="config.name" class="mcp-item">
          <div class="mcp-item-body">
            <p class="mcp-item-name">
              🔌 <strong>{{ config.name }}</strong>
              <span class="badge" :class="statusClass(config.name)">{{ statusLabel(config.name) }}</span>
              <span v-if="!config.enabled" class="badge badge-muted">已停用</span>
            </p>
            <p class="mcp-item-desc">
              <code>{{ config.command }}</code>
              <template v-if="config.args.length > 0"> {{ config.args.join(' ') }}</template>
            </p>
            <p v-if="Object.keys(config.env).length > 0" class="mcp-item-params">
              环境变量：{{ Object.keys(config.env).join('、') }}
            </p>
            <ul v-if="toolsResult?.servers.find((s) => s.name === config.name)?.tools.length" class="mcp-tool-list">
              <li v-for="tool in toolsResult.servers.find((s) => s.name === config.name)!.tools" :key="tool.name">
                <code>{{ tool.name }}</code>
                <span v-if="tool.description">：{{ tool.description }}</span>
                <label class="mcp-tool-confirm">
                  <input
                    type="checkbox"
                    :disabled="saving"
                    :checked="isConfirmTool(config.name, tool.name)"
                    @change="toggleConfirmTool(config.name, tool.name, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>执行前确认</span>
                </label>
              </li>
            </ul>
          </div>
          <div class="mcp-item-actions">
            <button class="mcp-btn" type="button" :disabled="saving" @click="startEdit(config.name)">编辑</button>
            <button class="mcp-btn mcp-btn-danger" type="button" :disabled="saving" @click="removeServer(config.name)">
              删除
            </button>
          </div>
        </li>
        <li v-if="configs.length === 0 && !loading" class="mcp-item">
          <p class="mcp-item-desc">尚未配置任何 MCP 服务器。点击「新增服务器」开始。</p>
        </li>
      </ul>

      <div class="mcp-toolbar">
        <button class="mcp-btn" type="button" :disabled="saving" @click="startCreate">新增服务器</button>
        <button class="mcp-btn" type="button" :disabled="loading || saving" @click="loadAll">刷新状态</button>
        <span v-if="statusMessage" class="mcp-status">{{ statusMessage }}</span>
      </div>

      <!-- 新增/编辑表单 -->
      <form v-if="editingKey" class="mcp-form" @submit.prevent="saveDraft">
        <h3>{{ editingKey === 'new' ? '新增 MCP 服务器' : `编辑「${editingKey}」` }}</h3>
        <label class="mcp-field">
          <span>名称（唯一标识，用于生成工具名前缀）</span>
          <input v-model="draft.name" type="text" placeholder="如 filesystem" />
        </label>
        <label class="mcp-field">
          <span>启动命令（command）</span>
          <input v-model="draft.command" type="text" placeholder="如 npx 或 node" />
        </label>
        <label class="mcp-field">
          <span>启动参数（每行一个参数）</span>
          <textarea
            v-model="draft.argsText"
            rows="3"
            placeholder="-y&#10;@modelcontextprotocol/server-filesystem&#10;D:\notes"
          ></textarea>
        </label>
        <label class="mcp-field">
          <span>环境变量（每行一条 KEY=VALUE，可留空）</span>
          <textarea v-model="draft.envText" rows="2" placeholder="API_KEY=xxx"></textarea>
        </label>
        <label class="mcp-check">
          <input v-model="draft.enabled" type="checkbox" />
          <span>启用（保存后自动连接；停用的服务器不会连接，其工具也不可用）</span>
        </label>
        <p v-if="draftError" class="mcp-form-error">{{ draftError }}</p>
        <div class="mcp-form-actions">
          <button class="mcp-btn mcp-btn-primary" type="submit" :disabled="saving">
            {{ saving ? '保存中…' : '保存并重连' }}
          </button>
          <button class="mcp-btn" type="button" :disabled="saving" @click="cancelEdit">取消</button>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
.section-head h2 {
  font-size: var(--font-size-xl);
}

.section-head p {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
}

.mcp-empty {
  margin-top: var(--space-4);
  padding: var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
}

.mcp-list {
  margin-top: var(--space-4);
}

.mcp-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  border-top: 1px dashed var(--color-border);
}

.mcp-item:first-child {
  border-top: 0;
}

.mcp-item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.mcp-item-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-md);
}

.mcp-item-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.mcp-item-desc code {
  font-family: var(--font-mono);
}

.mcp-item-params {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.mcp-tool-list {
  margin-top: var(--space-1);
  padding-left: var(--space-4);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.7;
}

.mcp-tool-list code {
  font-family: var(--font-mono);
}

.mcp-item-actions {
  display: flex;
  gap: var(--space-2);
  flex-shrink: 0;
}

.badge {
  display: inline-flex;
  align-items: center;
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 400;
}

.badge-ok {
  background: var(--color-brand-soft);
  color: var(--color-brand);
}

.badge-warn {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

/* 失败（坏配置）：红色徽标，与重连中的黄色区分 */
.badge-failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-weight: 600;
}

.badge-muted {
  background: var(--color-surface-muted);
  color: var(--color-text-secondary);
}

.badge-reconnecting {
  background: var(--color-warning-soft);
  color: var(--color-warning);
}

.mcp-tool-confirm {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-left: var(--space-2);
  cursor: pointer;
  white-space: nowrap;
}

.mcp-tool-confirm input {
  accent-color: var(--color-brand);
}

.mcp-toolbar {
  margin-top: var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.mcp-status {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.mcp-btn {
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-size: var(--font-size-sm);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.mcp-btn:hover {
  border-color: var(--color-border-strong);
}

.mcp-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.mcp-btn-primary {
  background: var(--color-brand);
  border-color: var(--color-brand);
  color: var(--color-on-brand);
}

.mcp-btn-danger {
  color: var(--color-danger);
}

.mcp-form {
  margin-top: var(--space-5);
  padding: var(--space-5);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface-muted);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.mcp-form h3 {
  font-size: var(--font-size-lg);
}

.mcp-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
}

.mcp-field input,
.mcp-field textarea {
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-size: var(--font-size-sm);
  font-family: var(--font-mono);
}

.mcp-field textarea {
  resize: vertical;
}

.mcp-check {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.mcp-form-error {
  font-size: var(--font-size-sm);
  color: var(--color-danger);
}

.mcp-form-actions {
  display: flex;
  gap: var(--space-3);
}
</style>
