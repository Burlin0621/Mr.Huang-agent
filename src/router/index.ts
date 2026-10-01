import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

import AgentsView from '@/views/AgentsView.vue'
import ChatView from '@/views/ChatView.vue'
import DashboardView from '@/views/DashboardView.vue'
import GroupChatView from '@/views/GroupChatView.vue'
import PromptsView from '@/views/PromptsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import SkillsView from '@/views/SkillsView.vue'
import TasksView from '@/views/TasksView.vue'
import TodayTopicsView from '@/views/TodayTopicsView.vue'
import VaultView from '@/views/VaultView.vue'
import WechatWritingView from '@/views/WechatWritingView.vue'
import XhsWritingView from '@/views/XhsWritingView.vue'

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
    // :conversationId 可选：不带 id 为「新对话草稿」态，带 id 打开会话工作区中的指定对话
    path: '/chat/:conversationId?',
    name: 'chat',
    component: ChatView,
    meta: { title: 'AI 对话' },
  },
  {
    path: '/group-chat',
    name: 'group-chat',
    component: GroupChatView,
    meta: { title: '群聊协作' },
  },
  {
    path: '/wechat-writing',
    name: 'wechat-writing',
    component: WechatWritingView,
    meta: { title: '公众号写作' },
  },
  {
    path: '/xhs-writing',
    name: 'xhs-writing',
    component: XhsWritingView,
    meta: { title: '小红书写作' },
  },
  {
    path: '/today-topics',
    name: 'today-topics',
    component: TodayTopicsView,
    meta: { title: '今日选题' },
  },
  {
    path: '/agents',
    name: 'agents',
    component: AgentsView,
    meta: { title: '智能体中心' },
  },
  {
    path: '/skills',
    name: 'skills',
    component: SkillsView,
    meta: { title: '技能中心' },
  },
  {
    path: '/prompts',
    name: 'prompts',
    component: PromptsView,
    meta: { title: '提示词库' },
  },
  {
    path: '/vault',
    name: 'vault',
    component: VaultView,
    meta: { title: '笔记库' },
  },
  {
    path: '/tasks',
    name: 'tasks',
    component: TasksView,
    meta: { title: '任务中心' },
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
