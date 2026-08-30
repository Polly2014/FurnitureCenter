import { Image as ImageIcon } from 'lucide-react'
import type { Furniture } from '../../types'

const conditionLabels: Record<string, string> = {
  excellent: '近新',
  good: '良好',
  fair: '可用',
  repair: '待维修',
}

export function FurnitureDetail({ item }: { item?: Furniture }) {
  if (!item) {
    return <div className="detail-empty"><ImageIcon size={28} /><span>选择家具查看图片与库存</span></div>
  }

  return (
    <>
      <div className="detail-image">
        {item.images[0] ? <img src={item.images[0].url} alt={item.images[0].alt_text} /> : <ImageIcon size={32} />}
        <span>{conditionLabels[item.condition] ?? item.condition}</span>
      </div>
      <div className="detail-copy">
        <span className="eyebrow">{item.sku}</span>
        <h2>{item.name}</h2>
        {item.name_en && <span className="english-name">{item.name_en}</span>}
        <p>{item.description}</p>
      </div>
      <dl className="attribute-grid">
        <div><dt>尺寸</dt><dd>{item.dimensions || '未记录'}</dd></div>
        <div><dt>颜色</dt><dd>{item.color || '未记录'}</dd></div>
        <div><dt>材质</dt><dd>{item.material || '未记录'}</dd></div>
        <div><dt>品牌</dt><dd>{item.brand && item.brand !== '-' ? item.brand : '未记录'}</dd></div>
      </dl>
      <div className="inventory-summary">
        <div><small>当前可用</small><strong>{item.quantity_available}</strong></div>
        <div><small>分布园区</small><strong>{item.inventory.length}</strong></div>
      </div>
      <div className="site-list">
        <h3>库存位置</h3>
        {item.inventory.map((position) => (
          <div key={position.id}>
            <span className="site-dot" />
            <span><strong>{position.site.name}</strong><small>{position.site.city} · {position.site.code}</small></span>
            <b>{position.quantity_available}<small> / {position.quantity_total}</small></b>
          </div>
        ))}
      </div>
      <div className="provenance">
        <span>数据来源</span>
        <strong>{item.source_workbook || '管理界面录入'}</strong>
        {item.source_sheet && <small>{item.source_sheet} · 第 {item.source_row} 行</small>}
        {!item.images.length && item.image_reference && <small>图片：{item.image_reference}</small>}
      </div>
    </>
  )
}