// Toast stack for PI extension `notify` requests (fire-and-forget UI). The
// pool collects them per runtime (useSessionPool); this is the only surface
// that renders them. Each toast auto-dismisses; click dismisses immediately.
import { useEffect } from 'react'
import type { NotifyEntry } from '@/hooks/useSessionPool'

const AUTO_DISMISS_MS = 6_000

function Toast({ entry, onDismiss }: { entry: NotifyEntry; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [onDismiss, entry.id])
  const tone =
    entry.notifyType === 'error' ? 'text-red-500' : entry.notifyType === 'warning' ? 'text-amber-500' : 'text-accent'
  return (
    <button
      type="button"
      onClick={onDismiss}
      className="pointer-events-auto w-72 rounded-lg border-[0.5px] border-line bg-canvas px-3 py-2 text-left shadow-pop"
    >
      <span className={`block text-xs leading-snug ${tone}`}>{entry.message}</span>
    </button>
  )
}

export function NotifyStack({ notifies, onDismiss }: { notifies: NotifyEntry[]; onDismiss: (id: string) => void }) {
  if (notifies.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-50 flex flex-col items-end gap-2">
      {notifies.map((n) => (
        <Toast key={n.id} entry={n} onDismiss={() => onDismiss(n.id)} />
      ))}
    </div>
  )
}
