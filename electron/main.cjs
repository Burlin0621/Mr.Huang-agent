/**
 * Electron 主进程（免打包调试窗口 + 生产加载 + LLM 转发）。
 *
 * 职责：
 * 1. 生产构建（app.isPackaged）加载 dist/index.html；开发模式以子进程方式启动
 *    Vite dev server（固定 localhost:5173），输出透传到终端；5173 已被占用则直接复用。
 * 2. 等待 5173 就绪后创建 BrowserWindow 并加载页面，代码热更新照常生效。
 * 3. 窗口关闭时杀掉 Vite 子进程并退出 app。
 * 4. 通过 IPC 暴露系统目录选择对话框，供 preload 桥接（mrHuangDesktop.selectFolder）。
 * 5. LLM 转发（解决生产环境 CORS）：渲染进程发 'llm:forward'，主进程用 fetch 转发到
 *    厂商 API，SSE 流式响应经 'llm:chunk' 逐块推回；'llm:abort' 触发主进程侧 abort。
 * 6. 工具调用统一入口 'tool:call'（注册表见 electron/tools.cjs）。
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')

const { registerToolIpc } = require('./tools.cjs')
const { registerCheckpointIpc } = require('./checkpoints.cjs')
const { registerVaultIpc } = require('./vault.cjs')
const { registerMemoryIpc } = require('./memory-store.cjs')
const { initMcp, registerMcpIpc, shutdownMcp } = require('./mcp.cjs')
const { cleanupOnQuit } = require('./browser.cjs')

const DEV_SERVER_PORT = 5173
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`
/** 就绪等待超时：给 Vite 冷启动留足时间 */
const DEV_SERVER_TIMEOUT_MS = 60_000

/** Vite 子进程句柄（null 表示复用了外部已运行的 dev server，不负责回收） */
let viteProcess = null
/** 主动退出时置 true，避免窗口 close 事件里重复清理 */
let quitting = false

/**
 * 探测端口是否可连（等价 wait-on tcp 的单次检查）。
 * Node 在部分 Windows 环境只把 "localhost" 绑定到 IPv6 ::1，
 * 因此同时探测 127.0.0.1 与 ::1，任一可连即视为就绪。
 */
function isPortOpen(port, timeoutMs = 1_000) {
  const hosts = ['127.0.0.1', '::1']
  return Promise.all(
    hosts.map(
      (host) =>
        new Promise((resolve) => {
          const socket = new net.Socket()
          const finish = (open) => {
            socket.destroy()
            resolve(open)
          }
          socket.setTimeout(timeoutMs)
          socket.once('connect', () => finish(true))
          socket.once('timeout', () => finish(false))
          socket.once('error', () => finish(false))
          socket.connect(port, host)
        }),
    ),
  ).then((results) => results.some(Boolean))
}

/** 轮询等待 dev server 就绪 */
async function waitForDevServer(timeoutMs = DEV_SERVER_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isPortOpen(DEV_SERVER_PORT)) return true
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/** 启动 Vite dev server 子进程，输出透传到当前终端 */
function startViteDevServer() {
  const projectRoot = path.join(__dirname, '..')
  // 统一用 npm run dev 走 package.json scripts，行为与 启动调试.bat 完全一致
  const child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm run dev'], {
    cwd: projectRoot,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stdout.on('data', (chunk) => process.stdout.write(chunk))
  child.stderr.on('data', (chunk) => process.stderr.write(chunk))
  child.on('error', (err) => {
    console.error('[desktop] 无法启动 Vite dev server:', err.message)
  })
  child.on('exit', (code) => {
    if (!quitting) console.error(`[desktop] Vite dev server 提前退出（code=${code ?? 'unknown'}）`)
  })
  return child
}

