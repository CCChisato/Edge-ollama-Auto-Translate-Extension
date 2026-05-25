chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'OLLAMA_FETCH') return
  try { console.log('[OLLAMA-EXT][BG] recv OLLAMA_FETCH', message) } catch { }

  ; (async () => {
    try {
      const url = message.url
      const init = message.init || {}
      let res
      const t0 = Date.now()
      try { console.log('[OLLAMA-EXT][BG] fetch start', url, init) } catch { }

      // 尝试发起请求，如果失败则重试（移除 targetAddressSpace）
      let retried = false
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fetchInit = attempt === 0 ? init : (() => {
            const { targetAddressSpace: _ignored, ...rest } = init
            return rest
          })()
          res = await fetch(url, fetchInit)
          // 请求成功（未抛出异常），检查是否需要重试
          if (res.status === 403 && !retried && init?.targetAddressSpace) {
            // 403 可能是 PNA 限制，重试（不带 targetAddressSpace）
            retried = true
            try { console.log('[OLLAMA-EXT][BG] got 403 with targetAddressSpace, retrying without it') } catch { }
            continue
          }
          // 成功获取响应，跳出循环
          break
        } catch (err) {
          if (attempt === 0 && init?.targetAddressSpace) {
            // 第一次失败且包含 targetAddressSpace，重试
            retried = true
            try { console.log('[OLLAMA-EXT][BG] fetch error once, retrying without targetAddressSpace', String(err)) } catch { }
            continue
          }
          // 重试也失败或没有 targetAddressSpace，抛出异常
          try { console.log('[OLLAMA-EXT][BG] fetch error final', String(err)) } catch { }
          throw err
        }
      }

      const contentType = res.headers.get('content-type') || ''
      try { console.log('[OLLAMA-EXT][BG] fetch done', { status: res.status, ok: res.ok, contentType, elapsedMs: Date.now() - t0 }) } catch { }

      // 先读取响应内容，避免重复读取
      const responseText = await res.text()

      // 处理 403 错误
      if (res.status === 403) {
        let errMsg = `HTTP 403 - 无法访问 Ollama API: ${url}`
        if (responseText) {
          errMsg += `\n响应内容: ${responseText}`
        }
        errMsg += `\n\n请确认 Ollama 服务正在运行，且 URL 配置正确！`
        try { console.log('[OLLAMA-EXT][BG] 403 error', errMsg) } catch { }
        sendResponse({ ok: false, status: 403, error: errMsg, text: responseText })
        return
      }

      // 处理其他状态码
      if (!res.ok) {
        let errMsg = `HTTP ${res.status} - 请求失败: ${url}`
        if (responseText) {
          errMsg += `\n响应内容: ${responseText}`
        }
        sendResponse({ ok: false, status: res.status, error: errMsg, text: responseText })
        return
      }

      // 尝试解析 JSON
      if (contentType.includes('application/json')) {
        try {
          const json = JSON.parse(responseText)
          try { console.log('[OLLAMA-EXT][BG] response json', json) } catch { }
          sendResponse({ ok: res.ok, status: res.status, json })
          return
        } catch (parseErr) {
          // JSON 解析失败，返回原始文本
          try { console.log('[OLLAMA-EXT][BG] JSON parse failed, returning text', String(parseErr)) } catch { }
        }
      }

      // 返回文本
      try { console.log('[OLLAMA-EXT][BG] response text length', responseText?.length) } catch { }
      sendResponse({ ok: res.ok, status: res.status, text: responseText })
    } catch (err) {
      const errMsg = `请求异常: ${String(err?.message || err)}\n提示: 请检查 Ollama 服务是否在 http://127.0.0.1:11434 运行`
      try { console.log('[OLLAMA-EXT][BG] fetch fatal error', errMsg) } catch { }
      sendResponse({ ok: false, status: 0, error: errMsg })
    }
  })()

  return true
})
