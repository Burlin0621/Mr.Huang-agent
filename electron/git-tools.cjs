/**
 * Git 结构化工具（git_status / git_diff / git_commit 的主进程实现，由 electron/tools.cjs 注册 handler 时调用）。
 *
 * - 用 child_process.spawn 直接调 git.exe（参数数组传参，不经 cmd.exe，避免提交说明里的
 *   中文/引号/换行被二次解析）；加 `-c core.quotepath=false` 让中文文件名原样输出；
 * - cwd 锁定工作区关联文件夹（复用 vault.cjs 的 resolveWithin；本模块固定用工作区根，不接受子目录）；
 * - 输出按 Buffer 收集后复用 shell-tools 的 decodeOutput（UTF-8 优先，GBK 兜底）；
 * - 返回文本整体截断到 8000 字符（同 shell_exec 约定），避免超大 diff 撑爆模型上下文；
 * - git_commit 只提交已暂存内容：暂存区为空且未传 stage_all 时报错引导模型先查看变更；
 *   stage_all=true 时先执行 `git add -A` 再提交（该取舍由调用方在 description 中向模型说明）。
 */
const { spawn } = require('node:child_process')
const vault = require('./vault.cjs')
const shellTools = require('./shell-tools.cjs')

/** 返回给模型的 git 输出文本上限（字符数，同 shell_exec） */
const GIT_OUTPUT_MAX_CHARS = 8000
/** 单条 git 命令超时（毫秒） */
const GIT_TIMEOUT_MS = 30_000

/** 把输出截断到 git 工具上限，并标注已截断 */
function truncateGitOutput(text) {
  if (text.length <= GIT_OUTPUT_MAX_CHARS) return text
  return `${text.slice(0, GIT_OUTPUT_MAX_CHARS)}\n\n[输出超过 ${GIT_OUTPUT_MAX_CHARS} 字符，已截断：原始长度 ${text.length} 字符]`
}

/** 校验并返回工作区根目录；未关联文件夹时抛中文错误（git 工具固定用工作区根） */
function resolveGitCwd(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || !workspaceRoot.trim()) {
    throw new Error('当前工作区未关联文件夹，请先在工作区设置中关联文件夹后再使用 git 工具')
  }
  return vault.resolveWithin(workspaceRoot, '')
}

/**
 * 执行一条 git 命令：spawn('git', args) 参数数组直传（不经 shell），
 * 超时 30 秒；返回 { code, stdout, stderr }（stdout/stderr 已解码、已去除首尾空白）。
 */
