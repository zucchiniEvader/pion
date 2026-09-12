import { useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { FileDiff, SquareTerminal, X } from 'lucide-react'
import type { ProjectRecord } from '@/types'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { ChangesPanel } from '@/components/ChangesPanel'
import { TerminalPanel } from '@/components/TerminalPanel'

export type RightTab = 'changes' | 'terminal'

interface RightSidebarProps {
  project: ProjectRecord
  /** Open state — the sidebar stays mounted after first open and animates
   * its width (0 ↔ draggable width) instead of mount/unmount popping. */
  open: boolean
  tab: RightTab
  onTabChange: (tab: RightTab) => void
  onClose: () => void
}

/** Default sidebar width — App grows the window by exactly this on open. */
export const RIGHT_SIDEBAR_WIDTH = 560
const MIN_WIDTH = 320

// Right-side sidebar: a tab switcher between the git ChangesPanel and the
// integrated TerminalPanel. Owns the shared frame — draggable width, the
// open/close slide animation, and the close button.
export function RightSidebar({ project, open, tab, onTabChange, onClose }: RightSidebarProps) {
  const { t } = useI18n()
  const [width, setWidth] = useState(RIGHT_SIDEBAR_WIDTH)
  // While dragging, the width transition must be OFF — it exists for the
  // open/close animation; left on, every drag frame eases over 200ms and
  // the edge chases the mouse instead of tracking it.
  const [dragging, setDragging] = useState(false)
  const outerRef = useRef<HTMLDivElement | null>(null)

  const onDragStart = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    // Hard-clamp the width STATE to the space that actually exists:
    // window − left sidebar − main's min-width. Flex capping alone only
    // clips the outer wrapper; the inner column (state-wide) then overhangs
    // it and right-aligned content shears off.
    const row = outerRef.current?.parentElement
    const leftW = row?.children[0]?.getBoundingClientRect().width ?? 0
    const rowW = row?.clientWidth ?? window.innerWidth
    const maxFit = Math.max(MIN_WIDTH, Math.round(rowW - leftW - 520))
    const maxW = Math.min(maxFit, Math.round(window.innerWidth * 0.85))
    setDragging(true)
    const move = (ev: MouseEvent) => {
      setWidth(Math.min(Math.max(startW + (startX - ev.clientX), MIN_WIDTH), maxW))
    }
    const up = () => {
      setDragging(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const tabBtn = (id: RightTab, label: string, Icon: typeof FileDiff) => (
    <button
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors',
        tab === id ? 'bg-fill-active font-medium text-ink' : 'text-ink2 hover:bg-fill-hover hover:text-ink',
      )}
      onClick={() => onTabChange(id)}
    >
      <Icon size={13} strokeWidth={1.75} />
      {label}
    </button>
  )

  return (
    // Outer animates width (0 ↔ draggable) and clips; the inner column keeps
    // the full width so content never reflows mid-animation (same structure
    // as the left sidebar's collapse). `shrink` (not shrink-0) lets flex cap
    // the panel when the drag overshoots the free space.
    <div
      ref={outerRef}
      className={cn('h-full min-w-0 shrink overflow-hidden', !dragging && 'transition-[width] duration-200 ease-out')}
      style={{ width: open ? width : 0 }}
    >
      <aside className="relative flex h-full flex-col border-l border-line bg-panel" style={{ width, minWidth: width }}>
        {/* Drag handle on the divider. */}
        <div className="absolute -left-0.5 top-0 z-10 h-full w-1 cursor-col-resize" onMouseDown={onDragStart} />
        <header className="flex h-12 shrink-0 items-center gap-1 border-b-[0.5px] border-line px-2">
          {tabBtn('changes', t('changes.tab'), FileDiff)}
          {tabBtn('terminal', t('terminal.tab'), SquareTerminal)}
          <button
            className="ml-auto rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
            title={t('common.close')}
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>
        {tab === 'changes' ? <ChangesPanel project={project} open={open} /> : <TerminalPanel key={project.path} project={project} />}
      </aside>
    </div>
  )
}
