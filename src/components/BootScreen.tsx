import { LoaderCircle, RefreshCw } from 'lucide-react'
import { AppLogo } from '@/components/AppLogo'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

interface BootScreenProps {
  phase: 'loading' | 'setup'
  /** detectPi's reason for the failure, shown on the setup page. */
  problem?: string
  onRecheck: () => void
}

// Startup gate: a calm splash while the PI environment is verified, and a
// setup guide when pi is missing — the main UI only mounts once PI is found.
export function BootScreen({ phase, problem, onRecheck }: BootScreenProps) {
  const { t } = useI18n()
  if (phase === 'setup') {
    return (
      <div className="flex max-w-sm flex-col items-center text-center">
        <AppLogo className="mb-4 size-14 rounded-2xl" />
        <h1 className="text-xl font-semibold tracking-tight">{t('boot.piMissing')}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink2">
          {t('boot.piRequired')}
          <br />
          {t('boot.installHint')}<code className="rounded bg-fill-hover px-1.5 py-0.5 text-xs">npm install -g @mariozechner/pi</code>
        </p>
        {problem && <p className="mt-3 text-xs text-warn">{problem}</p>}
        <Button variant="primary" className="mt-5" onClick={onRecheck}>
          <RefreshCw size={14} />
          {t('boot.recheck')}
        </Button>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center gap-4">
      <AppLogo className="size-14 rounded-2xl" />
      <div className="flex items-center gap-2 text-[13px] text-ink2">
        <LoaderCircle size={13} strokeWidth={1.75} className="animate-spin" />
        {t('boot.checking')}
      </div>
    </div>
  )
}
