<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'

import EmptyState from '@/components/EmptyState.vue'
import RichText from '@/components/RichText.vue'
import ToolStepCard from '@/components/ToolStepCard.vue'
import { TOPIC_PLATFORMS, TOPIC_STAGES } from '@/lib/today-topics'
import type { TopicPick } from '@/lib/today-topics'
import { TOPIC_STATUS_LABEL as STATUS_LABEL, useTodayTopicsStore } from '@/stores/today-topics'

/**
 * 今日选题（纯展示视图）：三 block 流水线的偏好表单与结果渲染。
 * 运行状态与编排逻辑全部在 useTodayTopicsStore（Pinia 常驻内存），
 * 切换左侧菜单后任务继续运行，回到本页原样展示（含流式中途进度）；
 * 偏好输入（账号定位/目标读者）的 localStorage 持久化逻辑在 store 中。
 */

const store = useTodayTopicsStore()
// 选中卡片下标也在 store 中：与流水线状态一起持久化，关闭应用后恢复原样
const { positioning, audience, platform, stages, expanded, selectedPickIndex } = storeToRefs(store)
const running = computed(() => store.running)
const parsedPicks = computed(() => store.parsedPicks)
const parseFailed = computed(() => store.parseFailed)
const cardsStatus = computed(() => store.cardsStatus)
const cardsStatusLabel = computed(() => store.cardsStatusLabel)
const hasResult = computed(() => store.hasResult)
const activeConfig = computed(() => store.activeConfig)

const router = useRouter()

/** 轻量提示 */
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function showNotice(text: string): void {
  notice.value = text
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
  }, 2200)
}

/* —— 流水线操作（运行逻辑在 store） —— */

/** 点击「看看今天有什么可写」/「换一批」：由 store 清空全部阶段后从头执行 */
function startScan(): void {
  // 重新扫描会生成新一批选题，旧下标不再可靠，清空选中
  selectedPickIndex.value = null
  void store.startPipeline()
}

function stopPipeline(): void {
  store.stop()
}

/** 单阶段重试入口：前置阶段未完成时给出提示 */
async function retryStage(stageIndex: number): Promise<void> {
  if (!store.prerequisitesDone(stageIndex)) {
    showNotice('请先完成前置阶段，或重新运行流水线')
    return
  }
  await store.retryStage(stageIndex)
  // 评估阶段重跑会生成新一批选题，旧下标不再可靠，清空选中
  if (stageIndex <= 1) selectedPickIndex.value = null
}

/* —— 选题卡片（Block 3：解析结果由 store 派生提供） —— */

/* —— 卡片选择模式：单选当前要写的话题（选中下标在 store，随流水线持久化） —— */

/** 当前选中话题（下标越界视为未选，防止旧下标残留） */
const selectedPick = computed<TopicPick | null>(() => {
  const picks = parsedPicks.value
  if (!picks || selectedPickIndex.value === null) return null
  return picks[selectedPickIndex.value] ?? null
})

/** 点击卡片主体：单选切换（再点同卡取消，点其他卡切换） */
function togglePick(index: number): void {
  selectedPickIndex.value = selectedPickIndex.value === index ? null : index
}

/** 写作目标平台：wechat 公众号 / xhs 小红书 */
type WritingTarget = 'wechat' | 'xhs'

/** 跳转对应平台写作页并携带主题（写作页挂载时自动填入）；快捷按钮点击同时视为选中该卡 */
function goToWriting(pick: TopicPick, index: number, target: WritingTarget): void {
  selectedPickIndex.value = index
  const routeName = target === 'wechat' ? 'wechat-writing' : 'xhs-writing'
  router.push({ name: routeName, query: { topic: pick.topic } })
}

/** 底部确认栏：跳转当前选中话题到指定平台写作 */
function goToSelected(target: WritingTarget): void {
  const index = selectedPickIndex.value
  const pick = selectedPick.value
  if (pick && index !== null) goToWriting(pick, index, target)
}
</script>

