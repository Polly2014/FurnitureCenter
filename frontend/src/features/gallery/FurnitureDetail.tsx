import { type MouseEvent, useEffect, useRef, useState } from 'react'
import { Image as ImageIcon, Maximize2, X } from 'lucide-react'
import type { Furniture } from '../../types'

const conditionLabels: Record<string, string> = {
  excellent: '近新',
  good: '良好',
  fair: '可用',
  repair: '待维修',
}

export function FurnitureDetail({ item }: { item?: Furniture }) {
  const [imageOpen, setImageOpen] = useState(false)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const imageTriggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (imageOpen && !dialog.open) dialog.showModal()
    if (!imageOpen && dialog.open) dialog.close()
  }, [imageOpen])

  useEffect(() => {
    if (!imageOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dialogRef.current?.close()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [imageOpen])

  if (!item) {
    return <div className="detail-empty"><ImageIcon size={28} /><span>选择家具查看图片与库存</span></div>
  }

  const primaryImage = item.images[0]
  const lightboxTitleId = `image-lightbox-title-${item.id}`

  function closeFromBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) event.currentTarget.close()
  }

  return (
    <>
      {primaryImage ? (
        <>
          <button ref={imageTriggerRef} type="button" className="detail-image image-zoom-trigger" onClick={() => setImageOpen(true)} aria-label={`查看${item.name}大图`}>
            <img src={primaryImage.url} alt={primaryImage.alt_text} />
            <span className="condition-badge">{conditionLabels[item.condition] ?? item.condition}</span>
            <span className="image-zoom-hint"><Maximize2 size={13} />查看大图</span>
          </button>
          <dialog
            ref={dialogRef}
            className="image-lightbox"
            aria-labelledby={lightboxTitleId}
            onClick={closeFromBackdrop}
            onClose={() => {
              setImageOpen(false)
              imageTriggerRef.current?.focus()
            }}
          >
            <div className="image-lightbox-frame">
              <header>
                <span><small>{item.sku}</small><strong id={lightboxTitleId}>{item.name}</strong></span>
                <button type="button" onClick={() => dialogRef.current?.close()} aria-label="关闭大图"><X size={18} /></button>
              </header>
              <img src={primaryImage.url} alt={primaryImage.alt_text} />
            </div>
          </dialog>
        </>
      ) : (
        <div className="detail-image">
          <ImageIcon size={32} />
          <span className="condition-badge">{conditionLabels[item.condition] ?? item.condition}</span>
        </div>
      )}
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
