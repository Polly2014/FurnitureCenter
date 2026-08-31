import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { answerFurnitureQuestion } from './lib/furniture-eval-agent.mjs'
import { expectedFurnitureFacts } from './lib/furniture-eval-oracle.mjs'

const endpoint = process.env.MCP_ENDPOINT ?? 'http://127.0.0.1:8787/mcp'
const token = process.env.MCP_BEARER_TOKEN
if (!token) throw new Error('MCP_BEARER_TOKEN is required')

const [xml, fixtureText] = await Promise.all([
  readFile(new URL('../evals/furniture-center.xml', import.meta.url), 'utf8'),
  readFile(new URL('../../tests/fixtures/catalog-contract.json', import.meta.url), 'utf8'),
])
if (/<(?:calls?|expect)\b/iu.test(xml)) {
  throw new Error('Evaluation XML must not prescribe tool calls or executable expectations')
}
const fixture = JSON.parse(fixtureText)
const cases = [...xml.matchAll(/<evaluation id="([^"]+)">([\s\S]*?)<\/evaluation>/gu)]
if (cases.length !== 10) throw new Error(`Expected exactly 10 evaluations, found ${cases.length}`)

function unescapeXml(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
}

function requiredTag(id, block, tag) {
  const match = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u'))
  if (!match) throw new Error(`${id}: missing <${tag}>`)
  return unescapeXml(match[1].trim())
}

const client = new Client(
  { name: 'furniture-center-question-evaluator', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
)
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  authProvider: { token: async () => token },
})

await client.connect(transport)
try {
  for (const [, id, block] of cases) {
    const question = requiredTag(id, block, 'question')
    requiredTag(id, block, 'answer')
    const produced = await answerFurnitureQuestion(question, client)
    const expected = expectedFurnitureFacts(id, fixture)
    assert.ok(produced.text.trim().length > 0, `${id}: agent returned an empty answer`)
    assert.ok(produced.calls.length > 0, `${id}: agent made no MCP tool calls`)
    assert.ok(
      produced.calls.every((call) => [
        'search_furniture', 'get_furniture', 'list_sites', 'list_categories',
      ].includes(call.name)),
      `${id}: agent called a tool outside the read-only surface`,
    )
    assert.deepStrictEqual(
      produced.facts,
      expected,
      `${id}: question-driven answer disagrees with fixture-derived semantic facts`,
    )
    const trace = produced.calls.map((call) => call.name).join(' -> ')
    console.log(`PASS ${id} | ${trace} | ${produced.text}`)
  }
} finally {
  await client.close()
}

console.log(`Verified ${cases.length} question-driven MCP evaluations through ${endpoint}`)
