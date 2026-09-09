import { Bug, ClipboardList, Coffee, Presentation } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useI18n, type TFn } from '@/i18n'
import type { MsgKey } from '@/i18n/zh'
import { PROMPT_FIX_ERRORS, PROMPT_MAKE_PPT, PROMPT_TIDY_DOCS, PROMPT_WEEKLY_REPORT } from '@/i18n/agent-prompts'

interface HomeProps {
  /** The foreground session crashed; offer in-place restore instead of the hero. */
  crashed: boolean
  onRestore: () => void
  /** Starter chip click: prefill the composer draft and focus it. */
  onStarter: (prompt: string) => void
}

// One-click drafts; clicking fills the composer rather than auto-sending.
// Labels are UI text (dict); prompts are agent-facing zh (agent-prompts.ts).
const STARTERS: { icon: typeof ClipboardList; labelKey: MsgKey; prompt: string }[] = [
  { icon: ClipboardList, labelKey: 'home.starter.weekly', prompt: PROMPT_WEEKLY_REPORT },
  { icon: Bug, labelKey: 'home.starter.fixErrors', prompt: PROMPT_FIX_ERRORS },
  { icon: Presentation, labelKey: 'home.starter.ppt', prompt: PROMPT_MAKE_PPT },
  { icon: Coffee, labelKey: 'home.starter.tidy', prompt: PROMPT_TIDY_DOCS },
]

function timeGreeting(t: TFn): string {
  const h = new Date().getHours()
  if (h < 5) return t('home.greeting.night')
  if (h < 11) return t('home.greeting.morning')
  if (h < 13) return t('home.greeting.noon')
  if (h < 18) return t('home.greeting.afternoon')
  return t('home.greeting.evening')
}

// Home hero: greeting + starter chips centered in the space above the
// composer. There is no input here on purpose — the composer is a separate,
// always-present element docked at the bottom of the session view.
export function Home({ crashed, onRestore, onStarter }: HomeProps) {
  const { t } = useI18n()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-10">
        <span
          aria-hidden
          className="pointer-events-none absolute -top-6 left-1/2 -translate-x-1/2 select-none text-[280px] font-semibold leading-none text-ink/[0.04]"
        >
          π
        </span>

        {crashed ? (
          <div className="relative flex w-full max-w-xl flex-col items-center gap-4">
            <div className="w-full rounded-xl border-[0.5px] border-line bg-tint-bad px-4 py-3 text-center text-[13px] font-medium text-bad shadow-card">
              {t('home.crashBanner')}
            </div>
            <Button variant="primary" onClick={onRestore}>{t('home.restore')}</Button>
          </div>
        ) : (
          <>
            <h1 className="relative text-[26px] font-semibold tracking-tight">{t('home.heroTitle', { greeting: timeGreeting(t) })}</h1>

            <div className="relative mt-7 flex flex-wrap items-center justify-center gap-2">
              {STARTERS.map(({ icon: Icon, labelKey, prompt }) => (
                <button
                  key={labelKey}
                  className="flex items-center gap-1.5 rounded-xl border-[0.5px] border-line bg-panel px-3 py-1.5 text-xs text-ink2 transition-colors hover:bg-fill-hover hover:text-ink"
                  onClick={() => onStarter(prompt)}
                >
                  <Icon size={13} strokeWidth={1.75} />
                  {t(labelKey)}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
