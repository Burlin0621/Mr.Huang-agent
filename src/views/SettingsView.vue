<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import AppIcon from '@/components/AppIcon.vue'
import ModelSettingsPanel from '@/components/ModelSettingsPanel.vue'
import McpSettingsPanel from '@/components/McpSettingsPanel.vue'
import AccountPanel from '@/components/AccountPanel.vue'
import NotificationPanel from '@/components/NotificationPanel.vue'
import AboutPanel from '@/components/AboutPanel.vue'
import { useThemeStore } from '@/stores/theme'
import type { ThemePreference } from '@/stores/theme'
import { AGENT_TOOLS } from '@/lib/agent-tools'
import {
  loadDisabledTools,
  loadShellQuickApprove,
  saveDisabledTools,
  saveShellQuickApprove,
} from '@/lib/tool-executor'
import {
  clampStepResultChars,
  clampTaskMaxRounds,
  loadTaskDefaults,
  persistTaskDefaults,
} from '@/lib/task-runner'
import { usePermissionStore, PERMISSION_MODES, type PermissionMode } from '@/stores/permission'
import { useWorkspacesStore } from '@/stores/workspaces'
import { storeToRefs } from 'pinia'
import { useWechatWritingStore } from '@/stores/wechat-writing'
import {
  clearShellApprovals,
  hasMemoryBridge,
  hasShellApproveBridge,
  listShellApprovals,
  readWorkspaceMemory,
  removeShellApproval,
  writeWorkspaceMemory,
  type ShellApproval,
} from '@/lib/desktop-bridge'

const themeStore = useThemeStore()
const permissionStore = usePermissionStore()
const route = useRoute()

type SettingsTab = 'appearance' | 'models' | 'mcp' | 'tools' | 'memory' | 'writing'

const SETTING_TABS: readonly SettingsTab[] = ['appearance', 'models', 'mcp', 'tools', 'memory', 'writing']

/** 当前设置分区（支持通过 /settings?tab=models 直达） */
const activeTab = ref<SettingsTab>(
  SETTING_TABS.includes(route.query.tab as SettingsTab)
    ? (route.query.tab as SettingsTab)
    : 'appearance',
)

watch(
  () => route.query.tab,
  (tab) => {
    if (typeof tab === 'string' && SETTING_TABS.includes(tab as SettingsTab)) {
      activeTab.value = tab as SettingsTab
    }
  },
)

const tabs: Array<{ value: SettingsTab; label: string }> = [
  { value: 'appearance', label: '外观' },
  { value: 'models', label: '模型接入' },
  { value: 'mcp', label: 'MCP 服务器' },
  { value: 'tools', label: '工具中心' },
  { value: 'memory', label: '工作区记忆' },
  { value: 'writing', label: '公众号写作' },
]

/* —— 公众号写作：账号资料（公众号名称/简介/作者职业，写作页只读，仅在此处修改） —— */

const wechatWritingStore = useWechatWritingStore()
const { mpName, mpBio, authorRole } = storeToRefs(wechatWritingStore)

/* —— 工具中心：启停偏好（渲染层拦截，主进程注册表不感知） —— */

/** 被禁用的工具名列表（localStorage 持久化；编辑本地副本，变更时写回） */
const disabledTools = ref<string[]>(loadDisabledTools())

/** 工具参数概要：必填参数名列表（无参工具显示"无参数"） */
function toolParamsSummary(name: string): string {
  const tool = AGENT_TOOLS.find((item) => item.name === name)
  if (!tool) return ''
  const required = tool.parameters.required
  return required.length > 0 ? required.join('、') : '无参数'
}

function isToolDisabled(name: string): boolean {
  return disabledTools.value.includes(name)
}

function toggleTool(name: string): void {
  const next = isToolDisabled(name)
    ? disabledTools.value.filter((item) => item !== name)
    : [...disabledTools.value, name]
  disabledTools.value = next
  saveDisabledTools(next)
}

const disabledCount = computed(() => disabledTools.value.length)

/* —— 任务执行（子智能体）全局默认参数（localStorage 持久化） —— */

const taskDefaults = loadTaskDefaults()

/** 每步 agent loop 最大回合数（全局默认值） */
const taskMaxRounds = ref(taskDefaults.maxRounds)

