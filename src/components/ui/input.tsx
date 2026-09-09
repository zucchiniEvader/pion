import { forwardRef, type InputHTMLAttributes } from 'react'
import { Input as BaseInput } from '@base-ui/react/input'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

// shadcn-style input primitive over Base UI's Input, tuned to the app's
// hairline-border text field look.
const inputVariants = cva(
  'w-full rounded-lg border-[0.5px] border-line bg-canvas text-ink outline-none transition-colors ' +
    'placeholder:text-ink2 focus:border-accent disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      size: {
        sm: 'px-2.5 py-1.5 text-xs',
        md: 'px-3 py-2 text-[13px]',
      },
    },
    defaultVariants: { size: 'sm' },
  },
)

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size' | 'onChange'>,
    VariantProps<typeof inputVariants> {
  /** Controlled change callback (Base UI style). */
  onValueChange?: (value: string) => void
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, size, onValueChange, ...props }, ref) => (
    <BaseInput
      ref={ref}
      className={cn(inputVariants({ size }), className)}
      onChange={onValueChange ? (e) => onValueChange(e.target.value) : undefined}
      {...props}
    />
  ),
)
Input.displayName = 'Input'
