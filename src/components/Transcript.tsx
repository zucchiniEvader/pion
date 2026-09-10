import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MessagePart, NoticePart, ThinkingPart, TranscriptMessage } from '@/lib/eventReducer'
import { fmtDur } from '@/lib/reltime'
import { useI18n, type TFn } from '@/i18n'
import { zh, type MsgKey } from '@/i18n/zh'
import { cn } from '@/lib/utils'
import { ToolRow } from './tool-row'
import { MarkdownContent } from './markdown'
import { OverlayScrollArea } from './overlay-scrollbar'
import { Brain, ChevronRight } from 'lucide-react'
import { openImagePreview } from './ImageLightbox'

// eventReducer stores i18n keys (not prose) for system statuses and
// placeholders; translate a part's text when it matches a dict key.
function localizePart(text: string, t: TFn): string {
  return text in zh ? t(text as MsgKey) : text
}

// Remembered scroll location per session; survives transcript remounts so
// switching back to a long session restores where the user left off instead
// of jumping to the bottom again. "stick" means the user was following the
// live tail when they left.
interface ScrollBookmark {
  top: number
  stick: boolean
}
const scrollMemory = new Map<string, ScrollBookmark>()
const NEAR_BOTTOM_PX = 80

export function Transcript({
  messages,
  running,
  elapsedSec,
  completedMs,
  sessionKey,
}: {
  messages: TranscriptMessage[]
  running?: boolean
  elapsedSec?: number
  completedMs?: number
  sessionKey?: string | null
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const { lang, t } = useI18n()

  // Restore the remembered location before paint so a switch never shows the
  // content scrolled to the top (or a smooth crawl to the bottom).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const saved = sessionKey ? scrollMemory.get(sessionKey) : undefined
    stickToBottomRef.current = saved ? saved.stick : true
    el.scrollTop = saved && !saved.stick ? saved.top : el.scrollHeight
  }, [sessionKey])

  // While streaming, follow the tail only when the user is already near it.
  // `running` is a dep so the tail indicator's appearance also re-sticks.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickToBottomRef.current) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages, running])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distance < NEAR_BOTTOM_PX
    if (sessionKey) scrollMemory.set(sessionKey, { top: el.scrollTop, stick: stickToBottomRef.current })
  }

  return (
    <OverlayScrollArea
      wrapperClassName="flex-1"
      scrollClassName="h-full select-text overflow-y-auto"
      innerRef={scrollRef}
      onScroll={onScroll}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6 pb-8">
        {!messages.length && (
          <div className="grid place-items-center py-24 text-[13px] text-ink2">
            Send a message to start a conversation with PI.
          </div>
        )}
        {messages.map((msg) => (
          <MessageBlock key={msg.id} msg={msg} />
        ))}
        {/* Live tail: the working/complete marker belongs to the end of the
            message flow (not a divider at the top), so it reads as part of the
            conversation. While a run is live it pulses "工作中 · <elapsed>"; on
            settle it becomes a static "工作完成 · <total>" for that output,
            and is replaced by the next run's "工作中". Per-output, not a
            session-global banner. */}
        {(running || completedMs) && (
          <div className="flex items-center gap-2 pt-1">
            {running ? (
              <>
                <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-accent" />
                <span className="text-xs text-ink2">
                  {t('transcript.working')}{elapsedSec ? ` · ${fmtDur(elapsedSec * 1000, lang)}` : ''}
                </span>
              </>
            ) : (
              <>
                <span className="size-1.5 shrink-0 rounded-full bg-ink2/40" />
                <span className="text-xs text-ink2">{t('transcript.workDone', { dur: fmtDur(completedMs!, lang) })}</span>
              </>
            )}
          </div>
        )}
      </div>
    </OverlayScrollArea>
  )
}

// System status row: the reducer stores an i18n key; the in-progress pulse
// is driven by the trailing ellipsis of the TRANSLATED text (both languages
// keep … on the in-progress variants).
function StatusLine({ text }: { text: string }) {
  const { t } = useI18n()
  const localized = localizePart(text, t)
  return (
    <div className="flex items-center justify-center gap-1.5">
      {localized.endsWith('…') && <span className="inline-block size-1.5 shrink-0 animate-pulse rounded-full bg-warn" />}
      {localized}
    </div>
  )
}

