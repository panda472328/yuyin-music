import React from 'react'
import ReactDOM from 'react-dom/client'
import DesktopLyrics from './DesktopLyrics'
import './desktop-lyrics.css'
import { createWebView2DesktopLyricsAPI } from './webview2-bridge'

if (!window.desktopLyricsAPI) window.desktopLyricsAPI = createWebView2DesktopLyricsAPI() ?? undefined

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><DesktopLyrics /></React.StrictMode>)
