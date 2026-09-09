import { useState, type KeyboardEvent } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { ProjectRecord, SettingsRuntime } from '@/types'
import { KANBAN_UNASSIGNED } from '@/types'
import { useI18n, useUserErrorMessage } from '@/i18n'

export interface CardCreateResult {
  projectPath: string
  title: string
  body?: string
  acceptance?: string[]
}

interface CardCreateDialogProps {
  projects: ProjectRecord[]
  runtimes: SettingsRuntime[]
  /** Pre-selected project (the current board filter, when it is one). */
  defaultProjectPath: string | null
  onClose: () => void
  onCreate: (input: CardCreateResult) => Promise<void>
}

// Card creation dialog. Project is OPTIONAL: a card may start unassigned in
// the global store and must pick a project only when it is dispatched or
// assigned (execution needs a home, ideation does not).
export function CardCreateDialog({ projects, runtimes, defaultProjectPath, onClose, onCreate }: CardCreateDialogProps) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const runtimeLabel = (project: ProjectRecord) =>
    !project.runtime || project.runtime === 'local'
      ? t('kanban.localRuntime')
      : runtimes.find((runtime) => runtime.id === project.runtime)?.name ?? project.runtime
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [acceptance, setAcceptance] = useState('')
  const [projectPath, setProjectPath] = useState<string>(defaultProjectPath ?? KANBAN_UNASSIGNED)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmed = title.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    try {
      const lines = acceptance
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
      await onCreate({
        projectPath,
        title: trimmed,
        ...(body.trim() ? { body } : {}),
        ...(lines.length ? { acceptance: lines } : {}),
      })
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const onTitleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="dialog-in fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border-[0.5px] border-line bg-canvas p-4 shadow-pop">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('kanban.newCard')}</h2>
          <button className="rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink" title={t('common.close')} onClick={onClose}>
            <X size={15} strokeWidth={1.75} />
          </button>
        </header>

        <div className="mt-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.fieldTitle')}</span>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={onTitleKeyDown}
              placeholder={t('kanban.titlePlaceholder')}
              className="h-9 rounded-lg border-[0.5px] border-line bg-panel px-2.5 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.fieldBody')}</span>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder={t('kanban.bodyPlaceholder')}
              className="resize-y rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.fieldAcceptance')}</span>
            <textarea
              value={acceptance}
              onChange={(e) => setAcceptance(e.target.value)}
              rows={3}
              placeholder={t('kanban.acceptancePlaceholder')}
              className="resize-y rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('kanban.fieldProject')}</span>
            <select
              value={projectPath}
              onChange={(e) => setProjectPath(e.target.value)}
              className="h-9 rounded-lg border-[0.5px] border-line bg-panel px-2 text-sm text-ink outline-none"
            >
              <option value={KANBAN_UNASSIGNED}>{t('kanban.unassignedOption')}</option>
              {projects.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name} · {runtimeLabel(p)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {error && <p className="mt-2 break-words text-[11px] text-bad">{ue(error)}</p>}

        <footer className="mt-4 flex items-center justify-end gap-1.5">
          <button
            className="rounded-lg px-3 py-1.5 text-xs text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
            onClick={onClose}
          >
            {t('common.cancel')}
          </button>
          <button
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-1.5 text-xs text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
            disabled={!title.trim() || busy}
            onClick={() => void submit()}
          >
            {busy && <LoaderCircle size={12} strokeWidth={2} className="animate-spin" />}
            {t('kanban.createCard')}
          </button>
        </footer>
      </div>
    </>
  )
}
