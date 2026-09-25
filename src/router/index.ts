import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

import DashboardView from '@/views/DashboardView.vue'
import DataCenterView from '@/views/DataCenterView.vue'
import SettingsView from '@/views/SettingsView.vue'
import TasksView from '@/views/TasksView.vue'

declare module 'vue-router' {
  interface RouteMeta {
    /** 页面标题：用于顶栏面包屑与浏览器标签页标题 */
    title: string
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'dashboard',
    component: DashboardView,
    meta: { title: '工作台' },
  },
  {
    path: '/tasks',
    name: 'tasks',
    component: TasksView,
    meta: { title: '任务中心' },
  },
  {
    path: '/data',
    name: 'data-center',
    component: DataCenterView,
    meta: { title: '数据中心' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsView,
    meta: { title: '设置' },
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    redirect: '/',
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.afterEach((to) => {
  document.title = `${to.meta.title} · Mr.Huang Agent`
})

export default router
