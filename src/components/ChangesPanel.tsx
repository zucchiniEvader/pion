import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, FileDiff, FolderGit2, LoaderCircle, RefreshCw } from 'lucide-react'
import type { GitChangedFile, GitFileDiff, GitStatusResult, ProjectRecord } from '@/types'
import { useI18n } from '@/i18n'

interface ChangesPanelProps {
  project: ProjectRecord
  open: boolean
}

const POLL_MS = 4_000

function badgeOf(f: GitChangedFile) {
  if (f.x === 'U' || f.y === 'U' || ['AA', 'DD'].includes(f.x + f.y)) return { letter: '!', cls: 'text-bad' }
  const c = f.y !== ' ' ? f.y : f.x
  switch (c) {
    case '?': case 'A': return { letter: 'A', cls: 'text-ok' }
    case 'D': return { letter: 'D', cls: 'text-bad' }
    case 'R': return { letter: 'R', cls: 'text-purple' }
    case 'C': return { letter: 'C', cls: 'text-purple' }
    default: return { letter: 'M', cls: 'text-warn' }
  }
}

function diffRows(diff: string) {
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  return diff.trimEnd().split('\n').flatMap((text) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      return [{ text, kind: 'hunk', old: '', next: '' }]
    }
    if (!inHunk) return []
    const kind = text.startsWith('+') ? 'add' : text.startsWith('-') ? 'remove' : text.startsWith(' ') ? 'context' : 'note'
    return [{ text, kind, old: kind === 'remove' || kind === 'context' ? String(oldLine++) : '', next: kind === 'add' || kind === 'context' ? String(newLine++) : '' }]
  })
}

function DiffLines({ diff }: { diff: string }) {
  const rows = diffRows(diff)
  if (!rows.length) return <pre className="whitespace-pre-wrap p-3 font-mono text-[11px] text-ink2 [overflow-wrap:anywhere]">{diff}</pre>
  return (
    <div className="py-1 font-mono text-[11px] leading-5">
      {rows.map((line, i) => (
        <div key={i} className={`flex ${line.kind === 'add' ? 'bg-tint-ok text-ok' : line.kind === 'remove' ? 'bg-tint-bad text-bad' : line.kind === 'hunk' ? 'my-1 bg-fill-hover text-ink2' : 'text-ink'}`}>
          {line.kind !== 'hunk' && <span aria-hidden="true" className="flex shrink-0 select-none text-[10px] text-ink2"><span className="w-9 pr-2 text-right">{line.old}</span><span className="w-9 pr-2 text-right">{line.next}</span></span>}
          <pre className={`min-w-0 flex-1 whitespace-pre-wrap pr-3 font-mono [overflow-wrap:anywhere] ${line.kind === 'hunk' ? 'px-3 py-1 text-[10px]' : ''}`}>{line.text || ' '}</pre>
        </div>
      ))}
    </div>
  )
}

function Stats({ diff }: { diff?: GitFileDiff | null }) {
  if (!diff?.diff) return null
  const rows = diffRows(diff.diff)
  const added = rows.filter((r) => r.kind === 'add').length
  const removed = rows.filter((r) => r.kind === 'remove').length
  if (!added && !removed) return null
  return <span className="flex shrink-0 gap-1.5 font-mono text-[10px] tabular-nums"><span className="text-ok">+{added}</span><span className="text-bad">−{removed}</span>{diff.truncated && <span className="text-ink2">…</span>}</span>
}