/** 单步结果摘要字符数上限（全局默认值） */
const taskResultMaxChars = ref(taskDefaults.resultMaxChars)

/** 保存任务执行参数：夹取到合法范围后持久化（失败时仅当前会话生效） */
function saveTaskParams(): void {
  taskMaxRounds.value = clampTaskMaxRounds(taskMaxRounds.value)
  taskResultMaxChars.value = clampStepResultChars(taskResultMaxChars.value)
  persistTaskDefaults({ maxRounds: taskMaxRounds.value, resultMaxChars: taskResultMaxChars.value })
}

/* —— 终端命令快捷确认（shell_exec 同命令同目录第二次起免确认） —— */

/** 快捷确认开关（默认开；持久化在统一存储层，工具调用时随 context 透传主进程） */
const shellQuickApprove = ref(loadShellQuickApprove())

/** 已记忆的免确认命令列表（桌面端主进程 userData/shell-approved.json） */
const shellApprovals = ref<ShellApproval[]>([])

/** 是否可管理记忆列表（纯浏览器模式无主进程） */
const shellApproveAvailable = hasShellApproveBridge()

/** 操作提示（空串表示无） */
const shellApproveStatus = ref('')

/** 切换开关：持久化并即时生效（下一次工具调用随 context 透传） */
function toggleShellQuickApprove(): void {
  saveShellQuickApprove(shellQuickApprove.value)
  shellApproveStatus.value = shellQuickApprove.value
    ? '已开启：同一命令在同一目录第二次执行起免确认。'
    : '已关闭：所有终端命令执行前都会弹确认框。'
}

/** 加载已记忆的免确认命令列表 */
async function loadShellApprovals(): Promise<void> {
  if (!shellApproveAvailable) return
  shellApprovals.value = await listShellApprovals()
}

/** 删除单条记忆 */
async function removeOneShellApproval(item: ShellApproval): Promise<void> {
  shellApproveStatus.value = ''
  await removeShellApproval(item.command, item.cwd)
  await loadShellApprovals()
}

/** 清空全部记忆 */
async function clearAllShellApprovals(): Promise<void> {
  if (!window.confirm('确定清空全部已记忆的免确认命令吗？清空后所有命令首次执行都会重新弹确认框。')) return
  shellApproveStatus.value = ''
  await clearShellApprovals()
  await loadShellApprovals()
  shellApproveStatus.value = '已清空全部免确认记忆。'
}

watch(
  activeTab,
  (tab) => {
    if (tab === 'tools') void loadShellApprovals()
  },
  { immediate: true },
)

interface ThemeOption {
  value: ThemePreference
  label: string
  description: string
  icon: 'monitor' | 'sun' | 'moon'
}

const themeOptions: ThemeOption[] = [
  {
    value: 'system',
    label: '跟随系统',
    description: '自动匹配操作系统的深浅色外观，并随系统变化实时切换',
    icon: 'monitor',
  },
  { value: 'light', label: '浅色模式', description: '始终使用浅色主题', icon: 'sun' },
  { value: 'dark', label: '深色模式', description: '始终使用深色主题', icon: 'moon' },
]

const resolvedLabel = computed(() => (themeStore.resolvedTheme === 'dark' ? '深色' : '浅色'))
const systemLabel = computed(() => (themeStore.systemDark ? '深色' : '浅色'))

/* —— 更多设置：子面板（账号 / 通知 / 关于）—— */

type MorePanel = 'account' | 'notifications' | 'about'

/** 当前展开的「更多设置」子面板（''=未展开，显示列表） */
const activeMorePanel = ref<MorePanel | ''>('')

/** 更多设置列表项元信息 */
const moreItems: Array<{ value: MorePanel; label: string; description: string }> = [
  {
    value: 'account',
    label: '账号与个人资料',
    description: '昵称、头像与签名简介，保存在本地。',
  },
  {
    value: 'notifications',
    label: '通知偏好',
    description: '任务提醒、消息声音与桌面通知开关。',
  },
  {
    value: 'about',
    label: '关于与版本信息',
    description: '应用名称、版本号与检查更新。',
  },
]

