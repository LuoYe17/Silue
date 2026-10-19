# Agent Note: 消息里的 HTML 放进沙盒 iframe 渲染，第一版不给卡片 JS 接口

Status: proposed

## Problem

中文 RP 圈有很多美化卡、状态栏卡：用正则把模型的输出替换成 HTML + CSS，在消息里画出状态栏、进度条、仿手机界面。开发者常玩的万象卡就是这样：`万象-正则.zip` 里有 12 条 ST 格式的正则（`placement: [2]`、`markdownOnly: true`），把 `<status>` 换成带样式的卡片，把「好感度」「性欲值」换成进度条。这些正则只用了 HTML + CSS，没有 JS。

卡片是从网上下载的，里面的脚本不加隔离的话，能读到 API Key 和其他数据。

开发者的聊天变量里有 JS 写入的数据，但查下来这些是开发者自己的 Tavo 插件「万象记忆」写的，不是角色卡带的脚本。这个插件的功能改成内置，见 [长期记忆](2026-10-19-long-term-memory.md)。

## Proposal

- **渲染**：模型输出先过正则，再按 Markdown 渲染，带 HTML 的部分放进 `<iframe sandbox="allow-scripts">`，不加 `allow-same-origin`。这样 iframe 是一个匿名来源，读不到 App 的存储，也调不了 Tauri 的接口（Tauri v2 不再往 iframe 里注入 IPC，见 https://github.com/advisories/GHSA-57fm-592m-34r7 ）。
- **安全策略**：Tauri 打包时会往页面的安全策略（CSP）里加哈希和 nonce（https://v2.tauri.app/security/csp/ ），加了之后 `'unsafe-inline'` 会失效，而用 `srcdoc` 写入的 iframe 会继承外层页面的安全策略。所以沙盒页面要通过一个自定义协议单独提供，配它自己的安全策略，不用 `srcdoc`。这个办法在 WebView2 和 WKWebView 上都没有实测过。
- **高度**：iframe 里面用 ResizeObserver 量出内容高度，再用 postMessage 告诉外层页面。
- **性能**：只有屏幕上能看到的消息才创建 iframe；滚出屏幕就销毁，换成静态快照。
- **JS**：第一版的 JS 只能改自己那块消息的显示（比如点按钮切换面板），不提供任何读写聊天变量、调用模型的接口。
- **插件系统**：第二版再做。等内置功能稳定了，参考 Tavo 插件的能力（监听消息事件、读写变量、调用模型、侧边栏按钮、往聊天页里加界面）来定接口。

## Alternatives considered

- **只支持 Markdown，或者只支持不带 JS 的 HTML** — 最强的理由：不需要沙盒，也没有安全问题，实现最简单。否掉的原因：美化卡是中文 RP 圈的主流，开发者选了完整支持。
- **第一版就提供卡片 JS 接口，兼容 Tavo 和酒馆助手** — 最强的理由：能直接跑更多社区卡。上一轮讨论一度定成要做，因为当时以为万象卡自带 JS。否掉的原因：查下来开发者的卡都用不到这个接口。而且酒馆助手跑的是不加沙盒的 iframe，卡片直接调用外层页面的函数（来源是第三方页面，未核实）；放进沙盒后只能通过 postMessage 异步转接，同步函数没法照原样兼容。
- **不加沙盒，像酒馆助手那样直接跑** — 最强的理由：兼容性最好。否掉的原因：下载来的卡能读到 API Key。

## Acceptance criteria

- 导入万象卡和 `万象-正则.zip` 后，状态栏和进度条的样子和在 Tavo 里一致（拿截图对比）。
- 在 iframe 里的脚本中尝试读取 `parent.document`、`localStorage`、`window.__TAURI__`，全部失败。
- 一段 500 条消息、每条都带 HTML 的聊天，在 iPhone 上滚动不掉帧（用滚动录屏确认），同时存在的 iframe 不超过屏幕上能看到的数量加上下各几条。

## Risks

- **自定义协议的方案没验证过**：在 Windows 和 iOS 上都没跑过，这一步不通的话，卡里的 JS 跑不起来，只能退回到「HTML + CSS，不带 JS」。
- **依赖酒馆助手的卡跑不了**：第一版里，用到酒馆助手接口的卡会失效，要在界面上提示「这张卡需要的功能还不支持」。
- **iframe 太多会卡**：没找到实测数据，靠只渲染屏幕上能看到的消息来压住。