// Extension text (`ctx.ui.notify`) and Pion's own local echo of an extension
// command. Left-aligned and unformatted on purpose: status dumps like `/mcp`'s
// arrive as indented lists, so line breaks and spacing have to survive.
const NOTICE_TONE: Record<NoticePart['tone'], string> = {
  info: 'border-line bg-panel text-ink',
  warning: 'border-transparent bg-tint-warn text-warn',
  error: 'border-transparent bg-tint-bad text-bad',
  command: '',
}

function NoticeBlock({ part }: { part: NoticePart }) {
  const { t } = useI18n()
  if (part.tone === 'command') {
    return (
      <div className="flex items-baseline gap-2 text-[11px] text-ink2">
        <span className="font-mono">{part.text}</span>
        <span className="shrink-0 rounded bg-fill-hover px-1.5 py-px text-[10px]">{t('transcript.localCommand')}</span>
      </div>
    )
  }
  return (
    <div
      className={cn(
        'w-fit max-w-[92%] whitespace-pre-wrap break-words rounded-lg border-[0.5px] px-3 py-2 font-mono text-[11px] leading-[1.55]',
        NOTICE_TONE[part.tone],
      )}
    >
      {part.text}
    </div>
  )
}

// memo: editRow 只克隆被事件触碰的那一行，未动行的对象身份不变，
// 流式 delta 就不会重渲染整份 transcript（长会话流式时 renderer CPU O(N)→O(1)）。
const MessageBlock = memo(function MessageBlock({ msg }: { msg: TranscriptMessage }) {
  const { t } = useI18n()
  if (msg.role === 'user') {
    return (
      <div className="mt-3 flex flex-col items-end">
        <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-line px-3.5 py-2">
          {msg.parts.map((p, i) => {
            if (p.type === 'text') return <div key={i}>{localizePart(p.text, t)}</div>
            if (p.type === 'image') {
              const url = `data:${p.mimeType};base64,${p.data}`
              return (
                <img
                  key={i}
                  src={url}
                  alt={t('transcript.attachedImage')}
                  className="mt-1.5 max-h-48 cursor-zoom-in rounded-lg border border-line first:mt-0"
                  draggable={false}
                  onClick={() => openImagePreview(url)}
                />
              )
            }
            return null
          })}
        </div>
      </div>
    )
  }
  if (msg.role === 'system') {
    // Notices are their own left-aligned rows; the lifecycle statuses below
    // stay the centred hairline row they have always been.
    const notices = msg.parts.filter((p): p is NoticePart => p.type === 'notice')
    if (notices.length > 0) {
      return (
        <div className="mt-2 flex flex-col gap-1.5">
          {notices.map((p, i) => (
            <NoticeBlock key={i} part={p} />
          ))}
        </div>
      )
    }
    return (
      <div className="self-center px-8 py-1 text-center text-xs text-ink2">
        {msg.parts.map((p, i) =>
          p.type === 'error' ? (
            <div key={i} className="italic">{p.text}</div>
          ) : p.type === 'status' ? (
            <StatusLine key={i} text={p.text} />
          ) : null,
        )}
      </div>
    )
  }
  // Assistant turns render as an activity flow. The trailing text run
  // after the last thinking/toolCall is the agent's final answer and stays
  // visible; everything before it (thinking, tool calls, intermediate
  // text) is the "process" and collapses into one block once the final
  // answer begins streaming. While the agent is still working (the last
  // part is itself thinking/toolCall, no trailing text yet) the process is
  // left expanded so the user can watch it work — matching the prior flat
  // layout exactly.
  const { processParts, finalParts } = splitAssistantParts(msg.parts)
  const finalStarted = finalParts.length > 0
  return (
    <div className="flex flex-col gap-0.5">
      {processParts.length > 0 && finalStarted ? (
        <ProcessGroup parts={processParts} autoCollapsed />
      ) : (
        processParts.map((part, i) => (
          <PartBlock key={i} part={part} streaming={msg.streaming && i === msg.parts.length - 1 && !finalStarted} markdown />
        ))
      )}
      {finalParts.map((part, i) => (
        <PartBlock key={`f${i}`} part={part} streaming={msg.streaming && i === finalParts.length - 1} markdown />
      ))}
    </div>
  )
})

// Split an assistant turn's parts at the last thinking/toolCall part: the
// trailing text run after it is the final answer; everything up to and
// including that activity part is collapsible process. No activity parts ⇒
// everything is final (no collapse). Last part is itself activity ⇒ no
// trailing text yet, all process (agent still working).
function splitAssistantParts(parts: MessagePart[]): { processParts: MessagePart[]; finalParts: MessagePart[] } {
  let lastActivity = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i].type
    if (t === 'thinking' || t === 'toolCall') { lastActivity = i; break }
  }
  if (lastActivity < 0) return { processParts: [], finalParts: parts }
  return { processParts: parts.slice(0, lastActivity + 1), finalParts: parts.slice(lastActivity + 1) }
}

