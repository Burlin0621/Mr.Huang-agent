// 极简 stdio MCP 测试服务器：暴露一个 echo 工具（冒烟测试用）
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const server = new McpServer({ name: 'echo-test', version: '0.1.0' })
server.tool('echo', { message: z.string().describe('要回显的文本') }, async ({ message }) => ({
  content: [{ type: 'text', text: `echo: ${message}` }],
}))
server.tool('no_args', {}, async () => ({ content: [{ type: 'text', text: 'ok' }] }))

async function main() {
  await server.connect(new StdioServerTransport())
}
main().catch(() => process.exit(1))
