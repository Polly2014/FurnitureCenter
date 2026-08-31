import { readFile } from 'node:fs/promises'

const endpoint = process.env.MCP_ENDPOINT ?? 'http://127.0.0.1:8787/mcp'
const token = process.env.MCP_BEARER_TOKEN
if (!token) throw new Error('MCP_BEARER_TOKEN is required')

const xml = await readFile(new URL('../evals/furniture-center.xml', import.meta.url), 'utf8')
const cases = [...xml.matchAll(/<evaluation id="([^"]+)">([\s\S]*?)<\/evaluation>/gu)]
if (cases.length !== 10) throw new Error(`Expected exactly 10 evaluations, found ${cases.length}`)

function unescapeXml(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
}

async function callTool(name, args) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: { name, arguments: args } }),
  })
  if (!response.ok) throw new Error(`MCP HTTP ${response.status}`)
  const raw = await response.text()
  const payload = response.headers.get('content-type')?.includes('text/event-stream')
    ? JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? '{}')
    : JSON.parse(raw)
  if (payload.error) throw new Error(`MCP ${payload.error.code}: ${payload.error.message}`)
  if (payload.result?.isError) throw new Error(payload.result.content?.[0]?.text ?? 'Tool error')
  return payload.result?.structuredContent
}

function lookup(root, path) {
  const parts = path.split('.')
  let value = root
  for (const part of parts) {
    if (part === 'length') return value?.length
    value = value?.[Number.isInteger(Number(part)) ? Number(part) : part]
  }
  return value
}

for (const [, id, block] of cases) {
  const calls = [...block.matchAll(/<call tool="([^"]+)">([\s\S]*?)<\/call>/gu)]
  const results = []
  for (const [, tool, args] of calls) results.push(await callTool(tool, JSON.parse(unescapeXml(args.trim()))))
  const expectedText = block.match(/<expect>([\s\S]*?)<\/expect>/u)?.[1]
  if (!expectedText) throw new Error(`${id}: missing expectations`)
  const expected = JSON.parse(unescapeXml(expectedText.trim()))
  for (const [path, wanted] of Object.entries(expected)) {
    const actual = lookup(results, path)
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      throw new Error(`${id}: ${path} expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`)
    }
  }
  console.log(`PASS ${id}`)
}

console.log(`Verified ${cases.length} MCP evaluations through ${endpoint}`)
