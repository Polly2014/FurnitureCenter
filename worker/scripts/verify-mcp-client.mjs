import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

const endpoint = process.env.MCP_ENDPOINT ?? 'http://127.0.0.1:8787/mcp'
const token = process.env.MCP_BEARER_TOKEN
if (!token) throw new Error('MCP_BEARER_TOKEN is required')

const client = new Client(
  { name: 'furniture-center-verifier', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
)
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  authProvider: { token: async () => token },
})

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const names = tools.tools.map((tool) => tool.name)
  const expected = ['search_furniture', 'get_furniture', 'list_sites', 'list_categories']
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tools: ${JSON.stringify(names)}`)
  }
  const result = await client.callTool({
    name: 'search_furniture',
    arguments: { site_id: 'site-beijing', available_only: true, limit: 20 },
  })
  if (result.isError || result.structuredContent?.count !== 2) {
    throw new Error('Expected two available Beijing furniture records')
  }
  console.log(`Protocol ${client.getNegotiatedProtocolVersion()}; tools ${names.join(', ')}; Beijing count 2`)
} finally {
  await client.close()
}
