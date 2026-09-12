import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  AtSign,
  CircleCheck,
  Check,
  ChevronDown,
  Code2,
  Copy,
  ExternalLink,
  FolderOpen,
  Globe,
  Info,
  KeyRound,
  LoaderCircle,
  Plug,
  Plus,
  QrCode,
  RefreshCw,
  Server,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { encode } from 'uqr'
import type {
  AppMeta,
  AppUpdateStatus,
  AuthProviderCandidate,
  AuthStateResult,
  ConfiguredAuthProvider,
  GuiUpdateInfo,
  PiAvailableModel,
  ProvidersLocalResult,
  SettingsPairingInfo,
  SettingsQrInfo,
  SettingsRuntime,
  SettingsStatus,
  CommunityPackage,
  UpdateCheckResult,
  UpdateProgressEvent,
} from '@/types'
import { Badge } from '@/components/ui/badge'
import { useI18n, useUserErrorMessage } from '@/i18n'
import { applyTheme, persistTheme, readStoredTheme } from '@/theme'
import { readTerminalPrefs, writeTerminalPrefs, DEFAULT_TERMINAL_FONT_FAMILY, type TerminalPrefs } from '@/lib/terminalPrefs'
import { AppLogo } from '@/components/AppLogo'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export type SettingsSection = 'general' | 'providers' | 'runtimes' | 'plugins' | 'about'

/** Update-check slice of useUpdateCheck, owned by App (single subscriber —
 * preload dispatches each push channel to the latest subscriber only). */
export interface SettingsUpdateApi {
  result: UpdateCheckResult | null
  progress: UpdateProgressEvent | null
  recheck: () => Promise<void>
  runUpdate: () => Promise<{ started: boolean; error?: string }>
}

interface SettingsDialogProps {
  meta: AppMeta | null
  runtimes: SettingsRuntime[]
  /** Re-pulls the runtime list from main (after add/remove/test). */
  onRefresh: () => Promise<void>
  initialSection: SettingsSection
  update: SettingsUpdateApi
  /** The default model was changed (persisted to pi's settings.json). */
  onDefaultModelChanged: (provider: string, modelId: string) => void
  onClose: () => void
}

type AddMode = 'pairing' | 'manual' | 'install'

/** Public download host for install.sh + the pion-daemon bundle: GitHub
 * Releases (`npm run publish:daemon-github` uploads the assets; the
 * releases/latest/download base always serves the newest ones). Paste an
 * intranet mirror URL here to override (no rebuild needed), or use the
 * pairing tab, which hands the daemon file over directly. */
const DEFAULT_DAEMON_DL_BASE = 'https://github.com/zucchiniEvader/pion/releases/latest/download'

// Settings dialog (docs/settings-design.md): a left-nav shell with five
// sections. General = language + appearance; Providers = read-only view of
// the local pi's models.json; Runtimes = the original runtime management;
// Updates was redesigned as the Plugins page: installed pi + extensions
// with upgrade affordances, plus the community gallery with in-app install.
// The GUI app's own self-update lives in About.
export function SettingsDialog({ meta, runtimes, onRefresh, initialSection, update, onDefaultModelChanged, onClose }: SettingsDialogProps) {
  const { t } = useI18n()
  const [section, setSection] = useState<SettingsSection>(initialSection)

  // Esc closes, same as clicking the overlay.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const navItems: { id: SettingsSection; label: string; icon: typeof Info }[] = [
    { id: 'general', label: t('settings.nav.general'), icon: SlidersHorizontal },
    { id: 'providers', label: t('settings.nav.providers'), icon: Box },
    { id: 'runtimes', label: t('settings.nav.runtimes'), icon: Server },
    { id: 'plugins', label: t('settings.nav.plugins'), icon: Plug },
    { id: 'about', label: t('settings.nav.about'), icon: Info },
  ]

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />
      <div className="dialog-in fixed left-1/2 top-1/2 z-50 flex h-[680px] w-[900px] max-h-[88vh] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border-[0.5px] border-line bg-canvas shadow-pop">
        {/* Full-width title bar: title left, close right (the conventional
            spot — the X previously squeezed into the nav column read odd). */}
        <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
          <h2 className="text-sm font-semibold">{t('settings.title')}</h2>
          <button className="grid size-7 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink" title={t('common.close')} onClick={onClose}>
            <X size={14} strokeWidth={1.75} />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* Left nav: five sections. */}
          <nav className="flex w-44 shrink-0 flex-col gap-1 border-r border-line bg-panel p-2.5">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                className={cn(
                  'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors',
                  section === id ? 'bg-fill-active font-medium text-ink' : 'text-ink2 hover:bg-fill-hover hover:text-ink',
                )}
                onClick={() => setSection(id)}
              >
                <Icon size={14} strokeWidth={1.75} className="shrink-0" />
                <span className="truncate">{label}</span>
                {id === 'runtimes' && (
                  <span className="ml-auto rounded bg-tint-warn px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-warn">
                    Beta
                  </span>
                )}
              </button>
            ))}
          </nav>

          {/* Right content: one scrollable pane per section. */}
          <div className="min-w-0 flex-1 overflow-y-auto p-6">
            {section === 'general' && <GeneralSection />}
            {section === 'providers' && <ProvidersSection onDefaultModelChanged={onDefaultModelChanged} />}
            {section === 'runtimes' && <RuntimesSection runtimes={runtimes} onRefresh={onRefresh} />}
            {section === 'plugins' && <PluginsSection update={update} />}
            {section === 'about' && <AboutSection meta={meta} />}
          </div>
        </div>
      </div>
    </>
  )
}

// macOS-style segmented control (same visual as the pairing/manual tabs).
function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 rounded-lg border-[0.5px] border-line bg-panel p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          className={cn('rounded-md px-2.5 py-1 text-xs font-medium transition-colors', value === o.value ? 'bg-canvas text-ink shadow-sm' : 'text-ink2 hover:text-ink')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SettingsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-lg border-[0.5px] border-line bg-panel px-3 py-2.5">
      <span className="text-[13px] font-medium text-ink">{label}</span>
      {children}
    </div>
  )
}

// ── General: language + appearance ─────────────────────────────────────────

function GeneralSection() {
  const { t, langSetting, setLang } = useI18n()
  const [theme, setThemeState] = useState(readStoredTheme)

  const pickTheme = (next: typeof theme) => {
    setThemeState(next)
    persistTheme(next)
    applyTheme(next)
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('settings.nav.general')}</h3>
      <SettingsRow label={t('settings.general.language')}>
        <Segmented
          value={langSetting}
          onChange={setLang}
          options={[
            { value: 'system', label: t('settings.general.langSystem') },
            { value: 'zh', label: t('settings.general.langZh') },
            { value: 'en', label: t('settings.general.langEn') },
          ]}
        />
      </SettingsRow>
      <SettingsRow label={t('settings.general.appearance')}>
        <Segmented
          value={theme}
          onChange={pickTheme}
          options={[
            { value: 'system', label: t('settings.general.themeSystem') },
            { value: 'light', label: t('settings.general.themeLight') },
            { value: 'dark', label: t('settings.general.themeDark') },
          ]}
        />
      </SettingsRow>
      <SettingsRow label={t('settings.general.terminalFont')}>
        <TerminalFontControls />
      </SettingsRow>
    </div>
  )
}

