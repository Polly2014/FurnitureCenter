import { type CSSProperties, type FormEvent, type PointerEvent, startTransition, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Boxes,
  Check,
  Armchair,
  Search,
  Settings2,
  X,
} from 'lucide-react'
import './App.css'
import {
  adjustInventory,
  createFurniture,
  deleteFurniture,
  getAgentStatus,
  getMetadata,
  searchFurniture,
  streamAgent,
  updateFurniture,
} from './api'
import { SpatialMap } from './components/SpatialMap'
import { ResizeHandle } from './components/ResizeHandle'
import { AdminView } from './features/admin/AdminView'
import { FurnitureDetail } from './features/gallery/FurnitureDetail'
import { ChatWorkspace, type ChatMessage } from './features/query/ChatWorkspace'
import type { AgentStatus, CatalogMetadata, QueryResult } from './types'

const emptyResult: QueryResult = {
  items: [],
  map_features: [],
  total: 0,
  applied_query: null,
  applied_filters: {},
  answer: null,
}

const conditionLabels: Record<string, string> = {
  excellent: '近新',
  good: '良好',
  fair: '可用',
  repair: '待维修',
}

const initialMessages: ChatMessage[] = [
  {
    id: 'welcome',
    role: 'assistant',
    content: '你好，我可以帮你按家具类型、品牌、库存和园区查询。目录、产品详情和位置会随回答同步更新。',
  },
]

