// 默认配置
const DEFAULT_OLLAMA_GENERATE_URL = 'http://localhost:11434/api/generate'
const DEFAULT_OLLAMA_MODEL = 'granite4.1:3b'

// 运行时配置（可从 chrome.storage.sync 读取）
let OLLAMA_GENERATE_URL = DEFAULT_OLLAMA_GENERATE_URL
let OLLAMA_MODEL = DEFAULT_OLLAMA_MODEL

// 从 storage 加载配置
async function loadConfig() {
  try {
    const result = await chrome.storage.sync.get(['ollamaGenerateUrl', 'ollamaModel'])
    if (result.ollamaGenerateUrl) OLLAMA_GENERATE_URL = result.ollamaGenerateUrl
    if (result.ollamaModel) OLLAMA_MODEL = result.ollamaModel
    dlog('config loaded', { OLLAMA_GENERATE_URL, OLLAMA_MODEL })
  } catch (err) {
    dlog('config load error', String(err))
  }
}

// 监听 storage 变化，实时更新配置
function setupConfigListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    let changed = false
    if (changes.ollamaGenerateUrl) {
      OLLAMA_GENERATE_URL = changes.ollamaGenerateUrl.newValue || DEFAULT_OLLAMA_GENERATE_URL
      changed = true
    }
    if (changes.ollamaModel) {
      OLLAMA_MODEL = changes.ollamaModel.newValue || DEFAULT_OLLAMA_MODEL
      changed = true
    }
    if (changed) {
      dlog('config updated via storage change', { OLLAMA_GENERATE_URL, OLLAMA_MODEL })
    }
  })
}

let currentTopic = ''

let currentPageKey = ''
let topicPromise = null

let translationEnabled = false
let mutationObserver = null

const MAX_CONCURRENCY = 1
let activeTranslations = 0
const translateQueue = []
const queuedElements = new WeakSet()
let sourceIdCounter = 0
const translationCache = new Map()
const TRANSLATION_CACHE_MAX = 500
const TRANSLATION_CACHE_STORAGE_KEY = 'ollamaTranslationCacheV1'
const DEBUG = true
let requestCounter = 0
let translationCacheReady = null

function dlog(...args) {
  if (!DEBUG) return
  try {
    console.log('[OLLAMA-EXT]', ...args)
  } catch { }
}

function normalizeLang(lang) {
  return String(lang || '').trim().toLowerCase()
}

function isEnglishPage() {
  const lang = normalizeLang(document.documentElement?.getAttribute?.('lang'))
  return lang === 'en' || lang.startsWith('en-')
}

