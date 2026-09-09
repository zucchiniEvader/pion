import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n'

// Module-level open requests so deeply nested images (transcript bubbles,
// composer strip) can trigger the overlay without threading state through
// every layer. App mounts one <ImageLightbox /> instance.
type Listener = (src: string | null) => void
const listeners = new Set<Listener>()

export function openImagePreview(src: string): void {
  for (const l of listeners) l(src)
}

export function ImageLightbox() {
  const [src, setSrc] = useState<string | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    const listener: Listener = (s) => setSrc(s)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    if (!src) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setSrc(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [src])

  if (!src) return null
  return (
    <div
      className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center bg-canvas/80 p-8 backdrop-blur-xl"
      onClick={() => setSrc(null)}
    >
      <img
        src={src}
        alt={t('lightbox.imagePreview')}
        className="max-h-full max-w-full rounded-xl border-[0.5px] border-line bg-canvas object-contain shadow-pop"
        draggable={false}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}