// Terminal font family (freeform, empty = default) + size (preset steps).
// Renderer-local prefs (src/lib/terminalPrefs.ts) — a live terminal applies
// them immediately via the prefs-change event.
function TerminalFontControls() {
  const [prefs, setPrefs] = useState(readTerminalPrefs)
  const update = (patch: Partial<TerminalPrefs>) => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    writeTerminalPrefs(next)
  }
  return (
    <div className="flex items-center gap-2">
      <input
        value={prefs.fontFamily}
        onChange={(e) => update({ fontFamily: e.target.value })}
        placeholder={DEFAULT_TERMINAL_FONT_FAMILY}
        spellCheck={false}
        className="h-8 w-64 rounded-lg border-[0.5px] border-line bg-panel px-2.5 font-mono text-xs text-ink outline-none placeholder:text-ink2/60 focus:border-ink/30"
      />
      <Segmented
        value={String(prefs.fontSize)}
        onChange={(v) => update({ fontSize: Number(v) })}
        options={['10', '12', '14', '16', '18'].map((s) => ({ value: s, label: s }))}
      />
    </div>
  )
}

// ── Providers: pi's credential store (auth.json) + the models.json view ───

function ProvidersSection({ onDefaultModelChanged }: { onDefaultModelChanged: (provider: string, modelId: string) => void }) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [data, setData] = useState<ProvidersLocalResult | null>(null)
  const [auth, setAuth] = useState<AuthStateResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)

  useEffect(() => {
    void window.pi.app.providersLocal().then(setData).catch((e) => setError(ue(e)))
    void window.pi.app.authState().then(setAuth).catch((e) => setAuthError(ue(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setDefault = async (m: PiAvailableModel): Promise<void> => {
    await window.pi.app.setDefaultModel(m.provider, m.id)
    onDefaultModelChanged(m.provider, m.id)
    setData(await window.pi.app.providersLocal())
  }

  // Two-step remove, like the runtimes list.
  const remove = async (id: string): Promise<void> => {
    if (busy) return
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id)
      return
    }
    setConfirmRemoveId(null)
    setBusy(true)
    setAuthError(null)
    try {
      setAuth(await window.pi.app.authRemove(id))
    } catch (e) {
      setAuthError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  if (error) return <p className="break-all text-xs text-bad">{error}</p>
  if (!data) return <LoaderCircle size={16} className="animate-spin text-ink2" />

  return (
    <div data-settings-providers className="@container mx-auto flex max-w-[640px] flex-col gap-6">
      <header>
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xl font-semibold tracking-tight text-ink">{t('settings.nav.providers')}</h3>
          <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-2 py-1 text-[10px] text-ink2">
            <Server size={11} />{t('settings.providers.thisDevice')}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-ink2">{t('settings.providers.description')}</p>
      </header>

      <section aria-labelledby="provider-default-model">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h4 id="provider-default-model" className="text-xs font-semibold text-ink">{t('settings.providers.defaultModel')}</h4>
          <span className="text-[10px] text-ink2">{t('settings.providers.defaultHint')}</span>
        </div>
        <DefaultModelPicker
          current={data.defaultProvider && data.defaultModel ? { provider: data.defaultProvider, model: data.defaultModel } : null}
          onPick={setDefault}
        />
      </section>

      <section aria-labelledby="provider-credentials">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h4 id="provider-credentials" className="flex items-center gap-2 text-xs font-semibold text-ink">
            {t('settings.providers.credentials')}
            {auth && <span className="text-[11px] font-normal tabular-nums text-ink2">{auth.configured.length}</span>}
          </h4>
          {!adding && auth && (
            <button className="flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11px] font-medium text-white transition-colors hover:bg-accent-hover" onClick={() => setAdding(true)}>
              <Plus size={12} />{t('settings.providers.addKey')}
            </button>
          )}
        </div>
        {adding && auth && (
          <AddApiKeyForm candidates={auth.candidates} configured={auth.configured}
            onSaved={(state) => { setAuth(state); setAdding(false) }} onCancel={() => setAdding(false)} />
        )}
        {!auth && !authError && <LoaderCircle size={14} className="animate-spin text-ink2" />}
        {auth && auth.configured.length === 0 && <p className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-ink2">{t('settings.providers.noCredentials')}</p>}
        {auth && auth.configured.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {auth.configured.map((c) => (
              <li key={c.id} className="flex min-w-0 items-center gap-3 px-3 py-2.5 transition-colors hover:bg-panel">
                <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg border border-line bg-panel text-xs font-semibold text-ink2">{c.name.slice(0, 1).toUpperCase()}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-ink" title={c.name}>{c.name}</p>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-ink2" title={c.id}>{c.id}</p>
                </div>
                <span className={cn('flex shrink-0 items-center gap-1.5 text-[10px]', c.kind === 'api_key' ? 'text-ok' : 'text-ink2')} title={c.kind === 'oauth' ? t('settings.providers.oauthHint') : undefined}>
                  {c.kind === 'api_key' ? <span className="size-1.5 rounded-full bg-ok" /> : <KeyRound size={11} />}
                  {t(c.kind === 'api_key' ? 'settings.providers.keyOk' : 'settings.providers.oauthBadge')}
                </span>
                <div className="flex w-6 shrink-0 justify-end">
                  {c.removable && (
                    <button className={cn('grid size-6 place-items-center rounded-md transition-colors', confirmRemoveId === c.id ? 'bg-tint-bad text-bad' : 'text-ink2 hover:bg-tint-bad hover:text-bad')}
                      title={confirmRemoveId === c.id ? t('settings.removeConfirm') : t('settings.remove')}
                      aria-label={`${confirmRemoveId === c.id ? t('settings.removeConfirm') : t('settings.remove')} ${c.name}`}
                      disabled={busy} onClick={() => void remove(c.id)}>
                      {confirmRemoveId === c.id ? <Check size={13} /> : <Trash2 size={13} strokeWidth={1.75} />}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2.5 text-[10px] leading-relaxed text-ink2">{t('settings.providers.credentialsHint')}</p>
        {authError && <p role="alert" className="mt-2 break-all text-xs text-bad">{authError}</p>}
      </section>

      <section aria-labelledby="provider-custom">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h4 id="provider-custom" className="flex items-center gap-2 text-xs font-semibold text-ink">
            {t('settings.providers.custom')}<span className="text-[11px] font-normal tabular-nums text-ink2">{data.providers.length}</span>
          </h4>
          {data.path && (
            <div className="flex items-center gap-1">
              <button className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-ink2 hover:bg-fill-hover hover:text-ink" title={data.path} onClick={() => void window.pi.app.openVSCode(data.path!)}>
                <ExternalLink size={12} />{t('settings.providers.openInEditor')}
              </button>
              <button className="grid size-7 place-items-center rounded-md text-ink2 hover:bg-fill-hover hover:text-ink" title={t('settings.providers.reveal')} aria-label={t('settings.providers.reveal')} onClick={() => void window.pi.app.revealPath(data.path!)}><FolderOpen size={14} /></button>
            </div>
          )}
        </div>
        {data.providers.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs text-ink2">{t('settings.providers.empty')}</div>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.providers.map((p) => (
              <li key={p.name} className="min-w-0 rounded-xl border border-line px-3 py-3">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-ink" title={p.name}>{p.name}</span>
                  <span className={cn('shrink-0 text-[10px]', p.hasApiKey ? 'text-ok' : 'text-ink2')}>{t(p.hasApiKey ? 'settings.providers.keyOk' : 'settings.providers.keyMissing')}</span>
                  <span className="shrink-0 rounded-md bg-panel px-1.5 py-0.5 text-[10px] tabular-nums text-ink2">{t('settings.providers.models', { count: p.modelCount })}</span>
                </div>
                <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-ink2">
                  <span className="min-w-0 flex-1 basis-48 truncate font-mono" title={p.baseUrl}>{p.baseUrl}</span>
                  <span className="break-all">{p.api}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2.5 text-[10px] leading-relaxed text-ink2">{t('settings.providers.localOnly')}</p>
      </section>
    </div>
  )
}

// Stores an API key in pi's auth.json: pick a provider (search over pi's
// built-in API-key providers + the user's models.json providers), then the
// key. The value goes daemon-side and is never read back.
function AddApiKeyForm({
  candidates,
  configured,
  onSaved,
  onCancel,
}: {
  candidates: AuthProviderCandidate[]
  configured: ConfiguredAuthProvider[]
  onSaved: (state: AuthStateResult) => void
  onCancel: () => void
}) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [provider, setProvider] = useState<AuthProviderCandidate | null>(null)
  const [query, setQuery] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const configuredIds = new Set(configured.filter((c) => c.kind === 'api_key').map((c) => c.id))

  const q = query.trim().toLowerCase()
  const matches = candidates.filter((c) => !q || c.id.toLowerCase().includes(q) || c.name.toLowerCase().includes(q)).slice(0, 40)

  const save = async (): Promise<void> => {
    if (!provider || busy) return
    setBusy(true)
    setError(null)
    try {
      onSaved(await window.pi.app.authSetKey(provider.id, key))
    } catch (e) {
      setError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-2 mb-2 flex flex-col gap-2 rounded-lg border-[0.5px] border-line bg-canvas p-2.5">
      {provider ? (
        <div className="flex items-center gap-2">
          <span className="text-[12px] font-medium text-ink">{provider.name}</span>
          <span className="font-mono text-[11px] text-ink2">{provider.id}</span>
          <button
            className="ml-auto text-[11px] text-accent hover:underline"
            onClick={() => {
              setProvider(null)
              setError(null)
            }}
          >
            {t('settings.providers.changeProvider')}
          </button>
        </div>
      ) : (
        <>
          <Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder={t('settings.providers.pickProvider')}
          />
          <div className="max-h-48 overflow-y-auto">
            {matches.map((c) => (
              <button
                key={c.id}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-fill-hover"
                onClick={() => setProvider(c)}
              >
                <span className="text-xs font-medium text-ink">{c.name}</span>
                <span className="font-mono text-[11px] text-ink2">{c.id}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[10px] text-ink2">
                  {c.env && <span>{c.env}</span>}
                  {c.custom && <span>{t('settings.providers.customBadge')}</span>}
                  {configuredIds.has(c.id) && <span className="text-ok">{t('settings.providers.keyOk')}</span>}
                </span>
              </button>
            ))}
            {matches.length === 0 && <p className="px-2 py-3 text-center text-xs text-ink2">{t('settings.providers.noMatch')}</p>}
          </div>
        </>
      )}

      {provider && (
        <Input
          type="password"
          autoFocus
          value={key}
          onValueChange={setKey}
          placeholder={t('settings.providers.apiKey')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save()
          }}
        />
      )}
      {provider?.env && <p className="text-[10px] text-ink2">{t('settings.providers.envHint', { env: provider.env })}</p>}
      {error && <p className="break-all text-[11px] text-bad">{error}</p>}

      <div className="flex justify-end gap-1.5">
        <button
          className="flex h-7 items-center rounded-lg border-[0.5px] border-line px-2.5 text-[11px] font-medium text-ink transition-colors hover:bg-fill-hover"
          onClick={onCancel}
        >
          {t('common.cancel')}
        </button>
        <button
          className="flex h-7 items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={!provider || !key.trim() || busy}
          onClick={() => void save()}
        >
          {busy && <LoaderCircle size={12} className="animate-spin" />}
          {t('settings.save')}
        </button>
      </div>
    </div>
  )
}

// Settings default-model picker: same interaction as the composer's model
// menu (search + provider groups + check), but backed by `pi --list-models`
// via main (works with no live runtime) and persisting to pi's settings.json.
function DefaultModelPicker({
  current,
  onPick,
}: {
  current: { provider: string; model: string } | null
  onPick: (m: PiAvailableModel) => Promise<void>
}) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<PiAvailableModel[] | null>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)

  // Outside click closes, like every other popover here.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // Catalog loads lazily on first open (~1s pi spawn in main, then cached).
  const toggle = async (): Promise<void> => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (models === null) {
      try {
        setModels(await window.pi.app.modelsList())
      } catch (e) {
        setError(ue(e))
        setModels([])
      }
    }
  }

  const pick = async (m: PiAvailableModel): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onPick(m)
      setOpen(false)
      setQuery('')
    } catch (e) {
      setError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  const q = query.trim().toLowerCase()
  const filtered = (models ?? []).filter((m) => !q || `${m.provider}/${m.id}`.toLowerCase().includes(q))
  // Group by provider, preserving first-appearance order.
  const groups = new Map<string, PiAvailableModel[]>()
  for (const m of filtered) {
    const list = groups.get(m.provider)
    if (list) list.push(m)
    else groups.set(m.provider, [m])
  }

  return (
    <span ref={rootRef} className="relative block min-w-0">
      <button
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-line bg-canvas px-3 py-2.5 text-left text-xs font-medium text-ink transition-colors hover:bg-fill-hover"
        aria-expanded={open}
        title={current ? `${current.provider}/${current.model}` : undefined}
        onClick={() => void toggle()}
      >
        <span className="min-w-0">
          {current ? <><span className="block break-all font-mono text-[13px]">{current.model}</span><span className="mt-1 block break-all text-[10px] font-normal text-ink2">{current.provider}</span></> : t('settings.providers.pickDefault')}
        </span>
        <ChevronDown size={11} strokeWidth={2} className={cn('shrink-0 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="pop-card absolute right-0 top-full z-30 mt-1.5 flex max-h-80 w-full flex-col overflow-hidden p-1">
          <div className="p-1 pb-1.5">
            <Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setOpen(false)
                }
              }}
              placeholder={t('composer.searchModel')}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
            {models === null && (
              <p className="flex items-center justify-center gap-2 px-2.5 py-3 text-xs text-ink2">
                <LoaderCircle size={13} className="animate-spin" />
              </p>
            )}
            {[...groups.entries()].map(([provider, items]) => (
              <div key={provider} className="mb-0.5">
                <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink2">{provider}</p>
                {items.map((m) => {
                  const isCurrent = current?.provider === m.provider && current?.model === m.id
                  return (
                    <button
                      key={`${m.provider}/${m.id}`}
                      className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover disabled:opacity-50"
                      disabled={busy}
                      title={`${m.provider}/${m.id}`}
                      onClick={() => void pick(m)}
                    >
                      <span className="truncate font-mono">{m.id}</span>
                      {isCurrent && <Check size={13} strokeWidth={2} className="shrink-0" />}
                    </button>
                  )
                })}
              </div>
            ))}
            {models !== null && !filtered.length && <p className="px-2.5 py-2 text-xs text-ink2">{t('composer.noModels')}</p>}
          </div>
          {error && <p className="break-words border-t-[0.5px] border-line px-2.5 py-2 text-[11px] text-bad">{error}</p>}
        </div>
      )}
    </span>
  )
}

// ── Runtimes: the original runtime management, relocated verbatim ──────────

function RuntimesSection({ runtimes, onRefresh }: { runtimes: SettingsRuntime[]; onRefresh: () => Promise<void> }) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [mode, setMode] = useState<AddMode>('pairing')
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  // iOS connect QR (pion:// link composed main-side, token included).
  const [qrRuntime, setQrRuntime] = useState<{ id: string; name: string } | null>(null)
  // Manual reconnect (settings button): immediate dial for an offline remote
  // — the background backoff ladder keeps retrying, but invisibly; this gives
  // the "server was down when Pion started" case a visible, instant action.
  const [reconnectingId, setReconnectingId] = useState<string | null>(null)

  const reconnect = async (id: string) => {
    if (reconnectingId) return
    setReconnectingId(id)
    setError(null)
    try {
      const r = await window.pi.settings.reconnect(id)
      if (!r.ok) setError(r.error)
      // Success needs no local patch: main pushes settings.onChanged and the
      // runtimes list (a prop) refreshes, flipping this row's badge.
    } catch (e) {
      setError(ue(e))
    } finally {
      setReconnectingId(null)
    }
  }

  // 允许远程接入 (dial-home listener) — pulled on mount, toggled via
  // settings.setListener. Disabling while runtimes are paired asks for a
  // confirm: those runtimes cannot re-dial until it is re-enabled.
  const [listener, setListener] = useState<SettingsStatus | null>(null)
  const [listenerBusy, setListenerBusy] = useState(false)
  const [confirmDisable, setConfirmDisable] = useState(false)
  useEffect(() => {
    void window.pi.settings.status().then(setListener).catch(() => undefined)
  }, [])

  // Pairing flow state. `pairingBaseline` = runtime ids present when the
  // pairing command was generated — the first NEW connected runtime is the
  // paired one (App refreshes runtimes on settings.onChanged).
  const [pairing, setPairing] = useState<SettingsPairingInfo | null>(null)
  const [pairingHost, setPairingHost] = useState('')
  const [pairingBaseline, setPairingBaseline] = useState<string[]>([])
  const [pairingDone, setPairingDone] = useState<string | null>(null)
  const [pairingCopied, setPairingCopied] = useState(false)
  const [pairingDaemonFile, setPairingDaemonFile] = useState('')
  const pairingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 远程安装 tab: editable download base + copyable one-liner.
  const [installBase, setInstallBase] = useState(DEFAULT_DAEMON_DL_BASE)
  const [installCopied, setInstallCopied] = useState(false)
  const installBaseClean = installBase.trim().replace(/\/+$/, '')
  const installCommand = installBaseClean ? `curl -fsSL ${installBaseClean}/install.sh | sh` : ''
  const copyInstallCommand = async () => {
    if (!installCommand) return
    try {
      await navigator.clipboard.writeText(installCommand)
      setInstallCopied(true)
      setTimeout(() => setInstallCopied(false), 1500)
    } catch {
      /* clipboard unavailable (permissions): leave the text selectable */
    }
  }

  const formValid = name.trim() && host.trim() && /^\d+$/.test(port) && token.trim()

  const toggleListener = async (enabled: boolean) => {
    if (listenerBusy || !listener) return
    if (!enabled && !confirmDisable) {
      setConfirmDisable(true)
      return
    }
    setConfirmDisable(false)
    setListenerBusy(true)
    setError(null)
    try {
      const r = await window.pi.settings.setListener({ enabled })
      if (!r.ok) setError(r.error)
      else setListener(r.value)
    } catch (e) {
      setError(ue(e))
    } finally {
      setListenerBusy(false)
    }
  }

  const startPairing = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setPairingDone(null)
    setPairingCopied(false)
    try {
      const r = await window.pi.settings.pairing.start({})
      if (!r.ok) {
        setError(r.error)
        return
      }
      setPairing(r.value)
      setPairingHost(r.value.hosts[0] ?? '')
      setPairingDaemonFile(r.value.daemonFile)
      setPairingBaseline(runtimes.map((x) => x.id))
      // Listener state changed as a side effect (pairing enables it).
      void window.pi.settings.status().then(setListener).catch(() => undefined)
    } catch (e) {
      setError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  const cancelPairing = async () => {
    try {
      await window.pi.settings.pairing.cancel()
    } catch {
      /* best-effort: the window also expires on its own */
    }
    setPairing(null)
    setPairingDone(null)
  }

  // Completion detection: a NEW connected runtime id (not in the baseline
  // snapshot) means the dial-home daemon just paired. Show a success state
  // briefly; the dialog stays open — the new runtime is visible in the list
  // right above.
  useEffect(() => {
    if (!pairing || pairingDone) return
    const paired = runtimes.find((r) => r.kind === 'remote' && r.connected && !pairingBaseline.includes(r.id))
    if (!paired) return
    setPairing(null)
    setPairingDone(paired.name)
    pairingTimer.current = setTimeout(() => setPairingDone(null), 4000)
    return () => {
      if (pairingTimer.current) clearTimeout(pairingTimer.current)
    }
  }, [runtimes, pairing, pairingBaseline, pairingDone])

  const pairingCommand = pairing
    ? `curl -fsSL http://${pairingHost || pairing.hosts[0] || '127.0.0.1'}:${pairing.port}/pion-daemon.cjs -o pion-daemon.cjs && node pion-daemon.cjs --user-data ~/.pion --connect ${pairingHost || pairing.hosts[0] || '127.0.0.1'}:${pairing.port} --token ${pairing.token}`
    : ''

  const copyPairingCommand = async () => {
    if (!pairingCommand) return
    try {
      await navigator.clipboard.writeText(pairingCommand)
      setPairingCopied(true)
      setTimeout(() => setPairingCopied(false), 1500)
    } catch {
      /* clipboard unavailable (permissions): leave the text selectable */
    }
  }

  const runTest = async () => {
    if (busy || !host.trim() || !/^\d+$/.test(port) || !token.trim()) return
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const r = await window.pi.settings.test({ host: host.trim(), port: Number(port), token })
      if (r.ok) setTestResult(t('settings.testOk', { version: r.value.daemonVersion }))
      else setError(r.error)
    } catch (e) {
      setError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (busy || !formValid) return
    setBusy(true)
    setError(null)
    setTestResult(null)
    try {
      const r = await window.pi.settings.addRemote({ name: name.trim(), host: host.trim(), port: Number(port), token })
      if (!r.ok) {
        setError(r.error)
        return
      }
      setName('')
      setHost('')
      setPort('')
      setToken('')
      await onRefresh()
    } catch (e) {
      setError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (busy) return
    if (confirmRemoveId !== id) {
      setConfirmRemoveId(id)
      return
    }
    setConfirmRemoveId(null)
    setBusy(true)
    setError(null)
    try {
      await window.pi.settings.removeRemote(id)
      await onRefresh()
    } catch (e) {
      setError(ue(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('settings.nav.runtimes')}</h3>

      <section className="flex items-center justify-between rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2">
        <div className="flex items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', listener?.listenerEnabled ? 'bg-ok' : 'bg-line')} />
          <span className="text-[13px] font-medium text-ink">{t('settings.allowRemote')}</span>
          {listener?.listenerEnabled && listener.listenerPort != null && (
            <span className="text-[11px] text-ink2">{t('settings.listenerPort', { port: listener.listenerPort })}</span>
          )}
        </div>
        <button
          className={cn(
            'flex h-6 w-10 items-center rounded-full border-[0.5px] border-line px-0.5 transition-colors',
            // Off = --raised, the inset-well grey: --canvas made the white knob
            // (bg-white) invisible in light mode; 20px keeps the ring concentric.
            listener?.listenerEnabled ? 'justify-end bg-accent' : 'justify-start bg-raised',
            listenerBusy && 'opacity-40',
          )}
          title={confirmDisable ? t('settings.disableListenerConfirm') : t('settings.allowRemote')}
          disabled={listenerBusy || listener === null}
          onClick={() => void toggleListener(!listener?.listenerEnabled)}
        >
          <span className="size-5 rounded-full bg-white shadow-sm" />
        </button>
      </section>

      <section>
        <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('settings.runtimes')}</div>
        <ul className="mt-2 flex flex-col gap-1">
          {runtimes.map((r) => (
            <li key={r.id} className="flex items-center gap-2 rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2">
              <span className={cn('size-2 shrink-0 rounded-full', r.connected ? 'bg-ok' : 'bg-line')} title={r.connected ? t('settings.connected') : t('settings.offline')} />
              <span className="truncate text-[13px] font-medium text-ink">{r.name}</span>
              {r.kind === 'remote' && (
                <span className="shrink-0 font-mono text-[11px] text-ink2">
                  {r.host}:{r.port}
                </span>
              )}
              {r.kind === 'local' && <span className="shrink-0 text-[11px] text-ink2">{t('settings.localHint')}</span>}
              <button
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-md transition-colors',
                  'text-ink2 hover:bg-fill-hover hover:text-ink',
                  r.kind === 'local' && 'ml-auto',
                )}
                title={t('settings.qrShow')}
                onClick={() => setQrRuntime({ id: r.id, name: r.name })}
              >
                <QrCode size={13} strokeWidth={1.75} />
              </button>
              {r.kind === 'remote' && (
                <button
                  className={cn(
                    'ml-auto grid size-6 shrink-0 place-items-center rounded-md transition-colors',
                    'text-ink2 hover:bg-fill-hover hover:text-ink',
                    reconnectingId === r.id && 'opacity-40',
                  )}
                  title={t('settings.reconnect')}
                  disabled={reconnectingId === r.id}
                  onClick={() => void reconnect(r.id)}
                >
                  <RefreshCw size={13} strokeWidth={1.75} className={cn(reconnectingId === r.id && 'animate-spin')} />
                </button>
              )}
              {r.kind === 'remote' && (
                <button
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-md transition-colors',
                    confirmRemoveId === r.id ? 'bg-tint-bad text-bad' : 'text-ink2 hover:bg-fill-hover hover:text-ink',
                  )}
                  title={confirmRemoveId === r.id ? t('settings.removeConfirm') : t('settings.remove')}
                  onClick={() => void remove(r.id)}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              )}
            </li>
          ))}
        </ul>
        {/* Section-level error slot: reconnect/list failures land here (the
            per-tab copies below only render while their tab is open, and a
            list-row action must be able to surface an error with no tab). */}
        {error && <p className="mt-2 break-all text-xs text-bad">{error}</p>}
      </section>

      <section>
        <div className="flex items-center gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('settings.addRuntime')}</div>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'pairing', label: t('settings.pairingTab') },
              { value: 'install', label: t('settings.installTab') },
              { value: 'manual', label: t('settings.manualTab') },
            ]}
          />
        </div>

        {mode === 'pairing' && (
          <div className="mt-2 flex flex-col gap-2">
            {pairingDone ? (
              <div className="flex items-center gap-2 rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2 text-[13px] text-ok">
                <CircleCheck size={14} strokeWidth={1.75} />
                {t('settings.pairingConnected', { name: pairingDone })}
              </div>
            ) : pairing ? (
              <>
                <div className="flex gap-2">
                  <select
                    value={pairingHost}
                    onChange={(e) => setPairingHost(e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-lg border-[0.5px] border-line bg-panel px-2 text-[12px] text-ink outline-none focus:border-ink/30"
                  >
                    {pairing.hosts.map((h) => (
                      <option key={h} value={h}>{h}</option>
                    ))}
                  </select>
                  <button
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-line px-3 text-xs font-medium text-ink transition-colors hover:bg-fill-hover"
                    onClick={() => void copyPairingCommand()}
                  >
                    <Copy size={13} strokeWidth={1.75} />
                    {pairingCopied ? t('settings.copied') : t('settings.copy')}
                  </button>
                </div>
                <p className="text-[11px] font-semibold text-ink2">{t('settings.pairingStepFile')}</p>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2 font-mono text-[11px] text-ink" title={pairingDaemonFile}>{pairingDaemonFile}</code>
                  <button
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-line px-3 text-xs font-medium text-ink transition-colors hover:bg-fill-hover"
                    onClick={() => void window.pi.app.revealPath(pairingDaemonFile)}
                  >
                    <FolderOpen size={13} strokeWidth={1.75} />
                    {t('settings.pairingReveal')}
                  </button>
                </div>
                <p className="text-[11px] font-semibold text-ink2">{t('settings.pairingStepCmd')}</p>
                <p className="text-[11px] text-ink2">{t('settings.pairingHint')}</p>
                <pre className="break-all rounded-lg border-[0.5px] border-line bg-panel p-2.5 font-mono text-[11px] leading-relaxed text-ink whitespace-pre-wrap">{pairingCommand}</pre>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1.5 text-xs text-ink2">
                    <LoaderCircle size={13} className="animate-spin" />
                    {t('settings.pairingWaiting')}
                  </span>
                  <button
                    className="ml-auto flex h-8 items-center rounded-lg border-[0.5px] border-line px-3 text-xs font-medium text-ink transition-colors hover:bg-fill-hover"
                    onClick={() => void cancelPairing()}
                  >
                    {t('settings.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void startPairing()}
                >
                  {busy ? <LoaderCircle size={13} className="animate-spin" /> : <KeyRound size={13} strokeWidth={1.75} />}
                  {t('settings.pairingGenerate')}
                </button>
              </div>
            )}
            {error && <p className="break-all text-xs text-bad">{error}</p>}
          </div>
        )}

        {mode === 'install' && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[11px] font-semibold text-ink2">{t('settings.installBaseLabel')}</span>
              <input
                value={installBase}
                placeholder="http://<host>:8081"
                onChange={(e) => setInstallBase(e.target.value)}
                spellCheck={false}
                className="h-8 min-w-0 flex-1 rounded-lg border-[0.5px] border-line bg-panel px-2.5 font-mono text-[11px] text-ink outline-none focus:border-ink/30"
              />
            </div>
            <p className="text-[11px] text-ink2">{t('settings.installStep1')}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2 font-mono text-[11px] text-ink">{installCommand}</code>
              <button
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] border-line px-3 text-xs font-medium text-ink transition-colors hover:bg-fill-hover disabled:opacity-40"
                disabled={!installCommand}
                onClick={() => void copyInstallCommand()}
              >
                <Copy size={13} strokeWidth={1.75} />
                {installCopied ? t('settings.copied') : t('settings.copy')}
              </button>
            </div>
            <p className="text-[11px] text-ink2">{t('settings.installStep2')}</p>
            <p className="text-[11px] text-ink2">{t('settings.installTerminalHint')}</p>
            <p className="break-all text-[11px] text-ink2">{t('settings.installMirrorHint')}</p>
          </div>
        )}

        {mode === 'manual' && (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('settings.namePlaceholder')}
                className="h-9 w-36 rounded-lg border-[0.5px] border-line bg-panel px-2.5 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
              />
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t('settings.hostPlaceholder')}
                className="h-9 min-w-0 flex-1 rounded-lg border-[0.5px] border-line bg-panel px-2.5 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
              />
              <input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={t('settings.portPlaceholder')}
                inputMode="numeric"
                className="h-9 w-24 rounded-lg border-[0.5px] border-line bg-panel px-2.5 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
              />
            </div>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={t('settings.tokenPlaceholder')}
              className="h-9 rounded-lg border-[0.5px] border-line bg-panel px-2.5 text-sm text-ink outline-none placeholder:text-ink2 focus:border-ink/30"
            />
            <div className="flex items-center gap-2">
              <button
                className="flex h-8 items-center gap-1.5 rounded-lg border-[0.5px] border-line px-3 text-xs font-medium text-ink transition-colors hover:bg-fill-hover disabled:opacity-40"
                disabled={busy || !host.trim() || !/^\d+$/.test(port) || !token.trim()}
                onClick={() => void runTest()}
              >
                {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Plug size={13} strokeWidth={1.75} />}
                {t('settings.test')}
              </button>
              <button
                className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
                disabled={busy || !formValid}
                onClick={() => void save()}
              >
                <CircleCheck size={13} strokeWidth={1.75} />
                {t('settings.save')}
              </button>
            </div>
            {testResult && <p className="text-xs text-ok">{testResult}</p>}
            {error && <p className="break-all text-xs text-bad">{error}</p>}
          </div>
        )}
      </section>

      {qrRuntime && <RuntimeQrDialog runtime={qrRuntime} onClose={() => setQrRuntime(null)} />}
    </div>
  )
}

// iOS connect QR for a runtime: main composes the pion:// link on request
// (the token crosses to the renderer only inside the payload the user chose
// to show). The matrix renders white-on-black-free — cameras want plain
// contrast, not theme colors. Escape closes just the QR: a capture-phase
// window listener preempts the settings dialog's own bubble-phase handler.
function RuntimeQrDialog({ runtime, onClose }: { runtime: { id: string; name: string }; onClose: () => void }) {
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const [info, setInfo] = useState<SettingsQrInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.pi.settings
      .qr(runtime.id)
      .then((r) => {
        if (cancelled) return
        if (r.ok) setInfo(r.value)
        else setError(r.error)
      })
      .catch((e) => {
        if (!cancelled) setError(ue(e))
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtime.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const copyUrl = async (): Promise<void> => {
    if (!info) return
    try {
      await navigator.clipboard.writeText(info.url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable (permissions): leave the text below */
    }
  }

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center">
      <div className="absolute inset-0 bg-black/25" onClick={onClose} />
      <div className="dialog-in relative flex w-[340px] max-w-[92vw] flex-col items-center gap-3 rounded-2xl border-[0.5px] border-line bg-canvas p-5 shadow-pop">
        <button
          className="absolute right-3 top-3 grid size-7 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('common.close')}
          onClick={onClose}
        >
          <X size={14} strokeWidth={1.75} />
        </button>
        <h3 className="max-w-[260px] truncate text-sm font-semibold">{t('settings.qrTitle', { name: runtime.name })}</h3>
        {error ? (
          <p className="break-all text-xs text-bad">{error}</p>
        ) : !info ? (
          <div className="grid h-[240px] place-items-center">
            <LoaderCircle size={20} className="animate-spin text-ink2" />
          </div>
        ) : (
          <>
            <div className="rounded-xl border-[0.5px] border-line bg-white p-3">
              <QrMatrix text={info.url} size={216} />
            </div>
            <p className="font-mono text-[11px] text-ink2">{t('settings.qrEndpoint', { host: info.host, port: info.wsPort })}</p>
            <button
              className="flex h-8 items-center gap-1.5 rounded-lg border-[0.5px] border-line px-3 text-xs font-medium text-ink transition-colors hover:bg-fill-hover"
              onClick={() => void copyUrl()}
            >
              <Copy size={13} strokeWidth={1.75} />
              {copied ? t('settings.copied') : t('settings.copy')}
            </button>
            {info.assumed && <p className="break-words text-[11px] leading-snug text-warn">{t('settings.qrAssumed')}</p>}
          </>
        )}
        <p className="text-[11px] leading-snug text-ink2">{t('settings.qrHint')}</p>
      </div>
    </div>
  )
}

// `pion://` payload → SVG (uqr gives a boolean module matrix; quiet zone of
// two modules on each side).
function QrMatrix({ text, size }: { text: string; size: number }) {
  const qr = useMemo(() => encode(text), [text])
  const dim = qr.size + 4
  const rows: React.ReactNode[] = []
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.data[y]?.[x]) rows.push(<rect key={`${x}-${y}`} x={x + 2} y={y + 2} width={1} height={1} />)
    }
  }
  return (
    <svg viewBox={`0 0 ${dim} ${dim}`} width={size} height={size} shapeRendering="crispEdges" role="img" aria-label="pion connect QR">
      <rect width={dim} height={dim} fill="#fff" />
      <g fill="#000">{rows}</g>
    </svg>
  )
}

