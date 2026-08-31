import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adjustInventory,
  createInventoryPosition,
  transferInventory,
} from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubSuccessfulFetch(payload: unknown = {}) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('inventory administration API', () => {
  it('sends independent deltas and the selected position version', async () => {
    const fetchMock = stubSuccessfulFetch()

    await adjustInventory('inventory-beijing', {
      kind: 'loan',
      delta_total: 0,
      delta_available: -2,
      reason: '借给三层会议室',
      expected_version: 4,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/inventory/inventory-beijing/adjustments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          kind: 'loan',
          delta_total: 0,
          delta_available: -2,
          reason: '借给三层会议室',
          expected_version: 4,
        }),
      }),
    )
  })

  it('sends both source and destination versions for a transfer', async () => {
    const fetchMock = stubSuccessfulFetch()

    await transferInventory('inventory-beijing', {
      destination_site_id: 'site-shanghai',
      quantity: 2,
      reason: '上海培训活动',
      expected_source_version: 4,
      expected_destination_version: 7,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/inventory/inventory-beijing/transfers',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          destination_site_id: 'site-shanghai',
          quantity: 2,
          reason: '上海培训活动',
          expected_source_version: 4,
          expected_destination_version: 7,
        }),
      }),
    )
  })

  it('creates a position for a specific furniture and site', async () => {
    const fetchMock = stubSuccessfulFetch()

    await createInventoryPosition('furniture-chair', {
      site_id: 'site-shenzhen',
      quantity_total: 5,
      quantity_available: 3,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/furniture/furniture-chair/inventory',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          site_id: 'site-shenzhen',
          quantity_total: 5,
          quantity_available: 3,
        }),
      }),
    )
  })
})
