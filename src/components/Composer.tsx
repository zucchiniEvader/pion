import { Fragment, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import type { ContextUsage, PiAvailableModel, PiCommandInfo, ProjectRecord, PromptImage, RuntimeInfo } from '@/types'
import type { RuntimeStatus } from '@/hooks/useSessionPool'
import { cn } from '@/lib/utils'
import { useI18n, useUserErrorMessage } from '@/i18n'
import type { MsgKey } from '@/i18n/zh'
import { Input } from '@/components/ui/input'
import { openImagePreview } from '@/components/ImageLightbox'
import { ArrowUp, Brain, Check, ChevronDown, Compass, Cpu, Folder, FolderOpen, LoaderCircle, Square, X } from 'lucide-react'

const FALLBACK_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'max']

// Same image contract as the preload allowlist: at most 8 attachments per
// dispatch, and only the MIME types PI accepts on the wire.
const MAX_IMAGES = 8
const IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/i

// A pasted image waiting to be sent. `data` is the canonical base64 payload
// (no data: URL prefix); `url` is the preview source.
interface PendingImage {
  id: string
  data: string
  mimeType: string
  url: string
}

// Small unique ids for preview strip entries; crypto.randomUUID is avoided
// so the strip works even in non-secure-context windows.
let pendingImageSeq = 0
const nextPendingImageId = () => `img-${Date.now().toString(36)}-${pendingImageSeq++}`

async function fileToPendingImage(file: File): Promise<PendingImage | null> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl)
  if (!match) return null
  return { id: nextPendingImageId(), mimeType: match[1], data: match[2], url: dataUrl }
}

// pi-plan-mode reports its state through setStatus("plan-mode", …); translate
// the known status strings, falling back to the raw text.
const PLAN_STATUS_KEY: Record<string, MsgKey> = {
  'plan active': 'composer.planActive',
  'plan ready': 'composer.planReady',
  'plan saved': 'composer.planSaved',
  'plan implementing': 'composer.planImplementing',
}

interface ComposerProps {
  /** 'draft' = no runtime attached yet (new-task page); 'live' = bound to one. */
  mode: 'draft' | 'live'
  status: RuntimeStatus
  runtime: RuntimeInfo | null
  /** pi's context-window estimate for this session; absent = no ring. */
  contextUsage?: ContextUsage | null
  draft: string
  onDraftChange: (text: string) => void
  /** Resolves true once dispatched; false or a throw restores the draft text. */
  onSend: (text: string, intent: 'prompt' | 'steer' | 'follow_up', images?: PromptImage[]) => Promise<boolean>
  onAbort: () => void
  /** The first dispatch of a fresh task is in flight; show stop immediately. */
  pendingDispatch?: boolean
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: string) => Promise<void>
  onGetModels: () => Promise<PiAvailableModel[]>
  onGetThinkingLevels: () => Promise<string[]>
  /** Slash-command registry from the runtime (extensions/templates/skills). */
  onGetCommands: () => Promise<PiCommandInfo[]>
  /** Plan-mode status text from the runtime's statuses (empty = off). */
  planStatus?: string | null
  // Draft-only: the project selector embedded in the composer card.
  projects: ProjectRecord[]
  activeProject: ProjectRecord | null
  /** Increments when the app wants the user to pick a project first. */
  nudgeSignal: number
  onSelectProject: (project: ProjectRecord) => void
  onBrowseProjects: () => void
  /** Increment to (re)focus the textarea — draft entry, starter chips. */
  focusKey: number
}

// Context-window gauge for the chip row. pi's get_session_stats reports an
// estimate of the live context against the model's window; this is that number
// as a ring (12 o'clock start, clockwise), with the raw token counts in the
// tooltip since the row has no space for them. Neutral greys, like pi's own
// footer: it is an indicator, not an accent or an alarm.
function ContextRing({ usage }: { usage: ContextUsage }) {
  const { t } = useI18n()
  const size = 16
  const stroke = 2.5
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const percent = usage.percent
  // Right after compaction pi reports null tokens: draw the empty track only.
  const filled = percent == null ? 0 : (circumference * Math.min(100, Math.max(0, percent))) / 100
  const count = (n: number | null): string | number => (n == null ? '—' : n >= 1000 ? `${Math.round(n / 1000)}k` : n)
  return (
    <span
      className="grid size-6 shrink-0 place-items-center"
      title={t('composer.contextUsage', {
        used: count(usage.tokens),
        total: count(usage.contextWindow),
        percent: percent == null ? '—' : Math.round(percent),
      })}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} stroke="currentColor" className="text-fill-active" />
        {filled > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={stroke}
            stroke="currentColor"
            strokeLinecap="round"
            strokeDasharray={`${filled} ${circumference - filled}`}
            className="text-ink2"
          />
        )}
      </svg>
    </span>
  )
}

