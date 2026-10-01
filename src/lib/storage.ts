/**
 * 统一持久化存储层：
 * - Electron 桌面端：经 IPC（kv-get / kv-set / kv-delete / kv-keys）把数据以
 *   JSON 文件写入主进程 userData/storage/<key>.json（临时文件 + rename 原子写），
 *   无 5MB 配额限制；渲染层持有内存快照，写入经短防抖合并成批量 IPC，避免高频调用。
 * - 纯浏览器模式（vite dev 无 Electron）：降级回 localStorage，行为与旧版一致。
 *
 * 启动时须先 await initStorage()（见 src/main.ts）再挂载应用：
 * initStorage 会把文件存储全量加载进内存，并把 localStorage 中旧前缀数据
 * 一次性迁移到文件存储（迁移成功后清理旧 key 并留标记）。
 *
 * 对外 API 与 localStorage 同构（同步）：storageGet / storageSet / storageRemove / storageKeys。
 */
import { hasKvBridge } from './desktop-bridge'

/** 本应用全部持久化 key 的统一前缀（沿用旧版 localStorage 前缀，便于迁移） */
const KEY_PREFIX = 'mr-huang-agent:'

/** 迁移完成标记 key（存于文件存储；带标记后不再迁移，只清理 localStorage 残留） */
const MIGRATED_FLAG_KEY = `${KEY_PREFIX}__file-migrated`

/** 写入防抖：合并窗口内的多次 set 为一次批量 IPC */
const FLUSH_DEBOUNCE_MS = 400

/** 是否处于 Electron 文件存储模式（initStorage 后确定） */
let electronMode = false

/** initStorage 是否已完成（完成前所有写入走 localStorage，迁移时可被拾起） */
let ready = false

/** 文件存储模式下的内存快照（key → 字符串值） */
const memory = new Map<string, string>()

/** 待落盘的脏数据（key → 新值；null 表示待删除） */
const dirty = new Map<string, string | null>()

let flushTimer: ReturnType<typeof setTimeout> | null = null
/** 串行化落盘：上一次 flush 未结束时新的 flush 排在其后 */
let flushChain: Promise<void> = Promise.resolve()

function bridge(): NonNullable<Window['mrHuangDesktop']> {
  return window.mrHuangDesktop as NonNullable<Window['mrHuangDesktop']>
}

function localStorageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined'
  } catch {
    return false
  }
}

/** 把 localStorage 中全部旧前缀 key 迁移到文件存储；成功后清理旧 key 并留标记 */
async function migrateFromLocalStorage(): Promise<void> {
  if (!localStorageAvailable()) return
  const legacy: Array<[string, string]> = []
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (!key || !key.startsWith(KEY_PREFIX) || key === MIGRATED_FLAG_KEY) continue
    const value = localStorage.getItem(key)
    if (value !== null) legacy.push([key, value])
  }
  const alreadyMigrated = memory.get(MIGRATED_FLAG_KEY) === '1'
  if (!alreadyMigrated) {
    for (const [key, value] of legacy) {
      memory.set(key, value)
      await bridge().kvSet!(key, value)
    }
    memory.set(MIGRATED_FLAG_KEY, '1')
    await bridge().kvSet!(MIGRATED_FLAG_KEY, '1')
  }
  // 无论是否首次迁移，都清理 localStorage 中的旧前缀残留（幂等）
  for (let i = localStorage.length - 1; i >= 0; i -= 1) {
    const key = localStorage.key(i)
    if (key && key.startsWith(KEY_PREFIX)) localStorage.removeItem(key)
  }
}

/** 初始化存储层：桌面端全量加载文件存储进内存并执行一次性迁移；须在挂载应用前 await */
export async function initStorage(): Promise<void> {
  if (ready) return
  ready = true
  if (!hasKvBridge()) return
  electronMode = true
  try {
    const keys = await bridge().kvKeys!()
    await Promise.all(
      keys.map(async (key) => {
        const value = await bridge().kvGet!(key)
        if (value !== null) memory.set(key, value)
      }),
    )
    await migrateFromLocalStorage()
  } catch (err) {
    // 加载/迁移失败不阻断启动：内存中已有部分数据，后续写入尽力落盘
    console.warn('[storage] 文件存储初始化失败，降级为内存模式：', err)
  }
  // 窗口隐藏（最小化/切换）时立即冲刷，降低异常退出丢数据窗口
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushNow()
  })
}

/** 立即把全部脏数据落盘（串行执行，避免与进行中的 flush 交错） */
export function flushNow(): Promise<void> {
  if (!electronMode || dirty.size === 0) return flushChain
  const entries = [...dirty.entries()]
  dirty.clear()
  flushChain = flushChain.then(async () => {
    for (const [key, value] of entries) {
      try {
        if (value === null) await bridge().kvDelete!(key)
        else await bridge().kvSet!(key, value)
      } catch {
        // 单条落盘失败静默跳过（下次写入会重试该 key）
      }
    }
  })
  return flushChain
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow()
  }, FLUSH_DEBOUNCE_MS)
}

/** 读取（同步；文件存储模式读内存快照，浏览器模式读 localStorage） */
export function storageGet(key: string): string | null {
  if (electronMode) return memory.has(key) ? (memory.get(key) as string) : null
  if (!localStorageAvailable()) return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

/** 写入（同步生效；文件存储模式下进内存 + 防抖批量落盘） */
export function storageSet(key: string, value: string): void {
  if (electronMode) {
    memory.set(key, value)
    dirty.set(key, value)
    scheduleFlush()
    return
  }
  if (!localStorageAvailable()) return
  try {
    localStorage.setItem(key, value)
  } catch {
    // localStorage 不可用（配额满等）时静默降级，仅当前会话生效
  }
}

/** 删除（同步生效） */
export function storageRemove(key: string): void {
  if (electronMode) {
    memory.delete(key)
    dirty.set(key, null)
    scheduleFlush()
    return
  }
  if (!localStorageAvailable()) return
  try {
    localStorage.removeItem(key)
  } catch {
    // 忽略
  }
}

/** 列出全部持久化 key（可传前缀过滤），无顺序保证 */
export function storageKeys(prefix = ''): string[] {
  const all = electronMode
    ? [...memory.keys()]
    : localStorageAvailable()
      ? Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? '').filter(Boolean)
      : []
  return all.filter((key) => key.startsWith(prefix))
}
