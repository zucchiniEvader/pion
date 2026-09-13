import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, Download, ExternalLink, LoaderCircle, Plug, RefreshCw, Search, Sparkles } from 'lucide-react'
import type { CommunityPackage, UpdateProgressEvent } from '@/types'
import type { SettingsUpdateApi } from '@/components/SettingsDialog'
import { useI18n, useUserErrorMessage } from '@/i18n'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { pionPluginAdaptation } from '@/lib/pluginAdapters'

function AdaptedBadge({ name }: { name: string }) {
  const { t } = useI18n()
  const adaptation = pionPluginAdaptation(name)
  if (!adaptation) return null
  return <span data-adapted className="inline-flex items-center gap-1 rounded-md bg-tint-accent px-1.5 py-1 text-[10px] font-medium text-accent" title={t(adaptation === 'ui' ? 'settings.plugins.adaptedUi' : 'settings.plugins.adaptedCommands')}><Sparkles size={10} />{t('settings.plugins.adapted')}</span>
}

function PackageIcon({ name, core = false }: { name: string; core?: boolean }) {
  return <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl border-[0.5px]', core || pionPluginAdaptation(name) ? 'border-accent/15 bg-tint-accent text-accent' : 'border-line bg-canvas text-ink2')}><Plug size={17} strokeWidth={1.6} /></span>
}

function InstallLog({ log, progress }: { log: string[]; progress: UpdateProgressEvent | null }) {
  const { t } = useI18n()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }) }, [log, progress])
  if (!log.length && !progress?.done) return null
  return <div ref={ref} role="status" className="max-h-32 overflow-y-auto rounded-xl border border-line bg-panel p-3 font-mono text-[10px] leading-4 text-ink2">
    {log.map((line, i) => <div key={i} className="whitespace-pre-wrap break-all">{line}</div>)}
    {progress?.done && <div className={progress.code === 0 && !progress.error ? 'text-ok' : 'text-bad'}>{progress.error || (progress.code === 0 ? t('settings.plugins.done') : t('settings.plugins.failed', { code: progress.code ?? '' }))}</div>}
  </div>
}

