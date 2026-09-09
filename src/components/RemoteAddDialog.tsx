import { useEffect, useState } from 'react'
import { LoaderCircle, X } from 'lucide-react'
import type { SettingsRuntime } from '@/types'
import { useI18n, useUserErrorMessage } from '@/i18n'

interface RemoteAddDialogProps {
  runtime: SettingsRuntime
  /** Adds the path to this runtime's daemon; caller refreshes the project list. */
  onAdd: (path: string, runtimeId: string) => Promise<void>
  onClose: () => void
}

// Remote add-project dialog (goal.md §9): lists candidate project directories
// discovered on the remote machine (daemon-side projects.discover — no remote
// file browser) and adds one via projects.addOn.
export function RemoteAddDialog({ runtime, onAdd, onClose }: RemoteAddDialogProps) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [candidates, setCandidates] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setCandidates(null)
    setError(null)
    window.pi.projects
      .discover(runtime.id)
      .then((list) => {
        if (!cancelled) setCandidates(list)
      })
      .catch((e) => {
        if (!cancelled) setError(ue(e))
      })
    return () => {
      cancelled = true
    }
    // ue is stable per lang; runtime.id change re-discovers
  }, [runtime.id, ue])

  const add = async (path: string) => {
    if (adding) return
    setAdding(path)
    setError(null)
    try {
      await onAdd(path, runtime.id)
      onClose()
    } catch (e) {
      setError(ue(e))
      setAdding(null)
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="dialog-in fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border-[0.5px] border-line bg-canvas p-4 shadow-pop">
        <header className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('remoteAdd.title', { name: runtime.name })}</h2>
          <button className="rounded-md p-1 text-ink2 transition-colors hover:bg-fill-hover hover:text-ink" title={t('common.close')} onClick={onClose}>
            <X size={15} strokeWidth={1.75} />
          </button>
        </header>

        <div className="mt-3">
          {!runtime.connected ? (
            <p className="rounded-lg border-[0.5px] border-line bg-panel px-3 py-2 text-xs text-ink2">{t('remoteAdd.offlineHint', { name: runtime.name })}</p>
          ) : candidates === null ? (
            <p className="flex items-center gap-2 rounded-lg border-[0.5px] border-line bg-panel px-3 py-2 text-xs text-ink2">
              <LoaderCircle size={13} className="animate-spin" />
              {t('remoteAdd.loading')}
            </p>
          ) : candidates.length === 0 ? (
            <p className="rounded-lg border-[0.5px] border-line bg-panel px-3 py-2 text-xs text-ink2">{t('remoteAdd.empty')}</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {candidates.map((path) => (
                <li key={path} className="flex items-center gap-2 rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2">
                  <span className="min-w-0 truncate font-mono text-xs text-ink" title={path}>
                    {path}
                  </span>
                  <button
                    className="ml-auto flex h-7 shrink-0 items-center rounded-md bg-accent px-2.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                    disabled={adding !== null}
                    onClick={() => void add(path)}
                  >
                    {adding === path ? <LoaderCircle size={12} className="animate-spin" /> : t('remoteAdd.add')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="mt-2 break-all text-xs text-bad">{error}</p>}
        </div>
      </div>
    </>
  )
}
