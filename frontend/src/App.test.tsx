import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ role: 'viewer' as 'viewer' | 'admin' }))

vi.mock('./features/auth/AuthGate', () => ({
  AuthGate: ({ children }: { children: (value: unknown) => unknown }) =>
    children({
      session: {
        role: state.role,
        label: `${state.role} account`,
        expires_at: '2026-09-01T00:00:00.000Z',
      },
      logout: vi.fn(),
    }),
}))

vi.mock('./components/SpatialMap', () => ({
  SpatialMap: () => <div aria-label="测试地图" />,
}))

vi.mock('./api', () => ({
  adjustInventory: vi.fn(),
  createFurniture: vi.fn(),
  createInventoryPosition: vi.fn(),
  deleteFurniture: vi.fn(),
  deleteFurnitureImage: vi.fn(),
  getAgentStatus: vi.fn().mockResolvedValue({
    mode: 'rules',
    provider: 'Local rules',
    model: 'rules',
    base_url: '',
    configured: true,
  }),
  getMetadata: vi.fn().mockResolvedValue({ categories: [], sites: [] }),
  searchFurniture: vi.fn().mockResolvedValue({
    items: [],
    map_features: [],
    total: 0,
    applied_query: null,
    applied_filters: {},
    answer: null,
  }),
  reorderFurnitureImages: vi.fn(),
  setFurniturePrimaryImage: vi.fn(),
  streamAgent: vi.fn(),
  transferInventory: vi.fn(),
  updateFurniture: vi.fn(),
  uploadFurnitureImage: vi.fn(),
}))

import App from './App'
import * as api from './api'

beforeEach(() => {
  state.role = 'viewer'
})

describe('role-aware application navigation', () => {
  it('does not offer the administration surface to a viewer', async () => {
    render(<App />)

    expect(await screen.findByRole('button', { name: '查询工作台' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '数据管理' })).not.toBeInTheDocument()
    expect(screen.getByText('viewer account')).toBeInTheDocument()
  })

  it('offers the administration surface to an admin', async () => {
    state.role = 'admin'
    render(<App />)

    expect(await screen.findByRole('button', { name: '数据管理' })).toBeInTheDocument()
    expect(screen.getByText('admin account')).toBeInTheDocument()
  })

  it('renders result-first Chat output from a fake upstream stream', async () => {
    vi.mocked(api.streamAgent).mockImplementation(async (_message, handlers) => {
      handlers.onStatus?.('planning')
      handlers.onResult({
        items: [],
        map_features: [],
        total: 1,
        applied_query: '会议椅',
        applied_filters: { available_only: true },
        answer: null,
      })
      handlers.onStatus?.('answering')
      handlers.onTextDelta('北京园区有会议椅。')
      handlers.onDone?.()
    })
    const user = userEvent.setup()
    render(<App />)

    await user.type(await screen.findByRole('textbox', { name: '自然语言查询' }), '北京有哪些会议椅？')
    await user.click(screen.getByRole('button', { name: '发送查询' }))

    expect(await screen.findByText('北京园区有会议椅。')).toBeInTheDocument()
    expect(screen.getByText('当前结果 1')).toBeInTheDocument()
  })
})
