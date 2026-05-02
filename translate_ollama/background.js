chrome.action.onClicked.addListener((tab) => {
  if (!tab?.id) return
  try { console.log('[OLLAMA-EXT][BG] action click -> send start to tab', tab.id, tab.url) } catch {}
  chrome.tabs.sendMessage(tab.id, { type: 'OLLAMA_TRANSLATE_START' }).catch(() => {})
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'OLLAMA_FETCH') return
  try { console.log('[OLLAMA-EXT][BG] recv OLLAMA_FETCH', message) } catch {}

  ;(async () => {
    try {
      const url = message.url
      const init = message.init || {}
      let res
      const t0 = Date.now()
      try { console.log('[OLLAMA-EXT][BG] fetch start', url, init) } catch {}
      try {
        res = await fetch(url, init)
      } catch (err) {
        try { console.log('[OLLAMA-EXT][BG] fetch error once', String(err)) } catch {}
        if (init?.targetAddressSpace) {
          const { targetAddressSpace: _ignored, ...retryInit } = init
          try { console.log('[OLLAMA-EXT][BG] retry without targetAddressSpace', retryInit) } catch {}
          res = await fetch(url, retryInit)
        } else {
          throw err
        }
      }
      const contentType = res.headers.get('content-type') || ''
      try { console.log('[OLLAMA-EXT][BG] fetch done', { status: res.status, ok: res.ok, contentType, elapsedMs: Date.now() - t0 }) } catch {}

      if (contentType.includes('application/json')) {
        const json = await res.json()
        try { console.log('[OLLAMA-EXT][BG] response json', json) } catch {}
        sendResponse({ ok: res.ok, status: res.status, json })
        return
      }

      const text = await res.text()
      try { console.log('[OLLAMA-EXT][BG] response text length', text?.length) } catch {}
      sendResponse({ ok: res.ok, status: res.status, text })
    } catch (err) {
      try { console.log('[OLLAMA-EXT][BG] fetch fatal error', String(err?.message || err)) } catch {}
      sendResponse({ ok: false, status: 0, error: String(err?.message || err) })
    }
  })()

  return true
})
