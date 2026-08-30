import { type FormEvent, useState } from 'react'
import { Boxes, Check, Minus, Plus, Search, Trash2, X } from 'lucide-react'
import type { CatalogMetadata, Furniture } from '../../types'

type AdminViewProps = {
  metadata: CatalogMetadata
  furniture: Furniture[]
  onSave: (event: FormEvent<HTMLFormElement>, furnitureId?: string) => Promise<boolean>
  onDelete: (furnitureId: string) => Promise<boolean>
  onAdjust: (inventoryId: string, delta: number) => void
}

export function AdminView({ metadata, furniture, onSave, onDelete, onAdjust }: AdminViewProps) {
  const [editing, setEditing] = useState<Furniture>()
  const categoryId = metadata.categories.find((category) => category.name === editing?.category)?.id

  async function submit(event: FormEvent<HTMLFormElement>) {
    if (await onSave(event, editing?.id)) setEditing(undefined)
  }

  async function remove() {
    if (editing && await onDelete(editing.id)) setEditing(undefined)
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
            {editing && <button type="button" onClick={() => setEditing(undefined)} aria-label="取消编辑"><X size={16} /></button>}
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
            <label><span>{editing ? '所在园区（库存位置不可直接修改）' : '所在园区'}</span><select name="site_id" required disabled={Boolean(editing)} defaultValue={editing?.inventory[0]?.site.id}>{metadata.sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label>
            <label><span>{editing ? '当前库存（请使用右侧加减按钮）' : '初始数量'}</span><input name="quantity" type="number" min="0" defaultValue={editing?.quantity_available ?? 1} readOnly={Boolean(editing)} required /></label>
            <label><span>图片地址</span><input name="image_url" type="url" defaultValue={editing?.images[0]?.url} placeholder="https://..." /></label>
            <label><span>描述</span><textarea name="description" rows={3} defaultValue={editing?.description} placeholder="材质、尺寸与适用场景" /></label>
            <div className="form-actions">
              <button className="primary-button" type="submit">{editing ? <Check size={17} /> : <Plus size={17} />}{editing ? '保存修改' : '加入目录'}</button>
              {editing && <button className="danger-button" type="button" onClick={() => void remove()}><Trash2 size={16} />删除</button>}
            </div>
          </form>
        </section>
        <section className="inventory-table-section">
          <div className="table-heading"><div><h2>家具与库存</h2><p>使用加减按钮生成库存调整记录</p></div><Search size={18} /></div>
          <div className="inventory-table">
            {furniture.map((item) => {
              const inventory = item.inventory[0]
              return (
                <div className="inventory-row" key={item.id}>
                  {item.images[0] ? <img src={item.images[0].url} alt="" /> : <span className="image-placeholder" />}
                  <div className="inventory-name"><small>{item.sku}</small><strong>{item.name}</strong><span>{item.brand && item.brand !== '-' ? item.brand : item.category} · {item.dimensions || '尺寸未记录'}</span></div>
                  <div className="inventory-sites">{item.inventory.map((position) => <span key={position.id}>{position.site.code}</span>)}</div>
                  <strong className="inventory-count">{item.quantity_available}</strong>
                  <div className="stepper">
                    <button type="button" onClick={() => inventory && onAdjust(inventory.id, -1)} disabled={!inventory || inventory.quantity_available === 0} aria-label={`减少 ${item.name} 库存`}><Minus size={15} /></button>
                    <button type="button" onClick={() => inventory && onAdjust(inventory.id, 1)} disabled={!inventory} aria-label={`增加 ${item.name} 库存`}><Plus size={15} /></button>
                  </div>
                  <button type="button" className="row-action" onClick={() => setEditing(item)} aria-label={`编辑 ${item.name}`}><span>编辑</span></button>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </main>
  )
}