export function PluginsSection({ update }: { update: SettingsUpdateApi }) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [tab, setTab] = useState<'installed' | 'community'>('installed')
  const [query, setQuery] = useState('')
  const [packages, setPackages] = useState<CommunityPackage[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reload, setReload] = useState(0)
  const [checking, setChecking] = useState(false)
  const [installFailure, setInstallFailure] = useState<{ name: string; message: string } | null>(null)
  const [activeInstall, setActiveInstall] = useState<string | null>(null)
  const installLock = useRef(false)
  const installName = useRef<string | null>(null)
  const [installed, setInstalled] = useState<Set<string>>(new Set())
  const [installProgress, setInstallProgress] = useState<UpdateProgressEvent | null>(null)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [updateLog, setUpdateLog] = useState<string[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const recheck = useRef(update.recheck)
  recheck.current = update.recheck
  const entries = update.result?.entries ?? []
  const installedNames = new Set([...entries.map((entry) => entry.name), ...installed])
  const updating = update.progress?.running === true

  useEffect(() => {
    if (tab !== 'community') return
    let cancelled = false
    setPackages(null)
    setLoadError(false)
    const timer = setTimeout(() => {
      void window.pi.plugins.community(query.trim()).then((pkgs) => {
        if (!cancelled) setPackages(pkgs.slice(0, 20))
      }).catch(() => { if (!cancelled) setLoadError(true) })
    }, query ? 300 : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [query, reload, tab])

  useEffect(() => window.pi.plugins.onProgress((event) => {
    setInstallProgress(event)
    if (event.line) setInstallLog((prev) => [...prev.slice(-300), event.line!])
    if (event.done) {
      if ((event.code !== 0 || event.error) && installName.current) {
        setInstallFailure({ name: installName.current, message: event.error || t('settings.plugins.failed', { code: event.code ?? '' }) })
      }
      if (event.code === 0 && !event.error) {
        const name = installName.current
        if (name) setInstalled((prev) => new Set([...prev, name]))
        void recheck.current().catch(() => {})
      }
      installLock.current = false
      installName.current = null
      setActiveInstall(null)
    }
  }), [])

  useEffect(() => {
    if (update.progress?.line) setUpdateLog((prev) => [...prev.slice(-300), update.progress!.line!])
  }, [update.progress])

  const startInstall = async (name: string) => {
    if (installLock.current || updating || installedNames.has(name)) return
    installLock.current = true
    installName.current = name
    setActiveInstall(name)
    setInstallFailure(null)
    setInstallLog([])
    setInstallProgress({ running: true })
    try {
      const result = await window.pi.plugins.install(name)
      if (!result.started) throw new Error(result.error || t('settings.plugins.installFailed'))
    } catch (error) {
      installLock.current = false
      installName.current = null
      setActiveInstall(null)
      setInstallFailure({ name, message: ue(error) })
      setInstallProgress({ running: false, done: true, code: -1, error: ue(error) })
    }
  }

  const checkUpdates = async () => {
    setChecking(true)
    setActionError(null)
    try { await update.recheck() } catch (error) { setActionError(ue(error)) } finally { setChecking(false) }
  }

  return <div data-plugins-page className="flex flex-col gap-5">
    <div><h3 className="text-lg font-semibold tracking-tight text-ink">{t('settings.nav.plugins')}</h3><p className="mt-1 text-xs leading-relaxed text-ink2">{t('settings.plugins.subtitle')}</p></div>
    <div role="tablist" aria-label={t('settings.nav.plugins')} className="flex gap-1 rounded-xl bg-panel p-1">
      {(['installed', 'community'] as const).map((id) => <button key={id} role="tab" tabIndex={tab === id ? 0 : -1} onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const next = event.key === 'Home' ? 'installed' : event.key === 'End' ? 'community' : tab === 'installed' ? 'community' : 'installed'
        setTab(next)
        document.getElementById(`plugins-tab-${next}`)?.focus()
      }} aria-selected={tab === id} aria-controls={`plugins-${id}`} id={`plugins-tab-${id}`} className={cn('flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs transition-colors', tab === id ? 'bg-canvas font-medium text-ink shadow-sm' : 'text-ink2 hover:text-ink')} onClick={() => setTab(id)}>{t(`settings.plugins.${id}`)}{id === 'installed' && update.result && <span className="rounded bg-fill-hover px-1.5 text-[10px] tabular-nums text-ink2">{entries.length}</span>}</button>)}
    </div>

    <div role="tabpanel" id={`plugins-${tab}`} aria-labelledby={`plugins-tab-${tab}`} className="flex flex-col gap-4">
    {tab === 'installed' ? <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-ink2">{t('settings.plugins.installedHint')}</span>
        <div className="flex items-center gap-2">
          <button title={t('settings.updates.recheck')} aria-label={t('settings.updates.recheck')} disabled={checking || updating || !!activeInstall} className="rounded-lg p-2 text-ink2 hover:bg-fill-hover disabled:opacity-40" onClick={() => void checkUpdates()}><RefreshCw size={13} className={checking ? 'animate-spin' : ''} /></button>
          <button disabled={updating || !!activeInstall || !(update.result?.outdatedCount)} className="rounded-lg bg-accent px-3 py-2 text-[11px] font-medium text-white hover:bg-accent-hover disabled:opacity-40" onClick={() => {
            setUpdateLog([])
            setActionError(null)
            void update.runUpdate().then((res) => { if (!res.started) setActionError(res.error || t('settings.plugins.installFailed')) }).catch((error) => setActionError(ue(error)))
          }}>{updating ? t('settings.updates.updating') : t('settings.updates.all')}</button>
        </div>
      </div>
      {actionError && <p role="alert" className="text-xs text-bad">{actionError}</p>}
      <ul data-plugin-grid="installed" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
        {entries.map((entry) => <li key={`${entry.kind}:${entry.name}`} className="flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-panel/50 p-4">
          <div className="flex items-start gap-3"><PackageIcon name={entry.name} core={entry.kind === 'pi'} /><div className="min-w-0 flex-1"><h4 className="break-words text-xs font-semibold leading-5 text-ink">{entry.name}</h4><p className="text-[10px] text-ink2">{entry.kind === 'pi' ? t('settings.plugins.core') : t('settings.updates.kindExtension')}</p></div><button title={t('settings.updates.openNpm')} className="shrink-0 text-ink2 hover:text-ink" onClick={() => void window.pi.app.openExternal(`https://www.npmjs.com/package/${entry.name}`)}><ArrowUpRight size={14} /></button></div>
          <div className="flex flex-wrap items-center gap-1.5"><AdaptedBadge name={entry.name} />{entry.outdated && <span className="rounded-md bg-tint-warn px-1.5 py-1 text-[10px] text-warn">{t('settings.updates.outdated')}</span>}</div>
          <div className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-[10px] tabular-nums text-ink2"><span>{entry.installed ?? '—'}{entry.outdated && entry.latest ? ` → ${entry.latest}` : ''}</span><span className="flex items-center gap-1"><Check size={11} />{t('settings.plugins.installedBadge')}</span></div>
        </li>)}
      </ul>
      {!update.result && <p className="py-8 text-center text-xs text-ink2">{t('settings.updates.checking')}</p>}
      {update.result && !entries.length && <p className="py-8 text-center text-xs text-ink2">{t('settings.plugins.noInstalled')}</p>}
      <InstallLog log={updateLog} progress={update.progress} />
    </> : <>
      <div className="relative"><Search size={14} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink2" /><Input className="pl-9" value={query} onValueChange={setQuery} placeholder={t('settings.plugins.search')} aria-label={t('settings.plugins.search')} /></div>
      <div className="flex items-center justify-between gap-3 text-[11px] text-ink2"><span>{t('settings.plugins.limit')}</span><button className="flex shrink-0 items-center gap-1 hover:text-ink" onClick={() => void window.pi.app.openExternal('https://pi.dev/packages')}>{t('settings.plugins.viewAll')}<ExternalLink size={11} /></button></div>
      <ul data-plugin-grid="community" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
        {(packages ?? []).map((pkg) => {
          const isInstalled = installedNames.has(pkg.name)
          const isInstalling = activeInstall === pkg.name
          return <li key={pkg.name} data-plugin={pkg.name} className="group flex min-w-0 flex-col rounded-xl border border-line bg-panel/50 p-4 transition-colors hover:border-accent/30 hover:bg-panel">
            <div className="mb-3 flex items-start justify-between gap-2"><PackageIcon name={pkg.name} /><AdaptedBadge name={pkg.name} /></div>
            <h4 className="break-words text-xs font-semibold leading-5 text-ink">{pkg.name}</h4>
            <p title={pkg.description ?? undefined} className="mt-1.5 line-clamp-2 min-h-9 text-[11px] leading-[18px] text-ink2">{pkg.description || t('settings.plugins.noDescription')}</p>
            <div className="mb-4 mt-3 flex min-w-0 items-center gap-2 text-[10px] text-ink2"><span className="min-w-0 flex-1 truncate">{pkg.publisher || '—'}</span><span className="shrink-0 tabular-nums">{pkg.version}</span></div>
            {installFailure?.name === pkg.name && <p role="alert" className="mb-3 break-words text-[11px] leading-relaxed text-bad">{installFailure.message}</p>}
            <div className="mt-auto flex items-center justify-between border-t border-line pt-3"><button title={t('settings.updates.openNpm')} className="flex items-center gap-1 text-[10px] text-ink2 hover:text-ink" onClick={() => void window.pi.app.openExternal(`https://www.npmjs.com/package/${pkg.name}`)}>{t('settings.plugins.details')}<ArrowUpRight size={11} /></button>
              <button data-install={pkg.name} disabled={!!activeInstall || updating || isInstalled} onClick={() => void startInstall(pkg.name)} className={cn('inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:cursor-default', isInstalled ? 'bg-fill-hover text-ink2' : 'bg-accent text-white hover:bg-accent-hover disabled:opacity-45')}>
                {isInstalling ? <LoaderCircle size={12} className="animate-spin" /> : isInstalled ? <Check size={12} /> : <Download size={12} />}{isInstalling ? t('settings.plugins.installing') : isInstalled ? t('settings.plugins.installedBadge') : t('settings.plugins.install')}
              </button>
            </div>
          </li>
        })}
      </ul>
      {loadError ? <div role="alert" className="flex flex-col items-center gap-3 rounded-xl border border-line p-8"><p className="text-xs text-ink2">{t('settings.plugins.loadFailed')}</p><button className="text-xs text-accent" onClick={() => setReload((n) => n + 1)}>{t('settings.plugins.retry')}</button></div> : packages === null ? <div className="flex items-center justify-center gap-2 py-10 text-xs text-ink2"><LoaderCircle size={14} className="animate-spin" />{t('settings.plugins.loading')}</div> : !packages.length && <p className="py-10 text-center text-xs text-ink2">{t('settings.plugins.empty')}</p>}
      <p className="text-[10px] leading-relaxed text-ink2">{t('settings.plugins.securityHint')}</p>
    </>}
    </div>
    <InstallLog log={installLog} progress={installProgress} />
  </div>
}
