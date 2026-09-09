import { useEffect, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { SessionState } from '@/hooks/useSessionPool'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

interface ActivityListProps {
  sessions: Map<string, SessionState>
  onSelect: (runtimeId: string) => void
  onRestart: (runtimeId: string) => void
}

// Last assistant text, truncated — a glanceable "what is it doing" preview.
function previewOf(s: SessionState): string {
  for (let i = s.transcript.length - 1; i >= 0; i--) {
    const m = s.transcript[i]
    if (m.role !== 'assistant') continue
    const text = m.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as { text: string }).text)
      .join('')
      .trim()
    if (text) return text.length > 80 ? `${text.slice(0, 80)}…` : text
  }
  return ''
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

function fmtElapsed(startedAt: number | null, now: number): string {
  if (!startedAt) return ''
  const sec = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`
}

// Central list of every pooled session: running ones keep streaming in the
// background, crashed ones offer in-place recovery. Click a row to foreground
// that session.
export function ActivityList({ sessions, onSelect, onRestart }: ActivityListProps) {
  const { t } = useI18n()
  // 1s tick so running rows show a live elapsed time.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const entries = [...sessions.entries()]

  if (entries.length === 0) {
    return (
      <div className="grid flex-1 place-items-center px-6">
        <p className="text-[13px] text-ink2">{t('activity.empty')}</p>
      </div>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-2 px-4 py-4">
        {entries.map(([rid, s]) => {
          const title = s.runtime?.sessionFile
            ? basename(s.runtime.sessionFile).replace(/\.jsonl$/, '')
            : s.lastStart?.sessionPath
              ? basename(s.lastStart.sessionPath).replace(/\.jsonl$/, '')
              : t('activity.newSession')
          const preview = previewOf(s)
          return (
            <div
              key={rid}
              className="flex w-full cursor-pointer items-center gap-3 rounded-xl border-[0.5px] border-line bg-panel px-4 py-3 text-left shadow-card transition-colors hover:bg-fill-hover"
              onClick={() => onSelect(rid)}
            >
              <span className="grid size-6 shrink-0 place-items-center">
                {s.status === 'running' ? (
                  <LoaderCircle size={15} strokeWidth={1.75} className="animate-spin text-accent" />
                ) : s.crashed ? (
                  <span className="size-2 rounded-full bg-bad" />
                ) : (
                  <span className="size-2 rounded-full bg-line" />
                )}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span className="truncate text-[13px] font-medium">{title}</span>
                  <span className="shrink-0 text-[11px] text-ink2">
                    {s.crashed ? t('activity.crashed') : s.status === 'running' ? t('activity.running', { elapsed: fmtElapsed(s.startedAt, now) }) : t('activity.idle')}
                  </span>
                </span>
                {s.lastStart?.projectPath && (
                  <span className="truncate text-[11px] text-ink2">{s.lastStart.projectPath}</span>
                )}
                {preview && <span className="truncate text-xs text-ink2">{preview}</span>}
              </span>
              {s.crashed && (
                <Button
                  variant="primary"
                  size="sm"
                  className="shrink-0"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRestart(rid)
                  }}
                >
                  {t('activity.resume')}
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
