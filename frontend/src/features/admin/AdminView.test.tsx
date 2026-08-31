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
  render(
    <AdminView
      metadata={metadata}
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

  it('transfers from the selected site with both inventory versions', async () => {
    const user = userEvent.setup()
    const { onTransfer } = renderAdmin()
    await user.click(screen.getByRole('button', { name: '编辑 弧背会议椅' }))

    await user.click(screen.getByRole('button', { name: '从北京园区调拨' }))
    const transferForm = screen.getByRole('form', { name: '从北京园区调拨' })
    await user.selectOptions(within(transferForm).getByLabelText('目标园区'), 'site-shanghai')
    await user.clear(within(transferForm).getByLabelText('数量'))
    await user.type(within(transferForm).getByLabelText('数量'), '2')
    await user.type(within(transferForm).getByLabelText('原因'), '上海培训活动')
    await user.click(within(transferForm).getByRole('button', { name: '确认调拨' }))

    expect(onTransfer).toHaveBeenCalledWith('inventory-arc-bj', {
      destination_site_id: 'site-shanghai',
      quantity: 2,
      reason: '上海培训活动',
      expected_source_version: 1,
      expected_destination_version: 3,
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
