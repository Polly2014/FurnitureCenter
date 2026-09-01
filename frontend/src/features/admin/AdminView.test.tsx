import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { CatalogMetadata, Furniture } from '../../types'
import { AdminView } from './AdminView'

const beijing = {
  id: 'site-beijing',
  code: 'BJ',
  name: '北京园区',
  city: '北京',
  latitude: 39.9042,
  longitude: 116.4074,
}

const shanghai = {
  id: 'site-shanghai',
  code: 'SH',
  name: '上海园区',
  city: '上海',
  latitude: 31.2304,
  longitude: 121.4737,
}

const shenzhen = {
  id: 'site-shenzhen',
  code: 'SZ',
  name: '深圳园区',
  city: '深圳',
  latitude: 22.5431,
  longitude: 114.0579,
}

const metadata: CatalogMetadata = {
  categories: [{ id: 'category-seating', name: '座椅' }],
  sites: [beijing, shanghai, shenzhen],
}

const adminSites = [beijing, shanghai, shenzhen].map((site) => ({
  ...site,
  is_active: true,
  version: 1,
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
}))

const transfers = [{
  id: 'transfer-1',
  furniture_id: 'furniture-arc-chair',
  furniture_sku: 'CHR-ARC-01',
  furniture_name: '弧背会议椅',
  source_inventory_id: 'inventory-arc-bj',
  source_site_id: 'site-beijing',
  source_site_code_snapshot: 'BJ',
  source_site_name_snapshot: '北京园区',
  destination_site_id: 'site-shanghai',
  destination_site_code_snapshot: 'SH',
  destination_site_name_snapshot: '上海园区',
  listed_quantity_before: 10,
  transferred_quantity: 3,
  unlisted_remainder: 7,
  reason: '上海园区会议室领取',
  actor_token_id: 'token-admin',
  actor_label_snapshot: '管理员',
  created_at: '2026-09-01T08:00:00.000Z',
}]

const chair: Furniture = {
  id: 'furniture-arc-chair',
  sku: 'CHR-ARC-01',
  name: '弧背会议椅',
  category: '座椅',
  description: '灰色织物坐面',
  condition: 'good',
  name_en: 'Arc-back Meeting Chair',
  main_category: '扶手椅和沙发',
  dimensions: '600*600*750',
  color: '灰色',
  material: '布艺 / 金属',
  brand: 'Haworth',
  image_reference: '',
  source_workbook: '',
  source_sheet: '',
  source_row: null,
  quantity_available: 16,
  images: [
    { id: 'image-front', url: '/images/image-front', alt_text: '弧背椅正面', is_primary: true },
    { id: 'image-side', url: '/images/image-side', alt_text: '弧背椅侧面', is_primary: false },
    { id: 'image-detail', url: '/images/image-detail', alt_text: '弧背椅细节', is_primary: false },
  ],
  inventory: [
    {
      id: 'inventory-arc-bj',
      site: beijing,
      quantity_total: 18,
      quantity_available: 12,
      version: 1,
    },
    {
      id: 'inventory-arc-sh',
      site: shanghai,
      quantity_total: 8,
      quantity_available: 4,
      version: 3,
    },
  ],
}

