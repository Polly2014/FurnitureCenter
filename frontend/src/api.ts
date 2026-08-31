import type {
  AgentStatus,
  AuthSession,
  CatalogMetadata,
  CreateInventoryPositionInput,
  InventoryAdjustmentInput,
  InventoryTransferInput,
  QueryResult,
} from './types'

const API_BASE = import.meta.env.VITE_API_BASE ?? ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? 'GET'
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrfToken = readCookie('fc_csrf')
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken)
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: Object.fromEntries(headers.entries()),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.detail ?? `请求失败 (${response.status})`)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function readCookie(name: string) {
  if (typeof document === 'undefined') return undefined
  for (const part of document.cookie.split(';')) {
    const [cookieName, ...valueParts] = part.trim().split('=')
    if (cookieName === name) return decodeURIComponent(valueParts.join('='))
  }
  return undefined
}

export function getAuthSession() {
  return request<AuthSession>('/api/auth/session')
}

export function login(token: string) {
  return request<AuthSession>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
}

export function logout() {
  return request<void>('/api/auth/logout', { method: 'POST' })
}

export function getMetadata() {
  return request<CatalogMetadata>('/api/catalog/metadata')
}

export function searchFurniture(filters: {
  query?: string
  category?: string
  site_id?: string
  available_only?: boolean
}) {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== '') params.set(key, String(value))
  })
  return request<QueryResult>(`/api/catalog/furniture?${params}`)
}

type AgentStreamHandlers = {
  onStatus?: (phase: string) => void
  onResult: (result: QueryResult) => void
  onTextDelta: (delta: string) => void
  onDone?: () => void
}

export async function streamAgent(message: string, handlers: AgentStreamHandlers) {
  const response = await fetch(`${API_BASE}/api/agent/query/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })
  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw new Error(payload?.detail ?? `请求失败 (${response.status})`)
  }
  if (!response.body) throw new Error('浏览器未提供流式响应体')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  function processBlock(block: string) {
    let event = 'message'
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (dataLines.length === 0) return
    const data = JSON.parse(dataLines.join('\n'))
    if (event === 'status') handlers.onStatus?.(data.phase)
    else if (event === 'result') handlers.onResult(data as QueryResult)
    else if (event === 'text_delta') handlers.onTextDelta(String(data))
    else if (event === 'done') handlers.onDone?.()
    else if (event === 'error') throw new Error(data.message ?? '流式查询失败')
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    let boundary = buffer.match(/\r?\n\r?\n/)
    while (boundary?.index !== undefined) {
      processBlock(buffer.slice(0, boundary.index))
      buffer = buffer.slice(boundary.index + boundary[0].length)
      boundary = buffer.match(/\r?\n\r?\n/)
    }
    if (done) break
  }
  if (buffer.trim()) processBlock(buffer)
}

export function createFurniture(payload: Record<string, string | number | null>) {
  return request<{ id: string }>('/api/admin/furniture', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function adjustInventory(inventoryId: string, payload: InventoryAdjustmentInput) {
  return request<{
    inventory_id: string
    quantity_total: number
    quantity_available: number
    version: number
  }>(
    `/api/admin/inventory/${inventoryId}/adjustments`,
    { method: 'POST', body: JSON.stringify(payload) },
  )
}

export function transferInventory(inventoryId: string, payload: InventoryTransferInput) {
  return request<{
    transfer_id: string
    source: { inventory_id: string; quantity_total: number; quantity_available: number; version: number }
    destination: { inventory_id: string; quantity_total: number; quantity_available: number; version: number }
  }>(`/api/admin/inventory/${inventoryId}/transfers`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createInventoryPosition(
  furnitureId: string,
  payload: CreateInventoryPositionInput,
) {
  return request<{
    inventory_id: string
    quantity_total: number
    quantity_available: number
    version: number
  }>(`/api/admin/furniture/${furnitureId}/inventory`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateFurniture(id: string, payload: Record<string, string | number | null>) {
  return request<void>(`/api/admin/furniture/${id}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteFurniture(id: string) {
  return request<void>(`/api/admin/furniture/${id}`, { method: 'DELETE' })
}

export function getAgentStatus() {
  return request<AgentStatus>('/api/agent/status')
}