function App() {
  const [view, setView] = useState<'query' | 'admin'>('query')
  const [metadata, setMetadata] = useState<CatalogMetadata>({ categories: [], sites: [] })
  const [agentStatus, setAgentStatus] = useState<AgentStatus>()
  const [result, setResult] = useState<QueryResult>(emptyResult)
  const [selectedId, setSelectedId] = useState<string>()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [siteId, setSiteId] = useState('')
  const [agentMessage, setAgentMessage] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages)
  const [agentPhase, setAgentPhase] = useState<'planning' | 'answering'>('planning')
  const [catalogWidth, setCatalogWidth] = useState(250)
  const [contextWidth, setContextWidth] = useState(390)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const workspaceRef = useRef<HTMLElement>(null)

  const selected = result.items.find((item) => item.id === selectedId)
  const selectedMapFeatures = useMemo<QueryResult['map_features']>(() => selected?.inventory.map((position) => ({
    site_id: position.site.id,
    site_name: position.site.name,
    latitude: position.site.latitude,
    longitude: position.site.longitude,
    quantity_available: position.quantity_available,
    furniture_ids: [selected.id],
  })) ?? [], [selected])
  const selectedSiteIds = useMemo(() => selectedMapFeatures.map((feature) => feature.site_id), [selectedMapFeatures])
  const mapFeatures = selected ? selectedMapFeatures : result.map_features
  const mapSelectedSiteIds = selected ? selectedSiteIds : []
  const mapLocationLabel = selected
    ? (selected.inventory.length === 1 ? selected.inventory[0].site.name : `${selected.inventory.length} 个园区`)
    : (mapFeatures.length ? `全部结果 · ${mapFeatures.length} 个园区` : '暂无位置')

  async function loadCatalog(overrides?: { query?: string; category?: string; site_id?: string }) {
    setLoading(true)
    setError(undefined)
    try {
      const next = await searchFurniture({
        query: overrides?.query ?? query,
        category: overrides?.category ?? category,
        site_id: overrides?.site_id ?? siteId,
        available_only: true,
      })
      startTransition(() => {
        setResult(next)
        setSelectedId(undefined)
      })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '无法加载家具目录')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    Promise.all([getMetadata(), searchFurniture({ available_only: true }), getAgentStatus()])
      .then(([nextMetadata, nextResult, nextAgentStatus]) => {
        setMetadata(nextMetadata)
        setResult(nextResult)
        setAgentStatus(nextAgentStatus)
        setSelectedId(undefined)
      })
      .catch((requestError: Error) => setError(requestError.message))
      .finally(() => setLoading(false))
  }, [])

  async function runAgent(message: string) {
    const content = message.trim()
    if (!content || loading) return
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', content }])
    setAgentMessage('')
    setAgentPhase('planning')
    setLoading(true)
    setError(undefined)
    const assistantId = `assistant-${Date.now()}`
    let assistantStarted = false
    let fallbackAnswer = '查询已完成，结果已同步到目录、产品详情和位置。'
    let pendingText = ''
    let sourceDone = false
    let flushTimer: number | undefined
    let resolveDrain: () => void = () => undefined
    const drainPromise = new Promise<void>((resolve) => { resolveDrain = resolve })

    const appendAssistantText = (text: string) => {
      const isFirstText = !assistantStarted
      assistantStarted = true
      setMessages((current) => {
        if (isFirstText) {
          return [...current, { id: assistantId, role: 'assistant', content: text }]
        }
        return current.map((entry) =>
          entry.id === assistantId ? { ...entry, content: entry.content + text } : entry,
        )
      })
    }

    const flushText = () => {
      flushTimer = undefined
      const characters = Array.from(pendingText)
      if (characters.length > 0) {
        const chunk = characters.slice(0, 2).join('')
        pendingText = characters.slice(2).join('')
        appendAssistantText(chunk)
        flushTimer = window.setTimeout(flushText, 20)
      } else if (sourceDone) {
        resolveDrain()
      }
    }

    const scheduleFlush = () => {
      if (flushTimer === undefined) flushTimer = window.setTimeout(flushText, 20)
    }
    try {
      await streamAgent(content, {
        onStatus: (phase) => {
          if (phase === 'planning' || phase === 'answering') setAgentPhase(phase)
        },
        onResult: (next) => {
          setResult(next)
          setSelectedId(next.items.length === 1 ? next.items[0].id : undefined)
          fallbackAnswer = next.answer ?? fallbackAnswer
        },
        onTextDelta: (delta) => {
          pendingText += delta
          scheduleFlush()
        },
        onDone: () => {
          sourceDone = true
          if (!assistantStarted && !pendingText) appendAssistantText(fallbackAnswer)
          scheduleFlush()
        },
      })
      sourceDone = true
      scheduleFlush()
      await drainPromise
    } catch (requestError) {
      if (flushTimer !== undefined) window.clearTimeout(flushTimer)
      const message = requestError instanceof Error ? requestError.message : '智能查询失败'
      setError(message)
      setMessages((current) => [
        ...current,
        { id: `assistant-error-${Date.now()}`, role: 'assistant', content: `查询没有完成：${message}` },
      ])
    } finally {
      setLoading(false)
    }
  }

  function submitAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void runAgent(agentMessage)
  }

  function clearConversation() {
    setMessages(initialMessages)
    setAgentMessage('')
    setError(undefined)
  }

  function selectMapFeature(feature: QueryResult['map_features'][number]) {
    const furnitureId = feature.furniture_ids.find((id) => result.items.some((item) => item.id === id))
    if (furnitureId) setSelectedId(furnitureId)
  }

  function changeCategory(nextCategory: string) {
    setCategory(nextCategory)
    void loadCatalog({ category: nextCategory })
  }

  function changeSite(nextSiteId: string) {
    setSiteId(nextSiteId)
    void loadCatalog({ site_id: nextSiteId })
  }

  async function saveFurniture(event: FormEvent<HTMLFormElement>, furnitureId?: string) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    try {
      const payload = {
        sku: String(form.get('sku')),
        name: String(form.get('name')),
        category_id: String(form.get('category_id')),
        description: String(form.get('description')),
        condition: String(form.get('condition')),
        name_en: String(form.get('name_en')),
        main_category: '',
        dimensions: String(form.get('dimensions')),
        color: String(form.get('color')),
        material: String(form.get('material')),
        brand: String(form.get('brand')),
        site_id: String(form.get('site_id')),
        quantity: Number(form.get('quantity')),
        image_url: String(form.get('image_url')) || null,
      }
      if (furnitureId) await updateFurniture(furnitureId, payload)
      else await createFurniture(payload)
      formElement.reset()
      setNotice(furnitureId ? '家具信息已更新' : '家具已加入目录')
      await loadCatalog({ query: '', category: '', site_id: '' })
      return true
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '新增失败')
      return false
    }
  }

  async function removeFurniture(furnitureId: string) {
    try {
      await deleteFurniture(furnitureId)
      setNotice('家具已删除')
      await loadCatalog({ query: '', category: '', site_id: '' })
      return true
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '删除失败')
      return false
    }
  }

  async function changeInventory(inventoryId: string, delta: number) {
    try {
      await adjustInventory(inventoryId, delta, delta > 0 ? '管理界面入库' : '管理界面盘点扣减')
      setNotice(delta > 0 ? '库存已增加' : '库存已扣减')
      await loadCatalog({ query: '', category: '', site_id: '' })
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '库存调整失败')
    }
  }

  function openAdministration() {
    setView('admin')
    setQuery('')
    setCategory('')
    setSiteId('')
    void loadCatalog({ query: '', category: '', site_id: '' })
  }

  function beginResize(pane: 'catalog' | 'context', event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = pane === 'catalog' ? catalogWidth : contextWidth
    const workspaceWidth = workspaceRef.current?.clientWidth ?? window.innerWidth
    const fixedOppositeWidth = pane === 'catalog' ? contextWidth : catalogWidth
    const maximum = Math.min(pane === 'catalog' ? 410 : 560, workspaceWidth - fixedOppositeWidth - 432)
    const minimum = pane === 'catalog' ? 220 : 330

    const onMove = (moveEvent: globalThis.PointerEvent) => {
      const delta = moveEvent.clientX - startX
      const proposed = pane === 'catalog' ? startWidth + delta : startWidth - delta
      const nextWidth = Math.max(minimum, Math.min(maximum, proposed))
      if (pane === 'catalog') setCatalogWidth(nextWidth)
      else setContextWidth(nextWidth)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      document.body.classList.remove('is-resizing')
    }
    document.body.classList.add('is-resizing')
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setView('query')}>
          <span className="brand-mark"><Armchair size={18} /></span>
          <span><strong>FURNITURE CENTER</strong><small>家具中心</small></span>
        </button>
        <nav className="view-switcher" aria-label="主导航">
          <button className={view === 'query' ? 'is-active' : ''} onClick={() => setView('query')}><Search size={16} />查询工作台</button>
          <button className={view === 'admin' ? 'is-active' : ''} onClick={openAdministration}><Settings2 size={16} />数据管理</button>
        </nav>
        <div className="system-state"><span />目录在线</div>
      </header>

      {error && <div className="toast error"><X size={16} />{error}<button onClick={() => setError(undefined)} aria-label="关闭"><X size={14} /></button></div>}
      {notice && <div className="toast success"><Check size={16} />{notice}<button onClick={() => setNotice(undefined)} aria-label="关闭"><X size={14} /></button></div>}

      {view === 'query' ? (
        <main
          className="query-workspace"
          ref={workspaceRef}
          style={{
            '--catalog-width': `${catalogWidth}px`,
            '--context-width': `${contextWidth}px`,
          } as CSSProperties}
        >
          <aside className="catalog-panel">
            <div className="panel-heading"><div><span className="eyebrow">CATALOG</span><h1>家具目录</h1></div><span className="result-count">{result.total}</span></div>
            <form className="filters" onSubmit={(event) => { event.preventDefault(); void loadCatalog() }}>
              <label className="search-field"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、编号或描述" /><button type="submit" aria-label="搜索"><ArrowRight size={16} /></button></label>
              <div className="filter-row">
                <select value={category} onChange={(event) => changeCategory(event.target.value)} aria-label="分类"><option value="">全部分类</option>{metadata.categories.map((item) => <option key={item.id} value={item.name}>{item.name}</option>)}</select>
                <select value={siteId} onChange={(event) => changeSite(event.target.value)} aria-label="园区"><option value="">全部园区</option>{metadata.sites.map((site) => <option key={site.id} value={site.id}>{site.city}</option>)}</select>
              </div>
            </form>
            <div className="catalog-list" aria-busy={loading}>
              {result.items.map((item) => (
                <button key={item.id} className={`catalog-item${selected?.id === item.id ? ' is-selected' : ''}`} onClick={() => setSelectedId(item.id)}>
                  {item.images[0] ? <img src={item.images[0].url} alt={item.images[0].alt_text} /> : <span className="image-placeholder" />}
                  <span className="item-copy"><small>{item.sku}</small><strong>{item.name}</strong><span>{item.brand && item.brand !== '-' ? item.brand : item.category} · {item.dimensions || (conditionLabels[item.condition] ?? item.condition)}</span></span>
                  <span className="availability"><b>{item.quantity_available}</b>可用</span>
                </button>
              ))}
              {!loading && result.items.length === 0 && <div className="empty-state"><Boxes size={24} /><span>没有符合条件的家具</span></div>}
            </div>
          </aside>

          <ResizeHandle label="调整目录栏宽度" onResizeStart={(event) => beginResize('catalog', event)} />

          <ChatWorkspace
            messages={messages}
            draft={agentMessage}
            loading={loading}
            phase={agentPhase}
            resultCount={result.total}
            agentStatus={agentStatus}
            onDraftChange={setAgentMessage}
            onSubmit={submitAgent}
            onSuggestion={(message) => void runAgent(message)}
            onClear={clearConversation}
          />

          <ResizeHandle label="调整详情栏宽度" onResizeStart={(event) => beginResize('context', event)} />

          <section className={`context-panel${selected ? '' : ' is-overview'}`}>
            {selected && <aside className="detail-panel"><FurnitureDetail item={selected} /></aside>}
            <section className="compact-map-panel">
              <header><div><span className="eyebrow">LOCATION</span><strong>{selected ? '库存位置' : '全部库存位置'}</strong></div><small>{mapLocationLabel}</small></header>
              <SpatialMap compact features={mapFeatures} selectedSiteIds={mapSelectedSiteIds} onSelect={selectMapFeature} />
            </section>
          </section>
        </main>
      ) : (
        <AdminView metadata={metadata} furniture={result.items} onSave={saveFurniture} onDelete={removeFurniture} onAdjust={(id, delta) => void changeInventory(id, delta)} />
      )}
    </div>
  )
}

export default App