function renderAdmin() {
  const onAdjust = vi.fn().mockResolvedValue(true)
  const onTransfer = vi.fn().mockResolvedValue(true)
  const onCreatePosition = vi.fn().mockResolvedValue(true)
  const onUploadImage = vi.fn().mockResolvedValue(true)
  const onReorderImages = vi.fn().mockResolvedValue(true)
  const onSetPrimaryImage = vi.fn().mockResolvedValue(true)
  const onDeleteImage = vi.fn().mockResolvedValue(true)
  const onCreateSite = vi.fn().mockResolvedValue(true)
  const onUpdateSite = vi.fn().mockResolvedValue(true)
  const onLoadTransfers = vi.fn().mockResolvedValue(true)
  render(
    <AdminView
      metadata={metadata}
      adminSites={adminSites}
      transfers={transfers}
      transferNextCursor={null}
      transfersLoading={false}
      furniture={[chair]}
      onSave={vi.fn().mockResolvedValue(true)}
      onDelete={vi.fn().mockResolvedValue(true)}
      onAdjust={onAdjust}
      onTransfer={onTransfer}
      onCreatePosition={onCreatePosition}
      onUploadImage={onUploadImage}
      onReorderImages={onReorderImages}
      onSetPrimaryImage={onSetPrimaryImage}
      onDeleteImage={onDeleteImage}
      onCreateSite={onCreateSite}
      onUpdateSite={onUpdateSite}
      onLoadTransfers={onLoadTransfers}
    />,
  )
  return {
    onAdjust,
    onTransfer,
    onCreatePosition,
    onUploadImage,
    onReorderImages,
    onSetPrimaryImage,
    onDeleteImage,
    onCreateSite,
    onUpdateSite,
    onLoadTransfers,
  }
}

