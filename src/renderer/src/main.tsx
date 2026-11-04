import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { followTheme } from './lib/theme'
import './styles.css'

followTheme()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