function stripThinkBlocks(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

function isSupportedTag(tagName) {
  return tagName === 'P' || tagName === 'LI' || tagName === 'SPAN'
}

function normalizeTextForCompare(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function getElementFromNode(node) {
  if (!node) return null
  if (node.nodeType === Node.ELEMENT_NODE) return node
  return node.parentElement || null
}

function isProtectedElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false

  if (el.closest('[translate="no"]')) return true
  if (el.closest('.ProseMirror')) return true
  if (el.closest('code, pre, samp, kbd')) return true
  if (el.closest('textarea, input, select, option, button')) return true
  if (el.closest('[role="textbox"], [role="searchbox"], [role="combobox"]')) return true

  const editableHost = el.closest('[contenteditable]')
  if (!editableHost) return false

  const editableValue = String(editableHost.getAttribute('contenteditable') || '').toLowerCase()
  return editableValue !== 'false'
}

function shouldSkipMutationNode(node) {
  const el = getElementFromNode(node)
  return isProtectedElement(el)
}

function hasSupportedDescendantForTranslation(el) {
  // 检查元素是否有任何需要单独翻译的支持标签子元素
  // 如果有，则跳过父元素的翻译，避免嵌套标签重复翻译
  const descendants = el.querySelectorAll?.('p, li, span')
  if (!descendants?.length) return false

  for (const node of descendants) {
    if (node === el) continue
    if (isTranslationNode(node)) continue
    if (isProtectedElement(node)) continue
    // 只要存在需要翻译的子元素，父元素就应该跳过
    // 因为子元素会被单独翻译，父元素再翻译会导致内容重复
    if (shouldTranslateElement(node)) return true
  }

  return false
}


function getSiteKey() {
  return location.origin
}

function makeTranslationCacheKey(text) {
  return `${getSiteKey()}|${text}`
}

function loadMapEntriesIntoMemory(entries) {
  translationCache.clear()
  for (const [key, value] of entries) {
    if (typeof key !== 'string' || typeof value !== 'string') continue
    translationCache.set(key, value)
  }
}

async function loadPersistentTranslationCache() {
  if (!chrome?.storage?.local) {
    dlog('persistent cache unavailable')
    return
  }

  const result = await chrome.storage.local.get(TRANSLATION_CACHE_STORAGE_KEY)
  const entries = Array.isArray(result?.[TRANSLATION_CACHE_STORAGE_KEY]) ? result[TRANSLATION_CACHE_STORAGE_KEY] : []
  loadMapEntriesIntoMemory(entries)
  dlog('persistent cache loaded', { size: translationCache.size })
}

async function savePersistentTranslationCache() {
  if (!chrome?.storage?.local) return
  const entries = Array.from(translationCache.entries()).slice(-TRANSLATION_CACHE_MAX)
  await chrome.storage.local.set({ [TRANSLATION_CACHE_STORAGE_KEY]: entries })
  dlog('persistent cache saved', { size: entries.length })
}

function ensureTranslationCacheReady() {
  if (!translationCacheReady) {
    translationCacheReady = loadPersistentTranslationCache().catch((err) => {
      dlog('persistent cache load error', String(err))
    })
  }
  return translationCacheReady
}

async function getCachedTranslation(cacheKey) {
  await ensureTranslationCacheReady()
  return translationCache.get(cacheKey)
}

async function setCachedTranslation(cacheKey, translatedText) {
  if (!translatedText) return
  await ensureTranslationCacheReady()

  if (translationCache.has(cacheKey)) translationCache.delete(cacheKey)
  translationCache.set(cacheKey, translatedText)

  while (translationCache.size > TRANSLATION_CACHE_MAX) {
    const oldestKey = translationCache.keys().next().value
    if (!oldestKey) break
    translationCache.delete(oldestKey)
  }

  await savePersistentTranslationCache().catch((err) => {
    dlog('persistent cache save error', String(err))
  })
}

function sendMessageToBackground(message, timeoutMs = 30000) {
  if (!chrome?.runtime?.sendMessage) return Promise.reject(new Error('runtime.sendMessage 不可用'))
  dlog('sendMessage -> background', message?.type, message)
  return new Promise((resolve, reject) => {
    let finished = false
    const timer = setTimeout(() => {
      finished = true
      reject(new Error('后台请求超时'))
    }, timeoutMs)

    chrome.runtime.sendMessage(message, (response) => {
      if (finished) return
      clearTimeout(timer)
      const lastError = chrome.runtime.lastError
      if (lastError) {
        dlog('background lastError', lastError?.message)
        reject(new Error(lastError.message || String(lastError)))
        return
      }
      dlog('background response', response)
      resolve(response)
    })
  })
}

async function fetchJson(url, init) {
  const reqId = ++requestCounter
  const started = performance.now()
  dlog('fetchJson start', { reqId, url, init })

  // 直接使用 background service worker 发起请求（不受 CORS 限制）
  try {
    const res = await sendMessageToBackground({ type: 'OLLAMA_FETCH', url, init }, 30000)
    dlog('fetchJson result', { reqId, elapsedMs: Math.round(performance.now() - started), res })

    if (!res?.ok) {
      const errMsg = res?.error || `HTTP ${res?.status || 0} - 访问 ${url} 失败`
      dlog('fetchJson background error', { reqId, err: errMsg })
      throw new Error(errMsg)
    }

    if (res?.json) return res.json
    if (res?.text) {
      try {
        return JSON.parse(res.text)
      } catch (parseErr) {
        dlog('fetchJson JSON parse error', { reqId, text: res.text, err: String(parseErr) })
        throw new Error(`JSON 解析失败: ${String(parseErr)}\n响应内容: ${res.text}`)
      }
    }
    throw new Error('空响应')
  } catch (bgErr) {
    // 提供简洁的错误提示
    let errMsg = String(bgErr?.message || bgErr)
    errMsg += `\n\n📋 解决方案:\n1. 确认 Ollama 正在运行: 访问 http://localhost:11434\n2. 确认模型已下载: ollama pull ${OLLAMA_MODEL}\n3. 重新加载浏览器扩展`
    dlog('fetchJson failed', { reqId, err: errMsg })
    throw new Error(errMsg)
  }
}

// 使用 XMLHttpRequest 发起请求（content script 中不受 CORS 限制）
function xhrFetch(url, init) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const method = (init?.method || 'GET').toUpperCase()
    xhr.open(method, url, true)

    // 设置请求头
    if (init?.headers) {
      for (const [key, value] of Object.entries(init.headers)) {
        xhr.setRequestHeader(key, value)
      }
    }

    xhr.responseType = 'text'
    xhr.onload = function () {
      dlog('xhrFetch onload', { status: xhr.status, statusText: xhr.statusText })
      if (xhr.status >= 200 && xhr.status < 300) {
        const contentType = xhr.getResponseHeader('content-type') || ''
        try {
          resolve(JSON.parse(xhr.responseText))
        } catch (parseErr) {
          reject(new Error(`JSON 解析失败: ${String(parseErr)}\n响应内容: ${xhr.responseText}`))
        }
      } else {
        let errMsg = `HTTP ${xhr.status}`
        if (xhr.statusText) errMsg += ` - ${xhr.statusText}`
        if (xhr.responseText) errMsg += `\n响应内容: ${xhr.responseText}`
        if (xhr.status === 403) {
          errMsg += `\n提示: 请检查 Ollama 是否允许来自 localhost 的访问（OLLAMA_ORIGINS="*"）`
        }
        reject(new Error(errMsg))
      }
    }
    xhr.onerror = function () {
      reject(new Error(`网络错误 - 无法连接到 ${url}\n提示: 请确认 Ollama 服务正在 http://127.0.0.1:11434 运行`))
    }
    xhr.ontimeout = function () {
      reject(new Error(`请求超时 (30s) - ${url}\n提示: 请检查 Ollama 响应是否正常`))
    }
    xhr.timeout = 30000

    dlog('xhrFetch sending', { method, url, hasBody: !!init?.body })
    if (init?.body) {
      xhr.send(init.body)
    } else {
      xhr.send()
    }
  })
}



