import logoUrl from '../../assets/pion-logo.png'
import { cn } from '@/lib/utils'

interface AppLogoProps {
  className?: string
}

/** The shared Pion brand mark, kept decorative beside visible labels. */
export function AppLogo({ className }: AppLogoProps) {
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center overflow-hidden bg-[#f5f5f7] shadow-card select-none',
        className,
      )}
      aria-hidden="true"
    >
      <img src={logoUrl} alt="" className="size-full object-contain" draggable={false} />
    </span>
  )
}
