import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * 进行中的流式会话运行时状态（模块级单例，不持久化）。
 *
 * 独立于 ChatView 组件生命周期存在：用户离开对话页（路由切换）时组件卸载，
 * 但流式请求继续后台执行并实时写回 conversations store；重新进入页面时
 * 依据本 store 恢复「生成中」展示。仅用户主动点击停止（abort）或请求
 * 自然结束/出错时才会清理。
 */
export const useChatStreamStore = defineStore('chat-stream', () => {
  /** 按对话隔离的流式状态：conversationId → 该对话的 AbortController（多对话可并行生成） */
  const streamingMap = ref(new Map<string, AbortController>())
  /** 按对话记录本轮生成开始时刻：conversationId → 起始时间戳（与 streamingMap 同生命周期） */
  const streamStartMap = ref(new Map<string, number>())

  /** 当前仍在生成中的对话数（驱动计时器等全局副作用的启停） */
  const activeCount = computed(() => streamingMap.value.size)

  /** 开始一次流式生成：登记 controller 与起始时刻，返回供请求传入 signal */
  function start(conversationId: string): AbortController {
    const controller = new AbortController()
    streamingMap.value.set(conversationId, controller)
    streamStartMap.value.set(conversationId, Date.now())
    return controller
  }

  /** 结束一次流式生成（完成 / 出错 / 中止后的清理），只清理指定对话条目 */
  function finish(conversationId: string): void {
    streamingMap.value.delete(conversationId)
    streamStartMap.value.delete(conversationId)
  }

  /** 中止指定对话的流式生成；不存在时静默 */
  function abort(conversationId: string): void {
    streamingMap.value.get(conversationId)?.abort()
  }

  /** 指定对话是否正在流式生成 */
  function isStreaming(conversationId: string): boolean {
    return streamingMap.value.has(conversationId)
  }

  return { streamingMap, streamStartMap, activeCount, start, finish, abort, isStreaming }
})
