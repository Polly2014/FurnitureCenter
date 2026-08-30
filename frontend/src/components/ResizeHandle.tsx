import type { PointerEvent } from 'react'

type ResizeHandleProps = {
  label: string
  onResizeStart: (event: PointerEvent<HTMLButtonElement>) => void
}

export function ResizeHandle({ label, onResizeStart }: ResizeHandleProps) {
  return (
    <button
      type="button"
      className="resize-handle"
      aria-label={label}
      title={label}
      onPointerDown={onResizeStart}
    ><span /></button>
  )
}