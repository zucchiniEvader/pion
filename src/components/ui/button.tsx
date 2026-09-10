import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// shadcn-style button primitive, tuned to macOS push-button metrics
// (compact heights, hairline borders, system-blue primary).
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap ' +
    'transition-colors duration-100 disabled:pointer-events-none disabled:opacity-40 ' +
    'active:duration-0 select-none',
  {
    variants: {
      variant: {
        primary:
          'bg-accent text-white shadow-[inset_0_0.5px_0_rgba(255,255,255,0.25)] ' +
          'hover:bg-accent-hover active:bg-accent-press',
        secondary:
          'bg-raised text-ink border-[0.5px] border-line shadow-card ' +
          'hover:bg-fill-active active:bg-fill-hover',
        ghost: 'text-ink hover:bg-fill-hover active:bg-fill-active',
        danger: 'text-bad hover:bg-tint-bad',
      },
      size: {
        sm: 'h-6 px-2 text-xs',
        md: 'h-7 px-3 text-[13px]',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
