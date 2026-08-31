import { type ChangeEvent, useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, ImagePlus, Star, Trash2, X } from 'lucide-react'
import type { Furniture, ImageRef, ImageUploadInput } from '../../types'

type ImageManagerProps = {
  furniture: Furniture
  onUpload: (
    furnitureId: string,
    file: File,
    metadata: ImageUploadInput,
    onProgress: (percent: number) => void,
  ) => Promise<boolean>
  onReorder: (furnitureId: string, imageIds: string[]) => Promise<boolean>
  onSetPrimary: (furnitureId: string, imageId: string) => Promise<boolean>
  onDelete: (furnitureId: string, imageId: string) => Promise<boolean>
}

export function ImageManager({ furniture, onUpload, onReorder, onSetPrimary, onDelete }: ImageManagerProps) {
  const images = furniture.images
  const [file, setFile] = useState<File>()
  const [previewUrl, setPreviewUrl] = useState<string>()
  const [altText, setAltText] = useState(furniture.name)
  const [isPrimary, setIsPrimary] = useState(false)
  const [progress, setProgress] = useState<number>()
  const [deleteTarget, setDeleteTarget] = useState<string>()
  const [busy, setBusy] = useState(false)

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  function clearPendingUpload() {
    setFile(undefined)
    setPreviewUrl(undefined)
    setAltText(furniture.name)
    setIsPrimary(false)
    setProgress(undefined)
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0]
    if (!selected) return
    setFile(selected)
    setPreviewUrl(URL.createObjectURL(selected))
    setAltText(furniture.name)
    setIsPrimary(images.length === 0)
    setProgress(undefined)
  }

  async function move(image: ImageRef, direction: -1 | 1) {
    const index = images.findIndex((item) => item.id === image.id)
    const target = index + direction
    if (target < 0 || target >= images.length || busy) return
    const next = [...images]
    ;[next[index], next[target]] = [next[target], next[index]]
    setBusy(true)
    await onReorder(furniture.id, next.map((item) => item.id))
    setBusy(false)
  }

  async function makePrimary(imageId: string) {
    if (busy) return
    setBusy(true)
    await onSetPrimary(furniture.id, imageId)
    setBusy(false)
  }

  async function remove(imageId: string) {
    if (busy) return
    setBusy(true)
    if (await onDelete(furniture.id, imageId)) {
      setDeleteTarget(undefined)
    }
    setBusy(false)
  }

  async function submitUpload() {
    if (!file || busy) return
    setBusy(true)
    setProgress(0)
    const uploaded = await onUpload(
      furniture.id,
      file,
      { alt_text: altText.trim() || furniture.name, is_primary: isPrimary },
      setProgress,
    )
    if (uploaded) clearPendingUpload()
    setBusy(false)
  }

  return (
    <section className="image-manager" aria-label="图片管理">
      <div className="image-manager-heading">
        <div><span className="eyebrow">PRIVATE R2</span><h3>图片管理</h3></div>
        <span>{images.length} 张</span>
      </div>
      <div className="image-manager-list">
        {images.map((image, index) => (
          <article className="managed-image" key={image.id}>
            <img src={image.url} alt={image.alt_text} />
            <div className="managed-image-copy">
              <strong>{image.alt_text}</strong>
              {image.is_primary && <span className="primary-image-tag"><Star size={11} fill="currentColor" />主图</span>}
              <div className="managed-image-actions">
                <button type="button" disabled={busy || index === 0} onClick={() => void move(image, -1)} aria-label={`上移 ${image.alt_text}`}><ArrowUp size={14} /></button>
                <button type="button" disabled={busy || index === images.length - 1} onClick={() => void move(image, 1)} aria-label={`后移 ${image.alt_text}`}><ArrowDown size={14} /></button>
                {!image.is_primary && <button type="button" disabled={busy} onClick={() => void makePrimary(image.id)} aria-label={`设为主图 ${image.alt_text}`}><Star size={14} />设为主图</button>}
                <button type="button" disabled={busy} onClick={() => setDeleteTarget(image.id)} aria-label={`删除 ${image.alt_text}`}><Trash2 size={14} /></button>
              </div>
              {deleteTarget === image.id && (
                <div className="inline-delete-confirm">
                  <span>确认移除这张图片？</span>
                  <button type="button" onClick={() => void remove(image.id)} aria-label={`确认删除 ${image.alt_text}`}>确认删除</button>
                  <button type="button" onClick={() => setDeleteTarget(undefined)}>取消</button>
                </div>
              )}
            </div>
          </article>
        ))}
      </div>
      <div className="image-upload-panel">
        <label className="image-file-picker"><ImagePlus size={16} /><span>选择图片</span><input type="file" accept="image/png,image/jpeg" aria-label="选择图片" onChange={chooseFile} /></label>
        {previewUrl && <div className="image-upload-preview"><img src={previewUrl} alt="待上传预览" /><button type="button" onClick={clearPendingUpload} aria-label="取消待上传图片"><X size={14} /></button></div>}
        {file && <>
          <label><span>图片说明</span><input value={altText} maxLength={240} onChange={(event) => setAltText(event.target.value)} /></label>
          <label className="primary-choice"><input type="checkbox" checked={isPrimary} onChange={(event) => setIsPrimary(event.target.checked)} />设为主图</label>
          {progress !== undefined && <progress max="100" value={progress}>{progress}%</progress>}
          <button className="primary-button compact" type="button" disabled={busy} onClick={() => void submitUpload()}>上传并保存</button>
        </>}
      </div>
    </section>
  )
}
