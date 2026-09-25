<script setup lang="ts">
import AppIcon from '@/components/AppIcon.vue'
import EmptyState from '@/components/EmptyState.vue'
</script>

<template>
  <div class="page">
    <header class="page-head">
      <h1>数据中心</h1>
      <p>统一管理数据源、数据同步与访问凭据。</p>
    </header>

    <section class="card" aria-label="数据源列表（占位）">
      <EmptyState
        title="暂无数据源"
        description="数据中心模块建设中，开放后可在这里接入与管理数据源。"
      >
        <button class="btn btn-primary" type="button" disabled>
          <AppIcon name="data" />
          接入数据源（即将开放）
        </button>
      </EmptyState>
    </section>
  </div>
</template>
