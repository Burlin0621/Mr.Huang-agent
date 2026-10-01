/**
 * MCP 全链路冒烟测试（纯 Node，无 Electron）：
 * 用极简 stdio MCP 测试服务器（scripts/mcp-echo-test-server.cjs）验证
 * 配置读写 → 连接 → 注册表注册 → list/call 工具 → 冲突让位 → 移除。
 * 运行：node scripts/mcp-smoke-test.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

process.env.MRHUANG_MCP_CONFIG_DIR = path.join(process.env.TEMP || '.', `mcp-test-${Date.now()}`)
fs.mkdirSync(process.env.MRHUANG_MCP_CONFIG_DIR, { recursive: true })

const mcp = require('../electron/mcp.cjs')

async function main() {
  const configs = [
    {
      name: 'echo_test',
      command: process.execPath,
      args: [path.resolve(__dirname, 'mcp-echo-test-server.cjs')],
      env: {},
      enabled: true,
    },
    { name: 'off', command: process.execPath, args: ['--version'], env: {}, enabled: false },
    { name: 'bad', command: 'definitely-not-a-command-xyz', args: [], env: {}, enabled: true },
  ]
  const saved = await mcp.saveConfigs(configs)
  console.log('save statuses:', JSON.stringify(saved.statuses))

  const tools = mcp.getMcpTools()
  console.log('tools:', JSON.stringify(tools.map((t) => t.name)))
  if (!tools.some((t) => t.name === 'mcp__echo_test__echo')) throw new Error('echo 工具未注册')

  console.log('echo result:', JSON.stringify(await mcp.callMcpTool('mcp__echo_test__echo', { message: '你好' })))
  console.log('no_args result:', JSON.stringify(await mcp.callMcpTool('mcp__echo_test__no_args', {})))

  try {
    await mcp.callMcpTool('mcp__echo_test__echo', {})
    throw new Error('missing-arg 未按预期报错')
  } catch (e) {
    console.log('missing-arg error:', e.message)
  }
  try {
    await mcp.callMcpTool('mcp__bad__x', {})
    throw new Error('bad-server 未按预期报错')
  } catch (e) {
    console.log('bad-server error:', e.message.slice(0, 80))
  }

  const { TOOL_REGISTRY, registerDynamicTool, removeDynamicTool, callTool } = require('../electron/tools.cjs')
  const mcpNames = Object.keys(TOOL_REGISTRY).filter((k) => k.startsWith('mcp__'))
  console.log('registry mcp tools:', JSON.stringify(mcpNames))
  console.log('callTool via registry:', JSON.stringify(await callTool('mcp__echo_test__echo', { message: 'via-registry' }, {})))
  console.log('conflict test (builtin name):', registerDynamicTool('current_time', { handler: async () => 'hijack' }))
  registerDynamicTool('mcp__tmp__t', { handler: async () => 'y' })
  removeDynamicTool('mcp__tmp__t')
  console.log('after remove, has mcp__tmp__t:', Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, 'mcp__tmp__t'))
  const time = await TOOL_REGISTRY['current_time'].handler({})
  console.log('builtin intact:', typeof time === 'string' && !time.startsWith('hijack'))

  await mcp.shutdownMcp()
  console.log('SMOKE_OK')
}

main().catch((e) => {
  console.error('SMOKE_FAIL', e)
  process.exit(1)
})
