import { useEffect, useRef, useState } from 'react'
import { ArrowRight, Check, ChevronRight, Copy, Download, ExternalLink, FolderGit2, KanbanSquare, LoaderCircle, MessagesSquare, RefreshCw, Terminal } from 'lucide-react'
import { AppLogo } from '@/components/AppLogo'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import type { MsgKey } from '@/i18n/zh'

// Where users get pi, and the two install routes pi.dev documents
// (https://pi.dev/docs/latest). Keep these in sync with the site: the package
// name changed once already (@mariozechner/pi → @earendil-works/pi-coding-agent),
// and an install hint pointing at a dead package is worse than none.
const PI_SITE_URL = 'https://pi.dev'
const PI_INSTALL_SCRIPT = 'curl -fsSL https://pi.dev/install.sh | sh'
const PI_INSTALL_NPM = 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'

interface BootScreenProps {
  phase: 'loading' | 'setup' | 'welcome'
  /** AppMeta.platform — the official installer script is POSIX-only. */
  platform?: string
  onRecheck: () => void
  /** Welcome page: dismiss the first-run intro and mount the main UI. */
  onStart: () => void
}

// The three core workflows introduced on first launch.
const FEATURES: { icon: typeof MessagesSquare; titleKey: MsgKey; descKey: MsgKey }[] = [
  { icon: MessagesSquare, titleKey: 'welcome.feature.sessions', descKey: 'welcome.feature.sessions.desc' },
  { icon: FolderGit2, titleKey: 'welcome.feature.projects', descKey: 'welcome.feature.projects.desc' },
  { icon: KanbanSquare, titleKey: 'welcome.feature.kanban', descKey: 'welcome.feature.kanban.desc' },
]

function WelcomeScreen({ onStart }: { onStart: () => void }) {
  const { t } = useI18n()
  return (
    <section className="w-full max-w-[460px] py-3" aria-labelledby="welcome-title">
      <div className="overflow-hidden rounded-2xl border border-line bg-canvas px-6 py-8 shadow-[0_8px_40px_-16px_rgba(0,0,0,0.16)] sm:px-8">
        <AppLogo className="mb-6 size-14 rounded-2xl" />
        <p className="mb-2 text-[11px] font-medium tracking-[0.14em] text-ink2">{t('welcome.label')}</p>
        <h1 id="welcome-title" className="text-2xl font-semibold tracking-tight">{t('welcome.title')}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink2">{t('welcome.subtitle')}</p>

        <ul className="mt-6 divide-y divide-line">
          {FEATURES.map(({ icon: Icon, titleKey, descKey }) => (
            <li key={titleKey} className="flex gap-3 py-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-panel text-ink2">
                <Icon size={17} strokeWidth={1.75} />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{t(titleKey)}</div>
                <p className="mt-1 text-xs leading-relaxed text-ink2">{t(descKey)}</p>
              </div>
            </li>
          ))}
        </ul>

        <Button variant="primary" className="mt-5 h-10 w-full rounded-lg text-[13px]" onClick={onStart}>
          {t('welcome.start')}
          <ArrowRight size={15} />
        </Button>
      </div>
    </section>
  )
}

// One copyable command. The clipboard write is best-effort, exactly like
// SettingsDialog's copy buttons: if the clipboard is unavailable the text is
// still there to select by hand (hence select-all).
function InstallCommand({ label, command, note }: { label: string; command: string; note?: string }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (permissions): leave the text selectable */
    }
  }
  return (
    <div className="py-4 first:pt-1 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {t(copied ? 'settings.copied' : 'settings.copy')}
        </Button>
      </div>
      <code className="mt-2 block select-all break-all rounded-lg bg-panel px-3 py-2.5 text-[11px] leading-relaxed text-ink">
        {command}
      </code>
      {note && <p className="mt-2 text-[11px] leading-relaxed text-ink2">{note}</p>}
    </div>
  )
}

