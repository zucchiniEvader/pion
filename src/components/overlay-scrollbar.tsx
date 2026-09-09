import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Overlay scrollbar: floats over the content's right edge, fades in while
// scrolling (or while grabbed) and fades out after a short idle. Native
// scrollbars — even styled ones — always take layout width, which squeezed
// the sidebar rows on overflow; this one never does. Wheel, trackpad, and
// keyboard scrolling stay native.
export function OverlayScrollArea({
  wrapperClassName,
  scrollClassName,
  innerRef,
  onScroll,
  children,
}: {
  /** Classes for the outer wrapper; owns the height (e.g. "flex-1"). */
  wrapperClassName?: string
  /** Classes for the scrolling element; include overflow-y-auto and padding. */
  scrollClassName?: string
  /** Lets the parent keep a ref to the actual scrolling element. */
  innerRef?: { current: HTMLDivElement | null }
  /** Extra scroll handler (the thumb re-measure always runs first). */
  onScroll?: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [geom, setGeom] = useState<{ top: number; height: number } | null>(null)
  const [active, setActive] = useState(false)
  const hideTimer = useRef<number | undefined>(undefined)
  const dragging = useRef(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    if (el.scrollHeight - el.clientHeight <= 1) {
      setGeom(null)
      return
    }
    const height = Math.max(36, (el.clientHeight / el.scrollHeight) * el.clientHeight)
    const top = (el.scrollTop / el.scrollHeight) * el.clientHeight
    setGeom({ top, height })
  }, [])

  const poke = useCallback(() => {
    measure()
    setActive(true)
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setActive(false), 900)
  }, [measure])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Geometry-only refresh on content/viewport size changes: expanding a
    // project must move the thumb but not wake the bar.
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    if (el.firstElementChild) ro.observe(el.firstElementChild)
    // Card lists swap children without resizing the container (board columns);
    // childList mutations re-measure the thumb geometry.
    const mo = new MutationObserver(measure)
    mo.observe(el, { childList: true, subtree: true })
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.clearTimeout(hideTimer.current)
    }
  }, [measure])

  const onThumbPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el) return
    e.preventDefault()
    dragging.current = true
    window.clearTimeout(hideTimer.current)
    setActive(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onThumbPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current
    if (!el || !dragging.current) return
    el.scrollTop += e.movementY * (el.scrollHeight / el.clientHeight)
    poke()
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    e.currentTarget.releasePointerCapture(e.pointerId)
    poke()
  }

  return (
    <div className={cn('relative min-h-0', wrapperClassName)}>
      <div
        ref={(el) => {
          ref.current = el
          if (innerRef) innerRef.current = el
        }}
        onScroll={(e) => {
          poke()
          onScroll?.()
        }}
        className={cn('overlay-scrollarea', scrollClassName)}
      >
        {children}
      </div>
      {geom && (
        <div
          className={cn('overlay-scrollbar', active && 'overlay-scrollbar-on')}
          style={{ top: geom.top + 2, height: geom.height }}
          onPointerDown={onThumbPointerDown}
          onPointerMove={onThumbPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />
      )}
    </div>
  )
}
