import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ProjectRecord } from '@/types'
import { useI18n } from '@/i18n'

interface TerminalPanelProps {
  project: ProjectRecord
}

// Terminal tab of the RightSidebar: a real shell (login shell, cwd = project
// dir) hosted by node-pty in Electron main (client-local, independent of the
// daemon / pi-rpc — goal.md terminal rule). Unmounting on tab switch is
// safe: main keeps the pty plus a scrollback tail, re-attach replays it.
export function TerminalPanel({ project }: TerminalPanelProps) {
  const { t } = useI18n()
  const hostRef = useRef<HTMLDivElement>(null)
  const [exited, setExited] = useState<number | null>(null)
  // Bump to respawn after exit (effect re-runs, attach spawns a fresh pty).
  const [session, setSession] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      // Follow the app theme (read once at mount — a theme switch repaints
      // on the next tab switch / remount, which is fine for v1).
      theme: (() => {
        const cs = getComputedStyle(document.documentElement)
        const bg = cs.getPropertyValue('--panel').trim()
        const fg = cs.getPropertyValue('--ink').trim()
        return { background: bg, foreground: fg, cursor: fg }
      })(),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    let disposed = false
    void window.pi.terminal
      .attach(project.path)
      .then(({ buffer }) => {
        if (disposed) return
        if (buffer) term.write(buffer)
        void window.pi.terminal.resize(project.path, term.cols, term.rows)
        term.focus()
      })
      .catch(() => undefined)
    const offData = window.pi.terminal.onData(project.path, (data) => term.write(data))
    const offExit = window.pi.terminal.onExit(project.path, (code) => {
      if (!disposed) setExited(code)
    })
    const input = term.onData((data) => void window.pi.terminal.input(project.path, data))
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* host hidden mid-transition */
      }
      void window.pi.terminal.resize(project.path, term.cols, term.rows)
    })
    ro.observe(host)
    return () => {
      disposed = true
      input.dispose()
      offData()
      offExit()
      ro.disconnect()
      term.dispose()
    }
  }, [project.path, session])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={hostRef} className="absolute inset-0 px-2 py-1.5" />
      {exited !== null && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-panel/95">
          <p className="text-xs text-ink2">{t('terminal.exited', { code: exited })}</p>
          <button
            className="rounded-lg bg-accent px-2.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90"
            onClick={() => {
              setExited(null)
              setSession((s) => s + 1)
            }}
          >
            {t('terminal.restart')}
          </button>
        </div>
      )}
    </div>
  )
}