// Setup guide: pi is missing. The primary action runs pi.dev's official
// installer in main (no shell: fetch → temp file → spawn('sh', [file]), see
// electron/main/pi-install.ts); the copyable commands stay as the fallback for
// what one-click cannot cover — a machine without Node, where the installer
// needs a terminal to offer installing it.
function SetupScreen({ platform, onRecheck }: {
  platform?: string
  onRecheck: () => void
}) {
  const { t } = useI18n()
  const [log, setLog] = useState<string[]>([])
  const [installing, setInstalling] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => window.pi.app.onInstallProgress((event) => {
    if (event.line) setLog((prev) => [...prev.slice(-300), event.line!])
    if (!event.done) return
    setInstalling(false)
    // Success: pi is on disk now, so just continue the boot gate — detectPi
    // caches only successful lookups, so the re-check picks it up.
    if (event.code === 0) onRecheck()
    else setFailure(event.error ?? t('boot.installFailedExit', { code: event.code ?? -1 }))
  }), [onRecheck, t])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const install = async () => {
    setFailure(null)
    setLog([])
    setInstalling(true)
    const res = await window.pi.app.installPi()
    if (!res.started) {
      setInstalling(false)
      setFailure(t('boot.installFailedStart', { reason: res.error ?? '' }))
    }
  }

  return (
    <section className="w-full max-w-[460px] py-3" aria-labelledby="setup-title">
      <div className="overflow-hidden rounded-2xl border border-line bg-canvas shadow-[0_8px_40px_-16px_rgba(0,0,0,0.16)]">
        <div className="px-6 pt-8 pb-6 sm:px-8">
          <AppLogo className="mb-6 size-14 rounded-2xl" />
          <p className="mb-2 text-[11px] font-medium tracking-[0.14em] text-ink2">{t('boot.setupLabel')}</p>
          <h1 id="setup-title" className="text-2xl font-semibold tracking-tight">{t('boot.setupTitle')}</h1>
          <p className="mt-2 text-[13px] leading-relaxed text-ink2">{t('boot.piRequired')}</p>

          <div className="mt-6 flex items-center gap-2 rounded-lg bg-panel px-3 py-2.5 text-xs text-ink2">
            <span className="size-1.5 shrink-0 rounded-full bg-warn" />
            {t('boot.piMissing')}
          </div>
          <Button variant="primary" className="mt-3 h-10 w-full rounded-lg text-[13px]" disabled={installing} onClick={() => void install()}>
            {installing ? <LoaderCircle size={15} className="animate-spin" /> : <Download size={15} />}
            {t(installing ? 'boot.installing' : 'boot.autoInstall')}
          </Button>
          <p className="mt-3 text-center text-[11px] leading-relaxed text-ink2">{t('boot.autoInstallHint')}</p>

          {(log.length > 0 || failure || installing) && (
            <div ref={logRef} role="log" aria-live="polite" aria-label={t('boot.installLog')} className="mt-4 max-h-36 overflow-y-auto rounded-lg border border-line bg-panel p-3 text-left font-mono text-[11px] leading-5 text-ink2">
              {installing && log.length === 0 && <div>{t('boot.installing')}</div>}
              {log.map((line, i) => (
                <div key={i} className="break-all whitespace-pre-wrap">{line}</div>
              ))}
              {failure && <div className="break-all whitespace-pre-wrap text-bad">{failure}</div>}
            </div>
          )}
        </div>

        <details className="group border-t border-line">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-4 text-xs text-ink2 transition-colors hover:bg-fill-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent sm:px-8 [&::-webkit-details-marker]:hidden">
            <Terminal size={14} />
            <span className="flex-1">{t('boot.manualInstall')}</span>
            <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
          </summary>
          <div className="divide-y divide-line px-6 pb-5 sm:px-8">
            <InstallCommand
              label={t(platform === 'win32' ? 'boot.installNpm' : 'boot.installScript')}
              command={platform === 'win32' ? PI_INSTALL_NPM : PI_INSTALL_SCRIPT}
              note={platform === 'win32' ? undefined : t('boot.installScriptNote')}
            />
            {platform !== 'win32' && <InstallCommand label={t('boot.installNpm')} command={PI_INSTALL_NPM} />}
          </div>
        </details>

      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-3 gap-y-2 text-xs text-ink2">
        <span>{t('boot.alreadyInstalled')}</span>
        <Button variant="ghost" size="sm" className="text-ink2" disabled={installing} onClick={onRecheck}>
          <RefreshCw size={12} />
          {t('boot.recheck')}
        </Button>
        <span aria-hidden="true" className="h-3 w-px bg-line" />
        <Button variant="ghost" size="sm" className="text-ink2" onClick={() => void window.pi.app.openExternal(PI_SITE_URL)}>
          {t('boot.openSite')}
          <ExternalLink size={12} />
        </Button>
      </div>
    </section>
  )
}

// Startup gate: a calm splash while the PI environment is verified, an install
// guide when pi is missing, and a one-screen welcome on the first launch that
// finds pi — the main UI only mounts once all of that is done.
export function BootScreen({ phase, platform, onRecheck, onStart }: BootScreenProps) {
  const { t } = useI18n()
  if (phase === 'welcome') return <WelcomeScreen onStart={onStart} />
  if (phase === 'setup') return <SetupScreen platform={platform} onRecheck={onRecheck} />
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