/** 杀掉 Vite 子进程树（cmd.exe 会再起 npm/node 子进程，必须整树结束） */
function stopViteDevServer() {
  if (!viteProcess || viteProcess.exitCode !== null) return
  try {
    // Windows 下 taskkill /T 结束整棵进程树，/F 强制
    spawn('taskkill', ['/pid', String(viteProcess.pid), '/T', '/F'], { windowsHide: true })
  } catch (err) {
    console.error('[desktop] 结束 Vite 子进程失败:', err instanceof Error ? err.message : err)
  }
  viteProcess = null
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Mr.Huang Agent',
    // 无边框：隐藏系统标题栏，Windows 下保留原生窗口控制按钮覆盖层
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#1f2937',
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  // 页面自身会设置 document.title，避免窗口标题被覆盖成 URL
  win.on('page-title-updated', (event) => event.preventDefault())
  win.loadURL(DEV_SERVER_URL).catch((err) => {
    console.error('[desktop] 加载页面失败:', err instanceof Error ? err.message : err)
  })
  return win
}

/** 生产模式：加载打包产物 dist/index.html */
function createProductionWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Mr.Huang Agent',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#1f2937',
      height: 40,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  win.on('page-title-updated', (event) => event.preventDefault())
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html')).catch((err) => {
    console.error('[desktop] 加载生产页面失败:', err instanceof Error ? err.message : err)
  })
  return win
}

/** 主题 → 原生窗口按钮（titleBarOverlay）配色：与 src/styles/tokens.css 的 bg/文字保持一致 */
const OVERLAY_THEMES = {
  light: { color: '#fffefc', symbolColor: '#1c1917' },
  dark: { color: '#161311', symbolColor: '#f0ece7' },
}

/** 注册 title-bar:overlay IPC：渲染进程主题变化时同步原生窗口按钮配色（仅 Windows 生效） */
let titleBarOverlayRegistered = false
function registerTitleBarOverlayIpc() {
  if (titleBarOverlayRegistered) return
  titleBarOverlayRegistered = true
  ipcMain.on('title-bar:overlay', (event, theme) => {
    const colors = theme === 'dark' ? OVERLAY_THEMES.dark : OVERLAY_THEMES.light
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (win && typeof win.setTitleBarOverlay === 'function') {
        win.setTitleBarOverlay({ ...colors, height: 40 })
      }
    } catch (err) {
      // setTitleBarOverlay 仅 Windows 支持，其他平台（macOS/Linux）静默忽略
      console.error('[desktop] setTitleBarOverlay 失败:', err instanceof Error ? err.message : err)
    }
  })
}

async function main() {
  // 去掉默认的 File/Edit/View/Window 菜单栏
  Menu.setApplicationMenu(null)

  // 生产构建：直接加载 dist 产物，不启动 dev server
  if (app.isPackaged) {
    createProductionWindow()
    registerForwardingIpc()
    registerTitleBarOverlayIpc()
    registerToolIpc(ipcMain)
    registerCheckpointIpc(ipcMain)
    registerVaultIpc(ipcMain)
    registerMemoryIpc(ipcMain)
    registerMcpIpc(ipcMain)
    void initMcp()
    return
  }

  const devReady = await isPortOpen(DEV_SERVER_PORT)
  if (!devReady) {
    console.log(`[desktop] 未检测到已运行的 dev server，正在启动 Vite（${DEV_SERVER_URL}）...`)
    viteProcess = startViteDevServer()
  } else {
    console.log('[desktop] 检测到 5173 端口已有 dev server，直接复用。')
  }

  const ready = await waitForDevServer()
  if (!ready) {
    console.error(`[desktop] 等待 ${DEV_SERVER_URL} 就绪超时，请确认 Vite 能正常启动后重试。`)
    app.quit()
    return
  }

  createWindow()
  registerForwardingIpc()
  registerTitleBarOverlayIpc()
  registerToolIpc(ipcMain)
  registerCheckpointIpc(ipcMain)
  registerVaultIpc(ipcMain)
  registerMemoryIpc(ipcMain)
  registerMcpIpc(ipcMain)
  // 启动时对已启用的 MCP 服务器逐个连接（异步、失败不阻塞窗口创建）
  void initMcp()
}

