import { type FormEvent, useState } from 'react'
import { ArrowRightLeft, PackagePlus, SlidersHorizontal, X } from 'lucide-react'
import type {
  CreateInventoryPositionInput,
  Furniture,
  InventoryAdjustmentInput,
  InventoryPosition,
  InventoryTransferInput,
  Site,
} from '../../types'

type ActiveOperation =
  | { mode: 'adjust'; inventoryId: string }
  | { mode: 'transfer'; inventoryId: string }
  | { mode: 'create' }

type InventoryPositionsProps = {
  furniture: Furniture
  sites: Site[]
  onAdjust: (inventoryId: string, payload: InventoryAdjustmentInput) => Promise<boolean>
  onTransfer: (inventoryId: string, payload: InventoryTransferInput) => Promise<boolean>
  onCreatePosition: (
    furnitureId: string,
    payload: CreateInventoryPositionInput,
  ) => Promise<boolean>
  onOpenTransfers: () => void
}

const adjustmentKinds = {
  acquisition: { label: '采购入库', totalSign: 1, availableSign: 1 },
  disposal: { label: '资产报废', totalSign: -1, availableSign: -1 },
  loan: { label: '借出占用', totalSign: 0, availableSign: -1 },
  return: { label: '归还入库', totalSign: 0, availableSign: 1 },
  repair: { label: '送修占用', totalSign: 0, availableSign: -1 },
  repair_return: { label: '维修恢复', totalSign: 0, availableSign: 1 },
} as const

type AdjustmentKind = keyof typeof adjustmentKinds

