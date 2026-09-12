import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { FileDiff, LoaderCircle, X } from 'lucide-react'
import type { GitChangedFile, GitFileDiff, GitStatusResult, ProjectRecord } from '@/types'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

interface ChangesPanelProps {
  project: ProjectRecord
  /** Open state — the panel stays mounted after first open and animates its
   * width (0 ↔ draggable width) instead of mount/unmount popping. */
  open: boolean
  onClose: () => void
}

const POLL_MS = 4_000
/** Default panel width — App grows the window by exactly this on open. */
export const CHANGES_PANEL_WIDTH = 560
const DEFAULT_WIDTH = CHANGES_PANEL_WIDTH
const MIN_WIDTH = 320

// One-letter badge per file. x = staged, y = worktree; prefer the worktree
// side (what the user sees on disk), fall back to the staged side.
function badgeOf(f: GitChangedFile): { letter: string; cls: string } {
  const c = f.y !== ' ' ? f.y : f.x
  switch (c) {
    case '?':
    case 'A':
      return { letter: 'A', cls: 'text-accent' }
    case 'D':
      return { letter: 'D', cls: 'text-bad' }
    case 'R':
      return { letter: 'R', cls: 'text-purple' }
    case 'U':
      return { letter: '!', cls: 'text-bad' }
    default:
      return { letter: 'M', cls: 'text-warn' }
  }
}

