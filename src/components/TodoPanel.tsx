import { useState } from 'react'
import type { TodoItem } from '@/lib/eventReducer'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { Check, ChevronDown, Circle, CircleDotDashed, ListTodo, LoaderCircle } from 'lucide-react'

// Todo list projected from the session's `todo` tool calls, docked above the
// composer. Hidden entirely until the agent creates its first task; from then
// on it tracks the latest snapshot (completed items stay visible but muted).
function StatusIcon({ status }: { status: TodoItem['status'] }) {
  if (status === 'completed') {
    return <Check size={13} strokeWidth={2.25} className="shrink-0 text-ok" />
  }
  if (status === 'in_progress') {
    return <LoaderCircle size={13} strokeWidth={2.25} className="shrink-0 animate-spin text-accent" />
  }
  if (status === 'pending') {
    return <Circle size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
  }
  return <CircleDotDashed size={13} strokeWidth={1.75} className="shrink-0 text-ink2" />
}

export function TodoPanel({ todos }: { todos: TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(false)
  const { t } = useI18n()
  if (todos.length === 0) return null
  const doneCount = todos.filter((t) => t.status === 'completed').length
  const active = todos.find((t) => t.status === 'in_progress')

  return (
    <div className="px-6 pb-2">
      <div className="mx-auto w-full max-w-3xl rounded-xl border-[0.5px] border-line bg-panel px-3 py-2 shadow-card">
        <button
          className="flex w-full items-center gap-2 text-left"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? t('todo.expand') : t('todo.collapse')}
        >
          <ListTodo size={14} strokeWidth={1.75} className="shrink-0 text-ink2" />
          <span className="text-xs font-semibold text-ink">Todos</span>
          <span className="text-xs text-ink2">{doneCount}/{todos.length}</span>
          {collapsed && active && (
            <span className="min-w-0 flex-1 truncate text-xs text-accent">{active.activeForm ?? active.subject}</span>
          )}
          <span className="flex-1" />
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={cn('shrink-0 text-ink2 transition-transform', collapsed && '-rotate-90')}
          />
        </button>
        {!collapsed && (
          <ul className="mt-1.5 flex flex-col gap-1">
            {todos.map((t) => (
              <li key={t.id} className="group flex items-start gap-2 rounded-md px-1 py-0.5">
                <span className="mt-[3px]">
                  <StatusIcon status={t.status} />
                </span>
                <span className="min-w-0 flex-1 text-xs leading-relaxed">
                  <span
                    className={cn(
                      t.status === 'completed' && 'text-ink2/60 line-through',
                      t.status === 'in_progress' && 'font-medium text-ink',
                      t.status === 'pending' && 'text-ink2',
                    )}
                  >
                    {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
                  </span>
                  {t.description && t.status !== 'completed' && (
                    <span className="ml-1.5 text-ink2/70" title={t.description}>{t.description}</span>
                  )}
                </span>
                <span className="shrink-0 pt-px text-[10px] text-ink2/50">#{t.id}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
