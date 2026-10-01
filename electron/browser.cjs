/**
 * 主进程「浏览器操控」模块（基于 playwright-core）。
 *
 * 设计要点：
 * 1. 不下载浏览器二进制，通过 channel 复用用户本机已安装的 Chrome/Edge；
 *    channel 启动失败时按 Windows 常见安装路径做 executablePath 回退探测。
 * 2. 懒启动单例：首次调用工具时才启动浏览器；单页复用（一次只维护一个 Page）。
 * 3. 无头模式默认开启，可用环境变量 MRHUANG_BROWSER_HEADLESS=0 切换有头便于调试。
 * 4. 操作统一超时（30 秒）；浏览器崩溃 / 连接断开时自动重置内部状态，下次调用懒启动自恢复。
 * 5. 所有异常转换为中文错误信息抛出，由 tools.cjs 统一回传给模型。
 */
/* global document, location */
// 说明：readPage 中 page.evaluate 的回调实际运行在浏览器页面上下文，因此需要 document/location 全局声明。
const fs = require('node:fs')

/** 浏览器启动与页面操作的超时（毫秒） */
const BROWSER_TIMEOUT_MS = 30_000
/** 正文文本与链接列表的安全上限（防止超大页面拖垮 IPC） */
const MAX_TEXT_CHARS = 60_000
const MAX_LINKS = 50

/** 无头开关：默认无头；MRHUANG_BROWSER_HEADLESS=0 时有头（调试用） */
function isHeadless() {
  return process.env.MRHUANG_BROWSER_HEADLESS !== '0'
}

/**
 * Windows 常见 Chrome/Edge 安装路径（executablePath 回退探测用）。
 * 顺序即探测顺序：Chrome 优先，Edge 兜底。
 */
const FALLBACK_EXECUTABLES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)

/** 当前浏览器启动 Promise（null 表示未启动；复用即"懒启动单例"） */
let browserPromise = null
/** 当前复用的页面（null 表示尚未创建或已失效） */
let currentPage = null

/** 重置内部状态（浏览器断开/崩溃/关闭后调用），下次调用将重新懒启动 */
function resetState() {
  browserPromise = null
  currentPage = null
}

/** 把 playwright 的常见异常翻译为中文提示 */
function toChineseError(err) {
  const raw = err instanceof Error ? err.message : String(err)
  if (/net::ERR_NAME_NOT_RESOLVED/i.test(raw)) return '域名解析失败，请检查网址是否正确（' + raw + '）'
  if (/net::ERR_CONNECTION_REFUSED/i.test(raw)) return '目标网站拒绝连接，服务可能未启动或被防火墙拦截（' + raw + '）'
  if (/net::ERR_CONNECTION_TIMED_OUT|net::ERR_TIMED_OUT/i.test(raw)) return '连接目标网站超时，请稍后重试（' + raw + '）'
  if (/net::ERR_CERT/i.test(raw)) return '目标网站证书异常（' + raw + '）'
  if (/net::ERR_ABORTED/i.test(raw)) return '导航被目标网站中止，可尝试改用 http_get 工具（' + raw + '）'
  if (err instanceof Error && err.name === 'TimeoutError') return `浏览器操作超时（${BROWSER_TIMEOUT_MS / 1000} 秒）`
  if (/Failed to launch|browserType\.launch/i.test(raw)) {
    return (
      '无法启动本机浏览器（' + raw + '）。' +
      '请确认已安装 Google Chrome 或 Microsoft Edge；若未安装，请安装其一后重试。'
    )
  }
  return raw
}

/** executablePath 回退探测：按常见安装路径找本机已装的 Chrome/Edge */
function findFallbackExecutable() {
  for (const candidate of FALLBACK_EXECUTABLES) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // 探测失败继续尝试下一个路径
    }
  }
  return null
}

