import { useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { ProjectRecord } from '@/types'
import { useI18n, useUserErrorMessage } from '@/i18n'

interface CronCreateDialogProps {
  projects: ProjectRecord[]
  /** Pre-selected project (the app-active one). */
  defaultProjectPath: string | null
  /** Called after a job was successfully created (parent refetches). */
  onCreated: () => void
  onClose: () => void
}

const PRESETS = [
  { key: 'cron.presetHourly', expr: '0 * * * *' },
  { key: 'cron.presetDaily', expr: '0 9 * * *' },
  { key: 'cron.presetWeekday', expr: '0 9 * * 1-5' },
  { key: 'cron.presetCustom', expr: '' },
] as const

// Create form for scheduled tasks (summoned from the scheduler page's 新建
// button). The list lives on the page; this dialog is create-only.
export function CronCreateDialog({ projects, defaultProjectPath, onCreated, onClose }: CronCreateDialogProps) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [projectPath, setProjectPath] = useState(defaultProjectPath ?? projects[0]?.path ?? '')
  const [name, setName] = useState('')
  const [preset, setPreset] = useState(1)
  const [customExpr, setCustomExpr] = useState('')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const schedule = PRESETS[preset]!.expr || customExpr

  const submit = async () => {
    if (busy || !projectPath || !prompt.trim() || !schedule.trim()) return
    setBusy(true)
    setError(null)
    try {
      await window.pi.cron.create({ projectPath, schedule, prompt, ...(name.trim() ? { name: name.trim() } : {}) })
      onCreated()
      onClose()
    } catch (e) {
      setError(ue(e))
      setBusy(false)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="dialog-in fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border-[0.5px] border-line bg-canvas p-4 shadow-pop">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('cron.new')}</h2>
          <button className="rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink" title={t('common.close')} onClick={onClose}>
            <X size={15} strokeWidth={1.75} />
          </button>
        </header>

        <div className="mt-3 flex flex-col gap-3">
          <div className="flex gap-2.5">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('cron.fieldProject')}</span>
              <select
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                className="h-9 rounded-lg border-[0.5px] border-line bg-panel px-2 text-sm text-ink outline-none"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('cron.fieldSchedule')}</span>
              <select
                value={preset}
                onChange={(e) => setPreset(Number(e.target.value))}
                className="h-9 rounded-lg border-[0.5px] border-line bg-panel px-2 text-sm text-ink outline-none"
              >
                {PRESETS.map((p, i) => (
                  <option key={p.key} value={i}>
                    {t(p.key)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {PRESETS[preset]!.expr === '' && (
            <input
              value={customExpr}
              onChange={(e) => setCustomExpr(e.target.value)}
              placeholder={t('cron.schedulePlaceholder')}
              className="h-9 rounded-lg border-[0.5px] border-line bg-panel px-2.5 font-mono text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
            />
          )}
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('cron.fieldName')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('cron.namePlaceholder')}
              className="h-9 rounded-lg border-[0.5px] border-line bg-panel px-2.5 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('cron.fieldPrompt')}</span>
            <textarea
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder={t('cron.promptPlaceholder')}
              className="resize-y rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
            />
          </label>
          {error && <p className="text-xs text-bad">{error}</p>}
          <div className="flex justify-end">
            <button
              className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={busy || !projectPath || !prompt.trim() || !schedule.trim()}
              onClick={() => void submit()}
            >
              {busy && <LoaderCircle size={13} className="animate-spin" />}
              {t('cron.create')}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
