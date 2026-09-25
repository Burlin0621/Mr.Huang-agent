<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>任务中心</h1>
      <p>创建、跟踪并归档你的任务，支持按流程自动执行。</p>
    </header>

    <section class="card" aria-label="任务列表（占位）">
      <EmptyState
        title="暂无任务"
        description="任务中心模块建设中，开放后可在这里创建、分派与跟踪任务。"
      >
        <button class="btn btn-primary" type="button" disabled>
          <AppIcon name="plus" />
          新建任务（即将开放）
        </button>
      </EmptyState>
    </section>
  </div>
</template>
