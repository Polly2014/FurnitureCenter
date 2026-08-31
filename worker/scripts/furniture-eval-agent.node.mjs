import assert from 'node:assert/strict'
import test from 'node:test'
import { answerFurnitureQuestion } from './lib/furniture-eval-agent.mjs'

function fakeClient() {
  const calls = []
  return {
    calls,
    async listTools() {
      return {
        tools: ['search_furniture', 'get_furniture', 'list_sites', 'list_categories']
          .map((name) => ({ name })),
      }
    },
    async callTool({ name, arguments: args }) {
      calls.push({ name, arguments: args })
      if (name === 'list_sites') {
        return {
          structuredContent: {
            ok: true,
            sites: [
              { id: 'site-beijing', code: 'BJ', name: '北京园区' },
              { id: 'site-shanghai', code: 'SH', name: '上海园区' },
            ],
          },
        }
      }
      if (name === 'search_furniture') {
        return {
          structuredContent: {
            ok: true,
            items: [{
              id: `item-${args.site_id}`,
              name: `Item at ${args.site_id}`,
              category: '桌台',
              quantity_available: 2,
              images: [],
              inventory: [{
                site_id: args.site_id,
                site_code: args.site_id === 'site-beijing' ? 'BJ' : 'SH',
                site_name: args.site_id,
                quantity_available: 2,
              }],
            }],
          },
        }
      }
      throw new Error(`Unexpected fake tool: ${name}`)
    },
  }
}

test('the natural-language place changes the MCP site filter', async () => {
  const beijing = fakeClient()
  await answerFurnitureQuestion(
    'What furniture is currently reusable in Beijing and what is the combined available quantity?',
    beijing,
  )
  assert.deepEqual(beijing.calls, [
    { name: 'list_sites', arguments: {} },
    {
      name: 'search_furniture',
      arguments: { site_id: 'site-beijing', available_only: true, limit: 50 },
    },
  ])

  const shanghai = fakeClient()
  await answerFurnitureQuestion(
    'What furniture is currently reusable in Shanghai and what is the combined available quantity?',
    shanghai,
  )
  assert.deepEqual(shanghai.calls, [
    { name: 'list_sites', arguments: {} },
    {
      name: 'search_furniture',
      arguments: { site_id: 'site-shanghai', available_only: true, limit: 50 },
    },
  ])
})