/** 更多设置面板标题（未展开时为空串） */
const morePanelTitle = computed(
  () => moreItems.find((item) => item.value === activeMorePanel.value)?.label ?? '',
)

/* —— 工作区记忆：预览 + 手动编辑 + 保存（按工作区隔离，桌面端专属） —— */

const workspacesStore = useWorkspacesStore()
const memoryAvailable = hasMemoryBridge()

/** 面板当前编辑的工作区 id（默认当前活动工作区） */
const memoryWorkspaceId = ref(workspacesStore.activeWorkspaceId)
/** 记忆编辑内容（textarea 双向绑定） */
const memoryText = ref('')
/** 加载中的工作区 id（防止切换后旧结果覆盖新内容） */
const memoryLoadingId = ref('')
const memorySaving = ref(false)
/** 保存/加载的操作提示（成功与失败共用，空串表示无提示） */
const memoryStatus = ref('')

/** 当前编辑内容相对已保存内容是否有改动（供保存按钮禁用态） */
const memoryDirty = ref(false)

async function loadWorkspaceMemory(): Promise<void> {
  const workspaceId = memoryWorkspaceId.value
  if (!memoryAvailable || !workspaceId) return
  memoryLoadingId.value = workspaceId
  memoryStatus.value = ''
  const content = await readWorkspaceMemory(workspaceId)
  if (memoryWorkspaceId.value !== workspaceId) return
  memoryText.value = content
  memoryDirty.value = false
  memoryLoadingId.value = ''
}

function onMemoryInput(): void {
  memoryDirty.value = true
  memoryStatus.value = ''
}