function DiffLines({ diff }: { diff: string }) {
  return (
    // Soft wrap: long lines (minified code, base64) must never overflow the
    // panel — wrap anywhere instead of horizontal scrolling.
    <pre className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed [overflow-wrap:anywhere]">
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? 'bg-tint-accent text-accent'
              : line.startsWith('-') && !line.startsWith('---')
                ? 'bg-tint-bad text-bad'
                : line.startsWith('@@')
                  ? 'text-warn'
                  : 'text-ink2'
          }
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

// Right-side panel: every changed file's unified diff as ONE continuous
// scrollable list — file headers act as dividers (sticky while scrolling),
// the next file follows naturally. pi has no "files the agent touched" API,
// so `git status` + per-file `git diff HEAD` is the displayed truth (user
// decision). The file list polls; diffs refetch only when the list actually
// changes (a stable working tree costs one `git status` per poll, nothing
// more). Width is draggable at the left divider.
export function ChangesPanel({ project, open, onClose }: ChangesPanelProps) {
  const { t } = useI18n()
  const [result, setResult] = useState<GitStatusResult | null>(null)
  // path → diff (or null while its fetch is in flight).
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff | null>>({})
  const [width, setWidth] = useState(DEFAULT_WIDTH)
  // While dragging, the width transition must be OFF — it exists for the
  // open/close animation; left on, every drag frame eases over 200ms and
  // the edge chases the mouse instead of tracking it.
  const [dragging, setDragging] = useState(false)
  const outerRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const listSig = useRef('')

  const refresh = useCallback(async () => {
    let next: GitStatusResult
    try {
      next = await window.pi.git.changedFiles(project.path)
    } catch {
      return // daemon hiccup — keep the last snapshot; the next tick retries
    }
    setResult(next)
    const sig = next.files.map((f) => `${f.x}${f.y}:${f.path}`).join('\n')
    if (sig === listSig.current) return
    listSig.current = sig
    // List changed → refetch every diff (the common case is a handful of
    // files; per-file caps keep big diffs bounded).
    setDiffs(Object.fromEntries(next.files.map((f) => [f.path, null])))
    const fetched = await Promise.all(
      next.files.map(async (f) => {
        try {
          return await window.pi.git.fileDiff(project.path, f.path)
        } catch {
          return { path: f.path, diff: '', truncated: false }
        }
      }),
    )
    // A newer list may have superseded this fetch while it ran — drop it.
    if (listSig.current === sig) {
      setDiffs(Object.fromEntries(fetched.map((d) => [d.path, d])))
    }
  }, [project.path])

  // Polling only while open: a closed panel freezes its last snapshot for
  // the slide-out animation and resumes fresh on the next open.
  useEffect(() => {
    if (!open) {
      if (timer.current) clearInterval(timer.current)
      return
    }
    setResult(null)
    setDiffs({})
    listSig.current = ''
    void refresh()
    timer.current = setInterval(() => void refresh(), POLL_MS)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [refresh, open])



  const onDragStart = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    // Hard-clamp the width STATE to the space that actually exists:
    // window − left sidebar − main's min-width. Flex capping alone only
    // clips the outer wrapper; the inner column (state-wide) then overhangs
    // it and right-aligned content (reveal icons, the X) shears off — the
    // "right side pops out" effect. With the state itself clamped, the
    // divider just stops at the edge.
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

  return (
    // Outer animates width (0 ↔ draggable) and clips; the inner column keeps
    // the full width so content never reflows mid-animation (same structure
    // as the left sidebar's collapse). `shrink` (not shrink-0) lets flex cap
    // the panel when the drag overshoots the free space — the row then
    // compresses THIS wrapper instead of pushing the panel past the window's
    // right edge (main keeps its min-width, nothing overflows outside).
    <div
      ref={outerRef}
      className={cn('h-full min-w-0 shrink overflow-hidden', !dragging && 'transition-[width] duration-200 ease-out')}
      style={{ width: open ? width : 0 }}
    >
    <aside className="relative flex h-full flex-col border-l border-line bg-panel" style={{ width, minWidth: width }}>
      {/* Drag handle on the divider; the border stays the visual affordance. */}
      <div className="absolute -left-0.5 top-0 z-10 h-full w-1 cursor-col-resize" onMouseDown={onDragStart} />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-line px-3">
        <FileDiff size={15} strokeWidth={1.75} className="text-ink2" />
        <h2 className="text-[13px] font-semibold">{t('changes.title')}</h2>
        {result && result.files.length > 0 && (
          <span className="rounded-full bg-fill-hover px-1.5 py-px text-[10px] font-medium tabular-nums text-ink2">{result.files.length}</span>
        )}
        <button
          className="ml-auto rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </header>
      {result && result.files.length > 0 && (
        // Overview: every changed file as a compact list — the diffs below
        // are one long scroll, so this is how you see WHAT changed without
        // reading everything. Click jumps to the file's section.
        <div className="max-h-36 shrink-0 overflow-y-auto border-b-[0.5px] border-line p-1.5">
          <ul className="space-y-px">
            {result.files.map((f) => {
              const badge = badgeOf(f)
              return (
                <li key={`ov-${f.x}${f.y}:${f.path}`}>
                  <button
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-fill-hover"
                    title={f.path}
                    onClick={() => {
                      outerRef.current
                        ?.querySelector(`[data-file="${CSS.escape(f.path)}"]`)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                    }}
                  >
                    <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${badge.cls}`}>{badge.letter}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink">{f.path}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {result === null ? (
          <LoaderCircle size={15} className="m-3 animate-spin text-ink2" />
        ) : !result.isRepo ? (
          <p className="px-3 py-2 text-xs text-ink2">{t('changes.notRepo')}</p>
        ) : result.files.length === 0 ? (
          <p className="px-3 py-2 text-xs text-ink2">{t('changes.empty')}</p>
        ) : (
          result.files.map((f) => {
            const badge = badgeOf(f)
            const diff = diffs[f.path]
            return (
              <section key={`${f.x}${f.y}:${f.path}`} data-file={f.path} className="border-b-[0.5px] border-line last:border-b-0">
                <header className="sticky top-0 z-[5] flex items-center gap-2 border-b-[0.5px] border-line bg-panel px-3 py-1.5">
                  <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${badge.cls}`}>{badge.letter}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-ink" title={f.path}>
                    {f.path}
                  </span>
                </header>
                <div className="px-2 py-1.5">
                  {diff === undefined || diff === null ? (
                    <LoaderCircle size={13} className="m-1.5 animate-spin text-ink2" />
                  ) : !diff.diff.trim() ? (
                    <p className="p-1 text-[11px] text-ink2">{t('changes.noDiff')}</p>
                  ) : (
                    <>
                      <DiffLines diff={diff.diff} />
                      {diff.truncated && <p className="p-1 text-[11px] text-warn">{t('changes.truncated')}</p>}
                    </>
                  )}
                </div>
              </section>
            )
          })
        )}
      </div>
    </aside>
    </div>
  )
}