async function ollamaGenerate(body) {
  const reqId = ++requestCounter
  const effectiveBody = { think: false, ...body }
  dlog('ollamaGenerate -> request', { reqId, url: OLLAMA_GENERATE_URL, body: effectiveBody })
  const started = performance.now()
  const data = await fetchJson(OLLAMA_GENERATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(effectiveBody),
    targetAddressSpace: 'loopback'
  }).catch((err) => {
    dlog('ollamaGenerate error', { reqId, err: String(err) })
    throw err
  })
  dlog('ollamaGenerate <- response', { reqId, elapsedMs: Math.round(performance.now() - started), data })
  return data
}



function getPageKey() {
  return location.href
}

function getTextSample(maxChars = 2000) {
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim()
  return text.slice(0, maxChars)
}

async function summarizeTopicWithOllama(sampleText) {
  dlog('summarizeTopicWithOllama start', { sampleLen: sampleText.length })
  const data = await ollamaGenerate({
    model: OLLAMA_MODEL,
    prompt: `下面是网页内容片段（最多2000字符）。请用中文概括该网页的主题，约100字以内。只输出概括内容，不要解释，不要思维链：\n${sampleText}`,
    stream: false,
    temperature: 0.1,
    options: {
      num_predict: 180
    }
  })
  const topic = stripThinkBlocks(data.response)?.trim() || ''
  dlog('summarizeTopicWithOllama done', { topic })
  return topic
}

async function refreshTopicForPage({ retries = 1 } = {}) {
  const pageKey = getPageKey()
  if (currentPageKey === pageKey && currentTopic) return currentTopic

  if (currentPageKey !== pageKey) {
    currentPageKey = pageKey
    currentTopic = ''
    topicPromise = null
  }

  if (topicPromise) return topicPromise

  topicPromise = (async () => {
    const sample = getTextSample(2000)
    dlog('refreshTopicForPage sample', { len: sample.length })
    if (sample.length < 200 && retries > 0) {
      await new Promise((r) => setTimeout(r, 1000))
      topicPromise = null
      return refreshTopicForPage({ retries: retries - 1 })
    }
    const topic = await summarizeTopicWithOllama(sample)
    currentTopic = topic
    return topic
  })()

  return topicPromise
}

function ensureSourceId(el) {
  if (!el.dataset.ollamaSourceId) {
    sourceIdCounter += 1
    el.dataset.ollamaSourceId = String(sourceIdCounter)
  }
  return el.dataset.ollamaSourceId
}

function isTranslationNode(el) {
  return el?.dataset?.ollamaTranslation === '1'
}

function hasExistingTranslation(el) {
  const sourceId = el.dataset.ollamaSourceId
  if (!sourceId) return false
  // 检查所有后续兄弟元素，避免因中间存在文本节点而漏检
  let sibling = el.nextElementSibling
  while (sibling) {
    if (isTranslationNode(sibling) && sibling.dataset.ollamaSourceId === sourceId) return true
    sibling = sibling.nextElementSibling
  }
  return false
}


function shouldTranslateElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false
  if (!isSupportedTag(el.tagName)) return false
  if (isProtectedElement(el)) return false
  if (isTranslationNode(el)) return false
  if (el.dataset.ollamaTranslated === '1') return false

  const text = normalizeTextForCompare(el.textContent)
  if (text.length < 2) return false
  // 如果元素包含需要单独翻译的子元素，跳过父元素避免嵌套重复翻译
  if (hasSupportedDescendantForTranslation(el)) return false

  const hasLatin = /[A-Za-z]/.test(text)
  const hasCjk = /[\u4e00-\u9fff]/.test(text)
  if (hasCjk && !hasLatin) return false

  return true
}


function enqueueTranslation(el) {
  if (!translationEnabled) return
  if (!shouldTranslateElement(el)) return
  if (queuedElements.has(el)) return

  ensureSourceId(el)
  if (hasExistingTranslation(el)) {
    el.dataset.ollamaTranslated = '1'
    return
  }

  queuedElements.add(el)
  translateQueue.push(el)
  dlog('enqueue', { queueSize: translateQueue.length, active: activeTranslations, tag: el.tagName, text: el.textContent?.trim() })
  processTranslateQueue()
}

function processTranslateQueue() {
  while (activeTranslations < MAX_CONCURRENCY && translateQueue.length) {
    const el = translateQueue.shift()
    if (!el || !document.contains(el)) {
      queuedElements.delete(el)
      continue
    }

    activeTranslations += 1
    dlog('process start', { active: activeTranslations, remaining: translateQueue.length })
    translateElement(el)
      .catch((err) => {
        console.warn('翻译失败:', err)
        dlog('process error', String(err))
      })
      .finally(() => {
        activeTranslations -= 1
        // 注意：不在这里删除 queuedElements，让 enqueueTranslation 的 shouldTranslateElement 检查
        // 中的 ollamaTranslated 标志来防止重复入队。translateElement 在返回前已设置该标志。
        dlog('process done', { active: activeTranslations, remaining: translateQueue.length })
        processTranslateQueue()
      })
  }
}


function createTranslationElement(sourceEl, translatedText) {
  const tagName = sourceEl.tagName.toLowerCase()
  const translatedEl = document.createElement(tagName)
  translatedEl.style.color = '#ffa0f7ff'
  translatedEl.dataset.ollamaTranslation = '1'
  translatedEl.dataset.ollamaSourceId = sourceEl.dataset.ollamaSourceId
  translatedEl.textContent = translatedText
  return translatedEl
}

// 标记正在翻译中的元素，防止并发重复处理
const translatingElements = new WeakSet()

async function translateElement(el) {
  if (!translationEnabled) return
  if (!shouldTranslateElement(el)) return
  if (translatingElements.has(el)) return
  if (hasExistingTranslation(el)) {
    el.dataset.ollamaTranslated = '1'
    return
  }

  // 立即标记为正在翻译中，防止并发重复处理
  translatingElements.add(el)

  try {
    const originalText = el.textContent.trim()
    const topic = await refreshTopicForPage({ retries: 1 })
    dlog('translateElement start', { len: originalText.length, preview: originalText.slice(0, 120), topic })
    const cacheKey = makeTranslationCacheKey(originalText)
    let chineseText = await getCachedTranslation(cacheKey)
    if (!chineseText) {
      chineseText = await translateWithOllama(originalText, topic)
      chineseText = stripThinkBlocks(chineseText)
      if (chineseText) await setCachedTranslation(cacheKey, chineseText)
      dlog('translateElement fromNetwork', { chineseLen: chineseText?.length, chinesePreview: chineseText?.slice?.(0, 120) })
    } else {
      dlog('translateElement fromCache', { chineseLen: chineseText?.length, chinesePreview: chineseText?.slice?.(0, 120) })
    }

    if (stripThinkBlocks(chineseText) === 'NO_REPLY') {
      dlog('translateElement NO_REPLY')
      el.dataset.ollamaTranslated = '1'
      return
    }
    if (!chineseText || stripThinkBlocks(chineseText) === '翻译失败') {
      dlog('translateElement EMPTY_OR_FAILED', { chineseText })
      el.dataset.ollamaTranslated = '1'
      return
    }
    if (!document.contains(el)) return
    if (hasExistingTranslation(el)) {
      el.dataset.ollamaTranslated = '1'
      return
    }

    const translatedEl = createTranslationElement(el, chineseText)
    el.after(translatedEl)
    el.dataset.ollamaTranslated = '1'
    dlog('translateElement inserted')
  } finally {
    translatingElements.delete(el)
  }
}


function scanAndEnqueue(root) {
  if (!translationEnabled) return
  if (!root) return

  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root
    if (isTranslationNode(el)) return
    if (isProtectedElement(el)) return
    if (isSupportedTag(el.tagName)) enqueueTranslation(el)

    const nodes = el.querySelectorAll?.('p, li, span')
    if (nodes?.length) {
      for (const node of nodes) enqueueTranslation(node)
    }
  } else if (root.nodeType === Node.TEXT_NODE) {
    const parent = root.parentElement?.closest?.('p, li, span')
    if (parent) enqueueTranslation(parent)
  }
}

