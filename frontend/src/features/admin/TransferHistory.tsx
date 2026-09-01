import { type FormEvent, useState } from 'react'
import { ArrowRight, ArrowRightLeft, Filter, History } from 'lucide-react'
import type { ManagedSite, TransferFilters, TransferRecord } from '../../types'

type TransferHistoryProps = {
  records: TransferRecord[]
  sites: ManagedSite[]
  loading: boolean
  nextCursor: string | null
  onLoad: (filters: TransferFilters) => Promise<boolean>
}

export function TransferHistory({
  records,
  sites,
  loading,
  nextCursor,
  onLoad,
}: TransferHistoryProps) {
  const [activeFilters, setActiveFilters] = useState<TransferFilters>({})

  function filtersFromForm(form: HTMLFormElement): TransferFilters {
    const data = new FormData(form)
    return {
      source_site_id: String(data.get('source_site_id')),
      destination_site_id: String(data.get('destination_site_id')),
      from: String(data.get('from')),
      to: String(data.get('to')),
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const filters = filtersFromForm(event.currentTarget)
    setActiveFilters(filters)
    await onLoad(filters)
  }

  return (
    <section className="admin-resource-section transfer-history" aria-label="调拨记录">
      <header className="resource-heading">
        <div>
          <span className="eyebrow">ALLOCATION LOG</span>
          <h2>调拨记录</h2>
          <p>每条记录均不可编辑，保留领取数量与整批下架的完整事实。</p>
        </div>
        <span className="record-total"><History size={18} />{records.length} 条记录</span>
      </header>

      <form className="history-filters" onSubmit={(event) => void submit(event)}>
        <label>
          <span>来源园区</span>
          <select name="source_site_id" defaultValue="">
            <option value="">全部来源</option>
            {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
        <label>
          <span>目标园区</span>
          <select name="destination_site_id" defaultValue="">
            <option value="">全部目标</option>
            {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        </label>
        <label><span>开始日期</span><input name="from" type="date" /></label>
        <label><span>结束日期</span><input name="to" type="date" /></label>
        <button className="primary-button compact" type="submit" disabled={loading}>
          <Filter size={15} />筛选记录
        </button>
      </form>

      <div className="transfer-table" aria-busy={loading}>
        <div className="transfer-table-header" aria-hidden="true">
          <span>时间 / 家具</span><span>调拨路径</span><span>下架前</span><span>调拨</span><span>未继续共享</span><span>操作</span>
        </div>
        {records.map((record) => (
          <article className="transfer-row" key={record.id}>
            <div className="transfer-identity">
              <time dateTime={record.created_at}>{new Date(record.created_at).toLocaleString('zh-CN')}</time>
              <strong>{record.furniture_name}</strong>
              <small>{record.furniture_sku}</small>
            </div>
            <div className="transfer-route">
              <span><b>{record.source_site_code_snapshot}</b>{record.source_site_name_snapshot}</span>
              <ArrowRight size={16} />
              <span><b>{record.destination_site_code_snapshot}</b>{record.destination_site_name_snapshot}</span>
            </div>
            <strong className="transfer-number">{record.listed_quantity_before}</strong>
            <strong className="transfer-number is-primary">{record.transferred_quantity}</strong>
            <strong className="transfer-number is-muted">{record.unlisted_remainder}</strong>
            <div className="transfer-meta">
              <span>{record.actor_label_snapshot}</span>
              <small>{record.reason}</small>
            </div>
          </article>
        ))}
        {!loading && records.length === 0 && (
          <div className="empty-state">
            <ArrowRightLeft size={24} />
            <span>暂无符合条件的调拨记录</span>
          </div>
        )}
      </div>

      {nextCursor && (
        <button
          className="quiet-button history-more"
          type="button"
          disabled={loading}
          onClick={() => void onLoad({ ...activeFilters, cursor: nextCursor })}
        >
          加载更多
        </button>
      )}
    </section>
  )
}
