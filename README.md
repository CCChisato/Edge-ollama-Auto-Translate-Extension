# Ollama 网页翻译插件

## English Summary

This is a simple browser extension that sends webpage text to a local Ollama model and inserts the Chinese translation back into the page.

It is basically a `vibe coding` project. I do not claim to fully understand every implementation detail, but the goal is practical:

- easy to use
- easy to modify
- local-first
- more controllable in privacy and permissions

For most custom behavior, you only need to edit [`content.js`](file:///c:/Users/12780/Desktop/software/translate_ollama/content.js), such as:

- model name
- prompt text
- which tags to translate
- which areas to skip
- auto-translate rules
- cache behavior

This project is meant to be a simple, customizable local translation tool, especially for users who prefer not to rely on commercial translation products or worry too much about privacy, permissions, or political/content restrictions.

一个非常简单的浏览器翻译插件，核心思路是：

- 在网页中找到需要翻译的文本
- 把文本发送给本地 Ollama
- 将中文翻译结果插入回页面

这个项目的目标不是做一个“完整商业级产品”，而是提供一个容易理解、容易改、容易自己定制的本地翻译小工具。

## 项目说明

这个项目基本属于 `vibe coding` 产物。

我本人并不熟悉所有代码实现原理，也不是在追求复杂架构，而是希望先做出一个：

- 能用
- 好改
- 本地运行
- 隐私更可控

的小插件。

所以如果你也只是想快速拥有一个“够用的网页翻译插件”，并且愿意自己微调一点参数，这个项目应该会比较适合你。

## 为什么做这个插件

相比商业翻译产品，这种本地方案有几个明显特点：

- 文本发给你本机的 Ollama，而不是默认交给第三方云服务
- 权限范围相对直观，代码也比较容易自己检查
- 可以自己决定模型、prompt、缓存方式、翻译策略
- 不用太担心商业产品带来的权限、隐私、政治内容过滤等问题

当然，这不代表它一定更强，只是它更适合“自己掌控”。

## 适合谁

适合下面这类用户：

- 想自己控制翻译流程的人
- 不想依赖商业翻译插件的人
- 想把网页文本交给本地模型处理的人
- 想快速改几个字段就得到自己想要行为的人

## 如何使用

### 1. 准备 Ollama

先确保本地已经安装并启动 Ollama，并且已经拉取你要使用的模型。

当前默认使用：

```text
qwen3.5:4b
```

### 2. 安装插件

1. 下载或克隆本仓库
2. 打开浏览器扩展页面
3. 打开“开发者模式”
4. 选择“加载已解压的扩展程序”
5. 选择本项目目录

### 3. 开始翻译

- 某些英文页面会自动翻译
- 某些页面需要点击一次扩展图标后开始翻译
- 翻译结果会直接插入到原文后面

## 如何定制

最常改的文件是：

[`content.js`](file:///c:/Users/12780/Desktop/software/translate_ollama/content.js)

即使你不熟悉完整代码原理，通常只改这里的一些字段和逻辑，也能控制插件的大部分行为。

例如你可以改：

- `OLLAMA_MODEL`
  - 切换使用的模型
- prompt 内容
  - 控制翻译风格、是否简洁、是否允许不翻译
- 自动翻译条件
  - 比如只在 `lang="en"` 页面启用
- 支持翻译的标签
  - 比如 `p`、`li`、`span`
- 跳过的区域
  - 比如 `code`、输入框、`contenteditable`
- 缓存策略
  - 控制哪些文本命中本地缓存
- 调试输出
  - 通过日志观察请求和注入过程

也就是说，这个项目比较适合“把它当成一个可改模板”，而不是一个完全封装、完全不用碰代码的成品。

## 目前特性

- 调用本地 Ollama 翻译网页内容
- 支持动态页面内容翻译
- 支持 `p`、`li`、`span`
- 跳过输入框、可编辑区域、代码区域
- 支持本地缓存，避免重复翻译浪费算力
- 可以通过 prompt 和字段快速调整行为

## 隐私与风险

这个插件的主要优势是“简单、透明、可本地化”，但也有几点需要注意：

- 你仍然需要自行确认浏览器扩展权限
- 你仍然需要自行确认本地模型和 Ollama 的安全性
- 翻译质量完全依赖你使用的模型和 prompt
- 某些复杂网页结构仍可能出现误翻译或漏翻译

如果你在意可控性，这种方案通常比黑盒商业插件更适合自己折腾。

## 最后

如果你会一点点改代码，这个项目会很好用。

如果你完全不懂代码，也可以先从修改 `content.js` 里的几个字段开始，一边试一边改，很快就能做出一个符合自己需求的简单翻译插件。