let scheduledScanTimer = null
function scheduleFullScan() {
  if (scheduledScanTimer) return
  scheduledScanTimer = setTimeout(() => {
    scheduledScanTimer = null
    dlog('scheduleFullScan run')
    scanAndEnqueue(document.body)
  }, 200)
}

function setupMutationObserver() {
  if (mutationObserver) return
  mutationObserver = new MutationObserver((mutations) => {
    dlog('mutation', { count: mutations.length })
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        for (const node of mutation.addedNodes) {
          if (shouldSkipMutationNode(node)) continue
          scanAndEnqueue(node)
        }
      } else if (mutation.type === 'characterData') {
        if (shouldSkipMutationNode(mutation.target)) continue
        scanAndEnqueue(mutation.target)
      }
    }
  })

  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true
  })
}

function setupNavigationHooks(onNavigate) {
  const originalPushState = history.pushState
  const originalReplaceState = history.replaceState

  history.pushState = function (...args) {
    const result = originalPushState.apply(this, args)
    onNavigate()
    return result
  }

  history.replaceState = function (...args) {
    const result = originalReplaceState.apply(this, args)
    onNavigate()
    return result
  }

  window.addEventListener('popstate', onNavigate)
}

let lastNavigationKey = ''
function handleNavigation() {
  const pageKey = getPageKey()
  if (pageKey === lastNavigationKey) return
  lastNavigationKey = pageKey

  currentPageKey = ''
  currentTopic = ''
  topicPromise = null

  if (translationEnabled) {
    dlog('handleNavigation -> startTranslation path', pageKey)
    refreshTopicForPage({ retries: 1 }).catch(() => { })
    scheduleFullScan()
  }
}

function startTranslation() {
  if (translationEnabled) return
  translationEnabled = true

  dlog('startTranslation')
  ensureTranslationCacheReady()
    .finally(() => {
      refreshTopicForPage({ retries: 1 }).catch(() => { })
      scanAndEnqueue(document.body)
      setupMutationObserver()
    })
}

// 注册消息监听器（必须在最前面，确保不会错过任何消息）
chrome.runtime?.onMessage?.addListener?.((message) => {
  dlog('onMessage', message)
  if (message?.type === 'OLLAMA_TRANSLATE_START') {
    startTranslation()
  } else if (message?.type === 'OLLAMA_AUTO_TRANSLATE') {
    handleAutoTranslateMessage(message.enabled)
  } else if (message?.type === 'OLLAMA_CONFIG_UPDATED') {
    loadConfig()
  }
})

// 检查并应用自动翻译设置
async function checkAutoTranslateSetting() {
  try {
    const result = await chrome.storage.sync.get('ollamaAutoTranslate')
    if (result.ollamaAutoTranslate) {
      dlog('autoTranslate enabled, starting translation')
      startTranslation()
    }
  } catch (err) {
    dlog('checkAutoTranslateSetting error', String(err))
  }
}

// 处理自动翻译消息
function handleAutoTranslateMessage(enabled) {
  dlog('handleAutoTranslateMessage', { enabled })
  if (enabled) {
    startTranslation()
  }
}

// ============================================================
// 手动翻译功能：框选文本 → 浮动按钮 → 翻译弹窗
// ============================================================

// 手动翻译弹窗的样式
const MANUAL_TRANSLATE_STYLE_ID = 'ollama-manual-translate-style'

