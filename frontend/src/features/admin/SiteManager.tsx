import { type FormEvent, useState } from 'react'
import { Building2, Check, MapPin, Plus, X } from 'lucide-react'
import type { CreateSiteInput, ManagedSite, UpdateSiteInput } from '../../types'

type SiteManagerProps = {
  sites: ManagedSite[]
  onCreate: (payload: CreateSiteInput) => Promise<boolean>
  onUpdate: (siteId: string, payload: UpdateSiteInput) => Promise<boolean>
}

export function SiteManager({ sites, onCreate, onUpdate }: SiteManagerProps) {
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<string>()
  const editing = sites.find((site) => site.id === editingId)
  const formSite = editing

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const payload: CreateSiteInput = {
      code: String(form.get('code')),
      name: String(form.get('name')),
      city: String(form.get('city')),
      latitude: Number(form.get('latitude')),
      longitude: Number(form.get('longitude')),
      is_active: form.get('is_active') === 'on',
    }
    const saved = editing
      ? await onUpdate(editing.id, { ...payload, expected_version: editing.version })
      : await onCreate(payload)
    if (saved) {
      setEditingId(undefined)
      setCreating(false)
    }
  }

  function closeForm() {
    setEditingId(undefined)
    setCreating(false)
  }

  return (
    <section className="admin-resource-section site-manager" aria-label="园区管理">
      <header className="resource-heading">
        <div>
          <span className="eyebrow">SITES</span>
          <h2>园区管理</h2>
          <p>维护共享物品的发布园区、地图坐标和可用状态。</p>
        </div>
        <button
          className="primary-button compact"
          type="button"
          onClick={() => {
            setEditingId(undefined)
            setCreating(true)
          }}
        >
          <Plus size={16} />新增园区
        </button>
      </header>

      {(creating || editing) && (
        <form
          className="site-form"
          key={editing?.id ?? 'new-site'}
          aria-label={editing ? `编辑${editing.name}` : '新增园区'}
          onSubmit={(event) => void submit(event)}
        >
          <div className="site-form-heading">
            <div>
              <Building2 size={17} />
              <strong>{editing ? '编辑园区' : '新增园区'}</strong>
            </div>
            <button type="button" className="icon-button" onClick={closeForm} aria-label="关闭园区表单">
              <X size={15} />
            </button>
          </div>
          <div className="site-form-grid">
            <label><span>园区编码</span><input name="code" required maxLength={50} defaultValue={formSite?.code} placeholder="例如：GZ" /></label>
            <label><span>园区名称</span><input name="name" required maxLength={200} defaultValue={formSite?.name} placeholder="例如：广州园区" /></label>
            <label><span>城市</span><input name="city" required maxLength={200} defaultValue={formSite?.city} placeholder="广州" /></label>
            <label><span>纬度</span><input name="latitude" type="number" required min="-90" max="90" step="any" defaultValue={formSite?.latitude} placeholder="23.1291" /></label>
            <label><span>经度</span><input name="longitude" type="number" required min="-180" max="180" step="any" defaultValue={formSite?.longitude} placeholder="113.2644" /></label>
            <label className="site-active-toggle">
              <input
                name="is_active"
                type="checkbox"
                aria-label="启用园区"
                defaultChecked={formSite?.is_active ?? true}
              />
              <span><strong>启用园区</strong><small>允许发布共享物品并作为调拨目标</small></span>
            </label>
          </div>
          <div className="form-actions">
            <button className="primary-button" type="submit">
              <Check size={16} />{editing ? '保存修改' : '保存园区'}
            </button>
            <button className="quiet-button" type="button" onClick={closeForm}>取消</button>
          </div>
        </form>
      )}

      <div className="site-card-grid">
        {sites.map((site) => (
          <article className={`site-card${site.is_active ? '' : ' is-inactive'}`} key={site.id}>
            <div className="site-card-top">
              <span className="site-code">{site.code}</span>
              <span className={`site-state${site.is_active ? ' is-active' : ''}`}>
                {site.is_active ? '启用' : '停用'}
              </span>
            </div>
            <div>
              <h3>{site.name}</h3>
              <p><MapPin size={14} />{site.city} · {site.latitude}, {site.longitude}</p>
            </div>
            <button
              className="row-action"
              type="button"
              aria-label={`编辑 ${site.name}`}
              onClick={() => {
                setCreating(false)
                setEditingId(site.id)
              }}
            >
              编辑
            </button>
          </article>
        ))}
      </div>
    </section>
  )
}
