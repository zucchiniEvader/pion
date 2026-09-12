import { useCallback, useEffect, useState } from 'react'
import { LoaderCircle, Play, Plus, Trash2, Clock, MessageSquare } from 'lucide-react'
import type { CronJob, ProjectRecord } from '@/types'
import { useI18n, useUserErrorMessage } from '@/i18n'
import { CronCreateDialog } from '@/components/CronCreateDialog'

interface SchedulerPageProps {
  projects: ProjectRecord[]
  /** Pre-selected project in the create dialog (the app-active one). */
  defaultProjectPath: string | null
  /** Deep-link into the session a job's last fire spawned. */
  onViewSession: (projectPath: string, sessionFile: string) => void
}

function fmtTime(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString()
}

// Main-area scheduler surface (sidebar 定时任务 entry, sibling of the kanban
// board): every project's cron jobs grouped by project, with full prompt and
// a last-fire session deep-link. Creation lives in CronCreateDialog, summoned
// by the header 新建 button. The daemon owns store + tick (daemon/cron.ts);
// this page refetches on mount, on a slow poll, and after every mutation.
export function SchedulerPage({ projects, defaultProjectPath, onViewSession }: SchedulerPageProps) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [jobsByProject, setJobsByProject] = useState<Record<string, CronJob[]> | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const out: Record<string, CronJob[]> = {}
    const failed: unknown[] = []
    await Promise.all(
      projects.map(async (p) => {
        try {
          out[p.path] = await window.pi.cron.list(p.path)
        } catch (e) {
          // A remote runtime whose daemon predates cron answers not_found
          // ("unknown method") — that project is simply cron-less, not an
          // error worth a banner (协议 v3 additive 的既定降级行为)。
          if (!/unknown method/.test(e instanceof Error ? e.message : String(e))) failed.push(e)
        }
      }),
    )
    setJobsByProject(out)
    if (failed.length) setError(ue(failed[0]))
  }, [projects, ue])

  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 15_000)
    return () => clearInterval(timer)
  }, [refresh])

  const mutate = async (op: () => Promise<unknown>) => {
    setError(null)
    try {
      await op()
    } catch (e) {
      setError(ue(e))
    } finally {
      await refresh()
    }
  }

  const total = jobsByProject ? Object.values(jobsByProject).reduce((n, jobs) => n + jobs.length, 0) : 0

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b-[0.5px] border-line px-4">
        <Clock size={15} strokeWidth={1.75} className="text-ink2" />
        <h1 className="text-[13px] font-semibold">{t('cron.title')}</h1>
        {total > 0 && <span className="rounded-full bg-fill-hover px-1.5 py-px text-[10px] font-medium tabular-nums text-ink2">{total}</span>}
        <button
          className="no-drag ml-auto flex h-7 items-center gap-1 rounded-lg bg-accent px-2.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
          onClick={() => setCreateOpen(true)}
        >
          <Plus size={13} strokeWidth={2} />
          {t('cron.new')}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {jobsByProject === null ? (
          <LoaderCircle size={16} className="animate-spin text-ink2" />
        ) : total === 0 ? (
          <p className="py-2 text-xs text-ink2">{t('cron.empty')}</p>
        ) : (
          projects.map((p) => {
            const jobs = jobsByProject[p.path]
            if (!jobs?.length) return null
            return (
              <section key={p.id} className="mb-4">
                <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2" title={p.path}>
                  {p.name}
                </h3>
                <ul className="space-y-1.5">
                  {jobs.map((job) => {
                    const next = fmtTime(job.nextRunAt)
                    const last = fmtTime(job.lastRunAt)
                    return (
                      <li key={job.id} className="rounded-xl border-[0.5px] border-line bg-panel px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={job.enabled}
                            onChange={(e) => mutate(() => window.pi.cron.setEnabled(p.path, job.id, e.target.checked))}
                            className="accent-[var(--color-accent)]"
                          />
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                            {job.name ?? job.prompt}
                          </span>
                          <code className="shrink-0 rounded bg-fill-hover px-1.5 py-0.5 text-[10px] text-ink2">{job.schedule}</code>
                          <button
                            className="rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                            title={t('cron.runNow')}
                            onClick={() => mutate(() => window.pi.cron.runNow(p.path, job.id))}
                          >
                            <Play size={13} strokeWidth={1.75} />
                          </button>
                          {job.lastSessionFile && (
                            <button
                              className="rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                              title={t('cron.openSession')}
                              onClick={() => onViewSession(p.path, job.lastSessionFile!)}
                            >
                              <MessageSquare size={13} strokeWidth={1.75} />
                            </button>
                          )}
                          <button
                            className="rounded-md p-1 text-ink2 transition-colors hover:bg-tint-bad hover:text-bad"
                            title={t('cron.delete')}
                            onClick={() => mutate(() => window.pi.cron.remove(p.path, job.id))}
                          >
                            <Trash2 size={13} strokeWidth={1.75} />
                          </button>
                        </div>
                        <p className="mt-1.5 line-clamp-3 whitespace-pre-wrap pl-6 text-xs text-ink2">{job.prompt}</p>
                        <div className="mt-1 pl-6 text-[11px] text-ink2">
                          {job.enabled ? (next ? t('cron.nextRun', { time: next }) : t('cron.neverRun')) : t('cron.disabled')}
                          {' · '}
                          {last ? t('cron.lastRun', { time: last }) : t('cron.neverRun')}
                          {job.lastError && <span className="block text-bad">{job.lastError}</span>}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })
        )}
      </div>

      {createOpen && (
        <CronCreateDialog
          projects={projects}
          defaultProjectPath={defaultProjectPath}
          onCreated={() => void refresh()}
          onClose={() => setCreateOpen(false)}
        />
      )}
      {error && <p className="mx-4 mb-2 text-xs text-bad">{error}</p>}
    </div>
  )
}
