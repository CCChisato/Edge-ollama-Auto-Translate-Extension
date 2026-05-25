# Ollama 网页翻译 - Edge 浏览器扩展

> 调用本地 Ollama 模型，实现网页全文翻译 + 框选文本手动翻译

## ✨ 功能

### 🌐 全文翻译
- 自动识别英文页面，调用本地 Ollama 模型翻译所有 `<p>`、`<li>`、`<span>` 标签
- 翻译结果以紫色文字显示在原文下方，方便对照阅读
- 支持 SPA 页面导航（自动检测路由变化并翻译新内容）
- 支持 MutationObserver 动态监听页面变化
- 内置翻译缓存（内存 + 持久化存储），避免重复翻译

### 🖱 框选翻译（手动翻译）
- 鼠标左键框选任意文本后，选区旁出现浮动 **「翻译」** 按钮
- 点击按钮弹出翻译弹窗，显示**词典级详细解释**
  - 单词/短语：音标、词性、中文释义、例句
  - 句子/段落：流畅中文翻译 + 逐词解释
- 翻译结果支持 Markdown 渲染（**粗体**、*斜体*、列表等）
- 弹窗可滑动，右上角「×」关闭，也可点击遮罩或按 `Esc` 关闭

### ⚙ 设置
- 可配置 Ollama API 地址（默认 `http://localhost:11434/api/generate`）
- 可配置使用的模型名称（默认 `granite4.1:3b`）
- 自动翻译开关，开启后自动翻译英文页面

## 📦 安装

### 1. 下载扩展
```bash
git clone https://github.com/CCChisato/Edge-ollama-Auto-Translate-Extension.git
```

### 2. 加载到 Edge
1. 打开 Edge 浏览器，进入 `edge://extensions/`
2. 开启 **「开发人员模式」**
3. 点击 **「加载解压缩的扩展」**
4. 选择 `translate_ollama` 文件夹

### 3. 安装并运行 Ollama
```bash
# 安装 Ollama（参考 https://ollama.com）
# 下载模型（推荐）
ollama pull granite4.1:3b
# 或
ollama pull qwen3.5:4b
```

### 4. 配置 Ollama 跨域访问（重要！）

> ⚠️ **Ollama 默认只监听 127.0.0.1，浏览器扩展需要跨域访问，必须设置环境变量**

#### Windows
```bash
# 设置环境变量后重启 Ollama
setx OLLAMA_ORIGINS "*"
# 然后重启 Ollama 服务（任务管理器结束 ollama.exe 再重新启动）
```

#### Linux / macOS
```bash
# 设置环境变量后重启 Ollama
export OLLAMA_ORIGINS="*"
# 或写入配置文件
echo 'export OLLAMA_ORIGINS="*"' >> ~/.bashrc
# 重启 Ollama
systemctl restart ollama  # Linux
# 或 macOS: 在菜单栏退出 Ollama 后重新启动
```

#### 验证 Ollama 是否正常运行
```bash
# 测试 API 是否可访问
curl http://localhost:11434/api/generate -d '{
  "model": "granite4.1:3b",
  "prompt": "Hello",
  "stream": false
}'
```

## 🚀 使用

### 全文翻译
1. 点击浏览器工具栏的扩展图标
2. 点击 **「开始翻译」** 按钮手动翻译当前页面
3. 或开启 **「自动翻译」** 开关，之后访问英文页面自动翻译

### 框选翻译
1. 在任意网页上用鼠标左键框选文本
2. 选区旁出现紫色 **「翻译」** 按钮
3. 点击按钮，弹出翻译弹窗显示词典级详细解释
4. 点击「×」或按 `Esc` 关闭弹窗

## 🔧 技术说明

### 架构
- **Manifest V3** - 使用 Service Worker 作为后台
- **Content Script** - 注入页面进行 DOM 操作和翻译
- **Background Service Worker** - 代理 API 请求，解决 CORS 限制
- **Ollama API** - 调用本地大语言模型进行翻译

### 跨域问题
浏览器扩展的 Content Script 无法直接访问 `localhost` API（受 CORS 限制）。本扩展通过以下方式解决：
1. Content Script 发送消息到 Background Service Worker
2. Service Worker 发起 `fetch()` 请求到 Ollama API
3. 结果返回给 Content Script

> 注意：即使使用 Service Worker 代理，某些浏览器仍可能因 **Private Network Access (PNA)** 限制阻止请求。如果遇到 403 错误，请确保设置了 `OLLAMA_ORIGINS="*"` 环境变量。

### 文件结构
```
translate_ollama/
├── manifest.json      # 扩展配置
├── background.js      # Service Worker - API 代理
├── content.js         # Content Script - 翻译核心逻辑
├── popup.html         # 弹出窗口 UI
├── popup.js           # 弹出窗口逻辑
└── README.md          # 本文件
```

## 📝 注意事项
- 翻译质量取决于使用的 Ollama 模型
- 首次翻译较慢（模型加载），后续翻译会使用缓存加速
- 建议使用支持中文的模型（如 `qwen3.5:4b`、`granite4.1:3b` 等）
- 如果遇到翻译失败，请检查 Ollama 服务是否正常运行

## 📄 许可证
MIT
