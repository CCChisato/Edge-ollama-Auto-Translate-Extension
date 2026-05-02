const OLLAMA_GENERATE_URL = 'http://127.0.0.1:11434/api/generate'
const OLLAMA_MODEL = 'qwen3.5:4b'

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
  } catch {}
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

function hasEquivalentSupportedDescendant(el, ownText) {
  const descendants = el.querySelectorAll?.('p, li, span')
  if (!descendants?.length) return false

  for (const node of descendants) {
    if (node === el) continue
    if (isTranslationNode(node)) continue
    if (isProtectedElement(node)) continue

    const childText = normalizeTextForCompare(node.textContent)
    if (childText && childText === ownText) return true
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
  const res = await sendMessageToBackground({ type: 'OLLAMA_FETCH', url, init }, 30000).catch((err) => {
    dlog('fetchJson error(sendMessage)', { reqId, err: String(err) })
    throw err
  })
  dlog('fetchJson result', { reqId, elapsedMs: Math.round(performance.now() - started), res })
  if (!res?.ok) throw new Error(res?.error || `HTTP ${res?.status || 0}`)
  if (res?.json) return res.json
  if (res?.text) return JSON.parse(res.text)
  throw new Error('空响应')
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
  const next = el.nextElementSibling
  return Boolean(sourceId && next && isTranslationNode(next) && next.dataset.ollamaSourceId === sourceId)
}

function shouldTranslateElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false
  if (!isSupportedTag(el.tagName)) return false
  if (isProtectedElement(el)) return false
  if (isTranslationNode(el)) return false
  if (el.dataset.ollamaTranslated === '1') return false

  const text = normalizeTextForCompare(el.textContent)
  if (text.length < 2) return false
  if (hasEquivalentSupportedDescendant(el, text)) return false

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
        queuedElements.delete(el)
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

async function translateElement(el) {
  if (!translationEnabled) return
  if (!shouldTranslateElement(el)) return
  if (hasExistingTranslation(el)) {
    el.dataset.ollamaTranslated = '1'
    return
  }

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
    refreshTopicForPage({ retries: 1 }).catch(() => {})
    scheduleFullScan()
  }
}

function startTranslation() {
  if (translationEnabled) return
  translationEnabled = true

  dlog('startTranslation')
  ensureTranslationCacheReady()
    .finally(() => {
      refreshTopicForPage({ retries: 1 }).catch(() => {})
      scanAndEnqueue(document.body)
      setupMutationObserver()
    })
}

function init() {
  console.log('✅ 翻译插件已启动')
  lastNavigationKey = getPageKey()
  ensureTranslationCacheReady()

  setupNavigationHooks(handleNavigation)

  chrome.runtime?.onMessage?.addListener?.((message) => {
    dlog('onMessage', message)
    if (message?.type === 'OLLAMA_TRANSLATE_START') startTranslation()
  })

  const auto = isEnglishPage()
  dlog('init', { auto })
  if (auto) startTranslation()
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
    prompt: `请把下面文本精准翻译成中文。要求：只输出翻译结果，不要解释、不要额外内容，不要输出思维链/推理过程。如果文本已经是中文、无意义或不需要翻译，请直接输出 NO_REPLY。\n网页主题（供参考）：${topic || ''}\n待翻译文本：\n${text}`,
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