describe('AdminView site inventory management', () => {
  it('adjusts the explicitly selected Beijing position without targeting Shanghai', async () => {
    const user = userEvent.setup()
    const { onAdjust } = renderAdmin()

    await user.click(screen.getByRole('button', { name: '编辑 弧背会议椅' }))

    const inventorySection = screen.getByRole('region', { name: '各园区库存' })
    expect(within(inventorySection).getByText('12 / 18')).toBeInTheDocument()
    expect(within(inventorySection).getByText('4 / 8')).toBeInTheDocument()

    await user.click(
      within(inventorySection).getByRole('button', { name: '调整北京园区库存' }),
    )
    const adjustmentForm = screen.getByRole('form', { name: '调整北京园区库存' })
    await user.selectOptions(within(adjustmentForm).getByLabelText('业务类型'), 'loan')
    await user.clear(within(adjustmentForm).getByLabelText('数量'))
    await user.type(within(adjustmentForm).getByLabelText('数量'), '2')
    await user.type(within(adjustmentForm).getByLabelText('原因'), '借给三层会议室')
    await user.click(within(adjustmentForm).getByRole('button', { name: '确认调整' }))

    expect(onAdjust).toHaveBeenCalledWith('inventory-arc-bj', {
      kind: 'loan',
      delta_total: 0,
      delta_available: -2,
      reason: '借给三层会议室',
      expected_version: 1,
    })
  })

  it('warns that transfer closes the listing and sends no destination version', async () => {
    const user = userEvent.setup()
    const { onTransfer } = renderAdmin()
    await user.click(screen.getByRole('button', { name: '编辑 弧背会议椅' }))

    await user.click(screen.getByRole('button', { name: '从北京园区调拨' }))
    const transferForm = screen.getByRole('form', { name: '从北京园区调拨' })
    await user.selectOptions(within(transferForm).getByLabelText('目标园区'), 'site-shanghai')
    await user.clear(within(transferForm).getByLabelText('数量'))
    await user.type(within(transferForm).getByLabelText('数量'), '2')
    await user.type(within(transferForm).getByLabelText('原因'), '上海培训活动')
    expect(within(transferForm).getByText(/当前共享 12 件/)).toBeInTheDocument()
    expect(within(transferForm).getByText(/剩余 10 件也不会继续/)).toBeInTheDocument()
    expect(within(transferForm).getByText(/目标园区不会自动入库/)).toBeInTheDocument()
    await user.click(within(transferForm).getByRole('button', { name: '确认调拨并下架' }))

    expect(onTransfer).toHaveBeenCalledWith('inventory-arc-bj', {
      destination_site_id: 'site-shanghai',
      quantity: 2,
      reason: '上海培训活动',
      expected_source_version: 1,
    })
    expect(await screen.findByRole('button', { name: '查看调拨记录' })).toBeInTheDocument()
  })

  it('creates and edits sites from a dedicated administration section', async () => {
    const user = userEvent.setup()
    const { onCreateSite, onUpdateSite } = renderAdmin()

    await user.click(screen.getByRole('button', { name: '园区管理' }))
    expect(screen.getByRole('heading', { name: '园区管理' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '新增园区' }))
    const createForm = screen.getByRole('form', { name: '新增园区' })
    await user.type(within(createForm).getByLabelText('园区编码'), 'GZ')
    await user.type(within(createForm).getByLabelText('园区名称'), '广州园区')
    await user.type(within(createForm).getByLabelText('城市'), '广州')
    await user.type(within(createForm).getByLabelText('纬度'), '23.1291')
    await user.type(within(createForm).getByLabelText('经度'), '113.2644')
    await user.click(within(createForm).getByRole('button', { name: '保存园区' }))
    expect(onCreateSite).toHaveBeenCalledWith({
      code: 'GZ',
      name: '广州园区',
      city: '广州',
      latitude: 23.1291,
      longitude: 113.2644,
      is_active: true,
    })

    await user.click(screen.getByRole('button', { name: '编辑 北京园区' }))
    const editForm = screen.getByRole('form', { name: '编辑北京园区' })
    await user.clear(within(editForm).getByLabelText('纬度'))
    await user.type(within(editForm).getByLabelText('纬度'), '39.91')
    await user.click(within(editForm).getByLabelText('启用园区'))
    await user.click(within(editForm).getByRole('button', { name: '保存修改' }))
    expect(onUpdateSite).toHaveBeenCalledWith('site-beijing', {
      code: 'BJ',
      name: '北京园区',
      city: '北京',
      latitude: 39.91,
      longitude: 116.4074,
      is_active: false,
      expected_version: 1,
    })
  })

  it('shows immutable 10/3/7 transfer history and filters by source and destination', async () => {
    const user = userEvent.setup()
    const { onLoadTransfers } = renderAdmin()

    await user.click(screen.getByRole('button', { name: '调拨记录' }))
    expect(screen.getByRole('heading', { name: '调拨记录' })).toBeInTheDocument()
    const history = screen.getByRole('region', { name: '调拨记录' })
    expect(within(history).getByText('弧背会议椅')).toBeInTheDocument()
    expect(within(history).getByText('10')).toBeInTheDocument()
    expect(within(history).getByText('3')).toBeInTheDocument()
    expect(within(history).getByText('7')).toBeInTheDocument()
    await user.selectOptions(within(history).getByLabelText('来源园区'), 'site-beijing')
    await user.selectOptions(within(history).getByLabelText('目标园区'), 'site-shanghai')
    await user.click(within(history).getByRole('button', { name: '筛选记录' }))
    expect(onLoadTransfers).toHaveBeenCalledWith({
      source_site_id: 'site-beijing',
      destination_site_id: 'site-shanghai',
      from: '',
      to: '',
    })
  })

  it('adds a missing site as its own inventory position', async () => {
    const user = userEvent.setup()
    const { onCreatePosition } = renderAdmin()
    await user.click(screen.getByRole('button', { name: '编辑 弧背会议椅' }))

    await user.click(screen.getByRole('button', { name: '添加园区库存' }))
    const createForm = screen.getByRole('form', { name: '添加园区库存' })
    await user.selectOptions(within(createForm).getByLabelText('园区'), 'site-shenzhen')
    await user.clear(within(createForm).getByLabelText('总量'))
    await user.type(within(createForm).getByLabelText('总量'), '5')
    await user.clear(within(createForm).getByLabelText('可用量'))
    await user.type(within(createForm).getByLabelText('可用量'), '3')
    await user.click(within(createForm).getByRole('button', { name: '确认添加' }))

    expect(onCreatePosition).toHaveBeenCalledWith('furniture-arc-chair', {
      site_id: 'site-shenzhen',
      quantity_total: 5,
      quantity_available: 3,
    })
  })

  it('uploads with local progress and manages primary, order and deletion explicitly', async () => {
    const user = userEvent.setup()
    const {
      onUploadImage,
      onReorderImages,
      onSetPrimaryImage,
      onDeleteImage,
    } = renderAdmin()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:local-preview'),
    })
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(() => undefined),
    })
    await user.click(screen.getByRole('button', { name: '编辑 弧背会议椅' }))

    const imageSection = screen.getByRole('region', { name: '图片管理' })
    expect(within(imageSection).getByText('主图')).toBeInTheDocument()
    await user.click(within(imageSection).getByRole('button', { name: '后移 弧背椅侧面' }))
    expect(onReorderImages).toHaveBeenCalledWith('furniture-arc-chair', [
      'image-front',
      'image-detail',
      'image-side',
    ])

    await user.click(within(imageSection).getByRole('button', { name: '设为主图 弧背椅侧面' }))
    expect(onSetPrimaryImage).toHaveBeenCalledWith('furniture-arc-chair', 'image-side')

    await user.click(within(imageSection).getByRole('button', { name: '删除 弧背椅侧面' }))
    expect(within(imageSection).getByText('确认移除这张图片？')).toBeInTheDocument()
    await user.click(within(imageSection).getByRole('button', { name: '确认删除 弧背椅侧面' }))
    expect(onDeleteImage).toHaveBeenCalledWith('furniture-arc-chair', 'image-side')

    let finishUpload: ((result: boolean) => void) | undefined
    onUploadImage.mockImplementation(
      async (_furnitureId, _file, _metadata, onProgress: (percent: number) => void) => {
        onProgress(42)
        return new Promise<boolean>((resolve) => {
          finishUpload = resolve
        })
      },
    )
    const file = new File(['png'], 'chair.png', { type: 'image/png' })
    await user.upload(within(imageSection).getByLabelText('选择图片'), file)
    expect(within(imageSection).getByRole('img', { name: '待上传预览' })).toHaveAttribute(
      'src',
      'blob:local-preview',
    )
    const altInput = within(imageSection).getByLabelText('图片说明')
    expect(altInput).toHaveValue('弧背会议椅')
    await user.click(within(imageSection).getByRole('button', { name: '上传并保存' }))
    await waitFor(() => expect(within(imageSection).getByRole('progressbar')).toHaveAttribute('value', '42'))
    expect(onUploadImage).toHaveBeenCalledWith(
      'furniture-arc-chair',
      file,
      { alt_text: '弧背会议椅', is_primary: false },
      expect.any(Function),
    )
    finishUpload?.(true)
    await waitFor(() => expect(within(imageSection).queryByRole('progressbar')).not.toBeInTheDocument())
  })

  it('accepts a dropped image through an accessible upload drop zone', async () => {
    const { onUploadImage } = renderAdmin()
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:dropped-preview'),
    })
    await userEvent.setup().click(screen.getByRole('button', { name: '编辑 弧背会议椅' }))
    const imageSection = screen.getByRole('region', { name: '图片管理' })
    const dropped = new File(['png'], 'dropped-chair.png', { type: 'image/png' })

    fireEvent.drop(within(imageSection).getByRole('button', { name: '拖放图片到此处或选择图片' }), {
      dataTransfer: { files: [dropped] },
    })

    expect(within(imageSection).getByRole('img', { name: '待上传预览' })).toHaveAttribute(
      'src',
      'blob:dropped-preview',
    )
    expect(within(imageSection).getByLabelText('图片说明')).toHaveValue('弧背会议椅')
    await userEvent.setup().click(within(imageSection).getByRole('button', { name: '上传并保存' }))
    expect(onUploadImage).toHaveBeenCalledWith(
      'furniture-arc-chair',
      dropped,
      { alt_text: '弧背会议椅', is_primary: false },
      expect.any(Function),
    )
  })
})
