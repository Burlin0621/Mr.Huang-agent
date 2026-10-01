/**
 * 终端命令执行工具（shell_exec 的主进程实现，由 electron/tools.cjs 注册 handler 时调用）。
 *
 * - Windows 下用 child_process.spawn 走 `cmd.exe /d /s /c <command>`（贴近用户日常习惯）；
 * - cwd 锁定在工作区关联文件夹内：复用 vault.cjs 的 resolveWithin 防路径逃逸，
 *   工作区未关联文件夹时抛中文错误；
 * - 超时（1000–300000ms，默认 60000）到时用 `taskkill /pid <pid> /T /F` 终止整个进程树；
 * - stdout/stderr 按 Buffer 收集后解码：优先 UTF-8，若含大量替换符（\uFFFD）则用
 *   iconv-lite 按 GBK 兜底（Windows cmd 中文输出常见 GBK）；
 * - 返回给模型的是固定格式文本（退出码 + stdout + stderr），整体截断到 8000 字符，
 *   避免长日志撑爆上下文；不注入环境变量、不回显命令本身（确认弹窗里已有）。
 */
const { spawn, execFile } = require('node:child_process')
const vault = require('./vault.cjs')

/** 返回给模型的 shell 输出文本上限（字符数） */
const SHELL_OUTPUT_MAX_CHARS = 8000
/** 默认超时（毫秒） */
const SHELL_DEFAULT_TIMEOUT_MS = 60_000
/** 超时下限/上限（毫秒） */
const SHELL_MIN_TIMEOUT_MS = 1000
const SHELL_MAX_TIMEOUT_MS = 300_000
/** 单流（stdout/stderr）收集上限，防止超长输出占用内存 */
const STREAM_CAPTURE_BYTES = 1024 * 1024

/** 把输出截断到 shell 上限，并标注已截断 */
function truncateShellOutput(text) {
  if (text.length <= SHELL_OUTPUT_MAX_CHARS) return text
  return `${text.slice(0, SHELL_OUTPUT_MAX_CHARS)}\n\n[输出超过 ${SHELL_OUTPUT_MAX_CHARS} 字符，已截断：原始长度 ${text.length} 字符]`
}

/**
 * 按 Buffer 解码输出：优先 UTF-8；若替换符（\uFFFD）占比明显偏高，
 * 用 iconv-lite 按 GBK 解码兜底（仅在 GBK 结果替换符更少时采用）。
 */
function decodeOutput(buf) {
  const utf8 = buf.toString('utf-8')
  if (buf.length === 0) return utf8
  const utf8Bad = (utf8.match(/\uFFFD/g) || []).length
  // 无明显替换符或替换符极少时直接用 UTF-8
  if (utf8Bad === 0 || utf8Bad / utf8.length < 0.01) return utf8
  try {
    // 可选依赖：仅在 GBK 兜底时加载
    const iconv = require('iconv-lite')
    const gbk = iconv.decode(buf, 'gbk')
    const gbkBad = (gbk.match(/\uFFFD/g) || []).length
    if (gbkBad < utf8Bad) return gbk
  } catch {
    // iconv-lite 不可用时静默回退 UTF-8
  }
  return utf8
}

/** 解析并校验工作目录：cwd 为工作区内相对路径，缺省为工作区根；逃逸/未关联文件夹时报错 */
function resolveShellCwd(workspaceRoot, cwdArg) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new Error('当前工作区未关联文件夹，请先在工作区设置中关联文件夹后再执行终端命令')
  }
  return vault.resolveWithin(workspaceRoot, typeof cwdArg === 'string' ? cwdArg : '')
}

/** 解析并钳制超时：1000–300000ms，缺省 60000，非法值回退默认 */
function parseShellTimeout(timeoutArg) {
  if (typeof timeoutArg !== 'number' || !Number.isFinite(timeoutArg)) {
    return SHELL_DEFAULT_TIMEOUT_MS
  }
  return Math.min(Math.max(Math.trunc(timeoutArg), SHELL_MIN_TIMEOUT_MS), SHELL_MAX_TIMEOUT_MS)
}

/** Windows 下终止整个进程树：taskkill /T /F，失败再退回 child.kill() */
function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child.pid) {
      resolve()
      return
    }
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      try {
        child.kill()
      } catch {
        // 进程已退出时忽略
      }
      resolve()
    })
  })
}

/** 空文本占位 */
function orEmpty(text) {
  return text.trim() ? text : '（空）'
}

/**
 * 执行一条 shell 命令并返回格式化文本（退出码 + stdout + stderr）。
 * @param {string} command 要执行的命令（非空）
 * @param {string|undefined} cwdArg 工作区内相对路径（缺省为工作区根）
 * @param {number|undefined} timeoutArg 超时毫秒（1000–300000，默认 60000）
 * @param {string|undefined} workspaceRoot 工作区关联文件夹绝对路径
 * @returns {Promise<string>} 格式化输出（已截断到 8000 字符）
 */
async function runShellCommand(command, cwdArg, timeoutArg, workspaceRoot) {
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('参数 command 不能为空')
  }
  const cwdAbs = resolveShellCwd(workspaceRoot, cwdArg)
  const timeoutMs = parseShellTimeout(timeoutArg)

  return await new Promise((resolve, reject) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      cwd: cwdAbs,
      windowsHide: true,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks = []
    const stderrChunks = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false

    const timer = setTimeout(async () => {
      timedOut = true
      await killProcessTree(child)
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= STREAM_CAPTURE_BYTES) return
      stdoutChunks.push(chunk)
      stdoutBytes += chunk.length
    })
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= STREAM_CAPTURE_BYTES) return
      stderrChunks.push(chunk)
      stderrBytes += chunk.length
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`命令启动失败：${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = decodeOutput(Buffer.concat(stdoutChunks))
      const stderr = decodeOutput(Buffer.concat(stderrChunks))
      if (timedOut) {
        const partial = [
          stdout.trim() ? `—— stdout（已捕获部分）——\n${stdout.trim()}` : '',
          stderr.trim() ? `—— stderr（已捕获部分）——\n${stderr.trim()}` : '',
        ]
          .filter(Boolean)
          .join('\n\n')
        reject(
          new Error(
            truncateShellOutput(
              `命令执行超时（${timeoutMs}ms），已终止进程树${partial ? `\n\n${partial}` : ''}`,
            ),
          ),
        )
        return
      }
      const exitLine = code === 0 ? '退出码：0' : `退出码：${code ?? '未知'}（命令执行失败）`
      resolve(
        truncateShellOutput(
          [exitLine, `—— stdout ——\n${orEmpty(stdout)}`, `—— stderr ——\n${orEmpty(stderr)}`].join('\n'),
        ),
      )
    })
  })
}

module.exports = { runShellCommand, resolveShellCwd, decodeOutput, truncateShellOutput }
