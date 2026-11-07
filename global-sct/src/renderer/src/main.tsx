import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('The global.sct window has no root element.')

// The CSP blocks inline scripts, so the bundled entry sets the variant before the first render.
document.documentElement.dataset.theme = window.sct.theme
window.sct.onThemeChanged((variant) => { document.documentElement.dataset.theme = variant })

createRoot(root).render(<StrictMode><App /></StrictMode>)