// The one composer for every state: docked at the bottom of the session view
// on the new-task page, while the runtime spawns, and inside a live session.
// It never unmounts across those transitions — only its chrome adapts
// (project selector in draft mode, model/thinking chips + stop once live).
export function Composer({
  mode,
  status,
  runtime,
  contextUsage,
  draft,
  onDraftChange,
  onSend,
  onAbort,
  pendingDispatch,
  onSetModel,
  onSetThinkingLevel,
  onGetModels,
  onGetThinkingLevels,
  onGetCommands,
  planStatus,
  projects,
  activeProject,
  nudgeSignal,
  onSelectProject,
  onBrowseProjects,
  focusKey,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { t } = useI18n()
  const ue = useUserErrorMessage()
  const running = mode === 'live' && status === 'running'
  const stopping = status === 'stopping'
  // Runtime spawn/re-attach in flight: block sends, spin the action button.
  const starting = status === 'starting'
  // Open chip menu; its options load lazily the first time the menu opens.
  const [openMenu, setOpenMenu] = useState<'model' | 'thinking' | null>(null)
  const [models, setModels] = useState<PiAvailableModel[] | null>(null)
  const [levels, setLevels] = useState<string[] | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [menuError, setMenuError] = useState<string | null>(null)
  // Draft-only project selector state.
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  // Flashed when a new-task attempt arrives without a selected project:
  // the selector lights up and the toolbar hint swaps to a warning.
  const [projectHint, setProjectHint] = useState(false)
  // Pasted images waiting to ride along with the next dispatch. Kept as a
  // local strip above the textarea; cleared on send, restored on failure.
  const [images, setImages] = useState<PendingImage[]>([])
  useEffect(() => {
    if (nudgeSignal <= 0) return
    setProjectHint(true)
    const timer = setTimeout(() => setProjectHint(false), 3000)
    return () => clearTimeout(timer)
  }, [nudgeSignal])
  const showProjectHint = mode === 'draft' && projectHint && !activeProject

  // Auto-grow like native message composers, clamped to a max height.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`
  }, [draft])

  // External focus requests (starter chips, entering a draft) keep the
  // composer as the single always-mounted input of the session view.
  useEffect(() => {
    if (focusKey > 0) inputRef.current?.focus()
  }, [focusKey])

  // A dispatch typed while the runtime is still spawning or re-attaching is
  // queued here and flushed the moment `starting` clears, instead of being
  // silently dropped — an Enter during that ~1s window used to vanish.
  const queuedSendRef = useRef<{ text: string; intent: 'prompt' | 'steer' | 'follow_up'; images?: PromptImage[] } | null>(null)

  const send = async (intent: 'prompt' | 'steer' | 'follow_up', textOverride?: string, imagesOverride?: PromptImage[]) => {
    const trimmed = (textOverride ?? draft).trim()
    if (!trimmed) return
    // The wire contract only carries images on `prompt`; while the runtime is
    // spawning the intent stays whatever was queued (normally prompt).
    const pending = imagesOverride ?? images
    const wireImages: PromptImage[] | undefined =
      intent === 'prompt' && pending.length
        ? pending.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }))
        : undefined
    if (starting) {
      queuedSendRef.current = { text: trimmed, intent, images: wireImages }
      onDraftChange('')
      setImages([])
      return
    }
    if (mode === 'live' && (running || stopping)) return
    // Optimistic clear; restored below when the dispatch didn't happen.
    onDraftChange('')
    setImages([])
    try {
      const ok = await onSend(trimmed, intent, wireImages)
      if (!ok) {
        onDraftChange(trimmed)
        if (wireImages) restoreImages(wireImages)
      }
    } catch (e) {
      onDraftChange(trimmed)
      if (wireImages) restoreImages(wireImages)
      console.error('send failed', e)
    }
  }

  // Puts failed-dispatch images back in the strip, preserving their previews.
  const restoreImages = (sent: PromptImage[]) => {
    setImages((prev) => {
      const back = sent
        .filter((img) => !prev.some((p) => p.data === img.data))
        .map((img) => ({ ...img, id: nextPendingImageId(), url: `data:${img.mimeType};base64,${img.data}` }))
      return [...back, ...prev].slice(0, MAX_IMAGES)
    })
  }

  // Reads pasted image payloads off the clipboard into pending previews.
  // Non-image clipboard content (plain text, files that aren't images) falls
  // through to the textarea's default paste behavior.
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.files].filter((f) => IMAGE_MIME.test(f.type))
    if (!files.length) return
    e.preventDefault()
    for (const file of files) {
      void fileToPendingImage(file).then((img) => {
        if (!img) return
        setImages((cur) =>
          cur.length < MAX_IMAGES && !cur.some((p) => p.data === img.data) ? [...cur, img] : cur,
        )
      })
    }
  }

  const removeImage = (id: string) => setImages((prev) => prev.filter((p) => p.id !== id))

  // Flush a queued dispatch once the runtime is attached; onSend runs with the
  // fresh props of this render, so it routes to the now-known runtime. If the
  // attached session is already mid-run (re-attach to a background run), the
  // text degrades to a follow-up instead of being dropped — follow_up carries
  // no images on the wire, so those go back to the strip for the next prompt.
  useEffect(() => {
    const queued = queuedSendRef.current
    if (starting || !queued) return
    queuedSendRef.current = null
    if (running) {
      if (queued.images?.length) restoreImages(queued.images)
      void send('follow_up', queued.text)
      return
    }
    void send(queued.intent, queued.text, queued.images)
  })

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen && slashItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashHighlight((slashIndex + 1) % slashItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashHighlight((slashIndex - 1 + slashItems.length) % slashItems.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing)) {
        e.preventDefault()
        acceptSlashItem(slashItems[slashIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSlashDismissed(true)
        return
      }
    }
    // Enter sends; while the agent runs, text queues as a follow-up.
    // Shift+Enter inserts a newline.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(running ? 'follow_up' : 'prompt')
    }
  }

  const toggleMenu = async (menu: 'model' | 'thinking') => {
    if (!menusReady) return
    setMenuError(null)
    if (openMenu === menu) {
      setOpenMenu(null)
      return
    }
    setOpenMenu(menu)
    if (menu === 'model') setModelQuery('')
    try {
      if (menu === 'model' && models === null) setModels(await onGetModels())
      if (menu === 'thinking' && levels === null) {
        const fetched = await onGetThinkingLevels()
        setLevels(fetched.length ? fetched : FALLBACK_THINKING_LEVELS)
      }
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e))
    }
  }

  const pickModel = async (m: PiAvailableModel) => {
    setMenuError(null)
    try {
      await onSetModel(m.provider, m.id)
      setOpenMenu(null)
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e))
    }
  }

  const pickThinkingLevel = async (level: string) => {
    setMenuError(null)
    try {
      await onSetThinkingLevel(level)
      setOpenMenu(null)
    } catch (e) {
      setMenuError(e instanceof Error ? e.message : String(e))
    }
  }

  const model = runtime?.model
  const modelLabel = model?.provider && model?.id ? `${model.provider}/${model.id}` : model?.name ?? ''
  // The wire command requires a non-empty message, so images alone can't send.
  const canSend = !!draft.trim() && !starting && (mode === 'draft' || (!running && !stopping))
  // Model/thinking menus query the runtime's registry; the chips enable as
  // soon as a runtime exists (including a prewarmed draft), regardless of
  // which page the composer is docked on.
  const menusReady = runtime != null

  // ── Slash commands ─────────────────────────────────────────────────────
  // Typing "/" (name phase, no space yet) opens the autocomplete popup fed
  // by pi's get_commands. PI itself executes/expands the sent text — the
  // composer only completes names. Idle-only: queued sends (follow_up) do
  // not run extension commands on pi's side.
  const [commands, setCommands] = useState<PiCommandInfo[] | null>(null)
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const slashMatch = /^\/(\S*)$/.exec(draft)
  const slashOpen = !!slashMatch && !slashDismissed && menusReady && !running && !stopping && !starting
  const slashQuery = (slashMatch?.[1] ?? '').toLowerCase()
  const slashItems =
    slashOpen && commands
      ? commands.filter((c) => c.name.toLowerCase().startsWith(slashQuery))
      : []
  const slashIndex = slashItems.length ? Math.min(slashHighlight, slashItems.length - 1) : 0

  // A new runtime carries its own command registry; typing re-arms the
  // popup after an Escape dismissal.
  const runtimeKey = runtime?.runtimeId ?? null
  useEffect(() => {
    setCommands(null)
  }, [runtimeKey])
  useEffect(() => {
    setSlashHighlight(0)
  }, [slashQuery])
  useEffect(() => {
    setSlashDismissed(false)
  }, [draft])
  useEffect(() => {
    if (!slashOpen || commands !== null) return
    let cancelled = false
    void onGetCommands()
      .then((list) => {
        if (!cancelled) setCommands(list)
      })
      .catch(() => {
        if (!cancelled) setCommands([])
      })
    return () => {
      cancelled = true
    }
  }, [slashOpen, commands, onGetCommands])

  // Enter/Tab on a popup item: exact "/name" sends (pi runs or expands it),
  // anything else completes the name and leaves room for arguments.
  const acceptSlashItem = (item: PiCommandInfo) => {
    const full = `/${item.name}`
    if (draft.trim() === full) void send('prompt')
    else onDraftChange(`${full} `)
  }

  return (
    <div className="shrink-0 px-6 pb-4">
      {/* Click-away catcher for the chip menus. */}
      {openMenu && <div className="fixed inset-0 z-20" onClick={() => setOpenMenu(null)} />}
      <div className="pion-composer mx-auto flex w-full max-w-3xl flex-col gap-0.5 rounded-2xl border-[0.5px] border-line bg-canvas px-3 py-2.5 shadow-card transition-[border-color,box-shadow] duration-150 motion-reduce:transition-none">
        {/* Stable slot above the textarea so the textarea never remounts when
            draft mode swaps to live mode. */}
        <div className="relative flex items-center gap-2">
          {mode === 'draft' && (
            <Fragment>
              {/* Click-away catcher for the project menu. */}
              {projectMenuOpen && <div className="fixed inset-0 z-20" onClick={() => setProjectMenuOpen(false)} />}
              <button
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-1 py-1 text-[13px] font-medium text-ink transition-all hover:bg-fill-hover',
                  showProjectHint && 'bg-tint-bad ring-2 ring-bad/40',
                )}
                title={activeProject?.path ?? t('composer.pickProjectTitle')}
                onClick={() => setProjectMenuOpen((v) => !v)}
              >
                {activeProject ? (
                  <FolderOpen size={15} strokeWidth={1.75} className="shrink-0 text-ink2" />
                ) : (
                  <Folder size={15} strokeWidth={1.75} className="shrink-0 text-ink2" />
                )}
                <span className="max-w-[240px] truncate">{activeProject?.name ?? t('composer.pickProject')}</span>
                <ChevronDown size={12} strokeWidth={2} className={cn('shrink-0 text-ink2 transition-transform', projectMenuOpen && 'rotate-180')} />
              </button>
              {projectMenuOpen && (
                <div className="pop-card absolute bottom-full left-0 z-30 mb-1.5 flex max-h-72 w-64 flex-col overflow-hidden p-1">
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    {projects.map((p) => (
                      <button
                        key={p.id}
                        className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover"
                        title={p.path}
                        onClick={() => {
                          setProjectMenuOpen(false)
                          onSelectProject(p)
                        }}
                      >
                        <Folder size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                        <span className="min-w-0 flex-1 truncate">{p.name}</span>
                        {activeProject?.path === p.path && <Check size={13} strokeWidth={2} className="shrink-0" />}
                      </button>
                    ))}
                  </div>
                  <div className="mt-1 border-t-[0.5px] border-line pt-1">
                    <button
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover"
                      onClick={() => {
                        setProjectMenuOpen(false)
                        onBrowseProjects()
                      }}
                    >
                      <FolderOpen size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
                      <span>{projects.length ? t('composer.browseMore') : t('composer.pickProjectFolder')}</span>
                    </button>
                  </div>
                </div>
              )}
            </Fragment>
          )}
          {/* Plan 状态在 draft/live 都要显示:/plan 作为首条消息发送时，
              扩展拦截了消息、transcript 保持为空，Composer 仍是 draft 模式。 */}
          {planStatus && (
            <div
              className="flex w-fit items-center gap-1.5 rounded-md bg-tint-accent px-1.5 py-1 text-xs text-ink"
              title={PLAN_STATUS_KEY[planStatus] ? t(PLAN_STATUS_KEY[planStatus]) : planStatus}
            >
              <Compass size={13} strokeWidth={1.75} className="shrink-0 text-accent" />
              <span className="font-medium">Plan</span>
              <span className="text-ink2">{PLAN_STATUS_KEY[planStatus] ? t(PLAN_STATUS_KEY[planStatus]) : planStatus}</span>
            </div>
          )}
        </div>
        <div className="relative">
          {slashOpen && (
            <div className="pop-card absolute bottom-full left-0 z-30 mb-1.5 max-h-72 w-[420px] overflow-y-auto p-1">
              {commands === null ? (
                <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink2">
                  <LoaderCircle size={11} className="animate-spin" /> {t('composer.loadingCommands')}
                </p>
              ) : slashItems.length === 0 ? (
                <p className="px-2.5 py-2 text-xs text-ink2">{t('composer.noCommands')}</p>
              ) : (
                slashItems.map((item, i) => (
                  <button
                    key={`${item.source}:${item.name}`}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors',
                      i === slashIndex ? 'bg-fill-hover' : 'hover:bg-fill-hover',
                    )}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => acceptSlashItem(item)}
                  >
                    <span className="shrink-0 font-medium">/{item.name}</span>
                    {item.description && <span className="min-w-0 flex-1 truncate text-ink2">{item.description}</span>}
                    <span
                      className={cn(
                        'shrink-0 rounded px-1.5 py-px text-[10px] font-medium',
                        item.source === 'extension' && 'bg-tint-accent text-ink2',
                        item.source === 'prompt' && 'bg-fill-hover text-ink2',
                        item.source === 'skill' && 'bg-ok/10 text-ok',
                      )}
                    >
                      {item.source === 'extension' ? t('composer.sourceExtension') : item.source === 'prompt' ? t('composer.sourcePrompt') : t('composer.sourceSkill')}
                    </span>
                  </button>
                ))
              )}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="w-full resize-none border-none bg-transparent px-1 py-1 text-[15px] leading-relaxed outline-none placeholder:text-ink2"
            value={draft}
            placeholder={
              mode === 'draft'
                ? t('composer.placeholderDraft')
                : running
                  ? t('composer.placeholderRunning')
                  : t('composer.placeholderLive')
            }
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            rows={2}
            disabled={starting}
          />
          {/* Pending image strip: thumbnails with a hover remove button. */}
          {images.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
              {images.map((img) => (
                <div key={img.id} className="group relative size-14 shrink-0">
                  <img
                    src={img.url}
                    alt={t('composer.pendingImage')}
                    className="size-full cursor-zoom-in rounded-lg border border-line object-cover"
                    draggable={false}
                    onClick={() => openImagePreview(img.url)}
                  />
                  <button
                    className="absolute -right-1.5 -top-1.5 grid size-4.5 place-items-center rounded-full bg-ink text-canvas opacity-0 shadow transition-opacity group-hover:opacity-100"
                    title={t('composer.removeImage')}
                    onClick={() => removeImage(img.id)}
                  >
                    <X size={10} strokeWidth={2.5} />
                  </button>
                </div>
              ))}
              {images.length >= MAX_IMAGES && (
                <span className="text-[11px] text-ink2">{t('composer.maxImages', { max: MAX_IMAGES })}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          {showProjectHint ? (
            <span className="pl-1 text-[11px] font-medium text-bad">{t('composer.pickProjectFirst')}</span>
          ) : !running && !stopping ? (
            <span className="pl-1 text-[11px] text-ink2/60">{t('composer.inputHint')}</span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-1">
            {contextUsage && <ContextRing usage={contextUsage} />}
            <span className="relative hidden sm:block">
              <button
                className={cn(
                  'flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink2 transition-colors',
                  menusReady && 'hover:bg-fill-hover hover:text-ink',
                  !menusReady && 'opacity-50',
                )}
                disabled={!menusReady}
                title={menusReady ? t('composer.switchModel') : t('composer.piStartToSwitch')}
                onClick={() => void toggleMenu('model')}
              >
                <Cpu size={13} strokeWidth={1.75} className="shrink-0" />
                <span className="max-w-[180px] truncate">{modelLabel || t('composer.pickModel')}</span>
                <ChevronDown size={11} strokeWidth={2} className={cn('shrink-0 transition-transform', openMenu === 'model' && 'rotate-180')} />
              </button>
              {openMenu === 'model' && (() => {
                const q = modelQuery.trim().toLowerCase()
                const filtered = (models ?? []).filter((m) =>
                  !q ||
                  `${m.provider}/${m.id}`.toLowerCase().includes(q) ||
                  (m.name ?? '').toLowerCase().includes(q),
                )
                // Group by provider, preserving first-appearance order.
                const groups = new Map<string, PiAvailableModel[]>()
                for (const m of filtered) {
                  const list = groups.get(m.provider)
                  if (list) list.push(m)
                  else groups.set(m.provider, [m])
                }
                return (
                  <div className="pop-card absolute bottom-full right-0 z-30 mb-1.5 flex max-h-80 w-72 flex-col overflow-hidden p-1">
                    <div className="p-1 pb-1.5">
                      <Input
                        autoFocus
                        value={modelQuery}
                        onValueChange={setModelQuery}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.stopPropagation()
                            setOpenMenu(null)
                          }
                        }}
                        placeholder={t('composer.searchModel')}
                      />
                    </div>
                    <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
                      {[...groups.entries()].map(([provider, items]) => (
                        <div key={provider} className="mb-0.5">
                          <p className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-ink2">{provider}</p>
                          {items.map((m) => {
                            const current = model?.provider === m.provider && model?.id === m.id
                            return (
                              <button
                                key={`${m.provider}/${m.id}`}
                                className="flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover"
                                title={`${m.provider}/${m.id}`}
                                onClick={() => void pickModel(m)}
                              >
                                <span className="truncate">{m.name || m.id}</span>
                                {current && <Check size={13} strokeWidth={2} className="shrink-0" />}
                              </button>
                            )
                          })}
                        </div>
                      ))}
                      {models !== null && !filtered.length && (
                        <p className="px-2.5 py-2 text-xs text-ink2">{t('composer.noModels')}</p>
                      )}
                    </div>
                    {menuError && <p className="break-words border-t-[0.5px] border-line px-2.5 py-2 text-[11px] text-bad">{ue(menuError)}</p>}
                  </div>
                )
              })()}
            </span>
            <span className="relative hidden sm:block">
              <button
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-ink2 transition-colors',
                  menusReady && 'hover:bg-fill-hover hover:text-ink',
                  !menusReady && 'opacity-50',
                )}
                disabled={!menusReady}
                title={menusReady ? t('composer.switchThinking') : t('composer.piStartToSwitch')}
                onClick={() => void toggleMenu('thinking')}
              >
                <Brain size={13} strokeWidth={1.75} className="shrink-0" />
                <span>{runtime?.thinkingLevel ?? t('composer.thinking')}</span>
                <ChevronDown size={11} strokeWidth={2} className={cn('shrink-0 transition-transform', openMenu === 'thinking' && 'rotate-180')} />
              </button>
              {openMenu === 'thinking' && (
                <div className="pop-card absolute bottom-full right-0 z-30 mb-1.5 w-40 overflow-y-auto p-1">
                  {(levels ?? FALLBACK_THINKING_LEVELS).map((level) => (
                    <button
                      key={level}
                      className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs text-ink transition-colors hover:bg-fill-hover"
                      onClick={() => void pickThinkingLevel(level)}
                    >
                      {level}
                      {runtime?.thinkingLevel === level && <Check size={13} strokeWidth={2} />}
                    </button>
                  ))}
                  {menuError && <p className="break-words px-2.5 py-2 text-[11px] text-bad">{ue(menuError)}</p>}
                </div>
              )}
            </span>
            {running || stopping || pendingDispatch ? (
              <button
                className="grid size-8 place-items-center rounded-full bg-bad text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                onClick={onAbort}
                disabled={stopping}
                title={pendingDispatch ? t('composer.cancelStart') : t('composer.abort')}
              >
                <Square size={12} strokeWidth={3} fill="currentColor" />
              </button>
            ) : (
              <button
                className={cn(
                  'grid size-8 place-items-center rounded-full transition-colors',
                  canSend ? 'bg-accent text-white hover:bg-accent-hover' : 'bg-raised text-ink2/80',
                )}
                onClick={() => void send('prompt')}
                disabled={!canSend}
                title={t('composer.send')}
              >
                {starting ? <LoaderCircle size={15} strokeWidth={2} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.5} />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