/* —— LLM 转发：渲染进程 → 主进程 → 厂商 API（解决生产 CORS） —— */

/** 进行中的转发请求：requestId → AbortController（供 'llm:abort' 取消） */
const activeForwards = new Map()

/** 注册 llm:forward / llm:abort IPC（幂等：只注册一次） */
let forwardingRegistered = false
function registerForwardingIpc() {
  if (forwardingRegistered) return
  forwardingRegistered = true

  // payload: { url, method?, headers, body, timeoutSeconds }
  ipcMain.on('llm:forward', async (event, requestId, payload) => {
    const sender = event.sender
    const send = (chunk) => {
      if (!sender.isDestroyed()) sender.send('llm:chunk', { requestId, ...chunk })
    }
    if (typeof requestId !== 'string' || !payload || typeof payload.url !== 'string') {
      send({ done: true, ok: false, errorKind: 'invalid', message: '转发请求参数不完整' })
      return
    }

    const controller = new AbortController()
    activeForwards.set(requestId, controller)
    const timeoutMs = Math.max(1, Number(payload.timeoutSeconds) || 120) * 1000
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(payload.url, {
        method: payload.method || 'POST',
        headers: payload.headers || {},
        body: payload.method === 'GET' ? undefined : payload.body,
        signal: controller.signal,
        redirect: 'follow',
      })

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '')
        send({ done: true, ok: false, status: response.status, body: bodyText.slice(0, 4000) })
        return
      }

      if (!response.body) {
        send({ done: true, ok: false, errorKind: 'parse', message: '响应不包含可读取的流' })
        return
      }

      // SSE/普通响应体逐块推回（保留原始分块边界，由渲染进程统一缓冲解析）
      const decoder = new TextDecoder('utf-8')
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          send({ text: decoder.decode(value, { stream: true }) })
        }
        const tail = decoder.decode()
        if (tail) send({ text: tail })
      } finally {
        reader.releaseLock()
      }
      send({ done: true, ok: true, status: response.status })
    } catch (err) {
      const aborted = controller.signal.aborted
      const message = err instanceof Error ? err.message : String(err)
      if (aborted && activeForwards.get(requestId)?.userAborted) {
        send({ done: true, ok: false, errorKind: 'aborted', message: '已停止生成' })
      } else if (aborted) {
        send({ done: true, ok: false, errorKind: 'timeout', message: String(Math.round(timeoutMs / 1000)) })
      } else {
        send({ done: true, ok: false, errorKind: 'network', message })
      }
    } finally {
      clearTimeout(timer)
      activeForwards.delete(requestId)
    }
  })

  ipcMain.on('llm:abort', (event, requestId) => {
    const controller = activeForwards.get(requestId)
    if (controller) {
      controller.userAborted = true
      controller.abort()
    }
  })
}

app.on('window-all-closed', () => {
  quitting = true
  stopViteDevServer()
  app.quit()
})

app.on('before-quit', () => {
  quitting = true
  stopViteDevServer()
})

// 应用退出前关闭内置浏览器（若已懒启动），避免残留 Chrome/Edge 子进程；
// 同时关闭全部 MCP 连接（终止 stdio 子进程）
app.on('will-quit', () => {
  cleanupOnQuit().catch(() => {
    // 退出阶段尽力清理，失败不再阻断退出
  })
  shutdownMcp().catch(() => {
    // 同上：MCP 连接关闭失败不阻断退出
  })
})

