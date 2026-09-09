import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// shadcn-style badge primitive: one shared chip metric for metadata rows
// (26px, hairline border, text-xs). Tones cover semantic stages/status; use
// `badgeVariants` to compose the same look onto buttons.
const badgeVariants = cva(
  'inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg border-[0.5px] px-2 text-xs whitespace-nowrap select-none',
  {
    variants: {
      tone: {
        neutral: 'border-line bg-panel text-ink2',
        soft: 'border-transparent bg-fill-hover text-ink2',
        info: 'border-transparent bg-info/12 text-info',
        warn: 'border-transparent bg-tint-warn text-warn',
        purple: 'border-transparent bg-purple/12 text-purple',
        ok: 'border-transparent bg-tint-ok text-ok',
        accent: 'border-transparent bg-tint-accent text-accent',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)
export { badgeVariants }

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />
}