// ── Plugins: installed (pi + extensions) + community gallery ──────────────

// Minimal version compare (x[.y[.z]], prerelease ignored) — same rule as
// daemon/version-check.ts, but renderer-side and standalone.
function isNewer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

function PluginsSection({ update }: { update: SettingsUpdateApi }) {
  const { t } = useI18n()
  const { result, recheck, progress, runUpdate } = update
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement | null>(null)
  const updating = progress?.running === true
  const finished = progress?.done === true

  useEffect(() => {
    if (progress?.line) setLog((prev) => [...prev.slice(-300), progress.line!])
  }, [progress])
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const runRecheck = async () => {
    setBusy(true)
    try {
      await recheck()
    } finally {
      setBusy(false)
    }
  }
  const startUpdate = async () => {
    setLog([])
    await runUpdate()
  }
  const copyCommand = () => {
    void navigator.clipboard.writeText('pi update --all')
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }

  const piOutdated = (result?.outdatedCount ?? 0) > 0

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('settings.plugins.installed')}</h3>
        <button
          className="grid size-6 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('settings.updates.recheck')}
          onClick={() => void runRecheck()}
        >
          <RefreshCw size={12} className={cn(busy && 'animate-spin')} />
        </button>
      </div>

      <ul className="flex flex-col gap-1">
        {/* pi + extension rows from the daemon version check. */}
        {(result?.entries ?? []).map((entry) => (
          <li key={`${entry.kind}:${entry.name}`} className="flex items-center gap-2 rounded-lg border-[0.5px] border-line bg-panel px-2.5 py-2 text-xs">
            <span className={cn('shrink-0 rounded px-1 py-px text-[10px] font-medium', entry.kind === 'pi' ? 'bg-tint-accent text-accent' : 'bg-fill-hover text-ink2')}>
              {entry.kind === 'pi' ? 'PI' : t('settings.updates.kindExtension')}
            </span>
            <span className="min-w-0 truncate font-medium text-ink" title={entry.name}>
              {entry.name}
            </span>
            {entry.outdated && <span className="shrink-0 rounded bg-tint-warn px-1.5 py-px text-[10px] font-medium text-warn">{t('settings.updates.outdated')}</span>}
            <span className="ml-auto shrink-0 tabular-nums text-ink2">
              {entry.installed ?? '?'} → {entry.latest ?? '?'}
            </span>
            <button
              className="grid size-5 shrink-0 place-items-center rounded text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
              title={t('settings.updates.openNpm')}
              onClick={() => void window.pi.app.openExternal(`https://www.npmjs.com/package/${entry.name}`)}
            >
              <ExternalLink size={11} />
            </button>
          </li>
        ))}
        {!result && <li className="px-1 py-2 text-xs text-ink2">{t('settings.updates.checking')}</li>}
      </ul>

      {!piOutdated && result && (
        <p className="text-xs text-ink2">
          {t('settings.updates.upToDate', {
            time: result.checkedAt ? new Date(result.checkedAt).toLocaleString() : '—',
          })}
        </p>
      )}

      {(log.length > 0 || (finished && progress?.error)) && (
        <div ref={logRef} className="max-h-32 overflow-y-auto rounded-md bg-canvas px-2 py-1.5 font-mono text-[10px] leading-4 text-ink2">
          {log.map((line, i) => (
            <div key={i} className="break-all whitespace-pre-wrap">
              {line}
            </div>
          ))}
          {finished && progress?.error && <div className="break-all whitespace-pre-wrap text-bad">{progress.error}</div>}
          {finished && !progress?.error && <div className={cn(progress?.code === 0 ? 'text-ok' : 'text-bad')}>{progress?.code === 0 ? t('settings.updates.done') : t('settings.updates.failed', { code: progress?.code ?? '' })}</div>}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <button
          className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-40"
          disabled={updating || !piOutdated}
          title={t('settings.updates.allTitle')}
          onClick={() => void startUpdate()}
        >
          <RefreshCw size={11} className={cn(updating && 'animate-spin')} />
          {updating ? t('settings.updates.updating') : t('settings.updates.all')}
        </button>
        {updating && <span className="text-[11px] text-ink2">{t('settings.updates.upgradingHint')}</span>}
        <button
          className="ml-auto grid size-6 shrink-0 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('settings.updates.copyCommand')}
          onClick={copyCommand}
        >
          {copied ? <CircleCheck size={12} className="text-ok" /> : <Copy size={12} />}
        </button>
      </div>

      <CommunityGallery update={update} />
    </div>
  )
}

