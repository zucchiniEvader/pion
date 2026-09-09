import type { CardStatus } from '@/types'
import type { BadgeProps } from '@/components/ui/badge'
import type { MsgKey } from '@/i18n/zh'

type BadgeTone = NonNullable<BadgeProps['tone']>

/** Status label dict keys, shared by the board columns and the detail page. */
export const STATUS_KEY: Record<CardStatus, MsgKey> = {
  todo: 'kanban.status.todo',
  in_progress: 'kanban.status.inProgress',
  review: 'kanban.status.review',
  done: 'kanban.status.done',
}

/**
 * Per-stage color mapping (goal: tasks read by stage at a glance):
 * - todo → blue (committed, waiting to run)
 * - in_progress → orange (work in flight)
 * - review → purple (awaiting human acceptance)
 * - done → green (finished)
 *
 * `stripe` colors the card's left edge on the board, `tone` tints the
 * read-only status Badge on the detail page, `dot` marks column headers.
 */
export const STATUS_STYLE: Record<CardStatus, { stripe: string; tone: BadgeTone; dot: string }> = {
  todo: { stripe: '', tone: 'info', dot: 'bg-info' },
  in_progress: { stripe: '', tone: 'warn', dot: 'bg-warn' },
  review: { stripe: '', tone: 'purple', dot: 'bg-purple' },
  done: { stripe: '', tone: 'ok', dot: 'bg-ok' },
}
