<script setup lang="ts">
import StatCard from '@/components/StatCard.vue'

const today = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'long',
}).format(new Date())

const stats = [
  { label: '今日任务', value: '0', note: '任务模块建设中' },
  { label: '已完成', value: '0', note: '暂无统计数据' },
  { label: '接入数据源', value: '0', note: '数据中心建设中' },
  { label: '活跃模块', value: '0', note: '敬请期待' },
]

const modules = [
  { name: '任务编排', desc: '按流程串联提示词、工具与数据源，自动执行多步任务', stage: '建设中' },
  { name: '数据接入', desc: '统一管理数据源、同步任务与访问凭据', stage: '规划中' },
  { name: '提示词库', desc: '沉淀并复用高质量提示词模板', stage: '规划中' },
  { name: '权限与成员', desc: '多角色协作与操作审计', stage: '规划中' },
]
</script>

<template>
  <div class="page">
    <section class="welcome card" aria-labelledby="welcome-title">
      <div class="welcome-text">
        <p class="welcome-date">{{ today }}</p>
        <h1 id="welcome-title">欢迎使用 Mr.Huang Agent</h1>
        <p class="welcome-desc">
          这是工程骨架版本（v0.1.0）：整体布局、导航、路由与主题系统已就绪，业务功能模块将按迭代计划陆续接入。
        </p>
      </div>
      <span class="badge badge-info welcome-badge">骨架预览</span>
    </section>

    <section class="stats" aria-label="统计概览（占位）">
      <StatCard
        v-for="item in stats"
        :key="item.label"
        :label="item.label"
        :value="item.value"
        :note="item.note"
      />
    </section>

    <section class="card" aria-labelledby="building-title">
      <header class="building-head">
        <h2 id="building-title">模块建设中</h2>
        <p>以下模块已列入迭代计划，当前先以占位形式呈现：</p>
      </header>
      <ul class="building-list">
        <li v-for="item in modules" :key="item.name" class="building-item">
          <span class="building-name">{{ item.name }}</span>
          <span class="building-desc">{{ item.desc }}</span>
          <span class="badge" :class="item.stage === '建设中' ? 'badge-warn' : 'badge-muted'">
            {{ item.stage }}
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.welcome {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
  background: linear-gradient(135deg, var(--color-brand-soft), var(--color-surface) 60%);
}

.welcome-date {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.welcome-text h1 {
  margin-top: var(--space-2);
  font-size: var(--font-size-2xl);
  font-weight: 700;
}

.welcome-desc {
  margin-top: var(--space-2);
  max-width: 560px;
  color: var(--color-text-secondary);
  line-height: 1.8;
}

.welcome-badge {
  flex-shrink: 0;
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4);
}

.building-head h2 {
  font-size: var(--font-size-xl);
}

.building-head p {
  margin-top: var(--space-1);
  color: var(--color-text-secondary);
}

.building-list {
  margin-top: var(--space-4);
}

.building-item {
  display: flex;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4) 0;
  border-top: 1px dashed var(--color-border);
}

.building-item:first-child {
  border-top: 0;
  padding-top: var(--space-2);
}

.building-name {
  min-width: 96px;
  font-weight: 600;
}

.building-desc {
  flex: 1;
  color: var(--color-text-secondary);
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

  .building-item {
    flex-wrap: wrap;
  }
}
</style>