// Community gallery: every npm package tagged `pi-package` (pi.dev/packages
// is built from the same tag). Click a row to select it; the expanded panel
// installs in-app via `pi install npm:<name> --no-approve`.
function CommunityGallery({ update }: { update: SettingsUpdateApi }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [packages, setPackages] = useState<CommunityPackage[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<UpdateProgressEvent | null>(null)
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement | null>(null)
  const installing = progress?.running === true
  const finished = progress?.done === true

  // Debounced server-side search; empty query lists the top by relevance.
  useEffect(() => {
    let cancelled = false
    const handle = setTimeout(
      () => {
        void window.pi.plugins
          .community(query.trim())
          .then((pkgs) => {
            if (!cancelled) {
              setPackages(pkgs)
              setLoadError(false)
            }
          })
          .catch(() => {
            if (!cancelled) {
              setPackages([])
              setLoadError(true)
            }
          })
      },
      query ? 300 : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [query])

  useEffect(
    () =>
      window.pi.plugins.onProgress((e) => {
        setProgress(e)
        if (e.line) setLog((prev) => [...prev.slice(-300), e.line!])
        // A successful install changed settings.json → refresh installed list.
        if (e.done && e.code === 0) void update.recheck()
      }),
    [update],
  )
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [log])

  const installedNames = new Set((update.result?.entries ?? []).map((e) => e.name))

  const startInstall = async (name: string) => {
    setLog([])
    const res = await window.pi.plugins.install(name)
    if (!res.started && res.error) setLog([res.error])
  }

  return (
    <>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink2">{t('settings.plugins.community')}</h3>
        <button
          className="grid size-6 place-items-center rounded-md text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
          title={t('settings.plugins.viewGallery')}
          onClick={() => void window.pi.app.openExternal('https://pi.dev/packages')}
        >
          <ExternalLink size={12} />
        </button>
      </div>
      <Input value={query} onValueChange={setQuery} placeholder={t('settings.plugins.search')} />
      <p className="text-[10px] leading-relaxed text-ink2">{t('settings.plugins.securityHint')}</p>

      <ul className="flex flex-col gap-1">
        {(packages ?? []).map((pkg) => {
          const isInstalled = installedNames.has(pkg.name)
          const open = selected === pkg.name
          return (
            <li key={pkg.name} className="overflow-hidden rounded-lg border-[0.5px] border-line bg-panel text-xs">
              <button className="flex w-full items-center gap-2 px-2.5 py-2 text-left" onClick={() => setSelected(open ? null : pkg.name)}>
                <span className="min-w-0 truncate font-medium text-ink" title={pkg.name}>
                  {pkg.name}
                </span>
                {isInstalled && <span className="shrink-0 rounded bg-tint-ok px-1.5 py-px text-[10px] font-medium text-ok">{t('settings.plugins.installedBadge')}</span>}
                <span className="ml-auto shrink-0 tabular-nums text-ink2">{pkg.version ?? ''}</span>
                <ChevronDown size={12} className={cn('shrink-0 text-ink2 transition-transform', open && 'rotate-180')} />
              </button>
              {open && (
                <div className="flex flex-col gap-2 border-t border-line px-2.5 py-2">
                  {pkg.description && <p className="leading-relaxed text-ink2">{pkg.description}</p>}
                  <div className="flex items-center gap-1.5">
                    <button
                      className="rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-40"
                      disabled={installing || isInstalled}
                      onClick={() => void startInstall(pkg.name)}
                    >
                      {installing ? t('settings.plugins.installing') : isInstalled ? t('settings.plugins.installedBadge') : t('settings.plugins.install')}
                    </button>
                    {pkg.publisher && <span className="text-[10px] text-ink2">{pkg.publisher}</span>}
                    <button
                      className="ml-auto grid size-5 shrink-0 place-items-center rounded text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                      title={t('settings.updates.openNpm')}
                      onClick={() => void window.pi.app.openExternal(`https://www.npmjs.com/package/${pkg.name}`)}
                    >
                      <ExternalLink size={11} />
                    </button>
                    <button
                      className="grid size-5 shrink-0 place-items-center rounded text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                      title={t('settings.plugins.viewGallery')}
                      onClick={() => void window.pi.app.openExternal(`https://pi.dev/packages/${pkg.name}`)}
                    >
                      <Globe size={11} />
                    </button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
        {packages === null && !loadError && <li className="px-1 py-2 text-xs text-ink2">{t('settings.plugins.loading')}</li>}
        {loadError && <li className="px-1 py-2 text-xs text-bad">{t('settings.plugins.loadFailed')}</li>}
        {packages?.length === 0 && !loadError && <li className="px-1 py-2 text-xs text-ink2">{t('settings.plugins.empty')}</li>}
      </ul>

      {(log.length > 0 || (finished && progress?.error)) && (
        <div ref={logRef} className="max-h-32 overflow-y-auto rounded-md bg-canvas px-2 py-1.5 font-mono text-[10px] leading-4 text-ink2">
          {log.map((line, i) => (
            <div key={i} className="break-all whitespace-pre-wrap">
              {line}
            </div>
          ))}
          {finished && progress?.error && <div className="break-all whitespace-pre-wrap text-bad">{progress.error}</div>}
          {finished && !progress?.error && (
            <div className={cn(progress?.code === 0 ? 'text-ok' : 'text-bad')}>{progress?.code === 0 ? t('settings.plugins.done') : t('settings.plugins.failed', { code: progress?.code ?? '' })}</div>
          )}
        </div>
      )}
    </>
  )
}

// ── About: versions + links ────────────────────────────────────────────────

// Outbound links for the About pane. PROJECT_HOME_URL is the site the Pages
// workflow deploys; package.json `homepage` mirrors it.
const PROJECT_HOME_URL = 'https://zucchinievader.github.io/pion/'
const PROJECT_REPO_URL = 'https://github.com/zucchiniEvader/pion'
const AUTHOR_TWITTER_URL = 'https://x.com/zucchiniEvader'

function AboutSection({ meta }: { meta: AppMeta | null }) {
  const { t } = useI18n()
  const platform = meta?.platform === 'darwin' ? 'macOS' : meta?.platform === 'win32' ? 'Windows' : meta?.platform === 'linux' ? 'Linux' : meta?.platform ?? '—'

  // GUI self-update (moved from the old Updates page): check → download →
  // restart-to-install via electron-updater; latest appears once a release
  // feed (package.json repository) is configured.
  const [gui, setGui] = useState<GuiUpdateInfo | null>(null)
  const [appUp, setAppUp] = useState<AppUpdateStatus | null>(null)

  useEffect(() => {
    void window.pi.app.guiUpdate().then(setGui).catch(() => undefined)
    void window.pi.app.appUpdate.status().then(setAppUp).catch(() => undefined)
    return window.pi.app.appUpdate.onStatus(setAppUp)
  }, [])

  const guiOutdated = gui?.latest != null && gui.version != null && isNewer(gui.latest, gui.version)

  return (
    <div data-settings-about className="@container mx-auto flex min-h-full max-w-[560px] flex-col">
      <section className="flex flex-col items-center pb-8 pt-5 text-center">
        <AppLogo className="size-[72px] rounded-[18px]" />
        <h3 className="mt-4 text-[30px] font-semibold leading-tight tracking-tight text-ink">Pion</h3>
        <p className="mt-2 text-[13px] leading-relaxed text-ink2">{t('settings.about.tagline')}</p>
        <span className="mt-3 rounded-full border-[0.5px] border-line bg-panel px-2.5 py-1 font-mono text-[10px] leading-none text-ink2">
          {meta ? `v${meta.version}` : '—'}
        </span>
      </section>

      <section aria-labelledby="about-environment">
        <h4 id="about-environment" className="mb-2.5 text-[11px] font-medium text-ink2">{t('settings.about.environment')}</h4>
        <dl className="overflow-hidden rounded-xl border-[0.5px] border-line bg-panel text-xs">
          <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-3.5">
            <dt className="text-ink2">{t('settings.about.platform')}</dt>
            <dd className="font-medium text-ink">{platform}</dd>
          </div>
          <div className="px-4 py-3.5">
            <div className="flex items-center justify-between gap-4">
              <dt className="shrink-0 text-ink2">{t('settings.about.pi')}</dt>
              <dd className={cn('text-right font-medium', meta && !meta.piPath ? 'text-bad' : 'text-ink')}>
                {!meta ? '—' : meta.piPath ? (meta.piVersion ? `v${meta.piVersion}` : '—') : t('settings.about.piMissing')}
              </dd>
            </div>
            {meta?.piPath && (
              <dd className="mt-2 break-all font-mono text-[10px] leading-relaxed text-ink2">{meta.piPath}</dd>
            )}
          </div>
        </dl>
      </section>

      <section aria-labelledby="about-app-update" className="mt-6">
        <h4 id="about-app-update" className="mb-2.5 text-[11px] font-medium text-ink2">{t('settings.about.app')}</h4>
        <div className="flex items-center gap-2 rounded-xl border-[0.5px] border-line bg-panel px-4 py-3.5 text-xs">
          <span className="min-w-0 truncate font-medium text-ink">Pion</span>
          <span className="ml-auto shrink-0 tabular-nums text-ink2">
            {gui ? (gui.latest && guiOutdated ? `${gui.version} → ${gui.latest}` : t('settings.updates.currentVersion', { version: gui.version })) : '—'}
          </span>
          {appUp?.state === 'downloading' ? (
            <span className="shrink-0 rounded bg-tint-accent px-1.5 py-px text-[10px] font-medium tabular-nums text-accent">
              {t('settings.updates.downloading', { percent: appUp.percent ?? 0 })}
            </span>
          ) : appUp?.state === 'downloaded' ? (
            <button
              className="shrink-0 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-accent-hover"
              onClick={() => void window.pi.app.appUpdate.install()}
            >
              {t('settings.updates.restartToInstall')}
            </button>
          ) : (
            <>
              <button
                className="shrink-0 rounded-md border-[0.5px] border-line px-2 py-1 text-[10px] font-medium text-ink2 transition-colors hover:bg-fill-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50"
                disabled={appUp?.state === 'checking' || appUp?.state === 'dev'}
                title={appUp?.state === 'error' ? appUp.message : undefined}
                onClick={() => void window.pi.app.appUpdate.check()}
              >
                {t('settings.updates.checkUpdate')}
              </button>
              {appUp?.state === 'available' && (
                <button
                  className="shrink-0 rounded-md bg-accent px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-accent-hover"
                  onClick={() => void window.pi.app.appUpdate.download()}
                >
                  {t('settings.updates.downloadUpdate')}
                </button>
              )}
            </>
          )}
          {gui?.releaseUrl && (
            <button
              className="grid size-5 shrink-0 place-items-center rounded text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
              title={t('settings.updates.viewReleases')}
              onClick={() => void window.pi.app.openExternal(gui.releaseUrl!)}
            >
              <ExternalLink size={11} />
            </button>
          )}
        </div>
      </section>

      <section aria-labelledby="about-links" className="mt-6">
        <h4 id="about-links" className="mb-2.5 text-[11px] font-medium text-ink2">{t('settings.about.explore')}</h4>
        <div className="grid grid-cols-1 gap-2 @min-[440px]:grid-cols-3">
          {[
            { href: PROJECT_HOME_URL, label: t('settings.about.home'), detail: t('settings.about.homeHint'), Icon: Globe },
            { href: PROJECT_REPO_URL, label: t('settings.about.repo'), detail: t('settings.about.repoHint'), Icon: Code2 },
            { href: AUTHOR_TWITTER_URL, label: t('settings.about.twitter'), detail: '@zucchiniEvader', Icon: AtSign },
          ].map(({ href, label, detail, Icon }) => (
            <button
              key={href}
              className="group flex min-w-0 flex-col gap-3 rounded-xl border-[0.5px] border-line p-3 text-left text-ink transition-colors hover:bg-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              title={href}
              onClick={() => void window.pi.app.openExternal(href)}
            >
              <span className="flex w-full items-center justify-between text-ink2">
                <Icon size={16} strokeWidth={1.5} />
                <ExternalLink size={11} className="opacity-50 transition-opacity group-hover:opacity-100" />
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium">{label}</span>
                <span className="mt-1 block break-words text-[10px] leading-relaxed text-ink2">{detail}</span>
              </span>
            </button>
          ))}
        </div>
      </section>

      <footer className="mt-auto pt-7 text-center text-[10px] leading-relaxed text-ink2">
        {t('settings.about.openSource')} <span className="px-1" aria-hidden="true">·</span> MIT License
      </footer>
    </div>
  )
}
