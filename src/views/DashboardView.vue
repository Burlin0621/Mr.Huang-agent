<script setup lang="ts">
import { computed } from 'vue'

import BearMascot from '@/components/BearMascot.vue'
import StatCard from '@/components/StatCard.vue'
import { useAgentsStore } from '@/stores/agents'
import { useConversationsStore } from '@/stores/conversations'
import { useGroupChatsStore } from '@/stores/group-chats'
import { useSkillsStore } from '@/stores/skills'

const agentsStore = useAgentsStore()
const conversationsStore = useConversationsStore()
const groupChatsStore = useGroupChatsStore()
const skillsStore = useSkillsStore()

const now = new Date()

const today = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}).format(now)

// —— 按时段切换问候语（「不懒小熊」勤奋可爱人设） ——
const greetingByPeriod: Array<{ range: [number, number]; text: string }> = [
  { range: [5, 11], text: '早上好，今天也要元气满满地开工呀 🐻' },
  { range: [11, 14], text: '中午好，吃饱饱才有力气继续搬砖呀 🐻' },
  { range: [14, 18], text: '下午好，午后的活儿交给不懒小熊陪你冲呀 🐻' },
  { range: [18, 23], text: '晚上好，今晚也离目标更近了一点点呀 🐻' },
  { range: [23, 29], text: '夜深了，别熬太晚，早点休息明天再战呀 🐻' },
]

function getGreeting(hour: number): string {
  const h = hour % 24
  return greetingByPeriod.find(({ range }) => h >= range[0] && h < range[1])?.text ?? greetingByPeriod[4].text
}

const greeting = getGreeting(now.getHours())

// —— 每日一句：按日期字符串哈希确定性选取，同一天不变、无需联网 ——
const quotes: string[] = [
  '勤奋不是天赋，是每天多坚持一小会儿的习惯。',
  '先完成，再完美，别让拖延偷走今天的成果。',
  '把大目标切成小块，一口一口吃掉它。',
  '灵感偏爱正在动手的人，而不是等待的人。',
  '今天的努力，是明天的自己寄来的礼物。',
  '写不出来的时候，先写下第一句废话也好。',
  '小熊不偷懒，一步一步也能翻过山坡。',
  '创作最好的时机是开始动笔的那一刻。',
  '复利藏在每一个不被看见的清晨里。',
  '别怕走得慢，怕的是原地打转。',
  '把每个想法记下来，灵感会排队来找你。',
  '认真的样子最可爱，努力的小熊最帅。',
  '困难只是暂时还没被拆解的任务清单。',
  '少一点完美主义，多一点迭代勇气。',
  '工具再好，也要动手才有产出。',
  '专注一小时，胜过磨蹭一上午。',
  '整理好素材库，创作就成功了一半。',
  '每天进步 1%，一年后就是全新的自己。',
  '先把事情做对，再把事情做得漂亮。',
  '别等状态来了才开工，开工了状态自然会来。',
  '记录本身就是一种创作。',
  '懒惰是暂时的舒服，勤奋是长期的自由。',
  '好作品都是改出来的，别吝啬打磨的时间。',
  '把今天过好，就是对未来最大的诚意。',
  '山不高，只是需要一步一步去爬。',
]

function getDailyQuote(date: Date): string {
  const key = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  let hash = 0
  for (const ch of key) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  }
  return quotes[hash % quotes.length]
}

const dailyQuote = getDailyQuote(now)

const stats = computed(() => [
  { label: '智能体', value: String(agentsStore.agents.length), note: `内置 + 自定义，已启用 ${agentsStore.enabledAgents.length} 个`, to: '/agents' },
  { label: '技能', value: String(skillsStore.skills.length), note: `已启用 ${skillsStore.enabledSkills.length} 个`, to: '/skills' },
  { label: '对话', value: String(conversationsStore.conversations.length), note: '全部工作区对话总数', to: '/chat' },
  { label: '群聊协作', value: String(groupChatsStore.groupChats.length), note: '多智能体群聊会话', to: '/group-chat' },
])

