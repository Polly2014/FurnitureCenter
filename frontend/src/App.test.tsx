import { render, screen, waitFor, within } from '@testing-library/react'
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
  createSite: vi.fn(),
  deleteFurniture: vi.fn(),
  deleteFurnitureImage: vi.fn(),
  getAgentStatus: vi.fn().mockResolvedValue({
    mode: 'rules',
    provider: 'Local rules',
    model: 'rules',
    base_url: '',
    configured: true,
  }),
  getAdminSites: vi.fn().mockResolvedValue([]),
  getMetadata: vi.fn().mockResolvedValue({ categories: [], sites: [] }),
  getTransfers: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
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
  updateSite: vi.fn(),
  uploadFurnitureImage: vi.fn(),
}))

import App from './App'
import * as api from './api'

const catalogResult = {
  items: [{
    id: 'chair-1',
    sku: 'CHR-ARC-01',
    name: '弧背会议椅',
    category: '座椅',
    description: '灰色织物坐面，适合会议室与协作空间。',
    condition: 'good',
    name_en: 'Arc-back Meeting Chair',
    main_category: '',
    dimensions: '600*600*750',
    color: '灰色',
    material: '布艺 / 金属',
    brand: 'Haworth',
    image_reference: '',
    source_workbook: '',
    source_sheet: '',
    source_row: null,
    quantity_available: 12,
    images: [],
    inventory: [{
      id: 'inventory-1',
      site: {
        id: 'site-bj',
        code: 'BJ',
        name: '北京园区',
        city: '北京',
        latitude: 39.9042,
        longitude: 116.4074,
      },
      quantity_total: 18,
      quantity_available: 12,
      version: 1,
    }],
  }],
  map_features: [{
    site_id: 'site-bj',
    site_name: '北京园区',
    latitude: 39.9042,
    longitude: 116.4074,
    quantity_available: 12,
    furniture_ids: ['chair-1'],
  }],
  total: 1,
  applied_query: null,
  applied_filters: { available_only: true },
  answer: null,
}

beforeEach(() => {
  vi.clearAllMocks()
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

  it('loads administration data and refreshes site metadata after creating a site', async () => {
    state.role = 'admin'
    const managedSite = {
      id: 'site-bj',
      code: 'BJ',
      name: '北京园区',
      city: '北京',
      latitude: 39.9042,
      longitude: 116.4074,
      is_active: true,
      version: 1,
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-01T00:00:00.000Z',
    }
    vi.mocked(api.getAdminSites).mockResolvedValue([managedSite])
    vi.mocked(api.getTransfers).mockResolvedValue({ items: [], next_cursor: null })
    vi.mocked(api.createSite).mockResolvedValue({
      ...managedSite,
      id: 'site-gz',
      code: 'GZ',
      name: '广州园区',
      city: '广州',
      latitude: 23.1291,
      longitude: 113.2644,
    })
    const user = userEvent.setup()
    render(<App />)

    await user.click(await screen.findByRole('button', { name: '数据管理' }))
    await waitFor(() => {
      expect(api.getAdminSites).toHaveBeenCalledTimes(1)
      expect(api.getTransfers).toHaveBeenCalledWith({ limit: 50 })
    })

    await user.click(screen.getByRole('button', { name: '园区管理' }))
    expect(await screen.findByText('北京园区')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新增园区' }))
    const form = screen.getByRole('form', { name: '新增园区' })
    await user.type(within(form).getByLabelText('园区编码'), 'GZ')
    await user.type(within(form).getByLabelText('园区名称'), '广州园区')
    await user.type(within(form).getByLabelText('城市'), '广州')
    await user.type(within(form).getByLabelText('纬度'), '23.1291')
    await user.type(within(form).getByLabelText('经度'), '113.2644')
    await user.click(within(form).getByRole('button', { name: '保存园区' }))

    await waitFor(() => {
      expect(api.createSite).toHaveBeenCalledWith({
        code: 'GZ',
        name: '广州园区',
        city: '广州',
        latitude: 23.1291,
        longitude: 113.2644,
        is_active: true,
      })
      expect(api.getAdminSites).toHaveBeenCalledTimes(2)
      expect(api.getMetadata).toHaveBeenCalledTimes(3)
    })
  })

  it('opens contextual details from the catalog and lets the user switch or close them', async () => {
    vi.mocked(api.searchFurniture).mockResolvedValueOnce(catalogResult)
    const user = userEvent.setup()
    render(<App />)

    const context = await screen.findByRole('region', { name: '家具详情与库存位置' })
    expect(context).not.toHaveClass('is-open')

    await user.click(screen.getByRole('button', { name: /弧背会议椅/ }))
    expect(context).toHaveClass('is-open', 'is-detail-view')
    expect(screen.getByRole('tab', { name: '家具详情' })).toHaveAttribute('aria-selected', 'true')

    await user.click(screen.getByRole('tab', { name: '库存位置' }))
    expect(context).toHaveClass('is-open', 'is-map-view')

    await user.click(screen.getByRole('button', { name: '关闭详情面板' }))
    expect(context).not.toHaveClass('is-open')
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

  it('opens furniture details when Chat returns one matching item', async () => {
    vi.mocked(api.streamAgent).mockImplementation(async (_message, handlers) => {
      handlers.onResult({ ...catalogResult, answer: '找到一把会议椅。' })
      handlers.onTextDelta('找到一把会议椅。')
      handlers.onDone?.()
    })
    const user = userEvent.setup()
    render(<App />)

    const context = await screen.findByRole('region', { name: '家具详情与库存位置' })
    expect(context).not.toHaveClass('is-open')

    await user.type(screen.getByRole('textbox', { name: '自然语言查询' }), '找一把会议椅')
    await user.click(screen.getByRole('button', { name: '发送查询' }))

    expect(await screen.findByText('找到一把会议椅。')).toBeInTheDocument()
    expect(context).toHaveClass('is-open', 'is-detail-view')
  })
})
