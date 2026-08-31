import { type FormEvent, useState } from 'react'
import { Boxes, Check, Plus, Search, Trash2, X } from 'lucide-react'
import type {
  CatalogMetadata,
  CreateInventoryPositionInput,
  Furniture,
  InventoryAdjustmentInput,
  InventoryTransferInput,
  ImageUploadInput,
} from '../../types'
import { ImageManager } from './ImageManager'
import { InventoryPositions } from './InventoryPositions'

type AdminViewProps = {
  metadata: CatalogMetadata
  furniture: Furniture[]
  onSave: (event: FormEvent<HTMLFormElement>, furnitureId?: string) => Promise<boolean>
  onDelete: (furnitureId: string) => Promise<boolean>
  onAdjust: (inventoryId: string, payload: InventoryAdjustmentInput) => Promise<boolean>
  onTransfer: (inventoryId: string, payload: InventoryTransferInput) => Promise<boolean>
  onCreatePosition: (
    furnitureId: string,
    payload: CreateInventoryPositionInput,
  ) => Promise<boolean>
  onUploadImage: (furnitureId: string, file: File, metadata: ImageUploadInput, onProgress: (percent: number) => void) => Promise<boolean>
  onReorderImages: (furnitureId: string, imageIds: string[]) => Promise<boolean>
  onSetPrimaryImage: (furnitureId: string, imageId: string) => Promise<boolean>
  onDeleteImage: (furnitureId: string, imageId: string) => Promise<boolean>
}

export function AdminView({
  metadata,
  furniture,
  onSave,
  onDelete,
  onAdjust,
  onTransfer,
  onCreatePosition,
  onUploadImage,
  onReorderImages,
  onSetPrimaryImage,
  onDeleteImage,
}: AdminViewProps) {
  const [editingId, setEditingId] = useState<string>()
  const editing = furniture.find((item) => item.id === editingId)
  const categoryId = metadata.categories.find((category) => category.name === editing?.category)?.id

  async function submit(event: FormEvent<HTMLFormElement>) {
    if (await onSave(event, editing?.id)) setEditingId(undefined)
  }

  async function remove() {
    if (editing && await onDelete(editing.id)) setEditingId(undefined)
  }

  return (
    <main className="admin-page">
      <section className="admin-heading">
        <div><span className="eyebrow">ADMINISTRATION</span><h1>数据管理</h1><p>在这里维护家具目录。所有库存变化都会形成审计记录。</p></div>
        <span className="record-total"><Boxes size={19} />{furniture.length} 类家具</span>
      </section>
      <div className="admin-layout">
        <section className="admin-form-section">
          <div className="form-heading">
            <h2>{editing ? '编辑家具' : '新增家具'}</h2>
            {editing && <button type="button" onClick={() => setEditingId(undefined)} aria-label="取消编辑"><X size={16} /></button>}
          </div>
          <form className="admin-form" key={editing?.id ?? 'new'} onSubmit={submit}>
            <label><span>家具名称</span><input name="name" required defaultValue={editing?.name} placeholder="例如：可堆叠访客椅" /></label>
            <label><span>资产编号</span><input name="sku" required readOnly={Boolean(editing)} defaultValue={editing?.sku} placeholder="CHR-VIS-01" /></label>
            <div className="form-row">
              <label><span>分类</span><select name="category_id" required defaultValue={categoryId}>{metadata.categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
              <label><span>状态</span><select name="condition" defaultValue={editing?.condition ?? 'good'}><option value="excellent">近新</option><option value="good">良好</option><option value="fair">可用</option><option value="repair">待维修</option></select></label>
            </div>
            <label><span>英文名称</span><input name="name_en" defaultValue={editing?.name_en} placeholder="English name" /></label>
            <div className="form-row">
              <label><span>尺寸</span><input name="dimensions" defaultValue={editing?.dimensions} placeholder="700*700*1000" /></label>
              <label><span>颜色</span><input name="color" defaultValue={editing?.color} placeholder="黑色" /></label>
            </div>
            <div className="form-row">
              <label><span>材质</span><input name="material" defaultValue={editing?.material} placeholder="布艺 / 金属" /></label>
              <label><span>品牌</span><input name="brand" defaultValue={editing?.brand} placeholder="Haworth" /></label>
            </div>
            {!editing && <label><span>所在园区</span><select name="site_id" required>{metadata.sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>}
            {!editing && <label><span>初始数量</span><input name="quantity" type="number" min="0" defaultValue="1" required /></label>}
            <label><span>图片地址</span><input name="image_url" type="url" defaultValue={editing?.images[0]?.url} placeholder="https://..." /></label>
            <label><span>描述</span><textarea name="description" rows={3} defaultValue={editing?.description} placeholder="材质、尺寸与适用场景" /></label>
            <div className="form-actions">
              <button className="primary-button" type="submit">{editing ? <Check size={17} /> : <Plus size={17} />}{editing ? '保存修改' : '加入目录'}</button>
              {editing && <button className="danger-button" type="button" onClick={() => void remove()}><Trash2 size={16} />删除</button>}
            </div>
          </form>
          {editing && (
            <>
              <InventoryPositions
                furniture={editing}
                sites={metadata.sites}
                onAdjust={onAdjust}
                onTransfer={onTransfer}
                onCreatePosition={onCreatePosition}
              />
              <ImageManager
                furniture={editing}
                onUpload={onUploadImage}
                onReorder={onReorderImages}
                onSetPrimary={onSetPrimaryImage}
                onDelete={onDeleteImage}
              />
            </>
          )}
        </section>
        <section className="inventory-table-section">
          <div className="table-heading"><div><h2>家具与库存</h2><p>总量用于浏览，编辑后可维护各园区库存</p></div><Search size={18} /></div>
          <div className="inventory-table">
            {furniture.map((item) => (
                <div className="inventory-row" key={item.id}>
                  {item.images[0] ? <img src={item.images[0].url} alt="" /> : <span className="image-placeholder" />}
                  <div className="inventory-name"><small>{item.sku}</small><strong>{item.name}</strong><span>{item.brand && item.brand !== '-' ? item.brand : item.category} · {item.dimensions || '尺寸未记录'}</span></div>
                  <div className="inventory-sites">{item.inventory.map((position) => <span key={position.id}>{position.site.code} {position.quantity_available}/{position.quantity_total}</span>)}</div>
                  <strong className="inventory-count">{item.quantity_available}</strong>
                  <button type="button" className="row-action" onClick={() => setEditingId(item.id)} aria-label={`编辑 ${item.name}`}><span>编辑</span></button>
                </div>
              ))}
          </div>
        </section>
      </div>
    </main>
  )
}
