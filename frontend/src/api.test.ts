import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adjustInventory,
  createInventoryPosition,
  getAuthSession,
  login,
  logout,
  transferInventory,
} from './api'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubSuccessfulFetch(payload: unknown = {}) {
  const fetchMock = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
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

describe('browser session API', () => {
  it('checks and creates sessions with browser credentials enabled', async () => {
    const fetchMock = stubSuccessfulFetch({
      role: 'viewer',
      label: '访客',
      expires_at: '2026-09-01T00:00:00.000Z',
    })

    await getAuthSession()
    await login('fc_viewer_example')

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/auth/session',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/auth/login',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ token: 'fc_viewer_example' }),
      }),
    )
  })

  it('adds the CSRF cookie value to state-changing requests', async () => {
    document.cookie = 'fc_csrf=csrf-test-value; Path=/'
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await logout()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({ 'x-csrf-token': 'csrf-test-value' }),
      }),
    )
  })
})
