// 开发服务器自检脚本：等待 http://localhost:5173 就绪后，
// 校验返回 200 且 HTML 中包含应用挂载点与模块入口。
const base = process.argv[2] ?? 'http://localhost:5173/'

async function waitForServer(url, attempts = 20, delayMs = 500) {
  let lastError = null
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, { redirect: 'manual' })
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastError
}

const res = await waitForServer(base)
const html = await res.text()

const hasMount = html.includes('<div id="app"></div>')
const hasEntry = html.includes('/src/main.ts')

console.log('检查地址:', base)
console.log('HTTP 状态码:', res.status)
console.log('HTML 包含挂载点 <div id="app">:', hasMount)
console.log('HTML 包含模块入口 /src/main.ts:', hasEntry)

if (res.status !== 200 || !hasMount || !hasEntry) {
  process.exit(1)
}