<template>
  <div class="today-topics">
    <!-- 未配置模型：引导去设置页 -->
    <EmptyState
      v-if="!activeConfig"
      title="尚未配置模型"
      description="今日选题需要一个大模型接口。请先到「设置 → 模型配置」填写接口地址与密钥。"
    >
      <RouterLink class="primary-button" to="/settings">去设置模型</RouterLink>
    </EmptyState>

    <template v-else>
      <!-- 顶部偏好输入区 -->
      <section class="requirement-card">
        <header class="card-header">
          <span class="card-kicker">今日选题</span>
          <h2 class="card-title">今天有什么适合写的？让「社媒运营专家」帮你扫描热点、挑选话题</h2>
        </header>
        <div class="form-grid">
          <label class="form-field form-span">
            <span class="form-label">账号定位 / 擅长领域</span>
            <input
              v-model="positioning"
              class="form-input"
              type="text"
              placeholder="例如：面向程序员的成长类账号，擅长 AI 工具实测"
              :disabled="running"
            />
          </label>
          <label class="form-field">
            <span class="form-label">目标读者</span>
            <input
              v-model="audience"
              class="form-input"
              type="text"
              placeholder="例如：工作 1-5 年的一线城市职场人"
              :disabled="running"
            />
          </label>
          <label class="form-field">
            <span class="form-label">偏好平台</span>
            <select v-model="platform" class="form-input" :disabled="running">
              <option v-for="item in TOPIC_PLATFORMS" :key="item" :value="item">{{ item }}</option>
            </select>
          </label>
        </div>
        <footer class="card-actions">
          <button class="primary-button" type="button" :disabled="running" @click="startScan">
            看看今天有什么可写
          </button>
          <button
            v-if="hasResult && !running"
            class="ghost-button"
            type="button"
            @click="startScan"
          >
            换一批
          </button>
          <button
            v-if="running"
            class="ghost-button"
            type="button"
            @click="stopPipeline"
          >
            停止
          </button>
        </footer>
      </section>

      <!-- 阶段流水线 -->
      <section class="stage-list">
        <article
          v-for="(stage, index) in TOPIC_STAGES"
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
            <!-- 工具调用步骤（热点扫描阶段，桌面端） -->
            <div v-if="stages[index].toolSteps.length > 0" class="stage-tools">
              <ToolStepCard
                v-for="(step, stepIndex) in stages[index].toolSteps"
                :key="stepIndex"
                :step="step"
              />
            </div>

            <!-- 产出正文 -->
            <RichText v-if="stages[index].content" :content="stages[index].content" class="stage-output" />
            <p v-else-if="stages[index].status === 'running'" class="stage-placeholder">
              正在生成，请稍候…
            </p>
            <p v-else-if="stages[index].status === 'idle'" class="stage-placeholder">
              尚未运行。完成后此处展示本阶段产出。
            </p>

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
                重试本阶段
              </button>
              <span v-if="stages[index].status === 'aborted'" class="stage-note">
                已中止，已生成内容保留。
              </span>
            </footer>
          </div>
        </article>

        <!-- Block 3：选题卡片（解析评估产出，不发起请求） -->
        <article class="cards-card" :class="`is-${cardsStatus}`">
          <header class="stage-summary cards-summary">
            <span class="stage-index" aria-hidden="true">3</span>
            <span class="stage-heading">
              <span class="stage-title">选题卡片</span>
              <span class="stage-hint">按推荐度排序，可一键去公众号写作</span>
            </span>
            <span class="stage-status" :class="`status-${cardsStatus}`">
              {{ cardsStatusLabel }}
              <span v-if="cardsStatus === 'running'" class="typing-dots" aria-hidden="true">
                <i></i><i></i><i></i>
              </span>
            </span>
          </header>

          <div v-if="parsedPicks" class="cards-body">
            <!-- 选题卡网格：平铺分列展示，点击选中 -->
            <div class="pick-grid">
              <!-- key 用下标：topic 同轮可能重复，避免选中歧义 -->
              <article
                v-for="(pick, index) in parsedPicks"
                :key="index"
                class="pick-card"
                :class="{ 'pick-selected': selectedPickIndex === index }"
                @click="togglePick(index)"
              >
                <header class="pick-header">
                  <span class="pick-order" aria-hidden="true">{{ index + 1 }}</span>
                  <h3 class="pick-topic">{{ pick.topic }}</h3>
                  <span
                    v-if="selectedPickIndex === index"
                    class="pick-selected-badge"
                  >
                    ✓ 已选
                  </span>
                  <span class="pick-score" :title="`推荐分 ${pick.score.toFixed(1)} / 10`">
                    {{ pick.score.toFixed(1) }} 分
                  </span>
                </header>
                <p v-if="pick.heatReason" class="pick-reason">{{ pick.heatReason }}</p>
                <ul v-if="pick.angles.length > 0" class="pick-angles">
                  <li v-for="angle in pick.angles" :key="angle">{{ angle }}</li>
                </ul>
                <p class="pick-meta">
                  <span v-if="pick.audience">适合：{{ pick.audience }}</span>
                  <span v-if="pick.platforms.length > 0">平台：{{ pick.platforms.join(' / ') }}</span>
                </p>
                <div v-if="pick.titleSamples.length > 0" class="pick-titles">
                  <p v-for="title in pick.titleSamples" :key="title" class="pick-title-sample">
                    {{ title }}
                  </p>
                </div>
                <p v-if="pick.riskNote" class="pick-risk">⚠ {{ pick.riskNote }}</p>
                <footer class="pick-actions">
                  <button
                    class="primary-button"
                    type="button"
                    @click.stop="goToWriting(pick, index, 'wechat')"
                  >
                    去公众号写
                  </button>
                  <button
                    class="ghost-button"
                    type="button"
                    @click.stop="goToWriting(pick, index, 'xhs')"
                  >
                    去小红书写
                  </button>
                </footer>
              </article>
            </div>

            <!-- 底部确认栏：统一操作入口 -->
            <footer class="pick-confirm-bar">
              <p class="pick-confirm-text">
                {{ selectedPick ? `已选：${selectedPick.topic}` : '点击卡片选择今天要写的话题' }}
              </p>
              <div class="pick-confirm-actions">
                <button
                  class="primary-button"
                  type="button"
                  :disabled="!selectedPick"
                  @click="goToSelected('wechat')"
                >
                  发送到公众号写作
                </button>
                <button
                  class="ghost-button"
                  type="button"
                  :disabled="!selectedPick"
                  @click="goToSelected('xhs')"
                >
                  发送到小红书写作
                </button>
              </div>
            </footer>
          </div>

          <!-- 结构化解析失败：降级渲染评估阶段原文 -->
          <div v-else-if="parseFailed" class="cards-body cards-fallback">
            <p class="stage-error">结构化解析失败，以下为评估阶段原文：</p>
            <RichText :content="stages[1].content" class="stage-output" />
            <footer class="stage-actions">
              <button
                class="ghost-button"
                type="button"
                :disabled="running"
                @click="retryStage(1)"
              >
                重试评估阶段
              </button>
            </footer>
          </div>

          <p v-else class="stage-placeholder">
            完成前两个阶段后，这里会以推荐卡片展示适合今天写的话题。
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
.today-topics {
  position: relative;
  max-width: 920px;
  margin: 0 auto;
  padding: var(--space-6) var(--space-5) var(--space-8);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

/* —— 顶部偏好卡 —— */
.requirement-card,
.stage-card,
.cards-card {
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
.cards-card {
  overflow: hidden;
  transition: border-color var(--transition-fast);
}

.stage-card.is-running,
.cards-card.is-running {
  border-color: var(--color-brand);
}

.stage-card.is-error,
.cards-card.is-error {
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

.cards-summary {
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

.stage-card.is-done .stage-index,
.cards-card.is-done .stage-index {
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

/* —— 选题卡片 —— */
.cards-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  margin: 0 var(--space-5) var(--space-5);
  padding-top: var(--space-4);
  border-top: 1px solid var(--color-border);
}

.cards-fallback {
  align-items: flex-start;
}

/* —— 选题卡网格：平铺分列，无叠加态 —— */
.pick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-4);
}

/* 序号徽标：标题前的内联小圆标（第几位选题） */
.pick-order {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

.pick-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  cursor: pointer;
  transition: box-shadow var(--transition-fast), border-color var(--transition-fast);
}

.pick-card:hover {
  box-shadow: var(--shadow-md);
}

/* 选中态：白卡保持不变 + 2px 品牌橙描边 + 右上角三角形角标（不刷 soft 底，
   避免与橙 soft 底的分数 chip 同色相消；描边补偿 1px 内边距防抖动） */
.pick-card.pick-selected {
  border-color: var(--color-brand);
  box-shadow: var(--shadow-md);
}

.pick-card.pick-selected::after {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  width: 0;
  height: 0;
  border-top: 16px solid var(--color-brand);
  border-left: 16px solid transparent;
  border-top-right-radius: var(--radius-md);
}

/* 「✓ 已选」小徽标：与右侧推荐分徽标并排（选中后缩小弱化，选中身份主要由描边+角标表达） */
.pick-selected-badge {
  flex-shrink: 0;
  padding: 1px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-brand);
  color: var(--color-on-brand);
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}

.pick-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

/* 分数 chip（及已选徽标）靠右：序号+标题占左侧 */
.pick-selected-badge,
.pick-score {
  margin-left: auto;
}

.pick-topic {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: 600;
  line-height: 1.4;
  color: var(--color-text);
}

.pick-score {
  flex-shrink: 0;
  padding: 2px var(--space-2);
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  color: var(--color-brand);
  font-size: var(--font-size-xs);
  font-weight: 600;
}

/* 选中卡内分数 chip 改 info 蓝浅底：与橙描边拉开色相，不再被选中底吞掉 */
.pick-card.pick-selected .pick-score {
  background: var(--color-info-soft);
  color: var(--color-info-500);
}

/* 底部确认栏：左侧选中状态文案 + 右侧双平台操作组 */
.pick-confirm-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

/* 确认栏按钮组：两个操作按钮并排，窄屏可换行防破版 */
.pick-confirm-actions {
  display: flex;
  flex-shrink: 0;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.pick-confirm-text {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pick-reason {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  color: var(--color-text-secondary);
}

.pick-angles {
  margin: 0;
  padding-left: 1.2em;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  font-size: var(--font-size-sm);
  color: var(--color-text);
}

.pick-meta {
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.pick-titles {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-surface-muted);
}

.pick-title-sample {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.pick-risk {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: var(--font-size-xs);
}

.pick-actions {
  margin-top: auto;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.pick-actions .primary-button,
.pick-actions .ghost-button {
  height: 32px;
  padding: 0 var(--space-4);
  font-size: var(--font-size-sm);
}

/* 确认栏按钮沿用标准 38px 高度，窄屏缩短内边距防溢出 */
.pick-confirm-actions .primary-button,
.pick-confirm-actions .ghost-button {
  padding: 0 var(--space-4);
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

  /* 选题卡网格：auto-fill 已自然降级单列，无需额外覆盖 */

  /* 确认栏窄屏换行：文案与按钮组各占一行，防破版 */
  .pick-confirm-bar {
    flex-wrap: wrap;
  }

  .pick-confirm-text {
    white-space: normal;
  }
}
</style>