// Collapsible summary of a turn's thinking + tool calls + intermediate text.
// Auto-collapses when the final answer begins streaming; the user can still
// expand it to inspect the process. Manual toggles win while the auto flag is
// stable; when it flips (final answer starts) we re-sync to collapsed.
// ponytail: per-flip resync, not a derived state — a derived open would reset
// the user's manual expand the moment more process parts stream in.
function ProcessGroup({ parts, autoCollapsed }: { parts: MessagePart[]; autoCollapsed?: boolean }) {
  const [open, setOpen] = useState(!autoCollapsed)
  const { t } = useI18n()
  useEffect(() => { setOpen(!autoCollapsed) }, [autoCollapsed])
  const steps = parts.filter((p) => p.type === 'toolCall').length
  const thinking = parts.some((p) => p.type === 'thinking')
  return (
    <div className="my-0.5">
      <button
        className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-ink2 transition-colors hover:bg-fill-hover"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={12} className={cn('shrink-0 transition-transform duration-150', open && 'rotate-90')} />
        <Brain size={14} strokeWidth={1.75} className="shrink-0" />
        <span>{t('transcript.work')}</span>
        {thinking && steps > 0 && <span className="text-ink2/80">{t('transcript.steps', { count: steps, s: steps === 1 ? '' : 's' })}</span>}
        {/* {!open && <span className="truncate text-ink2/70">· 点击展开</span>} */}
      </button>
      {open && (
        <div className="mt-0.5 flex flex-col gap-0.5 border-l border-line pl-2">
          {parts.map((part, i) => (
            <PartBlock key={i} part={part} markdown />
          ))}
        </div>
      )}
    </div>
  )
}

function PartBlock({ part, streaming, markdown }: { part: MessagePart; streaming?: boolean; markdown?: boolean }) {
  switch (part.type) {
    case 'text':
      return markdown ? (
        <div className="px-2 py-0.5">
          <MarkdownContent text={part.text} />
          {streaming && <span className="streaming-cursor">▍</span>}
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words px-2 py-0.5 text-[13px] leading-relaxed">
          {part.text}
          {streaming && <span className="streaming-cursor">▍</span>}
        </div>
      )
    case 'thinking':
      return <ThinkingRow part={part} />
    case 'error':
      return <div className="whitespace-pre-wrap break-words px-2 py-0.5 text-bad">{part.text}</div>
    case 'toolCall':
      return <ToolRow part={part} />
    default:
      return null
  }
}

// Collapsed-by-default reasoning block, Claude-desktop style: finished rows
// read "思考过程 · 持续了 N 秒"; while still streaming the row reads
// "思考中… · <latest words>" and pulses. Native <details> handles toggling.
function ThinkingRow({ part }: { part: ThinkingPart }) {
  const { lang, t } = useI18n()
  const finished = Boolean(part.startedAt && part.finishedAt)
  const live = Boolean(part.startedAt) && !finished
  const dur = finished && part.startedAt && part.finishedAt
    ? t('transcript.lastedDur', { dur: fmtDur(part.finishedAt - part.startedAt, lang) })
    : ''
  const preview = live && part.text ? tailPreview(part.text) : ''
  return (
    <details className="group my-0.5">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-[13px] text-ink2 transition-colors hover:bg-fill-hover [&::-webkit-details-marker]:hidden">
        <Brain size={14} strokeWidth={1.75} className={cn('shrink-0', live && 'animate-pulse')} />
        <span>{live ? t('transcript.thinking') : t('transcript.thoughtProcess')}</span>
        {dur && <span>· {dur}</span>}
        {preview && <span className="max-w-[380px] truncate text-ink2/80">· {preview}</span>}
        <ChevronRight size={12} className="shrink-0 transition-transform duration-150 group-open:rotate-90" />
      </summary>
      {!part.text.trim() ? null : (
        <div className="ml-[30px] mt-0.5 mr-4 select-text whitespace-pre-wrap break-words border-l border-line pl-3 pr-1 text-xs leading-relaxed text-ink2">
          {part.text}
        </div>
      )}
    </details>
  )
}

function tailPreview(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trimEnd()
  if (!trimmed) return ''
  return trimmed.length > 64 ? `…${trimmed.slice(-64)}` : trimmed
}
