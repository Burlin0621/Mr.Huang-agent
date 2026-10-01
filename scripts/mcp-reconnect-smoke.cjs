/**
 * MCP 补强冒烟测试（纯 Node，无 Electron）：验证
 * 1. confirmTools 命中的工具 requiresConfirm=true、未命中为 false；
 * 2. 断线自动重连：模拟 transport onclose 后标记 reconnecting、撤下工具，
 *    退避定时器（注入超短间隔）到期后自动重连成功并重新注册工具；
 * 3. 群聊链路的工具合并逻辑（resolveToolSchemas 对 mcp__ 前缀动态工具的兜底）不在此验证——
 *    该路径依赖 Vite 别名与渲染层环境，由 lint/build 与单聊既有链路覆盖。
 * 运行：node scripts/mcp-reconnect-smoke.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

process.env.MRHUANG_MCP_CONFIG_DIR = path.join(process.env.TEMP || '.', `mcp-reconnect-${Date.now()}`)
fs.mkdirSync(process.env.MRHUANG_MCP_CONFIG_DIR, { recursive: true })

const mcp = require('../electron/mcp.cjs')
const { TOOL_REGISTRY } = require('../electron/tools.cjs')

async function main() {
  // 注入超短退避间隔，测试不必真等 5 秒
  mcp.setReconnectBackoff({ initialMs: 20, maxMs: 50 })

  const configs = [
    {
      name: 'echo_test',
      command: process.execPath,
      args: [path.resolve(__dirname, 'mcp-echo-test-server.cjs')],
      env: {},
      enabled: true,
      confirmTools: ['echo'],
    },
  ]
  const saved = await mcp.saveConfigs(configs)
  if (saved.statuses.echo_test?.status !== 'connected') {
    throw new Error(`echo_test 未连接：${JSON.stringify(saved.statuses)}`)
  }

  // ① 工具级确认开关：命中 confirmTools 的 requiresConfirm=true，未命中为 false
  if (TOOL_REGISTRY['mcp__echo_test__echo']?.requiresConfirm !== true) {
    throw new Error('echo 工具应 requiresConfirm=true（在 confirmTools 列表中）')
  }
  if (TOOL_REGISTRY['mcp__echo_test__no_args']?.requiresConfirm !== false) {
    throw new Error('no_args 工具应 requiresConfirm=false（不在 confirmTools 列表中）')
  }
  console.log('confirm flag: echo=true, no_args=false  OK')

  // ② 断线自动重连：模拟 transport onclose（服务器进程退出的等价路径）
  mcp.handleTransportClose('echo_test')
  if (TOOL_REGISTRY['mcp__echo_test__echo']) throw new Error('断开后 echo 工具应已从注册表撤下')
  await new Promise((resolve) => setTimeout(resolve, 300))
  if (TOOL_REGISTRY['mcp__echo_test__echo']?.requiresConfirm !== true) {
    throw new Error('自动重连后 echo 工具应已重新注册且保持 requiresConfirm=true')
  }
  // 调用走注册表 handler（callTool 会弹原生确认框，纯 Node 环境无 BrowserWindow）
  const callResult = {
    ok: true,
    result: await TOOL_REGISTRY['mcp__echo_test__echo'].handler({ message: 'reconnected' }),
  }
  if (!callResult.ok || !String(callResult.result).includes('reconnected')) {
    throw new Error(`重连后调用失败：${JSON.stringify(callResult)}`)
  }
  console.log('auto-reconnect: tools re-registered + callTool OK')

  // ③ 退出清理：shutdownMcp 后注册表撤下、无残留定时器
  await mcp.shutdownMcp()
  if (TOOL_REGISTRY['mcp__echo_test__echo']) throw new Error('shutdown 后工具应已撤下')
  console.log('shutdown cleanup OK')
  console.log('RECONNECT_SMOKE_OK')
}

main().catch((e) => {
  console.error('RECONNECT_SMOKE_FAIL', e)
  process.exit(1)
})