export function InventoryPositions({
  furniture,
  sites,
  onAdjust,
  onTransfer,
  onCreatePosition,
  onOpenTransfers,
}: InventoryPositionsProps) {
  const [active, setActive] = useState<ActiveOperation>()
  const [transferQuantity, setTransferQuantity] = useState(1)
  const [transferCompleted, setTransferCompleted] = useState(false)
  const occupiedSiteIds = new Set(furniture.inventory.map((position) => position.site.id))
  const missingSites = sites.filter((site) => !occupiedSiteIds.has(site.id))

  async function submitAdjustment(
    event: FormEvent<HTMLFormElement>,
    position: InventoryPosition,
  ) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const kind = String(form.get('kind')) as AdjustmentKind
    const quantity = Number(form.get('quantity'))
    const reason = String(form.get('reason')).trim()
    const rule = adjustmentKinds[kind]
    const saved = await onAdjust(position.id, {
      kind,
      delta_total: rule.totalSign * quantity,
      delta_available: rule.availableSign * quantity,
      reason,
      expected_version: position.version,
    })
    if (saved) setActive(undefined)
  }

  async function submitTransfer(
    event: FormEvent<HTMLFormElement>,
    position: InventoryPosition,
  ) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const destinationSiteId = String(form.get('destination_site_id'))
    const saved = await onTransfer(position.id, {
      destination_site_id: destinationSiteId,
      quantity: transferQuantity,
      reason: String(form.get('reason')).trim(),
      expected_source_version: position.version,
    })
    if (saved) {
      setActive(undefined)
      setTransferCompleted(true)
    }
  }

  async function submitPosition(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const saved = await onCreatePosition(furniture.id, {
      site_id: String(form.get('site_id')),
      quantity_total: Number(form.get('quantity_total')),
      quantity_available: Number(form.get('quantity_available')),
    })
    if (saved) setActive(undefined)
  }

  return (
    <section className="inventory-positions" aria-label="各园区库存">
      <div className="inventory-positions-heading">
        <div>
          <span className="eyebrow">SITE INVENTORY</span>
          <h3>各园区库存</h3>
        </div>
        <span>{furniture.quantity_available} 件可用</span>
      </div>

      <div className="inventory-position-list">
        {furniture.inventory.map((position) => {
          const otherSites = sites.filter((site) => site.id !== position.site.id)
          const isAdjusting =
            active?.mode === 'adjust' && active.inventoryId === position.id
          const isTransferring =
            active?.mode === 'transfer' && active.inventoryId === position.id
          return (
            <article className="inventory-position-card" key={position.id}>
              <div className="inventory-position-summary">
                <span className="site-code">{position.site.code}</span>
                <div>
                  <strong>{position.site.name}</strong>
                  <small>可用 / 总量</small>
                </div>
                <strong className="site-quantity">
                  {position.quantity_available} / {position.quantity_total}
                </strong>
                <div className="site-actions">
                  <button
                    type="button"
                    aria-label={`调整${position.site.name}库存`}
                    onClick={() => setActive({ mode: 'adjust', inventoryId: position.id })}
                  >
                    <SlidersHorizontal size={15} />调整
                  </button>
                  <button
                    type="button"
                    aria-label={`从${position.site.name}调拨`}
                    disabled={otherSites.length === 0 || position.quantity_available === 0}
                    onClick={() => {
                      setTransferQuantity(1)
                      setActive({ mode: 'transfer', inventoryId: position.id })
                    }}
                  >
                    <ArrowRightLeft size={15} />调拨
                  </button>
                </div>
              </div>

              {isAdjusting && (
                <form
                  className="inventory-operation-form"
                  aria-label={`调整${position.site.name}库存`}
                  onSubmit={(event) => void submitAdjustment(event, position)}
                >
                  <label>
                    <span>业务类型</span>
                    <select name="kind" defaultValue="acquisition">
                      {Object.entries(adjustmentKinds).map(([value, rule]) => (
                        <option value={value} key={value}>{rule.label}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>数量</span>
                    <input name="quantity" type="number" min="1" defaultValue="1" required />
                  </label>
                  <label className="operation-reason">
                    <span>原因</span>
                    <input name="reason" required placeholder="例如：三层会议室借用" />
                  </label>
                  <button className="primary-button compact" type="submit">确认调整</button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="取消库存调整"
                    onClick={() => setActive(undefined)}
                  >
                    <X size={15} />
                  </button>
                </form>
              )}

              {isTransferring && (
                <form
                  className="inventory-operation-form"
                  aria-label={`从${position.site.name}调拨`}
                  onSubmit={(event) => void submitTransfer(event, position)}
                >
                  <label>
                    <span>目标园区</span>
                    <select name="destination_site_id" required>
                      {otherSites.map((site) => (
                        <option value={site.id} key={site.id}>{site.name}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>数量</span>
                    <input
                      name="quantity"
                      type="number"
                      min="1"
                      max={position.quantity_available}
                      value={transferQuantity}
                      onChange={(event) => setTransferQuantity(Number(event.target.value))}
                      required
                    />
                  </label>
                  <label className="operation-reason">
                    <span>原因</span>
                    <input name="reason" required placeholder="例如：上海培训活动" />
                  </label>
                  <div className="transfer-warning" role="note">
                    <p>当前共享 {position.quantity_available} 件，本次调拨 {transferQuantity || 0} 件。</p>
                    <p>
                      确认后，该共享批次将全部下架；目标园区不会自动入库，剩余{' '}
                      {Math.max(position.quantity_available - (transferQuantity || 0), 0)} 件也不会继续出现在共享目录中。
                    </p>
                  </div>
                  <button
                    className="primary-button compact"
                    type="submit"
                    disabled={
                      !Number.isInteger(transferQuantity)
                      || transferQuantity < 1
                      || transferQuantity > position.quantity_available
                    }
                  >
                    确认调拨并下架
                  </button>
                  <button
                    className="icon-button"
                    type="button"
                    aria-label="取消库存调拨"
                    onClick={() => setActive(undefined)}
                  >
                    <X size={15} />
                  </button>
                </form>
              )}
            </article>
          )
        })}
      </div>

      {transferCompleted && (
        <button className="view-transfer-history" type="button" onClick={onOpenTransfers}>
          <ArrowRightLeft size={15} />查看调拨记录
        </button>
      )}

      {missingSites.length > 0 && active?.mode !== 'create' && (
        <button
          className="add-position-button"
          type="button"
          onClick={() => setActive({ mode: 'create' })}
        >
          <PackagePlus size={16} />添加园区库存
        </button>
      )}

      {active?.mode === 'create' && (
        <form
          className="inventory-operation-form create-position-form"
          aria-label="添加园区库存"
          onSubmit={(event) => void submitPosition(event)}
        >
          <label>
            <span>园区</span>
            <select name="site_id" required>
              {missingSites.map((site) => (
                <option value={site.id} key={site.id}>{site.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>总量</span>
            <input name="quantity_total" type="number" min="0" defaultValue="0" required />
          </label>
          <label>
            <span>可用量</span>
            <input name="quantity_available" type="number" min="0" defaultValue="0" required />
          </label>
          <button className="primary-button compact" type="submit">确认添加</button>
          <button
            className="icon-button"
            type="button"
            aria-label="取消添加园区库存"
            onClick={() => setActive(undefined)}
          >
            <X size={15} />
          </button>
        </form>
      )}
    </section>
  )
}