function injectManualTranslateStyles() {
  if (document.getElementById(MANUAL_TRANSLATE_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = MANUAL_TRANSLATE_STYLE_ID
  style.textContent = `
    /* 浮动翻译按钮 */
    #ollama-float-btn {
      position: fixed;
      z-index: 2147483647;
      padding: 6px 14px;
      background: #7c3aed;
      color: #fff;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      transition: background 0.15s, transform 0.1s;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      line-height: 1.4;
      pointer-events: auto;
      user-select: none;
    }
    #ollama-float-btn:hover {
      background: #6d28d9;
    }
    #ollama-float-btn:active {
      transform: scale(0.95);
    }

    /* 翻译弹窗遮罩 */
    #ollama-popup-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 2147483646;
      background: rgba(0,0,0,0.3);
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: auto;
    }

    /* 翻译弹窗 */
    #ollama-popup {
      position: relative;
      width: 480px;
      max-width: 90vw;
      max-height: 80vh;
      background: #1a1a2e;
      border: 1px solid #374151;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #e0e0e0;
      pointer-events: auto;
    }

    /* 弹窗头部 */
    #ollama-popup-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid #374151;
      flex-shrink: 0;
    }
    #ollama-popup-title {
      font-size: 14px;
      font-weight: 600;
      color: #ffa0f7;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      margin-right: 8px;
    }
    #ollama-popup-close {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: 6px;
      color: #9ca3af;
      font-size: 18px;
      cursor: pointer;
      transition: background 0.15s, color 0.15s;
      flex-shrink: 0;
      line-height: 1;
    }
    #ollama-popup-close:hover {
      background: #374151;
      color: #ef4444;
    }

    /* 原文区域 */
    #ollama-popup-source {
      padding: 12px 16px 8px;
      font-size: 13px;
      color: #9ca3af;
      border-bottom: 1px solid #2d2d4a;
      flex-shrink: 0;
      max-height: 120px;
      overflow-y: auto;
      word-break: break-word;
      line-height: 1.5;
    }
    #ollama-popup-source-label {
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 4px;
      font-weight: 500;
    }

    /* 翻译结果区域（可滑动） */
    #ollama-popup-result {
      padding: 12px 16px;
      font-size: 14px;
      line-height: 1.7;
      color: #e0e0e0;
      overflow-y: auto;
      flex: 1;
      min-height: 60px;
      word-break: break-word;
    }
    #ollama-popup-result.loading {
      color: #9ca3af;
      font-style: italic;
    }
    #ollama-popup-result.error {
      color: #ef4444;
    }

    /* 翻译结果中的 Markdown 样式 */
    #ollama-popup-result strong {
      color: #ffa0f7;
      font-weight: 600;
    }
    #ollama-popup-result em {
      color: #93c5fd;
      font-style: italic;
    }
    #ollama-popup-result ul, #ollama-popup-result ol {
      margin: 4px 0;
      padding-left: 20px;
    }
    #ollama-popup-result li {
      margin: 2px 0;
      line-height: 1.6;
    }
    #ollama-popup-result p {
      margin: 6px 0;
    }
    #ollama-popup-result hr {
      border: none;
      border-top: 1px solid #374151;
      margin: 8px 0;
    }


    /* 滚动条样式 */
    #ollama-popup-source::-webkit-scrollbar,
    #ollama-popup-result::-webkit-scrollbar {
      width: 6px;
    }
    #ollama-popup-source::-webkit-scrollbar-track,
    #ollama-popup-result::-webkit-scrollbar-track {
      background: transparent;
    }
    #ollama-popup-source::-webkit-scrollbar-thumb,
    #ollama-popup-result::-webkit-scrollbar-thumb {
      background: #4b5563;
      border-radius: 3px;
    }
    #ollama-popup-source::-webkit-scrollbar-thumb:hover,
    #ollama-popup-result::-webkit-scrollbar-thumb:hover {
      background: #6b7280;
    }
  `
  document.head.appendChild(style)
}

// 获取选中的文本
function getSelectedText() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return ''
  return selection.toString().trim()
}

// 获取选中文本的边界矩形
function getSelectionRect() {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  return range.getBoundingClientRect()
}

// 浮动按钮
let floatBtn = null

function removeFloatBtn() {
  if (floatBtn && floatBtn.parentNode) {
    floatBtn.parentNode.removeChild(floatBtn)
  }
  floatBtn = null
}

function createFloatBtn(x, y) {
  removeFloatBtn()
  floatBtn = document.createElement('button')
  floatBtn.id = 'ollama-float-btn'
  floatBtn.textContent = '翻译'
  floatBtn.style.left = x + 'px'
  floatBtn.style.top = y + 'px'
  document.body.appendChild(floatBtn)
  floatBtn.addEventListener('click', onFloatBtnClick)
  return floatBtn
}

// 弹窗相关
let popupOverlay = null

function removePopup() {
  if (popupOverlay && popupOverlay.parentNode) {
    popupOverlay.parentNode.removeChild(popupOverlay)
  }
  popupOverlay = null
}

function createPopup(sourceText, translatedText, isLoading, isError) {
  removePopup()

  popupOverlay = document.createElement('div')
  popupOverlay.id = 'ollama-popup-overlay'

  const popup = document.createElement('div')
  popup.id = 'ollama-popup'

  // 头部
  const header = document.createElement('div')
  header.id = 'ollama-popup-header'
  const title = document.createElement('div')
  title.id = 'ollama-popup-title'
  title.textContent = '📖 翻译结果'
  const closeBtn = document.createElement('button')
  closeBtn.id = 'ollama-popup-close'
  closeBtn.textContent = '×'
  closeBtn.title = '关闭'
  closeBtn.addEventListener('click', removePopup)
  header.appendChild(title)
  header.appendChild(closeBtn)
  popup.appendChild(header)

  // 原文
  const sourceDiv = document.createElement('div')
  sourceDiv.id = 'ollama-popup-source'
  const sourceLabel = document.createElement('div')
  sourceLabel.id = 'ollama-popup-source-label'
  sourceLabel.textContent = '原文'
  const sourceContent = document.createElement('div')
  sourceContent.textContent = sourceText
  sourceDiv.appendChild(sourceLabel)
  sourceDiv.appendChild(sourceContent)
  popup.appendChild(sourceDiv)


  // 翻译结果
  const resultDiv = document.createElement('div')
  resultDiv.id = 'ollama-popup-result'
  if (isLoading) {
    resultDiv.textContent = '⏳ 翻译中...'
    resultDiv.classList.add('loading')
  } else if (isError) {
    resultDiv.textContent = translatedText || '翻译失败'
    resultDiv.classList.add('error')
  } else {
    resultDiv.innerHTML = renderMarkdown(translatedText) || ''
  }

  popup.appendChild(resultDiv)

  popupOverlay.appendChild(popup)
  document.body.appendChild(popupOverlay)

  // 点击遮罩关闭
  popupOverlay.addEventListener('click', (e) => {
    if (e.target === popupOverlay) removePopup()
  })
}

function showLoadingPopup(sourceText) {
  createPopup(sourceText, '', true, false)
}

function showResultPopup(sourceText, translatedText) {
  createPopup(sourceText, translatedText, false, false)
}

function showErrorPopup(sourceText, errorMsg) {
  createPopup(sourceText, errorMsg, false, true)
}

// 将简单的 Markdown 格式转换为 HTML（支持 **粗体**、*斜体*、列表等）
function renderMarkdown(text) {
  if (!text) return ''
  // 先转义 HTML 特殊字符，防止 XSS
  let html = text
    .replace(/&/g, '&' + 'amp;')
    .replace(/</g, '&' + 'lt;')
    .replace(/>/g, '&' + 'gt;')



  // 处理 **粗体** (非贪婪)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  // 处理 *斜体* (非贪婪)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')




  // 将行按换行分割
  const lines = html.split('\n')
  const result = []
  let inList = false
  let listType = null // 'ul' or 'ol'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    // 空行
    if (!trimmed) {
      if (inList) {
        result.push(listType === 'ol' ? '</ol>' : '</ul>')
        inList = false
        listType = null
      }
      continue
    }

    // 数字列表: 1. xxx
    const olMatch = trimmed.match(/^(\d+)\.\s+(.*)/)
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) result.push(listType === 'ol' ? '</ol>' : '</ul>')
        result.push('<ol>')
        inList = true
        listType = 'ol'
      }
      result.push('<li>' + olMatch[2] + '</li>')
      continue
    }

    // 无序列表: * xxx 或 - xxx
    const ulMatch = trimmed.match(/^[\*\-]\s+(.*)/)
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) result.push(listType === 'ol' ? '</ol>' : '</ul>')
        result.push('<ul>')
        inList = true
        listType = 'ul'
      }
      result.push('<li>' + ulMatch[1] + '</li>')
      continue
    }

    // 普通段落
    if (inList) {
      result.push(listType === 'ol' ? '</ol>' : '</ul>')
      inList = false
      listType = null
    }
    result.push('<p>' + trimmed + '</p>')
  }

  // 关闭未闭合的列表
  if (inList) {
    result.push(listType === 'ol' ? '</ol>' : '</ul>')
  }

  return result.join('\n')
}