function runGit(gitArgs, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdoutChunks = []
    const stderrChunks = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // 进程已退出时忽略
      }
    }, GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk))
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`git 命令启动失败（请确认已安装 Git 并加入 PATH）：${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`git 命令执行超时（${GIT_TIMEOUT_MS}ms）：git ${gitArgs.join(' ')}`))
        return
      }
      resolve({
        code: code ?? -1,
        stdout: shellTools.decodeOutput(Buffer.concat(stdoutChunks)).trim(),
        stderr: shellTools.decodeOutput(Buffer.concat(stderrChunks)).trim(),
      })
    })
  })
}

/** 执行 git 命令并要求退出码为 0；非 0 时抛出带 stderr 的中文错误 */
async function runGitStrict(gitArgs, cwd) {
  const { code, stdout, stderr } = await runGit(gitArgs, cwd)
  if (code !== 0) {
    throw new Error(`git ${gitArgs[0]} 失败（退出码 ${code}）：${stderr || stdout || '未知错误'}`)
  }
  return stdout
}

/** 确认 cwd 是一个 git 工作区（仓库或其子目录）；不是时报中文错误 */
async function ensureGitRepo(cwd) {
  const stdout = await runGitStrict(['rev-parse', '--is-inside-work-tree'], cwd)
  if (stdout.trim() !== 'true') {
    throw new Error('当前文件夹不是 git 仓库（或未初始化），无法使用 git 工具')
  }
}

/** 取当前分支名；detached HEAD 或取不到时回退占位文本 */
async function getBranchName(cwd) {
  const { code, stdout } = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (code !== 0 || !stdout.trim() || stdout.trim() === 'HEAD') return '（detached HEAD）'
  return stdout.trim()
}

/** 取与上游分支的领先/落后摘要（无上游时返回空串） */
async function getAheadBehind(cwd) {
  const { code, stdout } = await runGit(['status', '-sb'], cwd)
  if (code !== 0) return ''
  const first = stdout.split('\n')[0] || ''
  const bracket = first.match(/\[(.+)\]/)
  return bracket ? `（${bracket[1].trim()}）` : ''
}

/**
 * git_status：返回分支 + 暂存/未暂存/未跟踪文件清单（结构化文本）。
 * @param {string} workspaceRoot 工作区关联文件夹绝对路径
 * @returns {Promise<string>}
 */
async function getGitStatus(workspaceRoot) {
  const cwd = resolveGitCwd(workspaceRoot)
  await ensureGitRepo(cwd)
  const raw = await runGitStrict(['status', '--porcelain', '-z'], cwd)
  const branch = await getBranchName(cwd)
  const aheadBehind = await getAheadBehind(cwd)

  // -z 格式：NUL 分隔的 "XY <path>" 记录（重命名记录为 "XY new\0old\0"）
  const staged = []
  const unstaged = []
  const untracked = []
  const records = raw ? raw.split('\0') : []
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]
    if (!record) continue
    if (record.length < 4) continue
    const x = record[0]
    const y = record[1]
    const path = record.slice(3)
    if (record[2] === 'R' || record[2] === 'C') i += 1 // 跳过后随的原始路径记录
    if (x === '?' && y === '?') {
      untracked.push(path)
    } else {
      if (x !== ' ') staged.push(`${x} ${path}`)
      if (y !== ' ') unstaged.push(`${y} ${path}`)
    }
  }

  const lines = [`分支：${branch}${aheadBehind}`]
  const section = (title, items) => {
    lines.push('')
    lines.push(items.length > 0 ? `${title}（${items.length}）：` : `${title}（0）：无`)
    for (const item of items) lines.push(`  ${item}`)
  }
  section('已暂存', staged)
  section('未暂存', unstaged)
  section('未跟踪', untracked)
  if (staged.length === 0 && unstaged.length === 0 && untracked.length === 0) {
    lines.push('')
    lines.push('工作区干净，没有待提交的变更')
  }
  return truncateGitOutput(lines.join('\n'))
}

/**
 * git_diff：逐文件返回 unified diff（工作区默认 / --staged 暂存区 / 指定文件）。
 * @param {string} workspaceRoot 工作区关联文件夹绝对路径
 * @param {boolean} staged true 时比较暂存区 vs HEAD
 * @param {string|undefined} pathArg 可选，限定单个文件（工作区内相对路径，/ 或 \ 均可）
 * @returns {Promise<string>}
 */
async function getGitDiff(workspaceRoot, staged, pathArg) {
  const cwd = resolveGitCwd(workspaceRoot)
  await ensureGitRepo(cwd)
  const gitArgs = ['-c', 'core.quotepath=false', 'diff', '--unified=3', '--no-color']
  if (staged) gitArgs.push('--staged')
  const path = typeof pathArg === 'string' ? pathArg.trim().replace(/\\/g, '/') : ''
  if (path) {
    if (path.includes('..')) throw new Error('参数 path 禁止包含 ..（仅允许工作区内相对路径）')
    gitArgs.push('--', path)
  }
  const { code, stdout, stderr } = await runGit(gitArgs, cwd)
  if (code !== 0) {
    throw new Error(`git diff 失败（退出码 ${code}）：${stderr || '未知错误'}`)
  }
  if (!stdout.trim()) {
    const scope = staged ? '暂存区相对 HEAD' : '工作区相对暂存区'
    return path ? `（${path} 在${scope}没有差异）` : `（${scope}没有差异）`
  }
  const fileCount = (stdout.match(/^diff --git /gm) || []).length
  const header = path
    ? `文件：${path}（${staged ? '暂存区 vs HEAD' : '工作区 vs 暂存区'}）`
    : `共 ${fileCount} 个文件变更（${staged ? '暂存区 vs HEAD' : '工作区 vs 暂存区'}）`
  return truncateGitOutput(`${header}\n\n${stdout}`)
}

/** 取暂存区文件清单（含状态字母），形如 ["M  src/a.ts"]；空数组表示暂存区为空 */
async function getStagedFiles(cwd) {
  const raw = await runGitStrict(['diff', '--cached', '--name-status'], cwd)
  return raw ? raw.split('\n').map((line) => line.trim()).filter(Boolean) : []
}

/** 取未暂存 + 未跟踪文件清单（仅用于提交前预览与提示） */
async function getUnstagedSummary(cwd) {
  const raw = await runGitStrict(['status', '--porcelain'], cwd)
  const items = []
  for (const record of raw ? raw.split('\n') : []) {
    if (!record || record.length < 4) continue
    const x = record[0]
    const y = record[1]
    if (x === '?' && y === '?') items.push(`?? ${record.slice(3)}`)
    else if (y !== ' ') items.push(`${y} ${record.slice(3)}`)
  }
  return items
}

/** 把 message 拆成 subject（首行）与 body（其余行），供 git commit -m 两次传入 */
function splitCommitMessage(message) {
  const text = String(message ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) throw new Error('参数 message 不能为空：请为本次提交写一句说明（首行），需要细节可另起正文')
  const lines = text.split('\n')
  return { subject: lines[0].trim(), body: lines.slice(1).join('\n').trim() }
}

/**
 * git_commit 的确认弹窗预览：提交说明 + 暂存内容清单（stage_all 时附将被纳入的未暂存变更）。
 * 预检失败时由 tools.cjs 降级为 JSON 参数预览。
 */
async function previewCommit(workspaceRoot, stageAll, message) {
  const cwd = resolveGitCwd(workspaceRoot)
  await ensureGitRepo(cwd)
  const staged = await getStagedFiles(cwd)
  const { subject } = splitCommitMessage(message)
  const lines = [`提交说明：${subject}`]
  if (stageAll) {
    const unstaged = await getUnstagedSummary(cwd)
    lines.push('操作：先 git add -A 纳入全部变更，再提交')
    lines.push('')
    lines.push(`将提交的文件（${staged.length + unstaged.length}）：`)
    for (const item of [...staged, ...unstaged]) lines.push(`  ${item}`)
  } else if (staged.length === 0) {
    lines.push('操作：提交暂存区（当前暂存区为空，执行会报错）')
  } else {
    lines.push('操作：提交暂存区（未暂存的变更不会纳入）')
    lines.push('')
    lines.push(`将提交的文件（${staged.length}）：`)
    for (const item of staged) lines.push(`  ${item}`)
  }
  return truncateGitOutput(lines.join('\n'))
}

/**
 * git_commit：只提交已暂存内容；stageAll=true 时先 `git add -A` 再提交。
 * 返回提交摘要文本（hash / 说明 / 变更文件清单）。
 */
async function commitStaged(workspaceRoot, stageAll, message) {
  const cwd = resolveGitCwd(workspaceRoot)
  await ensureGitRepo(cwd)
  const { subject, body } = splitCommitMessage(message)

  if (stageAll === true) {
    await runGitStrict(['add', '-A'], cwd)
  }
  const staged = await getStagedFiles(cwd)
  if (staged.length === 0) {
    throw new Error(
      '暂存区为空，没有可提交的内容：请先用 git_status / git_diff 查看变更；' +
        '确认要把工作区全部变更纳入本次提交时，传 stage_all=true（等价于先 git add -A 再提交）',
    )
  }

  const commitArgs = ['commit', '-m', subject]
  if (body) commitArgs.push('-m', body)
  await runGitStrict(commitArgs, cwd)

  const summary = await runGitStrict(['log', '-1', '--pretty=format:%h|%H|%s'], cwd)
  const [shortHash, fullHash, committedSubject] = summary.split('|')
  const filesRaw = await runGitStrict(
    ['diff-tree', '--no-commit-id', '--name-status', '-r', fullHash || 'HEAD'],
    cwd,
  )
  const files = filesRaw ? filesRaw.split('\n').map((line) => line.trim()).filter(Boolean) : []
  const lines = [
    '提交成功',
    `提交：${shortHash}${fullHash ? `（${fullHash.slice(0, 12)}…）` : ''}`,
    `说明：${committedSubject || subject}`,
    `变更文件：${files.length} 个`,
  ]
  for (const file of files) lines.push(`  ${file}`)
  const unstaged = await getUnstagedSummary(cwd)
  if (unstaged.length > 0) {
    lines.push('')
    lines.push(`注意：仍有 ${unstaged.length} 个未暂存/未跟踪变更未纳入本次提交`)
  }
  return truncateGitOutput(lines.join('\n'))
}

module.exports = {
  getGitStatus,
  getGitDiff,
  commitStaged,
  previewCommit,
  resolveGitCwd,
  truncateGitOutput,
}
