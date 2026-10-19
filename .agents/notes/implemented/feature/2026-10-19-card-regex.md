# Agent Note: 角色卡自带的正则照 SillyTavern 规则执行，显示用的 HTML 放进不能跑脚本的 iframe

Status: implemented

## Problem

SillyTavern 把角色卡的正则存在 `extensions.regex_scripts` 里，导入时原样保留了（[角色卡导入](2026-10-19-card-import.md)），但显示和拼提示词都没用。开发者的万象卡有 15 条：

- 14 条 `markdownOnly: true`，只改显示：把 `<status>`、`<npc>`、`<memo>`、`<world>` 换成带样式的 `<div>`、`<details>`，把「好感度：80」换成进度条，给对话和【系统】上色。
- 1 条「万象-删旧状态」`promptOnly: true`、`minDepth: 6`、替换成空：发给模型时删掉离最新一条 6 条以上的 `<status>…</status>`，省 token。

不执行的话，界面上是一堆原始标签，提示词里带着每一轮的旧状态栏。

## Decision

- 代码在 `packages/core/src/prompt/regex.ts`：`cardRegexScripts(card)` 读卡里的正则（格式不对的单条跳过），`applyRegexScripts(scripts, text, ctx)` 按卡里的顺序依次执行。
- 规则照 SillyTavern，2026-10-19 对照过 release 分支的 `public/scripts/extensions/regex/engine.js`（`getRegexedString`、`runRegexScript`）和 `public/scripts/utils.js`（`regexFromString`）：
  - `placement` 只认 1（用户消息）和 2（AI 消息），system 消息不改。
  - `markdownOnly` 只改显示，`promptOnly` 只改提示词。
  - `minDepth`、`maxDepth`：最新一条深度是 0，为空或 -1 表示不限。
  - `findRegex` 写成 `/pattern/flags`，不带斜杠的整串当正则；写错的跳过。
  - 替换串里 `{{match}}` 等于 `$0`；`$1`、`$<name>` 引用分组，引用到的分组先删掉 `trimStrings` 里的字符串；最后替换 `{{char}}`、`{{user}}`。
  - `substituteRegex`：1 把 `{{char}}`、`{{user}}` 填进正则，2 转义后再填。
- 两个都没勾的正则，显示和拼提示词时各执行一遍。SillyTavern 是在收到消息时直接改写存档；这里不改存档，效果一样，原文还在，改了正则或删掉正则后旧消息也跟着变。
- 拼提示词：`buildChatPrompt` 先对聊天记录执行正则，再替换宏。世界书关键词仍然扫原文。
- 显示：`packages/app/src/App.tsx` 的 `MessageBody` 执行正则后再替换宏（之前开场白里的 `{{user}}` 原样显示，这次一起修了）。正则改出了东西就交给 `MessageHtml.tsx`，没改就按纯文本显示。
  - `MessageHtml` 用 `<iframe sandbox="allow-same-origin" srcdoc=…>`，不给 `allow-scripts`：iframe 里不能跑脚本。给 `allow-same-origin` 只是为了外层能读内容高度，没有脚本权限时 iframe 里的内容用不上这个来源。
  - 外层用 ResizeObserver 盯着 iframe 的 body，展开 `<details>` 时高度跟着变。字体、颜色从外层复制进去。
  - 2026-10-20 起，执行完正则再按 Markdown 渲染（顺序和 SillyTavern 一样），用 markdown-it 15.0.2，`breaks: true` 让单个换行也换行（ST 用 showdown 的 `simpleLineBreaks`）。代码在 `packages/app/src/markdown.ts`。
    - 正则改出了东西的消息：开 HTML 渲染，放进 iframe。
    - 没改过的消息：关 HTML（原文里的标签被转义），直接放进页面，不建 iframe。
    - 两种都不渲染链接和图片：链接在主页面里点了会把整个 App 导航走，图片会去加载网络地址。
    - 打字时不重新渲染所有消息（`MessageBody` 加了 `memo`）。
- `tauri.conf.json` 加了 `"dangerousDisableAssetCspModification": ["style-src"]`。打包时 Tauri 会往 CSP 里注入哈希（https://v2.tauri.app/security/csp/ ），`style-src` 里有了哈希，`'unsafe-inline'` 就失效，`srcdoc` 的 iframe 继承外层 CSP，卡片的 `style="…"` 全部不生效。只对 `style-src` 关掉注入，`script-src` 照旧。

## Alternatives considered

- **按 [HTML 沙盒笔记](../../proposed/feature/2026-10-19-card-html-sandbox.md) 走自定义协议、允许卡片 JS** — 最强的理由：一步到位，带 JS 的美化卡也能跑。否掉的原因：自定义协议在 WebView2 和 WKWebView 上都没验证过；开发者的卡只用到 HTML + CSS，不带脚本的 iframe 已经够用，而且现在就能在真 App 里验证。
- **用 DOMPurify 之类清理后直接插进页面** — 最强的理由：不用 iframe，没有量高度的问题，几百条消息也不卡。否掉的原因：要加依赖；卡片的 CSS 会漏到外层页面（选择器、`position: fixed`），清理规则漏一条就是 XSS，能读到 API Key。
- **按深度删旧内容的正则在拼提示词时跳过，保护缓存** — 最强的理由：深度一变旧消息内容就变，会打断缓存前缀。否掉的原因：只有刚越过深度线的那一条会变（上一轮已经删过的这一轮内容不变），缓存只在最近几条失效，见下面的测试；而这条正则在 203 条的聊天里省掉了三成字数。

## Consequences

- 2026-10-20 加上 Markdown 后，在真 App 里看：`# 第1章` 显示成标题，`---` 显示成分隔线，万象的状态栏、展开后的人物块和进度条样子不变。203 条的聊天里 101 条 AI 消息进 iframe，102 条用户消息直接渲染。

- 2026-10-19 在真 App 里用开发者的万象卡和从 Tavo 导入的聊天验证（只在本地跑，卡片和聊天含成人内容，不进仓库）：
  - 状态栏、档案、人物折叠块、对话上色、【系统】上色都显示出来了，样子和 Tavo 里一致（只看了截图，没有并排对比）；展开人物块后 iframe 高度从 1802 变成 2114。
  - 往 iframe 里插 `<script>` 和 `<img onerror>` 改标题，都没执行。
  - 203 条的聊天：原文 94 条带 `<status>`，提示词里只剩最近的 2 条；聊天记录从 167563 字降到 114545 字。
- 测试：`regex.test.ts` 7 个，覆盖读卡、三种生效范围、placement、minDepth、替换写法、请求标准答案（`__golden__/regex-card.json`）、深度删除只让最后一条变化。原来的标准答案没有变化，因为测试卡没有正则。
- 没有验证：
  - 打包后的 App 里 CSP 改动是否生效（只在开发模式下跑过，开发模式不加 CSP）。
  - 浅色模式：万象卡的颜色按深色背景写的（状态栏文字是 `#e8e0f0`），浅色模式下看不清，这是卡片的写法问题，没处理。
- 还没做（代码里有 `shortcut:` 注释）：
  - 中文紧贴标点的粗体（如 `文字**【x】**文字`）按 CommonMark 规则不生效；有需要再加 markdown-it-cjk-friendly。
  - 全局正则、导入 Tavo 导出的正则文件、正则管理界面。
  - 每条消息一个 iframe：203 条的聊天里同时有 101 个，没有测滚动是否卡顿，也没在 iPhone 上试。
  - 卡片里的图片、字体只能从本地加载（CSP 的 `img-src` 没放开网络地址），引用网络图片的卡显示不出图。
