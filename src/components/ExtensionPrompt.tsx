import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import type { PiEventEnvelope } from '@/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Renders an interactive extension_ui_request (confirm / input / select /
// editor) and calls back with the response. Question-style prompts (select)
// render as a plain floating card — the caller positions it above the
// composer — while the other methods keep a native-style modal alert with
// focus trapping and Escape-to-cancel. Unknown interactive methods fall back
// to a generic JSON surface so unknown payloads never crash the UI.
interface ExtensionPromptProps {
  request: PiEventEnvelope
  onRespond: (response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void
}

export function ExtensionPrompt({ request, onRespond }: ExtensionPromptProps) {
  const event = request.event as {
    method: string
    id: string
    /** pi names the heading "title"; older payloads used "message". */
    title?: string
    message?: string
    options?: unknown
    placeholder?: string
    defaultValue?: string
    allowEmpty?: boolean
  }
  const [value, setValue] = useState(typeof event.defaultValue === 'string' ? event.defaultValue : '')
  const cancel = () => onRespond({ cancelled: true })
  const heading = event.title ?? event.message

  if (event.method === 'select') {
    const options = normalizeSelectOptions(event.options)
    return (
      <div className="dialog-in rounded-xl border-[0.5px] border-line bg-canvas p-3 shadow-pop">
        <p className="px-1 text-[13px] font-semibold leading-snug">{heading ?? 'Select'}</p>
        <div className="mt-2 flex flex-col gap-1">
          {options.map((opt) => (
            <button
              key={opt.value}
              className="rounded-lg border-[0.5px] border-line bg-canvas px-3 py-2 text-left transition-colors hover:border-accent hover:bg-tint-accent"
              onClick={() => onRespond({ value: opt.value })}
            >
              <span className="block text-[13px]">{opt.label}</span>
              {opt.description && (
                <span className="mt-0.5 block text-xs leading-snug text-ink2">{opt.description}</span>
              )}
            </button>
          ))}
        </div>
        <div className="mt-2.5 flex justify-end">
          <Button size="sm" onClick={cancel}>Cancel</Button>
        </div>
      </div>
    )
  }

  const width =
    event.method === 'editor' ? 'w-[min(560px,calc(100vw-48px))]' : 'w-[min(420px,calc(100vw-48px))]'

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) cancel() }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[2px] dark:bg-black/45" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-6">
          <Dialog.Popup className={cn('dialog-in outline-none rounded-xl border-[0.5px] border-line bg-canvas p-4 shadow-pop', width)}>
            {(() => {
              switch (event.method) {
                case 'confirm':
                  return (
                    <>
                      <Dialog.Title className="text-sm font-semibold leading-snug">{heading ?? 'Confirm?'}</Dialog.Title>
                      <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" onClick={cancel}>Cancel</Button>
                        <Button size="sm" variant="primary" autoFocus onClick={() => onRespond({ confirmed: true })}>Confirm</Button>
                      </div>
                    </>
                  )
                case 'input':
                  return (
                    <>
                      <Dialog.Title className="text-sm font-semibold leading-snug">{heading ?? 'Input'}</Dialog.Title>
                      <input
                        className="mt-3 w-full rounded-lg border-[0.5px] border-line bg-canvas px-3 py-2 text-[13px] transition-shadow placeholder:text-ink2 focus:border-accent"
                        value={value}
                        placeholder={event.placeholder}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && (value || event.allowEmpty)) onRespond({ value }) }}
                        autoFocus
                      />
                      <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" onClick={cancel}>Cancel</Button>
                        <Button size="sm" variant="primary" disabled={!value && !event.allowEmpty} onClick={() => onRespond({ value })}>Submit</Button>
                      </div>
                    </>
                  )
                case 'editor':
                  return (
                    <>
                      <Dialog.Title className="text-sm font-semibold leading-snug">{heading ?? 'Edit'}</Dialog.Title>
                      <textarea
                        className="mt-3 min-h-[220px] w-full resize-y rounded-lg border-[0.5px] border-line bg-canvas px-3 py-2 font-mono text-xs leading-relaxed transition-shadow placeholder:text-ink2 focus:border-accent"
                        value={value}
                        placeholder={event.placeholder}
                        onChange={(e) => setValue(e.target.value)}
                        rows={10}
                        autoFocus
                      />
                      <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" onClick={cancel}>Cancel</Button>
                        <Button size="sm" variant="primary" onClick={() => onRespond({ value })}>Save</Button>
                      </div>
                    </>
                  )
                default:
                  // Generic fallback: never crash on an unknown interactive method.
                  return (
                    <>
                      <Dialog.Title className="font-mono text-xs text-accent">{event.method}</Dialog.Title>
                      <pre className="mt-2 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words rounded-md border-[0.5px] border-line bg-panel p-2.5 font-mono text-xs leading-relaxed select-text">
                        {safeStringify(request.event)}
                      </pre>
                      <div className="mt-4 flex justify-end gap-2">
                        <Button size="sm" onClick={cancel}>Dismiss</Button>
                      </div>
                    </>
                  )
              }
            })()}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

interface SelectOption {
  label: string
  description?: string
  value: string
}

// pi forwards select options verbatim from the extension, so their shape is
// free-form: strings, or objects with any common label/value spelling plus an
// optional description line. Whatever is missing falls back so every option
// stays visible and answerable; the response echoes a stable value string.
function normalizeSelectOptions(raw: unknown): SelectOption[] {
  if (!Array.isArray(raw)) return []
  const pick = (o: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = o[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return undefined
  }
  return raw.map((opt) => {
    if (typeof opt === 'string' || typeof opt === 'number') {
      const s = String(opt)
      return { label: s, value: s }
    }
    if (opt && typeof opt === 'object') {
      const o = opt as Record<string, unknown>
      const value = pick(o, 'value', 'id', 'label', 'name', 'title')
      const label = pick(o, 'label', 'title', 'name', 'value', 'id') ?? value
      const description = pick(o, 'description', 'detail', 'hint', 'subtitle')
      if (label) return { label, description, value: value ?? label }
      const json = safeStringify(opt)
      return { label: json, value: json }
    }
    const s = safeStringify(opt)
    return { label: s, value: s }
  })
}
