import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import { applyTheme, readStoredTheme } from './theme'
import './styles.css'

// macOS hiddenInset traffic lights overlay the window content; toolbars
// marked .traffic-inset reserve room for them.
if (/Mac/i.test(navigator.platform ?? '') || navigator.userAgent.includes('Macintosh')) {
  document.documentElement.classList.add('mac')
}

// Restore the appearance preference before first paint; setTheme also re-syncs
// nativeTheme.themeSource in main (harmless repeat of a persisted choice).
applyTheme(readStoredTheme())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>,
)