// 手动翻译（字典级解释）
async function manualTranslate(text) {

  const cacheKey = makeTranslationCacheKey('manual_dict:' + text)
  let cached = await getCachedTranslation(cacheKey)
  if (cached) return cached

  const data = await ollamaGenerate({
    model: OLLAMA_MODEL,
    prompt: `你是一个专业词典翻译工具。请对以下英文文本进行详细的词典级翻译和解释。

要求：
1. 如果文本是单个单词或短语：给出音标、词性、中文释义、例句及其中文翻译
2. 如果文本是句子或段落：先给出流畅的中文翻译，然后逐词/逐短语解释关键单词的含义和用法
3. 如果文本已经是中文：给出英文翻译和用法说明
4. 格式要清晰易读，使用换行和缩进组织内容
5. 不要输出思维链/推理过程

待翻译文本：
${text}`,
    stream: false,
    temperature: 0.1,
    options: {
      num_predict: 1024
    }
  })
  const response = stripThinkBlocks(data.response)?.trim() || ''
  if (response) {
    await setCachedTranslation(cacheKey, response)
  }
  return response || '翻译失败'
}

async function onFloatBtnClick() {
  const text = getSelectedText()
  if (!text) {
    removeFloatBtn()
    return
  }

  removeFloatBtn()
  showLoadingPopup(text)

  try {
    const result = await manualTranslate(text)
    // 更新弹窗内容
    const resultDiv = popupOverlay?.querySelector('#ollama-popup-result')
    const sourceDiv = popupOverlay?.querySelector('#ollama-popup-source')
    if (resultDiv) {
      resultDiv.classList.remove('loading')
      resultDiv.innerHTML = renderMarkdown(result) || '翻译失败'
    }

    if (sourceDiv) {
      // 更新原文显示
      const textNode = sourceDiv.childNodes[1]
      if (textNode) textNode.textContent = text
    }
  } catch (err) {
    const resultDiv = popupOverlay?.querySelector('#ollama-popup-result')
    if (resultDiv) {
      resultDiv.classList.remove('loading')
      resultDiv.classList.add('error')
      resultDiv.textContent = '翻译出错: ' + (err.message || String(err))
    }
  }
}