async function saveWorkspaceMemory(): Promise<void> {
  const workspaceId = memoryWorkspaceId.value
  if (!memoryAvailable || !workspaceId || memorySaving.value) return
  memorySaving.value = true
  memoryStatus.value = ''
  try {
    await writeWorkspaceMemory(workspaceId, memoryText.value)
    memoryDirty.value = false
    memoryStatus.value = '已保存工作区记忆'
  } catch (err) {
    memoryStatus.value = `保存失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    memorySaving.value = false
  }
}

// 切换工作区或首次进入「工作区记忆」分区时加载
watch(memoryWorkspaceId, () => void loadWorkspaceMemory())
watch(activeTab, (tab) => {
  if (tab === 'memory') {
    // 进入分区时默认选中当前活动工作区
    memoryWorkspaceId.value = workspacesStore.activeWorkspaceId
    void loadWorkspaceMemory()
  }
})
const memoryCharCount = computed(() => memoryText.value.length)
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>设置</h1>
      <p>偏好将保存在本地浏览器中（localStorage），不会上传到服务器。</p>
    </header>

    <div class="settings-tabs" role="tablist" aria-label="设置分区">
      <button
        v-for="tab in tabs"
        :key="tab.value"
        class="settings-tab"
        :class="{ 'is-active': activeTab === tab.value }"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.value"
        @click="activeTab = tab.value"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 外观 -->
    <template v-if="activeTab === 'appearance'">
      <section class="card" aria-labelledby="appearance-title">
        <header class="section-head">
          <h2 id="appearance-title">外观</h2>
          <p>
            选择主题模式后即时生效；顶栏的主题切换按钮与此处联动（三态循环：跟随系统 → 浅色 → 深色）。
          </p>
        </header>

        <div class="theme-options" role="radiogroup" aria-label="主题模式">
          <label
            v-for="option in themeOptions"
            :key="option.value"
            class="theme-option"
            :class="{ 'is-selected': themeStore.preference === option.value }"
          >
            <input
              class="theme-option-input"
              type="radio"
              name="theme-preference"
              :value="option.value"
              :checked="themeStore.preference === option.value"
              @change="themeStore.setPreference(option.value)"
            />
            <AppIcon :name="option.icon" class="theme-option-icon" />
            <span class="theme-option-body">
              <span class="theme-option-title">{{ option.label }}</span>
              <span class="theme-option-desc">{{ option.description }}</span>
            </span>
            <span class="theme-option-check" aria-hidden="true">✓</span>
          </label>
        </div>

        <p class="theme-hint">
          当前生效：<strong>{{ resolvedLabel }}</strong
          >主题<template v-if="themeStore.preference === 'system'"
            >（跟随系统，系统当前为{{ systemLabel }}）</template
          >。
        </p>
      </section>

      <!-- 更多设置：列表 + 展开子面板（面板内提供返回按钮） -->
      <section v-if="activeMorePanel === ''" class="card" aria-labelledby="more-title">
        <header class="section-head">
          <h2 id="more-title">更多设置</h2>
          <p>账号、通知与应用信息，点击进入对应面板。</p>
        </header>
        <ul class="more-list">
          <li v-for="item in moreItems" :key="item.value">
            <button class="more-item" type="button" @click="activeMorePanel = item.value">
              <span class="more-item-body">
                <span class="more-item-label">{{ item.label }}</span>
                <span class="more-item-desc">{{ item.description }}</span>
              </span>
              <AppIcon name="chevron-down" class="more-item-chevron" />
            </button>
          </li>
        </ul>
      </section>

      <section v-else class="card" aria-labelledby="more-panel-title">
        <header class="section-head more-panel-head">
          <div>
            <h2 id="more-panel-title">{{ morePanelTitle }}</h2>
            <p>修改即时生效并自动保存到本地。</p>
          </div>
          <button class="more-back" type="button" @click="activeMorePanel = ''">
            <AppIcon name="chevron-down" class="more-back-icon" />
            返回更多设置
          </button>
        </header>

        <AccountPanel v-if="activeMorePanel === 'account'" />
        <NotificationPanel v-else-if="activeMorePanel === 'notifications'" />
        <AboutPanel v-else />
      </section>
    </template>

    <!-- 模型接入 -->
    <section v-else-if="activeTab === 'models'" class="card" aria-labelledby="models-title">
      <ModelSettingsPanel />
    </section>

    <!-- MCP 服务器 -->
    <template v-else-if="activeTab === 'mcp'">
      <McpSettingsPanel />
    </template>

    <!-- 工作区记忆 -->
    <section v-else-if="activeTab === 'memory'" class="card" aria-labelledby="memory-title">
      <header class="section-head">
        <h2 id="memory-title">工作区记忆</h2>
        <p>智能体可自动维护，也可手动编辑；按工作区隔离。</p>
      </header>

      <div v-if="!memoryAvailable" class="memory-empty">
        记忆需要桌面端应用：请在 Electron 桌面端中使用本功能（纯浏览器模式下记忆不可用）。
      </div>

      <template v-else>
        <label class="memory-workspace-label" for="memory-workspace-select">选择工作区</label>
        <select
          id="memory-workspace-select"
          v-model="memoryWorkspaceId"
          class="memory-workspace-select"
        >
          <option v-for="ws in workspacesStore.sortedWorkspaces" :key="ws.id" :value="ws.id">
            {{ ws.icon }} {{ ws.name }}
          </option>
        </select>

        <p
          v-if="memoryStatus"
          class="memory-status"
          :class="{ 'is-error': memoryStatus.startsWith('保存失败') }"
        >
          {{ memoryStatus }}
        </p>

        <p v-if="memoryLoadingId" class="memory-hint">正在加载记忆…</p>
        <template v-else>
          <p v-if="memoryText.trim() === ''" class="memory-hint">
            暂无记忆，智能体会在工作中自动沉淀经验。
          </p>
          <textarea
            v-model="memoryText"
            class="memory-textarea"
            rows="14"
            spellcheck="false"
            placeholder="记忆以 Markdown 保存（单份上限 64KB）。例如：用户偏好、项目约定、经验教训…"
            aria-label="工作区记忆内容"
            @input="onMemoryInput"
          ></textarea>
          <div class="memory-actions">
            <button
              class="memory-save"
              type="button"
              :disabled="!memoryDirty || memorySaving"
              @click="saveWorkspaceMemory"
            >
              {{ memorySaving ? '保存中…' : '保存记忆' }}
            </button>
            <span class="memory-count">{{ memoryCharCount }} 字符</span>
          </div>
        </template>
      </template>
    </section>

    <!-- 公众号写作：账号资料（写作页只读，仅此处可改，改动即存） -->
    <section v-else-if="activeTab === 'writing'" class="card" aria-labelledby="writing-title">
      <header class="section-head">
        <h2 id="writing-title">公众号写作</h2>
        <p>
          公众号名称、简介与作者职业只能在设置中修改，修改即时生效并自动保存；
          「公众号写作」页会展示当前值（只读）。
        </p>
      </header>

      <div class="writing-profile-grid">
        <label class="writing-profile-field">
          <span>公众号名称</span>
          <input
            v-model="mpName"
            type="text"
            placeholder="例如：职场解毒室"
            maxlength="60"
          />
        </label>
        <label class="writing-profile-field">
          <span>公众号简介</span>
          <input
            v-model="mpBio"
            type="text"
            placeholder="例如：只聊打工人真实的生存智慧"
            maxlength="120"
          />
        </label>
        <label class="writing-profile-field">
          <span>作者职业</span>
          <input
            v-model="authorRole"
            type="text"
            placeholder="例如：10 年大厂 HR"
            maxlength="60"
          />
        </label>
      </div>
      <p class="writing-profile-hint">清空某项后，写作页对应字段会显示「未设置」。</p>
    </section>

    <!-- 工具中心 -->
    <template v-else>
      <section class="card" aria-labelledby="permission-title">
        <header class="section-head">
          <h2 id="permission-title">权限模式</h2>
          <p>
            控制智能体执行写类工具（vault_write、http_post_json）时的确认策略；
            与对话页输入区的权限模式下拉共用同一设置，切换即时生效。
          </p>
        </header>

        <div class="permission-options" role="radiogroup" aria-label="权限模式">
          <label
            v-for="option in PERMISSION_MODES"
            :key="option.value"
            class="theme-option"
            :class="{ 'is-selected': permissionStore.mode === option.value }"
          >
            <input
              class="theme-option-input"
              type="radio"
              name="permission-mode"
              :value="option.value"
              :checked="permissionStore.mode === option.value"
              @change="permissionStore.setMode(option.value as PermissionMode)"
            />
            <AppIcon :name="option.icon" class="theme-option-icon" />
            <span class="theme-option-body">
              <span class="theme-option-title">{{ option.label }}</span>
              <span class="theme-option-desc">{{ option.description }}</span>
            </span>
            <span class="theme-option-check" aria-hidden="true">✓</span>
          </label>
        </div>

        <p class="theme-hint">
          计划模式下写类工具会被直接拦截，并在 system 消息中注入计划模式约束（模型只输出计划）。
        </p>
      </section>

      <section class="card" aria-labelledby="tools-title">
        <header class="section-head">
          <h2 id="tools-title">工具中心</h2>
          <p>
            智能体在对话中可自主调用的内置工具。禁用后调用会被立即拒绝并提示"工具已被禁用"（拦截发生在应用内，不影响模型本身）。
          </p>
        </header>

        <ul class="tool-list">
          <li v-for="tool in AGENT_TOOLS" :key="tool.name" class="tool-item">
            <div class="tool-item-body">
              <p class="tool-item-name">
                🔧 <code>{{ tool.name }}</code>
                <span v-if="tool.name === 'http_post_json'" class="badge badge-warn">需确认</span>
                <span v-else class="badge badge-muted">免确认</span>
              </p>
              <p class="tool-item-desc">{{ tool.description }}</p>
              <p class="tool-item-params">
                参数：{{ toolParamsSummary(tool.name) }}
                <template v-if="tool.parameters.required.length > 0">
                  <span v-for="(spec, key) in tool.parameters.properties" :key="key">
                    · {{ key }}（{{ spec.type }}）：{{ spec.description }}
                  </span>
                </template>
              </p>
            </div>
            <button
              class="tool-toggle"
              type="button"
              role="switch"
              :aria-checked="!isToolDisabled(tool.name)"
              :class="{ 'is-on': !isToolDisabled(tool.name) }"
              @click="toggleTool(tool.name)"
            >
              <span class="tool-toggle-thumb" aria-hidden="true"></span>
              <span class="tool-toggle-text">{{ isToolDisabled(tool.name) ? '已禁用' : '已启用' }}</span>
            </button>
          </li>
        </ul>

        <p class="tool-summary">
          共 {{ AGENT_TOOLS.length }} 个工具，当前启用 {{ AGENT_TOOLS.length - disabledCount }} 个。
          工具执行环境为桌面端主进程，浏览器/纯网页模式下工具不可用。
        </p>
      </section>

      <section class="card" aria-labelledby="tool-safety-title">
        <header class="section-head">
          <h2 id="tool-safety-title">安全说明</h2>
          <p>工具由模型在对话中按需发起，以下限制用于控制风险：</p>
        </header>
        <ul class="safety-list">
          <li>
            <strong>确认框</strong>：发送数据的工具（如 <code>http_post_json</code>）执行前会弹原生确认框，
            你可以拒绝；拒绝结果会作为工具输出回传给模型，不会中断对话。
          </li>
          <li>
            <strong>网络限制</strong>：网络工具仅支持 http/https 地址，拒绝其他协议；
            请求超时 15 秒；返回内容超过约 20KB 会被截断并标注，避免撑爆上下文。
          </li>
          <li>
            <strong>执行环境</strong>：工具在桌面端主进程中执行，渲染进程无法越权访问注册表之外的能力；
            工具请求超时或失败时会以文本形式回传给模型，不会导致应用崩溃。
          </li>
          <li>
            <strong>禁用即时生效</strong>：开关状态保存在本地（localStorage），禁用后下一次调用即被拒绝。
          </li>
        </ul>
      </section>

      <section class="card" aria-labelledby="task-run-title">
        <header class="section-head">
          <h2 id="task-run-title">任务执行（子智能体）</h2>
          <p>
            计划批准后由执行子智能体逐步完成任务。这里的设置为全局默认值，
            新批准的执行任务会使用这些参数（会话内可单独调整时优先会话设置）。
          </p>
        </header>
        <div class="task-param-grid">
          <label class="task-param">
            <span>每步最大回合数（1-30）</span>
            <input
              v-model.number="taskMaxRounds"
              type="number"
              min="1"
              max="30"
              step="1"
              @change="saveTaskParams"
            />
            <small>子智能体执行单个步骤时的工具调用回合上限，防止失控。</small>
          </label>
          <label class="task-param">
            <span>单步结果上限字符数（200-4000）</span>
            <input
              v-model.number="taskResultMaxChars"
              type="number"
              min="200"
              max="4000"
              step="100"
              @change="saveTaskParams"
            />
            <small>每步结果摘要回填主对话时的截断长度。</small>
          </label>
        </div>
        <p class="task-param-hint">
          并行执行：在计划步骤行末尾标注「[并行]」的相邻步骤可并发执行（批准计划时可开关）；
          步骤行末尾可用「@模型名」为单步绑定指定模型，未标注时使用当前会话模型。
        </p>
      </section>

      <section class="card" aria-labelledby="shell-approve-title">
        <header class="section-head">
          <h2 id="shell-approve-title">终端命令快捷确认</h2>
          <p>
            针对终端命令工具 <code>shell_exec</code>：开启后，同一条命令在同一个目录下第一次执行仍会弹确认框，
            你点「允许执行」后会记住该组合，第二次及以后不再弹窗。关闭开关则所有命令执行前都弹确认框。
          </p>
        </header>

        <label class="shell-approve-toggle">
          <input v-model="shellQuickApprove" type="checkbox" @change="toggleShellQuickApprove" />
          <span>启用快捷确认（默认开启）</span>
        </label>

        <template v-if="shellApproveAvailable">
          <div class="shell-approve-head">
            <h3>已记忆的命令（{{ shellApprovals.length }} 条）</h3>
            <button
              class="shell-approve-btn shell-approve-btn-danger"
              type="button"
              :disabled="shellApprovals.length === 0"
              @click="clearAllShellApprovals"
            >
              清空全部
            </button>
          </div>
          <ul v-if="shellApprovals.length > 0" class="shell-approve-list">
            <li v-for="(item, index) in shellApprovals" :key="`${item.command}-${item.cwd}-${index}`">
              <div class="shell-approve-item-body">
                <code class="shell-approve-command">{{ item.command }}</code>
                <span class="shell-approve-cwd" :title="item.cwd">目录：{{ item.cwd }}</span>
              </div>
              <button
                class="shell-approve-btn"
                type="button"
                @click="removeOneShellApproval(item)"
              >
                删除
              </button>
            </li>
          </ul>
          <p v-else class="shell-approve-empty">暂无记忆：命令首次执行并点「允许执行」后会出现在这里。</p>
          <p v-if="shellApproveStatus" class="shell-approve-status">{{ shellApproveStatus }}</p>
        </template>
        <p v-else class="shell-approve-empty">
          终端命令快捷确认需要桌面端应用：纯浏览器模式下 shell_exec 不可用，因此没有可管理的记忆列表。
        </p>
      </section>
    </template>
  </div>
</template>

<style scoped>
.settings-tabs {
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  align-self: flex-start;
}

.settings-tab {
  height: 34px;
  padding: 0 var(--space-5);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  font-size: var(--font-size-md);
  transition:
    background-color var(--transition-fast),
    color var(--transition-fast),
    box-shadow var(--transition-fast);
}

.settings-tab:hover {
  color: var(--color-text);
}

/* 选中态：品牌橙贴纸（实底橙 + on-brand 字，深浅主题各自取对应对） */
.settings-tab.is-active {
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.section-head h2 {
  font-size: var(--font-size-xl);
}

.section-head p {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
}

.theme-options {
  margin-top: var(--space-5);
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--space-4);
}

.theme-option {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-7) var(--space-4) var(--space-4);
  border: 1.5px solid var(--color-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.theme-option:hover {
  border-color: var(--color-border-strong);
}

.theme-option.is-selected {
  border-color: var(--color-brand);
  background: var(--color-brand-soft);
}

.theme-option-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.theme-option-input:focus-visible + .theme-option-icon {
  outline: 2px solid var(--color-brand);
  outline-offset: 3px;
  border-radius: var(--radius-sm);
}

.theme-option-icon {
  width: 20px;
  height: 20px;
  margin-top: 2px;
  color: var(--color-text-secondary);
}

.theme-option.is-selected .theme-option-icon {
  color: var(--color-brand);
}

.theme-option-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.theme-option-title {
  font-weight: 600;
}

.theme-option-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.theme-option-check {
  position: absolute;
  top: var(--space-3);
  right: var(--space-3);
  display: none;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: 12px;
}

.theme-option.is-selected .theme-option-check {
  display: inline-flex;
}

.theme-hint {
  margin-top: var(--space-5);
  color: var(--color-text-secondary);
}

/* —— 工具中心：权限模式（复用 theme-option 卡片样式，四档纵排在窄屏、双列在宽屏） —— */
.permission-options {
  margin-top: var(--space-5);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-4);
}

@media (max-width: 860px) {
  .permission-options {
    grid-template-columns: 1fr;
  }
}

/* —— 更多设置列表与子面板 —— */
.more-list {
  margin-top: var(--space-4);
}

.more-list li {
  border-top: 1px dashed var(--color-border);
}

.more-list li:first-child {
  border-top: 0;
}

.more-item {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-2);
  border-radius: var(--radius-md);
  text-align: left;
  color: var(--color-text);
  transition: background-color var(--transition-fast);
}

.more-item:hover {
  background: var(--color-surface-muted);
}

.more-item-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.more-item-label {
  font-weight: 600;
  font-size: var(--font-size-md);
}

.more-item-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.more-item-chevron {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  transform: rotate(-90deg);
  color: var(--color-text-muted);
}

.more-panel-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
}

.more-back {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  flex-shrink: 0;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.more-back:hover {
  border-color: var(--color-brand);
  color: var(--color-text);
}

.more-back-icon {
  width: 14px;
  height: 14px;
  transform: rotate(90deg);
}

@media (max-width: 860px) {
  .theme-options {
    grid-template-columns: 1fr;
  }
}

/* —— 工具中心 —— */
.tool-list {
  margin-top: var(--space-4);
}

.tool-item {
  display: flex;
  align-items: flex-start;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  border-top: 1px dashed var(--color-border);
}

.tool-item:first-child {
  border-top: 0;
  padding-top: var(--space-2);
}

.tool-item-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.tool-item-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-md);
  font-weight: 600;
}

.tool-item-name code {
  font-family: var(--font-mono);
}

.tool-item-desc {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.tool-item-params {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.6;
}

/* 启用/禁用开关 */
.tool-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: var(--color-surface-muted);
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast);
}

.tool-toggle:hover {
  border-color: var(--color-border-strong);
  background: var(--color-surface);
}

.tool-toggle-thumb {
  width: 28px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--color-border-strong);
  position: relative;
  transition: background-color var(--transition-fast);
}

.tool-toggle-thumb::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: var(--radius-full);
  background: var(--color-surface);
  box-shadow: var(--shadow-sm);
  transition: transform var(--transition-fast);
}

.tool-toggle.is-on .tool-toggle-thumb {
  background: var(--color-brand);
}

.tool-toggle.is-on .tool-toggle-thumb::after {
  transform: translateX(12px);
}

.tool-toggle-text {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.tool-summary {
  margin-top: var(--space-4);
  color: var(--color-text-secondary);
}

.safety-list {
  margin-top: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.safety-list li {
  padding: var(--space-2) 0;
  border-top: 1px dashed var(--color-border);
  color: var(--color-text-secondary);
  line-height: 1.7;
  font-size: var(--font-size-sm);
}

.safety-list li:first-child {
  border-top: 0;
}

.safety-list code {
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
  background: var(--color-surface-muted);
  padding: 1px var(--space-1);
  border-radius: var(--radius-sm);
}

/* 任务执行（子智能体）参数表单 */
.task-param-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
  margin-bottom: var(--space-2);
}

.task-param {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

.task-param input {
  width: 100%;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  color: var(--color-text);
}

.task-param small {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.task-param-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

/* —— 公众号写作：账号资料 —— */
.writing-profile-grid {
  margin-top: var(--space-5);
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-3);
}

.writing-profile-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

.writing-profile-field input {
  width: 100%;
  height: 38px;
  padding: 0 var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-md);
  transition: border-color var(--transition-fast);
}

.writing-profile-field input:focus {
  outline: none;
  border-color: var(--color-brand);
}

.writing-profile-hint {
  margin-top: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* —— 工作区记忆 —— */
.memory-empty {
  margin-top: var(--space-4);
  padding: var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  background: var(--color-surface-muted);
}

.memory-workspace-label {
  display: block;
  margin-top: var(--space-4);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.memory-workspace-select {
  margin-top: var(--space-2);
  min-width: 240px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-md);
}

.memory-status {
  margin-top: var(--space-3);
  color: var(--color-success);
}

.memory-status.is-error {
  color: var(--color-danger);
}

.memory-hint {
  margin-top: var(--space-3);
  color: var(--color-text-secondary);
}

.memory-textarea {
  margin-top: var(--space-3);
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  line-height: 1.7;
  resize: vertical;
}

.memory-actions {
  margin-top: var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.memory-save {
  padding: var(--space-2) var(--space-5);
  border: 1px solid var(--color-brand);
  border-radius: var(--radius-md);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.memory-save:not(:disabled):hover {
  background: var(--color-brand-strong);
  border-color: var(--color-brand-strong);
}

.memory-save:not(:disabled):active {
  background: var(--color-brand-deep);
  border-color: var(--color-brand-deep);
}

.memory-save:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.memory-count {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

/* —— 终端命令快捷确认 —— */
.shell-approve-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.shell-approve-toggle input {
  accent-color: var(--color-brand);
}

.shell-approve-head {
  margin-top: var(--space-4);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.shell-approve-head h3 {
  font-size: var(--font-size-md);
}

.shell-approve-list {
  margin-top: var(--space-2);
  display: flex;
  flex-direction: column;
}

.shell-approve-list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-top: 1px dashed var(--color-border);
}

.shell-approve-item-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.shell-approve-command {
  font-family: var(--font-mono);
  font-size: var(--font-size-sm);
  overflow-wrap: anywhere;
}

.shell-approve-cwd {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell-approve-btn {
  flex-shrink: 0;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-surface);
  font-size: var(--font-size-xs);
  cursor: pointer;
}

.shell-approve-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.shell-approve-btn-danger {
  color: var(--color-danger);
}

.shell-approve-empty {
  margin-top: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.shell-approve-status {
  margin-top: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-success);
}
</style>