export function ChangesPanel({ project, open }: ChangesPanelProps) {
  const { t } = useI18n()
  const [result, setResult] = useState<GitStatusResult | null>(null)
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff | null>>({})
  const [failed, setFailed] = useState<string[]>([])
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const rootRef = useRef<HTMLDivElement | null>(null)
  const refreshRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let busy = false
    setResult(null)
    setDiffs({})
    setCollapsed(new Set())
    setFailed([])
    setError(false)
    const refresh = async () => {
      if (busy || cancelled) return
      busy = true
      setLoading(true)
      try {
        const next = await window.pi.git.changedFiles(project.path)
        if (cancelled) return
        setResult(next)
        setError(false)
        // Status letters do not change when an already-modified file is edited.
        // Refresh contents too, retaining the displayed diff until it is ready.
        let index = 0
        const errors: string[] = []
        await Promise.all(Array.from({ length: Math.min(4, next.files.length) }, async () => {
          while (index < next.files.length && !cancelled) {
            const f = next.files[index++]!
            try {
              const diff = await window.pi.git.fileDiff(project.path, f.path)
              if (!cancelled) setDiffs((prev) => ({ ...prev, [f.path]: diff }))
            } catch {
              errors.push(f.path)
            }
          }
        }))
        if (!cancelled) {
          setFailed(errors)
          setDiffs((prev) => Object.fromEntries(next.files.map((f) => [f.path, prev[f.path] ?? null])))
        }
      } catch {
        if (!cancelled) setError(true)
      } finally {
        busy = false
        if (!cancelled) setLoading(false)
      }
    }
    refreshRef.current = () => void refresh()
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    return () => { cancelled = true; clearInterval(timer); refreshRef.current = () => {} }
  }, [project.path, open])

  const toggle = useCallback((path: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  }), [])
  const files = result?.files ?? []
  const allCollapsed = files.length > 0 && files.every((f) => collapsed.has(f.path))

  return (
    <div ref={rootRef} data-changes-panel className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b-[0.5px] border-line px-3">
        <FolderGit2 size={14} className="text-ink2" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink">{t('changes.title')}</span>
        {result?.isRepo && <span className="rounded-md bg-fill-hover px-1.5 py-0.5 text-[10px] tabular-nums text-ink2">{files.length}</span>}
        {files.length > 0 && <button className="rounded px-1.5 py-1 text-[10px] text-ink2 hover:bg-fill-hover hover:text-ink" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(files.map((f) => f.path)))}>{t(allCollapsed ? 'changes.expandAll' : 'changes.collapseAll')}</button>}
        <button aria-label={t('changes.refresh')} title={t('changes.refresh')} disabled={loading} onClick={() => refreshRef.current()} className="rounded p-1 text-ink2 hover:bg-fill-hover hover:text-ink disabled:opacity-50"><RefreshCw size={13} className={loading ? 'animate-spin' : ''} /></button>
      </div>
      {error && <p role="alert" className="border-b border-line px-3 py-2 text-[11px] text-bad">{t('changes.loadError')}</p>}
      {files.length > 0 && <div className="max-h-40 shrink-0 overflow-y-auto border-b-[0.5px] border-line p-1.5">
        {files.map((f) => {
          const badge = badgeOf(f)
          const slash = f.path.lastIndexOf('/')
          return <button key={f.path} title={f.path} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-fill-hover focus-visible:outline focus-visible:outline-accent" onClick={() => {
            setCollapsed((prev) => { const next = new Set(prev); next.delete(f.path); return next })
            rootRef.current?.querySelector(`[data-file="${CSS.escape(f.path)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }}>
            <span className={`w-3 shrink-0 text-center font-mono text-[10px] font-semibold ${badge.cls}`}>{badge.letter}</span>
            <span className="shrink-0 max-w-[60%] truncate text-[11px] text-ink">{f.path.slice(slash + 1)}</span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-ink2">{slash >= 0 ? f.path.slice(0, slash) : ''}</span>
            <Stats diff={diffs[f.path]} />
          </button>
        })}
      </div>}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!result ? (!error && <div className="flex items-center justify-center gap-2 p-8 text-xs text-ink2"><LoaderCircle size={15} className="animate-spin" />{t('changes.loading')}</div>) : !result.isRepo || files.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center"><span className="rounded-full bg-fill-hover p-3 text-ink2">{result.isRepo ? <Check size={22} /> : <FolderGit2 size={22} />}</span><p className="text-xs text-ink2">{t(result.isRepo ? 'changes.empty' : 'changes.notRepo')}</p></div>
        ) : files.map((f) => {
          const badge = badgeOf(f)
          const diff = diffs[f.path]
          return <section key={f.path} data-file={f.path} className="border-b-[0.5px] border-line last:border-b-0">
            <header className="sticky top-0 z-[5] bg-panel">
              <button aria-expanded={!collapsed.has(f.path)} title={f.path} onClick={() => toggle(f.path)} className="flex w-full items-center gap-2 border-b-[0.5px] border-line px-3 py-2.5 text-left hover:bg-fill-hover">
                {collapsed.has(f.path) ? <ChevronRight size={12} className="shrink-0 text-ink2" /> : <ChevronDown size={12} className="shrink-0 text-ink2" />}
                <FileDiff size={13} className={`shrink-0 ${badge.cls}`} />
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-ink">{f.path}</span>
                <Stats diff={diff} />
              </button>
            </header>
            {!collapsed.has(f.path) && <div>
              {failed.includes(f.path) ? <p role="alert" className="p-3 text-[11px] text-bad">{t('changes.loadError')}</p> : !diff ? <LoaderCircle size={13} className="m-3 animate-spin text-ink2" /> : !diff.diff.trim() ? <p className="p-3 text-[11px] text-ink2">{t('changes.noDiff')}</p> : <><DiffLines diff={diff.diff} />{diff.truncated && <p className="p-3 text-[11px] text-warn">{t('changes.truncated')}</p>}</>}
            </div>}
          </section>
        })}
      </div>
    </div>
  )
}