// 鼠标松开事件：检测文本选择并显示浮动按钮
function handleMouseUp(e) {
  // 如果点击在弹窗或按钮上，不处理
  if (e.target.closest('#ollama-popup-overlay') || e.target.closest('#ollama-float-btn')) return

  // 延迟执行，让 selection 稳定
  setTimeout(() => {
    const text = getSelectedText()
    if (!text || text.length < 2) {
      removeFloatBtn()
      return
    }

    const rect = getSelectionRect()
    if (!rect) {
      removeFloatBtn()
      return
    }

    // 计算按钮位置（在选区右下方）
    let btnX = rect.right + 4
    let btnY = rect.bottom + 4

    // 确保按钮不超出视口
    const btnWidth = 60
    const btnHeight = 32
    if (btnX + btnWidth > window.innerWidth - 8) {
      btnX = rect.left - btnWidth - 4
    }
    if (btnY + btnHeight > window.innerHeight - 8) {
      btnY = rect.top - btnHeight - 4
    }

    createFloatBtn(btnX, btnY)
  }, 10)
}

// 鼠标按下时移除浮动按钮
function handleMouseDown(e) {
  if (e.target.closest('#ollama-float-btn') || e.target.closest('#ollama-popup-overlay')) return
  removeFloatBtn()
}

// 按 Escape 关闭弹窗
function handleKeyDown(e) {
  if (e.key === 'Escape') {
    removePopup()
    removeFloatBtn()
  }
}

// 初始化手动翻译功能
function initManualTranslate() {
  injectManualTranslateStyles()
  document.addEventListener('mouseup', handleMouseUp)
  document.addEventListener('mousedown', handleMouseDown)
  document.addEventListener('keydown', handleKeyDown)
}

// ============================================================
// 主初始化
// ============================================================

async function init() {
  console.log('✅ 翻译插件已启动')
  lastNavigationKey = getPageKey()
  ensureTranslationCacheReady()

  // 先加载配置，再设置监听器和自动翻译
  await loadConfig()
  setupConfigListener()

  // 修复：自动翻译应完全由 storage 中的 ollamaAutoTranslate 控制
  // 不再根据页面语言自动开启翻译
  checkAutoTranslateSetting()

  setupNavigationHooks(handleNavigation)

  // 初始化手动翻译功能（始终可用，不受自动翻译开关影响）
  initManualTranslate()

  dlog('init complete')
}

init()



/**
 * 调用本地 Ollama qwen3.5:4b 翻译
 * @param {string} text 待翻译文本
 * @param {string} topic 网页主题
 * @returns {Promise<string>} 中文结果
 */
async function translateWithOllama(text, topic) {
  const data = await ollamaGenerate({
    model: OLLAMA_MODEL,
    prompt: `请把下面文本精准翻译成中文。要求：
1. 如果待翻译文本已经是原生中文（包括常见中文表达、专有名词已有标准中译且无需翻译）、或者是无意义内容（如乱码、纯符号、数字、无语义字符），请直接输出 NO_REPLY。
2. 否则，只输出翻译结果，不要解释、不要额外内容、不要输出思维链/推理过程。
3. 不要复述或回显原文。

网页主题（供参考）：${topic || ''}

待翻译文本：
${text}`,
    stream: false,
    temperature: 0.1,
    options: {
      num_predict: 256
    }
  })
  const response = stripThinkBlocks(data.response)?.trim() || ''
  if (!response) {
    dlog('translateWithOllama empty response', { thinkingLen: data?.thinking?.length || 0, doneReason: data?.done_reason })
    return '翻译失败'
  }
  return response
}