// 目录选择：与 src/lib/desktop-bridge.ts 的契约一致（取消/未选返回 null）
ipcMain.handle('select-folder', async () => {
  const win = BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: '选择文件夹',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

/**
 * HTML 预览：写入系统临时目录后用 shell.openPath 以系统默认浏览器打开。
 * 为什么走主进程：本应用 Electron 环境渲染进程的 window.open 不可用
 * （页面报 "TypeError: window.open is not a function"），Blob URL 方案在桌面端走不通。
 * 始终 resolve（{ ok, error? }）不 reject，错误文案由渲染层 toast 展示。
 */
ipcMain.handle('preview:open-html', async (_event, fileName, content) => {
  try {
    if (typeof content !== 'string') return { ok: false, error: '内容无效' }
    // 文件名清洗：去掉路径分隔符与 Windows 非法字符（防路径注入/穿越），空或非字符串回退固定名
    const cleaned = typeof fileName === 'string' ? fileName.replace(/[/\\:*?"<>|]/g, '') : ''
    const trimmed = cleaned.trim()
    const safeName = trimmed || 'html-preview'
    const finalName = safeName.toLowerCase().endsWith('.html') ? safeName : `${safeName}.html`
    const filePath = path.join(app.getPath('temp'), finalName)
    fs.writeFileSync(filePath, content, 'utf8')
    // openPath 返回空串表示成功，否则为错误信息（如未关联默认浏览器）
    const openError = await shell.openPath(filePath)
    return openError ? { ok: false, error: openError } : { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
})

/* —— 通用 KV 文件持久化：userData/storage/<key>.json，临时文件 + rename 原子写 —— */

/** KV 存储目录（app ready 前调用 getPath('userData') 亦可用） */
const KV_STORAGE_DIR = path.join(app.getPath('userData'), 'storage')

function ensureKvStorageDir() {
  fs.mkdirSync(KV_STORAGE_DIR, { recursive: true })
}

/** key → 文件名：仅保留安全字符，其余替换为 '-'（同时阻断路径穿越） */
function kvFilePath(key) {
  const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '-')
  return path.join(KV_STORAGE_DIR, `${safe}.json`)
}

/**
 * 读取单个 key；不存在/损坏/不匹配返回 null。
 * 文件内容为 { k: 原始 key, v: 值 }——文件名经过安全字符替换，
 * 原始 key 存在内容里以保证往返一致。
 */
ipcMain.handle('kv:get', (_event, key) => {
  if (typeof key !== 'string') return null
  try {
    const parsed = JSON.parse(fs.readFileSync(kvFilePath(key), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || parsed.k !== key) return null
    return parsed.v ?? null
  } catch {
    return null
  }
})

/** 写入单个 key：先写临时文件再 rename，避免半截文件 */
ipcMain.handle('kv:set', (_event, key, value) => {
  if (typeof key !== 'string') throw new Error('kv:key 必须是字符串')
  ensureKvStorageDir()
  const target = kvFilePath(key)
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ k: key, v: value }), 'utf8')
  fs.renameSync(tmp, target)
  return true
})

/** 删除单个 key（不存在时静默成功） */
ipcMain.handle('kv:delete', (_event, key) => {
  if (typeof key !== 'string') return false
  try {
    fs.rmSync(kvFilePath(key), { force: true })
  } catch {
    // 尽力删除，失败不阻断
  }
  return true
})

/** 列出全部原始 key（前缀过滤在渲染层做）；损坏文件跳过 */
ipcMain.handle('kv:keys', () => {
  try {
    ensureKvStorageDir()
    const keys = []
    for (const name of fs.readdirSync(KV_STORAGE_DIR)) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(fs.readFileSync(path.join(KV_STORAGE_DIR, name), 'utf8'))
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.k === 'string') {
          keys.push(parsed.k)
        }
      } catch {
        // 单个文件损坏时跳过，不影响其余 key
      }
    }
    return keys
  } catch {
    return []
  }
})

main().catch((err) => {
  console.error('[desktop] 启动失败:', err instanceof Error ? err.message : err)
  stopViteDevServer()
  app.quit()
})