// —— 快捷入口：常用功能一键直达（均为真实路由） ——
const quickEntries = [
  { icon: '💬', name: '对话', desc: '与智能体一对一高效沟通', to: '/chat' },
  { icon: '👥', name: '群聊协作', desc: '多智能体群聊协同作战', to: '/group-chat' },
  { icon: '🤖', name: '智能体', desc: '管理与配置你的智能体', to: '/agents' },
  { icon: '🧩', name: '技能', desc: '为智能体装配实用技能', to: '/skills' },
  { icon: '✍️', name: '提示词', desc: '沉淀复用高质量提示词', to: '/prompts' },
  { icon: '🔥', name: '今日话题', desc: '发现今日热点创作灵感', to: '/today-topics' },
  { icon: '📚', name: '知识库', desc: '素材与灵感的知识沉淀', to: '/vault' },
  { icon: '📰', name: '公众号写作', desc: '从选题到成文一键发布', to: '/wechat-writing' },
]
</script>

<template>
  <div class="page">
    <section class="welcome card" aria-labelledby="welcome-title">
      <div class="welcome-text">
        <p class="welcome-date">{{ today }}</p>
        <h1 id="welcome-title">{{ greeting }}</h1>
        <p class="welcome-quote">
          <span class="quote-mark" aria-hidden="true">「</span>{{ dailyQuote
          }}<span class="quote-mark" aria-hidden="true">」</span>
        </p>
      </div>
      <div class="welcome-bear">
        <BearMascot :size="88" />
      </div>
    </section>

    <section class="stats" aria-label="统计概览（占位）">
      <StatCard
        v-for="item in stats"
        :key="item.label"
        :label="item.label"
        :value="item.value"
        :note="item.note"
        :to="item.to"
      />
    </section>

    <section class="card" aria-labelledby="quick-entries-title">
      <header class="quick-head">
        <h2 id="quick-entries-title"><span class="head-deco" aria-hidden="true"></span>快捷入口</h2>
        <p>常用功能一键直达</p>
      </header>
      <div class="quick-grid">
        <router-link
          v-for="entry in quickEntries"
          :key="entry.to"
          :to="entry.to"
          class="quick-entry"
          :aria-label="`前往${entry.name}`"
        >
          <span class="quick-icon" aria-hidden="true">{{ entry.icon }}</span>
          <span class="quick-name">{{ entry.name }}</span>
          <span class="quick-desc">{{ entry.desc }}</span>
        </router-link>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* —— 问候语 + 每日一句（品牌小熊形象） —— */
.welcome {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-6);
}

.welcome-date {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  letter-spacing: 0.02em;
}

.welcome-text h1 {
  margin-top: var(--space-2);
  font-size: var(--font-size-3xl);
  font-weight: var(--font-weight-display);
  letter-spacing: -0.01em;
  line-height: 1.25;
  color: var(--color-text);
}

.welcome-quote {
  margin-top: var(--space-3);
  max-width: 560px;
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md);
  background: var(--color-brand-soft);
  border-left: 3px solid var(--color-brand);
  color: var(--color-text-secondary);
  line-height: 1.8;
  font-size: var(--font-size-md);
}

.quote-mark {
  color: var(--color-brand);
  font-weight: 600;
}

.welcome-bear {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 112px;
  height: 112px;
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-sm);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
}

.quick-head h2 {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-xl);
}

/* 区块标题旁的几何点缀：圆点 + 圆环（单卡片仅此一处，低干扰） */
.head-deco {
  position: relative;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--color-brand-soft);
  border: 3px solid var(--color-brand-200);
  flex-shrink: 0;
}

.quick-head p {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
}

.quick-grid {
  margin-top: var(--space-4);
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--space-3);
}

.quick-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  text-decoration: none;
  transition: background-color var(--transition-fast), border-color var(--transition-fast),
    transform var(--transition-fast);
}

.quick-entry:hover {
  background: var(--color-brand-soft);
  border-color: var(--color-brand-200);
  transform: translateY(-2px);
}

.quick-icon {
  font-size: var(--font-size-2xl);
  line-height: 1.2;
}

.quick-name {
  margin-top: var(--space-1);
  font-weight: 600;
  color: var(--color-text);
}

.quick-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

@media (max-width: 1100px) {
  .stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 620px) {
  .stats {
    grid-template-columns: 1fr;
  }

  .welcome {
    flex-direction: column;
  }

  .quick-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