/** 启动浏览器：channel 优先（chrome → msedge），失败后 executablePath 路径探测兜底 */
async function launchBrowser() {
  const { chromium } = require('playwright-core')
  const baseOptions = { headless: isHeadless(), timeout: BROWSER_TIMEOUT_MS }
  const attempts = [
    { label: 'channel: chrome', options: { ...baseOptions, channel: 'chrome' } },
    { label: 'channel: msedge', options: { ...baseOptions, channel: 'msedge' } },
  ]
  const fallbackPath = findFallbackExecutable()
  if (fallbackPath) {
    attempts.push({ label: `executablePath: ${fallbackPath}`, options: { ...baseOptions, executablePath: fallbackPath } })
  }

  const failures = []
  for (const attempt of attempts) {
    try {
      const browser = await chromium.launch(attempt.options)
      // 连接断开（崩溃 / 被外部关闭）时重置状态，下次调用懒启动自恢复
      browser.on('disconnected', () => resetState())
      return browser
    } catch (err) {
      failures.push(`${attempt.label}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(
    '未能启动本机浏览器。请安装 Google Chrome 或 Microsoft Edge 后重试。各启动方式失败原因：' +
      failures.join('；'),
  )
}

/** 获取（懒启动）浏览器单例；启动失败时清空缓存以便下次重试 */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err) => {
      browserPromise = null
      throw err
    })
  }
  return browserPromise
}

/** 获取复用页面；页面已关闭/崩溃时在现有浏览器里新开一页 */
async function getPage() {
  const browser = await getBrowser()
  if (currentPage && !currentPage.isClosed()) return currentPage
  try {
    currentPage = await browser.newPage()
  } catch (err) {
    // 上下文可能已随崩溃失效：重置整个浏览器后重试一次
    resetState()
    const fresh = await getBrowser()
    try {
      currentPage = await fresh.newPage()
    } catch (retryErr) {
      throw new Error(toChineseError(retryErr))
    }
    void err
  }
  currentPage.setDefaultTimeout(BROWSER_TIMEOUT_MS)
  currentPage.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS)
  // 页面崩溃时释放引用，下次调用重开新页（浏览器本身仍存活时无需重启）
  currentPage.once('crash', () => {
    currentPage = null
  })
  return currentPage
}

/**
 * 导航到指定 URL：先等待 networkidle，失败或超时则退回 domcontentloaded 兜底。
 * 返回 { title, url }。
 */
async function navigate(url) {
  // 双保险：tools.cjs 已校验协议，此处再拦一次，确保 file:/ftp: 等协议无法触达浏览器
  let protocol = ''
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error('URL 无法解析，请提供完整的 http(s) 地址')
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error(`仅支持 http/https 协议，收到：${protocol}`)
  }
  try {
    const page = await getPage()
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: BROWSER_TIMEOUT_MS })
    } catch {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS })
    }
    return { title: await page.title(), url: page.url() }
  } catch (err) {
    throw new Error(toChineseError(err))
  }
}

/**
 * 读取当前页面：标题 + 正文纯文本（在页面内剥离噪音标签后提取，保留换行结构）
 * + 链接列表。必须先成功 navigate 过；否则返回 null 由调用方转中文提示。
 */
async function readPage() {
  if (!currentPage || currentPage.isClosed()) return null
  try {
    const data = await currentPage.evaluate(
      ({ maxTextChars, maxLinks }) => {
        const NOISE_SELECTOR = 'script,style,noscript,nav,header,footer,aside,template,svg,canvas,form,button'
        const root = document.body || document.documentElement
        if (!root) return { title: document.title, url: location.href, text: '', links: [] }
        const clone = root.cloneNode(true)
        clone.querySelectorAll(NOISE_SELECTOR).forEach((el) => el.remove())
        const raw = (clone.innerText || clone.textContent || '')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n\s*\n+/g, '\n\n')
          .trim()
        const links = []
        const seen = new Set()
        clone.querySelectorAll('a[href]').forEach((a) => {
          const hrefAttr = a.getAttribute('href') || ''
          if (!hrefAttr || hrefAttr.startsWith('javascript:') || hrefAttr.startsWith('#')) return
          let absolute
          try {
            absolute = new URL(hrefAttr, location.href).href
          } catch {
            return
          }
          if (seen.has(absolute)) return
          seen.add(absolute)
          const label = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
          links.push(label ? `${label} → ${absolute}` : absolute)
          if (links.length >= maxLinks) return
        })
        return {
          title: document.title,
          url: location.href,
          text: raw.length > maxTextChars ? raw.slice(0, maxTextChars) : raw,
          links,
        }
      },
      { maxTextChars: MAX_TEXT_CHARS, maxLinks: MAX_LINKS },
    )
    return data
  } catch (err) {
    throw new Error(toChineseError(err))
  }
}

/**
 * 对当前页面截全页 PNG：宽度超过 1280 时先把视口收窄到 1280（防超大图），
 * 返回 { dataUrl, width, height }（dataUrl 形如 data:image/png;base64,...）。
 * 未打开页面时返回 null，由调用方转中文提示。
 */
async function screenshot() {
  if (!currentPage || currentPage.isClosed()) return null
  try {
    const size = await currentPage.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }))
    const targetWidth = Math.min(Math.max(size.width, 320), 1280)
    if (size.width > 1280) {
      await currentPage.setViewportSize({ width: targetWidth, height: 720 })
    }
    const buffer = await currentPage.screenshot({ fullPage: true, type: 'png' })
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`
    return { dataUrl, width: Math.min(size.width, 1280), height: size.height }
  } catch (err) {
    throw new Error(toChineseError(err))
  }
}

/** 关闭浏览器并释放资源；无实例时静默返回 */
async function closeBrowser() {
  const promise = browserPromise
  resetState()
  if (!promise) return
  try {
    const browser = await promise
    await browser.close()
  } catch {
    // 关闭失败无需提示：状态已重置，下次调用会重新懒启动
  }
}

/** 应用退出前的清理（app 'will-quit' 调用）：尽力关闭，不再抛错 */
async function cleanupOnQuit() {
  await closeBrowser()
}

module.exports = { navigate, readPage, screenshot, closeBrowser, cleanupOnQuit, BROWSER_TIMEOUT_MS }
