// ===== DOM 引用 =====
const btnTranslate = document.getElementById('btnTranslate')
const btnAuto = document.getElementById('btnAuto')
const btnConfig = document.getElementById('btnConfig')
const configSection = document.getElementById('configSection')
const inputUrl = document.getElementById('inputUrl')
const inputModel = document.getElementById('inputModel')
const btnSave = document.getElementById('btnSave')
const btnCancel = document.getElementById('btnCancel')
const statusEl = document.getElementById('status')

// ===== 工具函数 =====
function setStatus(msg, isError = false) {
  statusEl.textContent = msg
  statusEl.className = 'status' + (isError ? ' error' : '')
  if (!isError) {
    setTimeout(() => {
      if (statusEl.textContent === msg) {
        statusEl.textContent = ''
      }
    }, 3000)
  }
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  return tabs[0]
}

async function sendToContentTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message)
  } catch (err) {
    // 内容脚本可能还没加载，忽略
    console.log('[POPUP] sendMessage error:', String(err))
  }
}

// ===== 加载配置 =====
async function loadConfig() {
  const result = await chrome.storage.sync.get(['ollamaGenerateUrl', 'ollamaModel', 'ollamaAutoTranslate'])
  inputUrl.value = result.ollamaGenerateUrl || ''
  inputModel.value = result.ollamaModel || ''
  updateAutoButton(!!result.ollamaAutoTranslate)
}

function updateAutoButton(enabled) {
  btnAuto.textContent = enabled ? '🔄 自动翻译：开启' : '🔄 自动翻译：关闭'
  btnAuto.classList.toggle('active', enabled)
}

// ===== 按钮 1：开始翻译 =====
btnTranslate.addEventListener('click', async () => {
  const tab = await getCurrentTab()
  if (!tab?.id) {
    setStatus('无法获取当前标签页', true)
    return
  }
  await sendToContentTab(tab.id, { type: 'OLLAMA_TRANSLATE_START' })
  setStatus('✅ 已发送翻译指令')
})

// ===== 按钮 2：自动翻译开关 =====
btnAuto.addEventListener('click', async () => {
  const result = await chrome.storage.sync.get('ollamaAutoTranslate')
  const current = !!result.ollamaAutoTranslate
  const newVal = !current
  await chrome.storage.sync.set({ ollamaAutoTranslate: newVal })
  updateAutoButton(newVal)

  const tab = await getCurrentTab()
  if (tab?.id) {
    await sendToContentTab(tab.id, { type: 'OLLAMA_AUTO_TRANSLATE', enabled: newVal })
  }
  setStatus(newVal ? '🟢 自动翻译已开启' : '🔴 自动翻译已关闭')
})

// ===== 按钮 3：展开/收起配置 =====
btnConfig.addEventListener('click', () => {
  const isHidden = configSection.classList.contains('hidden')
  configSection.classList.toggle('hidden')
  btnConfig.textContent = isHidden ? '🔽 收起设置' : '⚙ 设置 Ollama 参数'
})

// ===== 保存配置 =====
btnSave.addEventListener('click', async () => {
  const url = inputUrl.value.trim()
  const model = inputModel.value.trim()

  if (!url && !model) {
    setStatus('请至少填写一项配置', true)
    return
  }

  const toSave = {}
  if (url) toSave.ollamaGenerateUrl = url
  if (model) toSave.ollamaModel = model

  await chrome.storage.sync.set(toSave)
  setStatus('✅ 配置已保存，立即生效')

  // 通知当前标签页配置已更新
  const tab = await getCurrentTab()
  if (tab?.id) {
    await sendToContentTab(tab.id, { type: 'OLLAMA_CONFIG_UPDATED' })
  }
})

// ===== 取消配置 =====
btnCancel.addEventListener('click', () => {
  // 重新加载原始值
  loadConfig()
  configSection.classList.add('hidden')
  btnConfig.textContent = '⚙ 设置 Ollama 参数'
  setStatus('')
})

// ===== 初始化 =====
loadConfig()
