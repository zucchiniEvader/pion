import { useCallback, useEffect, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { GitChangedFile, GitFileDiff, GitStatusResult, ProjectRecord } from '@/types'
import { useI18n } from '@/i18n'

interface ChangesPanelProps {
  project: ProjectRecord
  /** RightSidebar tab visibility — polling runs only while shown. */
  open: boolean
}

const POLL_MS = 4_000

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

// Changes tab of the RightSidebar: every changed file's unified diff as ONE
// continuous scrollable list (sticky file headers as dividers), plus a
// compact overview list up top that jumps to each section. pi has no "files
// the agent touched" API, so `git status` + per-file `git diff HEAD` is the
// displayed truth (user decision). The file list polls; diffs refetch only
// when the list actually changes (a stable tree costs one `git status`).
// The frame (tabs, width, drag, animation) lives in RightSidebar.
export function ChangesPanel({ project, open }: ChangesPanelProps) {
  const { t } = useI18n()
  const [result, setResult] = useState<GitStatusResult | null>(null)
  // path → diff (or null while its fetch is in flight).
  const [diffs, setDiffs] = useState<Record<string, GitFileDiff | null>>({})
  const rootRef = useRef<HTMLDivElement | null>(null)
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

  // Polling only while shown: a hidden/closed tab freezes its last snapshot
  // and resumes fresh when shown again.
  useEffect(() => {
    if (!open) {
      if (timer.current) clearInterval(timer.current)
      return
    }
    // Fresh (re)show or project switch: drop the previous snapshot.
    setResult(null)
    setDiffs({})
    listSig.current = ''
    void refresh()
    timer.current = setInterval(() => void refresh(), POLL_MS)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [refresh, open])

  return (
    <div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
      {result !== null && result.files.length > 0 && (
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
                      rootRef.current
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
    </div>
  )
}
