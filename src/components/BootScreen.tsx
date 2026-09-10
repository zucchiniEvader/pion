import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download, ExternalLink, FolderGit2, KanbanSquare, LoaderCircle, MessagesSquare, RefreshCw } from 'lucide-react'
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
  /** detectPi's reason for the failure, shown on the setup page. */
  problem?: string
  /** AppMeta.platform — the official installer script is POSIX-only. */
  platform?: string
  onRecheck: () => void
  /** Welcome page: dismiss the first-run intro and mount the main UI. */
  onStart: () => void
}

// What Pion is, in three lines (docs/onboarding-design.md §3.3). Same card
// language as Home's starter chips.
const FEATURES: { icon: typeof MessagesSquare; titleKey: MsgKey; descKey: MsgKey }[] = [
  { icon: MessagesSquare, titleKey: 'welcome.feature.sessions', descKey: 'welcome.feature.sessions.desc' },
  { icon: FolderGit2, titleKey: 'welcome.feature.projects', descKey: 'welcome.feature.projects.desc' },
  { icon: KanbanSquare, titleKey: 'welcome.feature.kanban', descKey: 'welcome.feature.kanban.desc' },
]

function WelcomeScreen({ onStart }: { onStart: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex max-w-md flex-col items-center text-center">
      <AppLogo className="mb-5 size-16 rounded-2xl" />
      <h1 className="text-xl font-semibold tracking-tight">{t('welcome.title')}</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-ink2">{t('welcome.subtitle')}</p>
      <ul className="mt-6 w-full space-y-2 text-left">
        {FEATURES.map(({ icon: Icon, titleKey, descKey }) => (
          <li
            key={titleKey}
            className="flex gap-2.5 rounded-xl border-[0.5px] border-line bg-panel px-3 py-2.5 shadow-card"
          >
            <Icon size={15} strokeWidth={1.75} className="shrink-0 self-center text-ink2" />
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t(titleKey)}</div>
              <div className="mt-0.5 text-xs leading-relaxed text-ink2">{t(descKey)}</div>
            </div>
          </li>
        ))}
      </ul>
      <Button variant="primary" className="mt-6 h-8 px-5" onClick={onStart}>
        {t('welcome.start')}
      </Button>
    </div>
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
    <div className="rounded-xl border-[0.5px] border-line bg-panel p-3 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium">{label}</span>
        <Button size="sm" variant="ghost" onClick={() => void copy()}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {t(copied ? 'settings.copied' : 'settings.copy')}
        </Button>
      </div>
      <code className="mt-2 block select-all break-all rounded-md bg-fill-hover px-2 py-1.5 text-[11px] leading-relaxed text-ink2">
        {command}
      </code>
      {note && <p className="mt-1.5 text-[11px] text-ink2">{note}</p>}
    </div>
  )
}

// Setup guide: pi is missing. The primary action runs pi.dev's official
// installer in main (no shell: fetch → temp file → spawn('sh', [file]), see
// electron/main/pi-install.ts); the copyable commands stay as the fallback for
// what one-click cannot cover — a machine without Node, where the installer
// needs a terminal to offer installing it.
function SetupScreen({ problem, platform, onRecheck }: {
  problem?: string
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
    <div className="flex max-w-lg flex-col items-center text-center">
      <AppLogo className="mb-4 size-14 rounded-2xl" />
      <h1 className="text-xl font-semibold tracking-tight">{t('boot.piMissing')}</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-ink2">{t('boot.piRequired')}</p>

      <Button variant="primary" className="mt-5 h-8 px-4" disabled={installing} onClick={() => void install()}>
        {installing ? <LoaderCircle size={14} className="animate-spin" /> : <Download size={14} />}
        {t(installing ? 'boot.installing' : 'boot.autoInstall')}
      </Button>
      <p className="mt-2 max-w-md text-[11px] leading-relaxed text-ink2">{t('boot.autoInstallHint')}</p>

      {(log.length > 0 || failure || installing) && (
        <div ref={logRef} className="mt-3 max-h-32 w-full overflow-y-auto rounded-md bg-canvas px-2 py-1.5 text-left font-mono text-[10px] leading-4 text-ink2">
          {log.map((line, i) => (
            <div key={i} className="break-all whitespace-pre-wrap">{line}</div>
          ))}
          {failure && <div className="break-all whitespace-pre-wrap text-bad">{failure}</div>}
        </div>
      )}

      {problem && <p className="mt-3 text-xs text-warn">{problem}</p>}

      <div className="mt-5 flex w-full items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-[11px] text-ink2">{t('boot.manualInstall')}</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      <div className="mt-3 w-full space-y-2.5 text-left">
        {/* The official installer is a POSIX shell script; Windows only has the
            npm route documented, so there we show npm alone. */}
        <InstallCommand
          label={t('boot.installScript')}
          command={platform === 'win32' ? PI_INSTALL_NPM : PI_INSTALL_SCRIPT}
          note={platform === 'win32' ? undefined : t('boot.installScriptNote')}
        />
        {platform !== 'win32' && <InstallCommand label={t('boot.installNpm')} command={PI_INSTALL_NPM} />}
      </div>

      <div className="mt-5 flex items-center gap-2">
        <Button variant="secondary" onClick={() => void window.pi.app.openExternal(PI_SITE_URL)}>
          <ExternalLink size={14} />
          {t('boot.openSite')}
        </Button>
        <Button variant="secondary" onClick={onRecheck}>
          <RefreshCw size={14} />
          {t('boot.recheck')}
        </Button>
      </div>
    </div>
  )
}

// Startup gate: a calm splash while the PI environment is verified, an install
// guide when pi is missing, and a one-screen welcome on the first launch that
// finds pi — the main UI only mounts once all of that is done.
export function BootScreen({ phase, problem, platform, onRecheck, onStart }: BootScreenProps) {
  const { t } = useI18n()
  if (phase === 'welcome') return <WelcomeScreen onStart={onStart} />
  if (phase === 'setup') return <SetupScreen problem={problem} platform={platform} onRecheck={onRecheck} />
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
