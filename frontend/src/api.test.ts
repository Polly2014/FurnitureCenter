import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  adjustInventory,
  createInventoryPosition,
  getAuthSession,
  login,
  logout,
  streamAgent,
  transferInventory,
  uploadFurnitureImage,
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
        headers: expect.objectContaining({
          'idempotency-key': expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
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

  it('sends only the source version because the destination listing is untouched', async () => {
    const fetchMock = stubSuccessfulFetch()

    await transferInventory('inventory-beijing', {
      destination_site_id: 'site-shanghai',
      quantity: 2,
      reason: '上海培训活动',
      expected_source_version: 4,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/inventory/inventory-beijing/transfers',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'idempotency-key': expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
        body: JSON.stringify({
          destination_site_id: 'site-shanghai',
          quantity: 2,
          reason: '上海培训活动',
          expected_source_version: 4,
        }),
      }),
    )
  })

  it('creates and updates sites and lists transfer history through admin endpoints', async () => {
    const fetchMock = stubSuccessfulFetch({ items: [], next_cursor: null })
    const api = await import('./api') as typeof import('./api') & {
      getAdminSites: () => Promise<unknown>
      createSite: (payload: Record<string, unknown>) => Promise<unknown>
      updateSite: (id: string, payload: Record<string, unknown>) => Promise<unknown>
      getTransfers: (filters: Record<string, string | number | undefined>) => Promise<unknown>
    }

    await api.getAdminSites()
    await api.createSite({
      code: 'GZ',
      name: '广州园区',
      city: '广州',
      latitude: 23.1291,
      longitude: 113.2644,
      is_active: true,
    })
    await api.updateSite('site-guangzhou', {
      name: '广州创新园区',
      is_active: false,
      expected_version: 1,
    })
    await api.getTransfers({
      source_site_id: 'site-beijing',
      destination_site_id: 'site-shanghai',
      limit: 20,
      cursor: 'cursor-2',
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/admin/sites',
      expect.objectContaining({ credentials: 'include' }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/admin/sites',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          code: 'GZ',
          name: '广州园区',
          city: '广州',
          latitude: 23.1291,
          longitude: 113.2644,
          is_active: true,
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      '/api/admin/sites/site-guangzhou',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          name: '广州创新园区',
          is_active: false,
          expected_version: 1,
        }),
      }),
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      '/api/admin/transfers?source_site_id=site-beijing&destination_site_id=site-shanghai&limit=20&cursor=cursor-2',
      expect.objectContaining({ credentials: 'include' }),
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

describe('streaming chat API', () => {
  it('sends only the message with browser credentials and CSRF, then surfaces a sanitized terminal error', async () => {
    document.cookie = 'fc_csrf=chat-csrf-token; Path=/'
    const encoder = new TextEncoder()
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('event: error\ndata: {"code":"upstream","message":"智能查询暂时不可用，请稍后重试。"}\n\n'))
        controller.close()
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(streamAgent('北京有哪些会议椅？', {
      onResult: vi.fn(),
      onTextDelta: vi.fn(),
    })).rejects.toThrow('智能查询暂时不可用，请稍后重试。')

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/agent/query/stream',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-CSRF-Token': 'chat-csrf-token',
        }),
        body: JSON.stringify({ message: '北京有哪些会议椅？' }),
      }),
    )
  })
})

describe('image administration API', () => {
  it('uploads image bytes with CSRF, browser credentials and progress before finalizing metadata', async () => {
    document.cookie = 'fc_csrf=image-csrf-token; Path=/'
    const fetchMock = stubSuccessfulFetch({
      id: 'image-new',
      url: '/images/image-new',
      alt_text: '弧背会议椅',
      is_primary: true,
    })
    const sent: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown; credentials: boolean }> = []

    class FakeUploadRequest {
      static last: FakeUploadRequest | undefined
      method = ''
      url = ''
      headers: Record<string, string> = {}
      responseText = JSON.stringify({ upload_id: 'upload-new' })
      status = 201
      withCredentials = false
      upload = { onprogress: undefined as ((event: ProgressEvent) => void) | undefined }
      onload: (() => void) | undefined
      onerror: (() => void) | undefined

      constructor() { FakeUploadRequest.last = this }
      open(method: string, url: string) { this.method = method; this.url = url }
      setRequestHeader(name: string, value: string) { this.headers[name.toLowerCase()] = value }
      send(body: unknown) {
        sent.push({ method: this.method, url: this.url, headers: this.headers, body, credentials: this.withCredentials })
        this.upload.onprogress?.({ lengthComputable: true, loaded: 2, total: 4 } as ProgressEvent)
        this.onload?.()
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeUploadRequest)
    const onProgress = vi.fn()
    const image = new File(['png!'], 'not-the-object-key.png', { type: 'image/png' })

    const created = await uploadFurnitureImage(
      'furniture-arc-chair',
      image,
      { alt_text: '弧背会议椅', is_primary: true },
      onProgress,
    )

    expect(sent).toEqual([
      expect.objectContaining({
        method: 'POST',
        url: '/api/admin/furniture/furniture-arc-chair/images/uploads',
        credentials: true,
        headers: expect.objectContaining({
          'content-type': 'image/png',
          'x-csrf-token': 'image-csrf-token',
          'idempotency-key': expect.stringMatching(/^[0-9a-f-]{36}$/),
        }),
        body: image,
      }),
    ])
    expect(onProgress).toHaveBeenCalledWith(50)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/admin/furniture/furniture-arc-chair/images/uploads/upload-new/finalize',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({ alt_text: '弧背会议椅', is_primary: true }),
      }),
    )
    expect(created).toMatchObject({ id: 'image-new', is_primary: true })
  })
})
